#!/usr/bin/env python3
"""Self-healing for the development loop: reviews feed a backlog, and problems
in it are fixed, tested and applied without anyone at the keyboard.

Only `tools/dev.py --improve` runs this. Nothing here ships in the extension.

    review    Claude Code reads a run (read-only) and ends its review with the
              problems it found as JSON, reusing the backlog's slug for a
              problem already listed, so the same fault on five sites is one
              entry seen five times.
    backlog   .dev/backlog.json (and backlog.md to read): every problem, the
              runs and sites that showed it, and what was done about it. A
              fixed problem that shows up again is reopened: a regression.
    fix       The most pressing open problem goes to a Claude Code session
              working in a copy of the project (.dev/autofix/<id>/repo), never
              in the working tree. It must reproduce the problem in a test,
              fix the cause in a general way, add no model calls, and pass
              ./test.sh.
    gate      This script then runs ./test.sh itself, and the corpus, in the
              copy. Only a fix that passes both, without the corpus scoring
              worse than its last run, is copied into the working tree, where
              dev.py rebuilds the add-on. A file someone changed meanwhile is
              never overwritten; the fix is kept as a patch instead.

Costs are capped: one fix at a time, a few per session (--max-fixes), two
attempts per problem, a spending cap per session, and problems ranked by
severity and how often they recur, so effort goes where users hit it.

    python3 tools/dev.py backlog          # what is open, fixed, failed
    python3 tools/dev.py fix [SLUG]       # fix one problem now (default: the top one)
"""
import datetime, difflib, hashlib, json, os, pathlib, re, shutil, subprocess, sys, threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEV = ROOT / '.dev'
BACKLOG = DEV / 'backlog.json'
WORK = DEV / 'autofix'

# What a fix may change, and what it may not: the loop does not rewrite itself.
EDITABLE = ('src/', 'tools/', 'CLAUDE.md', 'README.md', 'test.sh', 'build.sh')
PROTECTED = ('tools/autofix.py', 'tools/dev.py', 'src/common/local-config.js', 'src/common/dev-config.js')
COPY_SKIP = {'.git', '.dev', 'dist', 'node_modules', '__pycache__', '.DS_Store'}

SEVERITY = {'high': 3, 'medium': 2, 'low': 1}
MAX_ATTEMPTS = 2

_lock = threading.Lock()


def now():
    return datetime.datetime.now().isoformat(timespec='seconds')


# --- the review's problem list ---------------------------------------------------

def review_instructions():
    """Appended to the review prompt: the problem list, and the backlog to match against."""
    known = load()
    listed = '\n'.join(f'- {slug}: {p["summary"][:140]} ({p["status"]})'
                       for slug, p in sorted(known.items(), key=lambda kv: -score(kv[1]))[:60])
    return f"""

Finally, after the review, list the problems as JSON in a fenced ```json block, the last thing in your answer:
[{{"slug": "short-kebab-name", "severity": "high|medium|low", "kind": "wrong-value|missed|not-kept|report-tool|other",
   "summary": "one sentence: what goes wrong for the user and the likely cause", "files": ["src/..."]}}]
- high: a wrong answer would be submitted, or a required question is left empty without the user being told.
- medium: an optional question missed, a wrong label or scope that could cause the above, a misleading message.
- low: report tooling, cosmetic.
- If a problem is the same as one already in the backlog below, use its slug exactly. Name the general fault, not the site
  ("radio-label-from-aria-group-not-label-for", not "calcareers-state-radio").
- An empty list [] if the run is right.

Backlog so far:
{listed or '(empty)'}"""


def parse_problems(text):
    """The JSON list at the end of a review, or [] if there is none."""
    blocks = re.findall(r'```json\s*(.*?)```', text or '', re.S)
    for block in reversed(blocks):
        try:
            items = json.loads(block)
        except ValueError:
            continue
        if isinstance(items, list):
            return [p for p in items if isinstance(p, dict) and p.get('slug') and p.get('summary')]
    return []


# --- the backlog -----------------------------------------------------------------

def load():
    try:
        return json.loads(BACKLOG.read_text())
    except (OSError, ValueError):
        return {}


def save(backlog):
    BACKLOG.parent.mkdir(parents=True, exist_ok=True)
    tmp = BACKLOG.with_suffix('.tmp')
    tmp.write_text(json.dumps(backlog, indent=1))
    tmp.replace(BACKLOG)
    (DEV / 'backlog.md').write_text(render(backlog))


def score(p):
    """Severity times how many runs showed it: what users hit most, first."""
    return SEVERITY.get(p.get('severity'), 1) * max(1, len(p.get('runs', [])))


def render(backlog):
    out = ['# Backlog', '', 'Problems found by reviewing fills, most pressing first. Written by tools/autofix.py.', '']
    for status in ('reopened', 'open', 'failed', 'conflict', 'fixed', 'wontfix'):
        items = sorted([(s, p) for s, p in backlog.items() if p.get('status') == status], key=lambda kv: -score(kv[1]))
        if not items:
            continue
        out += [f'## {status.capitalize()} ({len(items)})', '']
        for slug, p in items:
            sites = ', '.join(sorted(set(p.get('sites', []))))
            out.append(f'- **{slug}** ({p.get("severity")}, {len(p.get("runs", []))} run(s){": " + sites if sites else ""}): {p["summary"]}')
            if p.get('note'):
                out.append(f'  - {p["note"]}')
        out.append('')
    return '\n'.join(out)


def record(run_folder, problems, site=''):
    """Add a review's problems to the backlog. Returns the slugs it added or reopened."""
    touched = []
    with _lock:
        backlog = load()
        for p in problems:
            slug = re.sub(r'[^a-z0-9-]+', '-', str(p['slug']).lower()).strip('-')[:80]
            if not slug:
                continue
            entry = backlog.get(slug)
            if not entry:
                entry = backlog[slug] = {'summary': p['summary'], 'severity': p.get('severity', 'medium'),
                                         'kind': p.get('kind', 'other'), 'files': p.get('files', []),
                                         'runs': [], 'sites': [], 'status': 'open', 'attempts': 0, 'since': now()}
                touched.append(slug)
            elif entry['status'] == 'fixed':
                # Seen again after a fix: a regression, worth one more attempt.
                entry['status'] = 'reopened'
                entry['attempts'] = min(entry.get('attempts', 0), MAX_ATTEMPTS - 1)
                entry['note'] = f'Seen again in {run_folder.name} after it was fixed.'
                touched.append(slug)
            if SEVERITY.get(p.get('severity'), 0) > SEVERITY.get(entry.get('severity'), 0):
                entry['severity'] = p['severity']
            if run_folder.name not in entry.setdefault('runs', []):
                entry['runs'].append(run_folder.name)
            if site and site not in entry.setdefault('sites', []):
                entry['sites'].append(site)
        save(backlog)
    return touched


def pick(only=None):
    """The open problem to fix next, or None."""
    backlog = load()
    candidates = [(s, p) for s, p in backlog.items()
                  if p.get('status') in ('open', 'reopened') and p.get('attempts', 0) < MAX_ATTEMPTS
                  and (only is None or s == only)]
    if not candidates:
        return None
    return max(candidates, key=lambda kv: (kv[1].get('status') == 'reopened', score(kv[1])))


def update(slug, **fields):
    with _lock:
        backlog = load()
        if slug in backlog:
            backlog[slug].update(fields)
            if fields.get('status') == 'fixed':
                prune(backlog, slug)
            save(backlog)


def prune(backlog, slug):
    """Once a problem is fixed, its old evidence only fills a later session's
    context: the entry keeps what reopening it needs (slug, summary, note), and
    each run folder no unfixed problem still points to is deleted, with the
    fix session's copy of the project. Runs no review has listed are never
    touched, nor the newest run."""
    p = backlog[slug]
    runs = p.pop('runs', [])
    for key in ('sites', 'files'):
        p.pop(key, None)
    still = {r for q in backlog.values() if q.get('status') != 'fixed' for r in q.get('runs', [])}
    latest = RUNS_DIR() / 'latest'
    newest = latest.resolve().name if latest.is_symlink() else ''
    for r in runs:
        folder = RUNS_DIR() / r
        if r not in still and r != newest and folder.is_dir() and folder.parent == RUNS_DIR():
            shutil.rmtree(folder, ignore_errors=True)
    work = p.pop('lastWork', '')
    if work and (ROOT / work / 'repo').is_dir():
        shutil.rmtree(ROOT / work / 'repo', ignore_errors=True)


# --- fixing in a copy ------------------------------------------------------------

FIX_PROMPT = """You are fixing one problem in Applicator, the job-application filler in this directory. This is a
copy of the project made for this fix: edit files here only. Read CLAUDE.md first and follow it; it holds the product
requirements and the lessons learned.

The problem ({slug}, {severity}): {summary}
Likely files: {files}
Runs that showed it, newest first (each holds page.md, report.json, before.html, after.html and review.md):
{runs}

1. Reproduce it first: add a check that fails because of this problem. DOM, timers or events go in a
   tools/test-firefox.py fixture copied from the real markup's shape; pure logic goes in tools/test-orchestrator.py.
   Use fictional values only (Pat Brien, 415-555-0134, Portland, Acme, Globex).
2. Fix the cause in src/, for the whole family of pages that share it, not only this site: the aim is that similar
   problems do not come back. A site-specific rule only when the markup really is unique to one widely used system.
3. Keep fills cheap and fast: no new model calls or requests per fill, and no change to the TypeSafe or DeepSeek
   prompts unless the fault is in them (a changed DeepSeek system prompt makes fills cost more until it is cached).
4. Run ./test.sh until every check passes. Never weaken, skip or delete an existing check to make it pass.
5. Do not edit tools/autofix.py or tools/dev.py, do not commit, do not print API keys.

If you cannot fix it safely, change nothing and say why. End with three short lines: Cause, Fix, Tests."""


def sha(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def tracked_files(base):
    """Files a fix could change, relative to base."""
    out = {}
    for path in base.rglob('*'):
        rel = path.relative_to(base).as_posix()
        if any(part in COPY_SKIP for part in path.relative_to(base).parts) or not path.is_file():
            continue
        if rel.startswith(EDITABLE):
            out[rel] = sha(path)
    return out


def make_copy(dest):
    def ignore(_dir, names):
        return [n for n in names if n in COPY_SKIP]
    shutil.copytree(ROOT, dest, ignore=ignore, symlinks=True)
    (dest / '.dev').mkdir()
    # Shared, read-only for a fix: web-ext for the dev-loop test, the corpus and its answer keys.
    for name in ('tools', 'corpus'):
        if (DEV / name).exists():
            (dest / '.dev' / name).symlink_to(DEV / name)


def keyed_score(scorecard):
    """(right, total) from a corpus scorecard, or None."""
    m = re.search(r'\*\*(\d+) of (\d+) keyed fields right\*\*', scorecard or '')
    return (int(m.group(1)), int(m.group(2))) if m else None


def baseline_score():
    runs = DEV / 'corpus-runs'
    if not runs.exists():
        return None
    for folder in sorted((p for p in runs.iterdir() if p.is_dir() and p.name[0].isdigit()), reverse=True):
        try:
            text = (folder / 'scorecard.md').read_text()
        except OSError:
            continue
        # Only a run of the whole corpus is a fair comparison.
        pages = len([p for p in (DEV / 'corpus').iterdir() if (p / 'entry.json').exists()]) if (DEV / 'corpus').exists() else 0
        if pages and text.count('](') < pages:
            continue
        return keyed_score(text)
    return None


def attempt(slug, claude, say, corpus_check=True, budget_usd=5):
    """Try to fix one backlog problem. Returns 'fixed', 'failed', 'conflict' or 'skipped'."""
    backlog = load()
    p = backlog.get(slug)
    if not p:
        return 'skipped'
    update(slug, attempts=p.get('attempts', 0) + 1, status='fixing', lastAttempt=now())
    stamp = f'{datetime.datetime.now():%Y%m%d-%H%M%S}-{slug[:40]}'
    work = WORK / stamp
    repo = work / 'repo'
    work.mkdir(parents=True, exist_ok=True)
    log = work / 'log.md'

    def finish(status, note):
        update(slug, status=status if status != 'failed' or p.get('attempts', 0) + 1 >= MAX_ATTEMPTS else 'open',
               note=note, lastWork=str(work.relative_to(ROOT)))
        with log.open('a') as f:
            f.write(f'\n## {status}\n\n{note}\n')
        say(f'Fix {slug}: {status}. {note}')
        return status

    say(f'Fixing {slug} in {work.relative_to(ROOT)} ...')
    make_copy(repo)
    before = tracked_files(repo)
    runs = [RUNS_DIR() / r for r in reversed(p.get('runs', []))][:4]
    prompt = FIX_PROMPT.format(slug=slug, severity=p.get('severity'), summary=p['summary'],
                               files=', '.join(p.get('files', [])) or 'unknown',
                               runs='\n'.join(f'- {r}' for r in runs) or '- (none saved)')
    allowed = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(./test.sh)', 'Bash(./test.sh:*)',
               'Bash(python3 tools/test-logic.py:*)', 'Bash(python3 tools/test-orchestrator.py:*)',
               'Bash(python3 tools/test-firefox.py:*)', 'Bash(python3 tools/syntax-check.py:*)',
               'Bash(python3 tools/verify.py:*)',
               # Read-only helpers, so a session can read its own test output (./test.sh | tail).
               'Bash(tail:*)', 'Bash(head:*)', 'Bash(grep:*)', 'Bash(cat:*)', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(sed -n:*)']
    cmd = [claude, '-p', prompt, '--allowedTools', *allowed, '--permission-mode', 'dontAsk',
           '--max-budget-usd', str(budget_usd), '--output-format', 'text']
    for r in runs:
        if r.exists():
            cmd += ['--add-dir', str(r.resolve())]
    try:
        res = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=3600)
        told = (res.stdout or res.stderr).strip()
    except subprocess.TimeoutExpired:
        told = 'The fix session ran for an hour and was stopped.'
    log.write_text(f'# Fix attempt: {slug}\n\n{p["summary"]}\n\n## What the session said\n\n{told}\n')

    after = tracked_files(repo)
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    if any(c.startswith(PROTECTED) for c in changed):
        return finish('failed', f'It changed protected files ({", ".join(c for c in changed if c.startswith(PROTECTED))}).')
    if not changed:
        return finish('failed', 'No change was made. ' + told[-300:])

    # The gate: the checks and the corpus, run here, not taken on the session's word.
    say(f'Fix {slug}: checking {len(changed)} changed file(s) with ./test.sh ...')
    tests = subprocess.run(['./test.sh'], cwd=repo, capture_output=True, text=True, timeout=1800)
    (work / 'test.log').write_text(tests.stdout + tests.stderr)
    if tests.returncode != 0:
        fails = [l for l in (tests.stdout + tests.stderr).splitlines() if 'FAIL' in l][:5]
        return finish('failed', 'The checks failed: ' + ('; '.join(fails) or 'see test.log'))

    if corpus_check and (DEV / 'corpus').exists():
        base = baseline_score()
        say(f'Fix {slug}: checks pass; running the corpus ...')
        run = subprocess.run([sys.executable, 'tools/corpus.py', 'run'], cwd=repo, capture_output=True, text=True, timeout=3600)
        (work / 'corpus.log').write_text(run.stdout + run.stderr)
        latest = sorted((repo / '.dev' / 'corpus-runs').glob('2*/scorecard.md'))
        got = keyed_score(latest[-1].read_text()) if latest else None
        if got and base and (got[1] - got[0]) > (base[1] - base[0]):
            return finish('failed', f'The corpus got worse: {got[0]}/{got[1]} right, against {base[0]}/{base[1]} before.')
        if latest:
            # This run is the new baseline for the next fix.
            shutil.copytree(latest[-1].parent, DEV / 'corpus-runs' / latest[-1].parent.name, dirs_exist_ok=True)

    # Apply, unless someone changed one of these files meanwhile.
    patch = []
    for rel in changed:
        old = (ROOT / rel).read_text().splitlines(keepends=True) if before.get(rel) else []
        new = (repo / rel).read_text().splitlines(keepends=True) if after.get(rel) else []
        patch += difflib.unified_diff(old, new, f'a/{rel}', f'b/{rel}')
    (work / 'fix.patch').write_text(''.join(patch))
    moved = [rel for rel in changed if sha(ROOT / rel) != before.get(rel)]
    if moved:
        return finish('conflict', f'Passed, but {", ".join(moved)} changed in the working tree meanwhile. '
                                  f'The fix is in {(work / "fix.patch").relative_to(ROOT)}.')
    for rel in changed:
        target = ROOT / rel
        if after.get(rel):
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(repo / rel, target)
        elif target.exists():
            target.unlink()
    summary = ' '.join(l.strip() for l in told.splitlines()[-3:] if l.strip())[:400]
    return finish('fixed', f'Applied ({", ".join(changed)}). {summary}')


def RUNS_DIR():
    return DEV / 'runs'


class Worker:
    """Fixes open problems one at a time in the background, up to a cap."""

    def __init__(self, claude, say, max_fixes=5, corpus_check=True, budget_usd=5):
        self.claude, self.say = claude, say
        self.left = max_fixes
        self.corpus_check = corpus_check
        self.budget_usd = budget_usd
        self.wake = threading.Event()
        # An attempt cut short when dev.py last stopped is open again.
        with _lock:
            backlog = load()
            for p in backlog.values():
                if p.get('status') == 'fixing':
                    p['status'] = 'open'
            save(backlog)
        threading.Thread(target=self._run, daemon=True).start()

    def nudge(self):
        self.wake.set()

    def _run(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            while self.left > 0:
                nxt = pick()
                if not nxt:
                    break
                self.left -= 1
                try:
                    attempt(nxt[0], self.claude, self.say, self.corpus_check, self.budget_usd)
                except Exception as err:  # a broken attempt must not stop the dev loop
                    update(nxt[0], status='open', note=f'The attempt crashed: {err}')
                    self.say(f'Fix {nxt[0]} crashed: {err}')
            if self.left <= 0:
                self.say('Reached the fix limit for this session (--max-fixes).')
                return


def main():
    """`dev.py backlog` and `dev.py fix [SLUG]` land here."""
    import argparse
    ap = argparse.ArgumentParser(prog='dev.py')
    ap.add_argument('cmd', choices=['backlog', 'fix'])
    ap.add_argument('slug', nargs='?')
    ap.add_argument('--claude')
    ap.add_argument('--no-corpus', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'backlog':
        print(render(load()))
        return
    sys.path.insert(0, str(ROOT / 'tools'))
    import dev
    claude = dev.find_claude(a.claude)
    if not claude:
        sys.exit('No Claude Code CLI found; pass --claude PATH.')
    nxt = pick(a.slug)
    if not nxt:
        sys.exit('Nothing open to fix.' if not a.slug else f'{a.slug} is not open, or has had its attempts.')
    attempt(nxt[0], claude, dev.say, corpus_check=not a.no_corpus)


if __name__ == '__main__':
    main()
