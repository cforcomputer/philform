#!/usr/bin/env python3
"""The development loop: a Firefox that always runs the current source, and a
folder of every fill to look back at.

    python3 tools/dev.py                               # your answers from .dev/personal-config.json
    python3 tools/dev.py --config FILE                 # another exported configuration
    python3 tools/dev.py --config ... --review       # Claude Code reviews each fill
    python3 tools/dev.py --improve                    # ... and fixes what the reviews find
    python3 tools/dev.py review [RUN]                 # review a saved run (default: latest)
    python3 tools/dev.py backlog                      # problems found so far, and what became of them
    python3 tools/dev.py fix [SLUG]                   # fix one backlog problem now

What it does:

  - Opens Firefox with its own profile in .dev/firefox-profile, so sign-ins
    and the extension's data survive between sessions.
  - Builds the extension into .dev/build and installs it as a temporary
    add-on. Every time a file in src/, icons/ or a manifest changes, it checks
    the source parses, rebuilds and reloads the add-on in place.
  - Runs a small server on 127.0.0.1. The dev build (and only the dev build)
    sends it a report after every fill, from the popup or from the keyboard
    shortcut Alt+Shift+F. Each lands in .dev/runs/<time>-<site>/:

      page.md           everything needed to judge the fill: every field with its
                        options, TypeSafe's choice and runners-up, the decision
                        and why, what the page shows, and the markup around
                        anything that looks wrong
      report.json       the whole trace: extraction per pass, every TypeSafe
                        question and answer, decisions, fill results
      before.html       the page before anything was touched
      after.html        the page after the fill
      screenshot.png    the visible part of the tab after the fill
      review.md         with --review: Claude Code's review of the run

    .dev/runs/latest always points at the newest.

  - With --review, each review also lists its problems for the backlog
    (.dev/backlog.md). With --improve, the most pressing ones are then fixed
    in a copy of the project, checked with ./test.sh and the corpus, and only
    then copied into the working tree, which rebuilds the add-on. See
    tools/autofix.py; it never commits.

Firefox is run and the add-on reloaded by Mozilla's web-ext, installed into
.dev/tools the first time (it needs Node: brew install node). It reloads over
Firefox's debugging protocol, not WebDriver, which would mark the browser as
automated (navigator.webdriver) for bot checks on job sites to react to.

Export on the dev build's settings page saves your configuration to
.dev/personal-config.json instead of downloading it (without API keys), and
dev.py, corpus.py and try-form.py use that file when no --config is given.

Everything in .dev/ is gitignored. Reports contain your profile values, so
they stay on this machine.
"""
import argparse, base64, datetime, hashlib, http.server, json, os, pathlib, re, shutil, signal, socket
import subprocess, sys, threading, time
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import runreport  # noqa: E402
import autofix  # noqa: E402


def use_home(home):
    """Where the profile, build and runs live: .dev/ unless a test says otherwise."""
    global DEV, BUILD, RUNS, PROFILE, STAMP, TOOLS, PERSONAL
    DEV = pathlib.Path(home).resolve()
    # Your own answers, as the dev build last exported them (gitignored).
    # Every dev tool loads it when no --config is given.
    PERSONAL = DEV / 'personal-config.json'
    BUILD = DEV / 'build'
    RUNS = DEV / 'runs'
    PROFILE = DEV / 'firefox-profile'
    # web-ext reloads the add-on when this changes, which happens only after a
    # build that parsed and completed.
    STAMP = DEV / 'reload-stamp'
    # Shared by every dev home, so tests do not reinstall it.
    TOOLS = ROOT / '.dev' / 'tools'


use_home(os.environ.get('APPLICATOR_DEV_HOME') or ROOT / '.dev')
FIREFOX = pathlib.Path('/Applications/Firefox.app/Contents/MacOS/firefox')
WATCHED = ['src', 'icons', 'manifest.firefox.json', 'build.sh']


def say(message):
    print(f'[{datetime.datetime.now():%H:%M:%S}] {message}', flush=True)


def shown(path):
    """A path relative to the project when it is inside it."""
    try:
        return pathlib.Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


# --- web-ext -------------------------------------------------------------------

def web_ext():
    """The web-ext binary, installed into the dev home on first use."""
    binary = TOOLS / 'node_modules/.bin/web-ext'
    if binary.exists():
        return binary
    if not shutil.which('npm'):
        sys.exit('web-ext needs Node. Install it with: brew install node')
    say('Installing web-ext into the dev folder (once) ...')
    TOOLS.mkdir(parents=True, exist_ok=True)
    subprocess.run(['npm', 'install', '--prefix', str(TOOLS), '--no-fund', '--no-audit', 'web-ext'],
                   check=True, stdout=subprocess.DEVNULL)
    return binary


# --- building ----------------------------------------------------------------

class Builder:
    def __init__(self, report_url, seed, grants, mode='proxy'):
        self.report_url = report_url
        self.seed = seed
        self.grants = grants
        self.mode = mode
        self.number = 0

    def build(self):
        """Check, build and stage the dev package. Returns an error, or None."""
        check = subprocess.run([sys.executable, str(ROOT / 'tools/syntax-check.py')], capture_output=True, text=True)
        if check.returncode != 0:
            return 'the source does not parse:\n' + '\n'.join(
                l for l in (check.stdout + check.stderr).splitlines() if 'FAIL' in l or 'rror' in l)[:2000]
        # Its own output folder: another dev.py, or a test, may be building too.
        res = subprocess.run([str(ROOT / 'build.sh'), 'firefox'], cwd=ROOT, capture_output=True, text=True,
                             env={**os.environ, 'DIST': str(DEV / 'dist')})
        if res.returncode != 0:
            return 'build.sh failed:\n' + (res.stdout + res.stderr)[-2000:]

        self.number += 1
        staged = DEV / 'build-next'
        shutil.rmtree(staged, ignore_errors=True)
        shutil.copytree(DEV / 'dist' / 'firefox', staged)

        manifest = json.loads((staged / 'manifest.json').read_text())
        # A shortcut for the fill, so testing is one key press away.
        manifest['commands'] = {'fill-page': {
            'suggested_key': {'default': 'Alt+Shift+F'},
            'description': 'Fill the form on this page (development build)'}}
        # Through Philform's service the build reaches no model API itself,
        # exactly like a store build, which has no host permissions at all.
        hosts = manifest.get('host_permissions', []) if self.mode == 'direct' else []
        manifest['host_permissions'] = hosts + [f'{o.rstrip("/")}/*' for o in self.grants]
        manifest['name'] = manifest['name'] + ' (dev)'
        # Firefox keeps the toolbar icon of a reloaded add-on by path, so a
        # redrawn icon would never show. Name each file after its content.
        renamed = {}
        for icon in sorted((staged / 'icons').glob('*.png')):
            digest = hashlib.sha1(icon.read_bytes()).hexdigest()[:8]
            icon.rename(icon.with_name(f'{icon.stem}.{digest}.png'))
            renamed[f'icons/{icon.name}'] = f'icons/{icon.stem}.{digest}.png'
        for sizes in (manifest.get('icons', {}), manifest.get('action', {}).get('default_icon', {})):
            for size, path in sizes.items():
                sizes[size] = renamed.get(path, path)
        (staged / 'manifest.json').write_text(json.dumps(manifest, indent=2))

        config = {
            'reportUrl': self.report_url,
            'build': {'number': self.number, 'at': datetime.datetime.now().isoformat(timespec='seconds')},
            'mode': self.mode,
            'seed': self.seed
        }
        (staged / 'src/common/dev-config.js').write_text(
            '// Written by tools/dev.py into its own build only. Never commit or ship this.\n'
            f'export const DEV_CONFIG = {json.dumps(config)};\n')

        # Swap in one move, so Firefox never reads a half-copied build.
        shutil.rmtree(BUILD, ignore_errors=True)
        staged.rename(BUILD)
        return None


# --- saving runs -------------------------------------------------------------

def save_run(report):
    site = re.sub(r'[^\w.-]+', '_', urlparse(report.get('url', '')).hostname or 'page')
    folder = RUNS / f'{datetime.datetime.now():%Y%m%d-%H%M%S}-{site}'
    folder.mkdir(parents=True, exist_ok=True)

    shot = report.pop('screenshot', None)
    if shot and shot.startswith('data:image/png;base64,'):
        (folder / 'screenshot.png').write_bytes(base64.b64decode(shot.split(',', 1)[1]))
    for name, frames in (('after', report.pop('after', None) or []),
                         ('before', next((e.pop('frames', []) for e in (report.get('trace') or {}).get('events', [])
                                          if e['kind'] == 'page-before'), []))):
        for f in frames:
            if 'html' not in f:
                continue
            suffix = '' if f.get('frameId', 0) == 0 else f"-frame{f['frameId']}"
            (folder / f'{name}{suffix}.html').write_text(f['html'])
    (folder / 'report.json').write_text(json.dumps(report, indent=1))
    flagged, _ = runreport.write_page(folder, report,
                                      screenshot='screenshot.png' if (folder / 'screenshot.png').exists() else None)

    latest = RUNS / 'latest'
    if latest.is_symlink() or latest.exists():
        latest.unlink()
    latest.symlink_to(folder.name)
    return folder, flagged


# --- reviews -----------------------------------------------------------------

REVIEW_PROMPT = """You are reviewing one run of Applicator, the browser extension in this repository that fills job application forms.

The run is saved in {folder}. Start with page.md, then use report.json (the full trace: every field extracted per pass, every TypeSafe question with its answer and confidence, every decision and fill result, and a read-back of what each field shows afterwards), and before.html / after.html when you need to see the page's markup.

Work out:
1. Fields filled wrongly: the page shows a value that does not answer the question, or not the user's value.
2. Fields that should have been filled from the profile but were left empty, and why (extraction, decision, or the write).
3. Fields reported as filled that the page did not keep.
4. For each problem, the likely cause in the source under src/ (cite file:line) and a concrete fix.
5. How to make the system better, not only this page. The page-structure round (page.md "Page structure (TypeSafe)", src/background/structure.js) reads each field's question from the page's lines: where it picked a wrong line, kept a wrong label, set aside a real question or missed one, say what general change would fix the whole family (its instructions, the candidate lines offered, how content/extract.js structureOf reads the page). Also note anything that would make fills on never-seen forms more complete or more correct at no extra cost per fill. Users judge the product by every field being filled correctly with their own answers.

Be specific and brief. Rank problems by how much they matter to someone submitting this application. If the run looks right, say so in one line. Do not edit any file; your answer is saved as review.md."""


def find_claude(explicit=None):
    if explicit:
        return explicit
    on_path = shutil.which('claude')
    if on_path:
        return on_path
    local = pathlib.Path.home() / '.claude/local/claude'
    if local.exists():
        return str(local)
    bundled = sorted(pathlib.Path.home().glob('.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude'),
                     key=lambda p: [int(x) if x.isdigit() else x for x in re.split(r'(\d+)', p.parts[-4])])
    return str(bundled[-1]) if bundled else None


def review(folder, claude=None):
    """Ask a headless Claude Code session, with read-only tools, to review a run.
    Its problems go into the backlog (tools/autofix.py)."""
    binary = find_claude(claude)
    if not binary:
        say('No Claude Code CLI found; pass --claude PATH to review runs.')
        return None
    prompt = REVIEW_PROMPT.format(folder=shown(folder)) + autofix.review_instructions()
    res = subprocess.run(
        [binary, '-p', prompt, '--allowedTools', 'Read', 'Grep', 'Glob',
         '--add-dir', str(folder.resolve()), '--output-format', 'text'],
        cwd=ROOT, capture_output=True, text=True, timeout=900)
    text = res.stdout.strip() or res.stderr.strip()
    (folder / 'review.md').write_text(text + '\n')
    # A review that did not run (a usage limit, a crash) adds nothing.
    if res.returncode == 0:
        try:
            site = urlparse(json.loads((folder / 'report.json').read_text()).get('url', '')).hostname or ''
        except (OSError, ValueError):
            site = ''
        added = autofix.record(folder, autofix.parse_problems(text), site)
        if added:
            say(f'Backlog: {", ".join(added)}')
    return folder / 'review.md'


# --- the report server ---------------------------------------------------------

def save_issue(report):
    """A page the user flagged from the popup: the run, the page now, the note."""
    site = re.sub(r'[^\w.-]+', '_', urlparse(report.get('url', '')).hostname or 'page')
    folder = DEV / 'issues' / f'{datetime.datetime.now():%Y%m%d-%H%M%S}-{site}'
    folder.mkdir(parents=True, exist_ok=True)
    for f in report.pop('after', None) or []:
        if 'html' in f:
            suffix = '' if f.get('frameId', 0) == 0 else f"-frame{f['frameId']}"
            (folder / f'after{suffix}.html').write_text(f['html'])
    (folder / 'report.json').write_text(json.dumps(report, indent=1))
    (folder / 'note.md').write_text(f"# Reported {report.get('reportedAt', '')}\n\n{report.get('url', '')}\n\n"
                                    f"{report.get('note') or '(no note)'}\n")
    runreport.write_page(folder, report)
    return folder


def save_config(export):
    """An export from the dev build's settings page, kept as the project's
    personal configuration. API keys are dropped: they live in
    src/common/local-config.js, and this file need not be guarded like one."""
    data = export.get('data', export)
    settings = data.get('settings') or {}
    data['settings'] = {k: v for k, v in settings.items() if not re.search(r'Key|Token|Secret', k)}
    if isinstance(export.get('data'), dict):
        export['containsCredentials'] = False
    tmp = PERSONAL.with_suffix('.tmp')
    tmp.write_text(json.dumps(export, indent=1))
    tmp.replace(PERSONAL)
    return PERSONAL


def serve(on_report, on_issue=None, on_config=None):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _cors(self):
            self.send_header('access-control-allow-origin', '*')
            self.send_header('access-control-allow-headers', 'content-type')

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('content-length') or 0))
            try:
                report = json.loads(body)
            except ValueError:
                report = None
            # A saved configuration is answered once it is on disk, so the
            # settings page can say it was saved, or fall back to a download.
            if self.path.endswith('/config'):
                ok = False
                if isinstance(report, dict) and on_config:
                    try:
                        on_config(report)
                        ok = True
                    except OSError:
                        pass
                self.send_response(204 if ok else 500)
                self._cors()
                self.end_headers()
                return
            self.send_response(204)
            self._cors()
            self.end_headers()
            if report is None:
                return
            handler = on_issue if self.path.endswith('/issue') and on_issue else on_report
            threading.Thread(target=handler, args=(report,), daemon=True).start()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True  # an open connection must not hold dev.py at exit
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --- main ----------------------------------------------------------------------

def snapshot():
    """Modification times of everything that goes into a build."""
    stamps = {}
    for name in WATCHED:
        path = ROOT / name
        files = [path] if path.is_file() else [p for p in path.rglob('*') if p.is_file()]
        for p in files:
            if p.name == '.DS_Store' or p.name.endswith('~'):
                continue
            try:
                stamps[str(p)] = p.stat().st_mtime_ns
            except FileNotFoundError:
                pass
    return stamps


def load_seed(path):
    if not path:
        return None
    data = json.loads(pathlib.Path(path).expanduser().read_text())
    data = data.get('data', data)
    settings = {k: v for k, v in (data.get('settings') or {}).items() if not re.search(r'Key|Token', k)}
    return {'profile': data.get('profile') or None, 'settings': settings or None}


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ('backlog', 'fix'):
        autofix.main()
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'review':
        ap = argparse.ArgumentParser(prog='dev.py review')
        ap.add_argument('cmd')
        ap.add_argument('run', nargs='?', default='latest')
        ap.add_argument('--claude')
        a = ap.parse_args()
        folder = (RUNS / a.run) if not pathlib.Path(a.run).is_dir() else pathlib.Path(a.run)
        folder = folder.resolve()
        say(f'Reviewing {folder.name} ...')
        out = review(folder, a.claude)
        if out:
            print(out.read_text())
        return

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', help='an exported Applicator configuration, loaded into an empty profile '
                    '(default: .dev/personal-config.json, which the dev build\'s Export updates)')
    ap.add_argument('--review', action='store_true', help='have Claude Code review every fill')
    ap.add_argument('--improve', action='store_true',
                    help='review every fill and fix what the reviews find (development builds only; see tools/autofix.py)')
    ap.add_argument('--max-fixes', type=int, default=5, help='with --improve: fixes to attempt this session (default 5)')
    ap.add_argument('--fix-budget', type=float, default=5, help='with --improve: dollar cap per fix session (default 5)')
    ap.add_argument('--no-corpus-check', action='store_true', help='with --improve: skip the corpus run that gates each fix')
    ap.add_argument('--claude', help='path to the claude CLI (found automatically otherwise)')
    ap.add_argument('--url', default='', help='a page to open on start')
    ap.add_argument('--fresh', action='store_true', help='start from a new Firefox profile')
    ap.add_argument('--direct', action='store_true',
                    help='call the model APIs with your own keys (local-config.js) instead of Philform\'s service')
    ap.add_argument('--grant', action='append', default=[], help='an origin the dev build may always reach (for tests)')
    ap.add_argument('--headless', action='store_true', help='no window (for tests)')
    ap.add_argument('--automation', action='store_true', help='also enable WebDriver, for tools/test-dev.py only')
    ap.add_argument('--no-watch', action='store_true', help='keep the first build: no rebuild on save (corpus runs)')
    a = ap.parse_args()

    if not FIREFOX.exists():
        sys.exit('Firefox is not installed at /Applications/Firefox.app.')
    if a.fresh:
        shutil.rmtree(PROFILE, ignore_errors=True)
    for d in (DEV, RUNS):
        d.mkdir(parents=True, exist_ok=True)

    reviewing = threading.Semaphore(1)
    if a.improve:
        a.review = True
    fixer = None
    if a.improve:
        claude = find_claude(a.claude)
        if not claude:
            sys.exit('--improve needs the Claude Code CLI; pass --claude PATH.')
        fixer = autofix.Worker(claude, say, max_fixes=a.max_fixes, corpus_check=not a.no_corpus_check,
                               budget_usd=a.fix_budget)
        say(f'Improving: reviews feed .dev/backlog.md, and up to {a.max_fixes} fix(es) are tried this session.')
        fixer.nudge()  # problems already in the backlog come first

    def on_report(report):
        folder, flagged = save_run(report)
        s = report.get('summary') or {}
        outcome = f"failed: {report['error']['message']}" if report.get('error') else \
            f"{s.get('filled')} of {s.get('fieldsFound')} filled in {s.get('durationMs')} ms, {flagged} flagged"
        say(f'Run saved: {shown(folder)}  ({outcome})')
        if a.review:
            with reviewing:
                say(f'Reviewing {folder.name} with Claude Code ...')
                out = review(folder, a.claude)
                if out:
                    say(f'Review written: {shown(out)}')
            if fixer:
                fixer.nudge()

    def on_issue(report):
        folder = save_issue(report)
        say(f"Issue reported: {shown(folder)}  ({(report.get('note') or 'no note')[:80]})")
        if a.review:
            with reviewing:
                out = review(folder, a.claude)
                if out:
                    say(f'Review written: {shown(out)}')

    def on_config(export):
        path = save_config(export)
        say(f'Personal configuration saved: {shown(path)}')

    server = serve(on_report, on_issue, on_config)
    report_url = f'http://127.0.0.1:{server.server_address[1]}/report'
    if not a.config and PERSONAL.exists():
        a.config = str(PERSONAL)
        say(f'Profile from {shown(PERSONAL)}')
    builder = Builder(report_url, load_seed(a.config), a.grant, 'direct' if a.direct else 'proxy')
    say('Models through your own keys (--direct)' if a.direct else 'Models through Philform\'s service, like a store build (--direct for your own keys)')
    error = builder.build()
    if error:
        sys.exit(f'Could not build: {error}')

    STAMP.write_text(str(builder.number))
    marionette_port = free_port() if a.automation else None
    # Started through LaunchServices: a Firefox started as a child of an editor
    # or terminal inherits that app's privacy permissions, cannot read its own
    # data folder in ~/Library, and shows a "Profile Missing" dialog.
    launcher = DEV / 'firefox-launch.sh'
    launcher.write_text('#!/bin/sh\n'
                        '# Written by tools/dev.py: run Firefox as itself, with its own permissions.\n'
                        f'exec /usr/bin/open -n -W -a "{FIREFOX.parents[2]}" --args "$@"\n')
    launcher.chmod(0o755)
    args = [str(web_ext()), 'run', '--source-dir', str(BUILD), '--firefox', str(launcher),
            '--firefox-profile', str(PROFILE), '--profile-create-if-missing', '--keep-profile-changes',
            '--watch-file', str(STAMP), '--no-input',
            '--pref', 'browser.shell.checkDefaultBrowser=false',
            '--pref', 'datareporting.policy.dataSubmissionEnabled=false',
            '--pref', 'browser.aboutwelcome.enabled=false']
    if a.url:
        args += ['--start-url', a.url]
    if os.environ.get('APPLICATOR_DEV_VERBOSE'):
        args.append('--verbose')
    if a.headless:
        args.append('--arg=--headless')
    if a.automation:
        args += ['--arg=--marionette', '--arg=-remote-allow-system-access', '--pref', f'marionette.port={marionette_port}']
    # web-ext looks in HOME for Firefox's list of profiles, only to warn about
    # using the default one, and the same privacy protection refuses that read.
    # A private HOME for web-ext alone skips it. Firefox, started through
    # LaunchServices, keeps the real one.
    (DEV / 'home').mkdir(parents=True, exist_ok=True)
    # Firefox 159 grants Marionette system access only through this variable.
    env = {**os.environ, 'HOME': str(DEV / 'home'), 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'}
    runner = subprocess.Popen(args, cwd=DEV, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              start_new_session=True)

    ready = threading.Event()

    def lines_of(stream):
        """web-ext ends its reload notice with a carriage return and no newline,
        so output is split on either as soon as it arrives."""
        pending = ''
        while True:
            chunk = os.read(stream.fileno(), 4096)
            if not chunk:
                break
            pending += chunk.decode('utf-8', 'replace')
            parts = re.split(r'[\r\n]', pending)
            pending = parts.pop()
            yield from parts
            if 'last extension reload' in pending.lower():
                yield pending
                pending = ''
        if pending:
            yield pending

    def follow():
        """Turn web-ext's output into this loop's own messages."""
        for line in lines_of(runner.stdout):
            line = line.rstrip()
            if not line:
                continue
            if os.environ.get('APPLICATOR_DEV_VERBOSE'):
                say(f'web-ext| {line}')
            if 'temporary add-on' in line.lower() and not ready.is_set():
                ready.set()
                say(f'Ready. Build {builder.number} installed. Reports go to {shown(RUNS)}/. '
                    f'Fill a page from the popup or with Alt+Shift+F.' + (f' marionette={marionette_port}' if marionette_port else ''))
            elif 'last extension reload' in line.lower():
                say(f'Reloaded build {builder.number}')
            elif re.search(r'error|failed', line, re.I) and 'console' not in line.lower():
                say(f'web-ext: {line}')

    threading.Thread(target=follow, daemon=True).start()

    def stop(*_):
        say('Closing Firefox.')
        try:
            os.killpg(os.getpgid(runner.pid), signal.SIGTERM)
        except Exception:
            pass
        subprocess.run(['pkill', '-f', str(PROFILE)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    stamps = snapshot()
    while True:
        time.sleep(0.4)
        if runner.poll() is not None:
            say('Firefox closed.')
            break
        if a.no_watch or snapshot() == stamps:
            continue
        # Let an editor finish writing a burst of files.
        time.sleep(0.3)
        before, stamps = stamps, snapshot()
        changed = sorted(pathlib.Path(p).relative_to(ROOT).as_posix()
                         for p in set(before) | set(stamps) if before.get(p) != stamps.get(p))
        error = builder.build()
        if error:
            say(f'Not reloaded, {error}')
            continue
        say(f"Built {builder.number}" + (f" ({', '.join(changed[:3])}{'...' if len(changed) > 3 else ''})" if changed else ''))
        STAMP.write_text(str(builder.number))


if __name__ == '__main__':
    main()
