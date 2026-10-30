#!/usr/bin/env python3
"""A corpus of real application forms, filled headless and scored.

    python3 tools/corpus.py add URL [--name NAME] [--wait SECONDS]
    python3 tools/corpus.py list
    python3 tools/corpus.py run [NAME ...] [--config EXPORT.json]
    python3 tools/corpus.py accept NAME          # answer key from the last run, to review and correct
    python3 tools/corpus.py score [RUN_DIR]      # rescore a run against the current answer keys

Each entry lives in .dev/corpus/<name>/: entry.json (the URL) and, once
written, expected.json, the answer key: what each field should show after a
fill, "" for a field that must stay empty, null for "don't care".

A form behind a sign-in (Workday, SuccessFactors) gets "steps" in entry.json,
run in the page after it opens and before the fill:

    {"js": "CODE or FILE.js", "env": ["pge_username", ...]}   a page script; FILE.js
        is read from the entry's folder; `env` holds the named values from
        .creds.env (never printed); a script that calls resolve() is awaited
    {"until": "EXPRESSION", "timeout": 60}   wait until it is truthy
    {"sleep": SECONDS}

A step that fails or times out fails the page ("could not drive the page").

`run` starts tools/dev.py headless in its own throwaway Firefox profile, opens
each URL, fills it through the development build exactly as a click would,
and saves into .dev/corpus-runs/<time>/<name>/ the run's page.md, report.json,
before/after HTML and a full-page screenshot. scorecard.md in the run folder
sums it up: per page, how many fields were filled, flagged, and right against
the answer key, and every field that was not.

The answer keys hold your own values, so the corpus stays in .dev/, which is
gitignored. The profile the keys are written for is .dev/corpus/profile.json:
copied from --config the first time (without API keys), or, for a new corpus,
your .dev/personal-config.json.
"""
import argparse, base64, datetime, json, os, pathlib, queue, re, shutil, subprocess, sys, threading, time
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from marionette import Marionette  # noqa: E402
import runreport  # noqa: E402

CORPUS = ROOT / '.dev' / 'corpus'
RUNS = ROOT / '.dev' / 'corpus-runs'
HOME = ROOT / '.dev' / 'corpus-home'
SETTINGS = CORPUS / 'settings.json'


def say(message):
    print(f'[{datetime.datetime.now():%H:%M:%S}] {message}', flush=True)


def entries(names=None):
    found = []
    for d in sorted(CORPUS.iterdir()) if CORPUS.exists() else []:
        if (d / 'entry.json').exists() and (not names or d.name in names):
            found.append((d.name, json.loads((d / 'entry.json').read_text()), d))
    return found


def name_for(url):
    u = urlparse(url)
    parts = [p for p in u.path.split('/') if p and not p.isdigit()]
    base = '-'.join([u.hostname.split('.')[-2] if u.hostname.count('.') else u.hostname] + parts[:2])
    digits = re.findall(r'\d{4,}', u.path + u.query)
    return re.sub(r'[^a-z0-9-]+', '-', (base + (('-' + digits[-1][-6:]) if digits else '')).lower()).strip('-')[:60]


def cmd_add(a):
    name = a.name or name_for(a.url)
    d = CORPUS / name
    d.mkdir(parents=True, exist_ok=True)
    entry = {'url': a.url, 'wait': a.wait, 'added': datetime.date.today().isoformat()}
    # A form embedded from another site needs that site granted, which a
    # person does with "Allow access" in the popup.
    if a.grant:
        entry['grant'] = a.grant
    (d / 'entry.json').write_text(json.dumps(entry, indent=1))
    say(f'Added {name}')


def cmd_list(_):
    for name, entry, d in entries():
        key = d / 'expected.json'
        n = len(json.loads(key.read_text()).get('fields', {})) if key.exists() else 0
        print(f"{name:<50} {'key: %d fields' % n if n else 'no answer key':<18} {entry['url']}")


def config_path(given):
    """The profile the answer keys are written for, kept in the project as
    .dev/corpus/profile.json (without API keys)."""
    CORPUS.mkdir(parents=True, exist_ok=True)
    if given:
        export = json.loads(pathlib.Path(given).expanduser().read_text())
        data = export.get('data', export)
        data['settings'] = {k: v for k, v in (data.get('settings') or {}).items() if not re.search(r'Key|Token|Secret', k)}
        if 'data' in export:
            export['containsCredentials'] = False
        kept = CORPUS / 'profile.json'
        kept.write_text(json.dumps(export, indent=1))
        SETTINGS.write_text(json.dumps({'config': str(kept)}))
        return str(kept)
    # The answer keys were written for the profile the corpus was set up
    # with, so that one is kept; a new corpus starts from what the dev build
    # last exported.
    if SETTINGS.exists():
        return json.loads(SETTINGS.read_text())['config']
    personal = ROOT / '.dev' / 'personal-config.json'
    if personal.exists():
        return str(personal)
    sys.exit('Give --config EXPORT.json the first time (an exported Applicator configuration), '
             'or export from the dev build\'s settings page.')


class Dev:
    """tools/dev.py, headless, with WebDriver on for driving the pages."""

    def __init__(self, config, origins):
        env = {**os.environ, 'APPLICATOR_DEV_HOME': str(HOME)}
        # One build for the whole run: an edit made meanwhile must not reload
        # the add-on in the middle of a fill.
        args = [sys.executable, '-u', str(ROOT / 'tools/dev.py'), '--headless', '--automation', '--fresh', '--no-watch',
                '--config', config]
        for origin in origins:
            args += ['--grant', origin]
        # With your own keys, straight to the models: through philform's
        # service every fresh profile makes a new account, and the service
        # allows only a few a day from one address (every gate then scored 0).
        local = ROOT / 'src/common/local-config.js'
        if local.exists() and re.search(r"typesafeApiKey:\s*'[^']+'", local.read_text()):
            args.append('--direct')
        self.proc = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.lines = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(l.rstrip()) for l in self.proc.stdout], daemon=True).start()

    def wait(self, pattern, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                line = self.lines.get(timeout=1)
            except queue.Empty:
                if self.proc.poll() is not None:
                    return None
                continue
            m = re.search(pattern, line)
            if m:
                return m
        return None

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        subprocess.run(['pkill', '-f', str(HOME)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def handles(m):
    h = m.send('WebDriver:GetWindowHandles')
    return h.get('value', h) if isinstance(h, dict) else h


def creds(names):
    """Named values from .creds.env, for a step's `env`; never printed."""
    path = ROOT / '.creds.env'
    found = {}
    for line in (path.read_text().splitlines() if path.exists() else []):
        k, _, v = line.partition('=')
        if k.strip() in names:
            found[k.strip()] = v.strip()
    missing = [n for n in names if n not in found]
    if missing:
        raise RuntimeError(f'.creds.env has no {", ".join(missing)}')
    return found


def run_steps(m, folder, steps):
    """An entry's steps: sign in, step to the form, reset it (see the header)."""
    for i, step in enumerate(steps or []):
        if 'sleep' in step:
            time.sleep(float(step['sleep']))
        elif 'until' in step:
            deadline = time.time() + float(step.get('timeout', 60))
            while True:
                try:
                    if m.send('WebDriver:ExecuteScript', {'script': f'return !!({step["until"]});', 'args': []}).get('value'):
                        break
                except RuntimeError:
                    pass  # the page is between loads
                if time.time() > deadline:
                    raise RuntimeError(f'step {i + 1}: timed out waiting for {step["until"][:80]}')
                time.sleep(1)
        elif 'js' in step:
            code = step['js']
            if re.fullmatch(r'[\w.-]+\.js', code):
                code = (folder / code).read_text()
            env = creds(step.get('env') or [])
            run_async = 'resolve(' in code
            script = ('const resolve = arguments[arguments.length - 1]; ' if run_async else '') + 'const env = arguments[0]; ' + code
            try:
                m.send('WebDriver:ExecuteAsyncScript' if run_async else 'WebDriver:ExecuteScript', {'script': script, 'args': [env]})
            except RuntimeError as err:
                # The message can quote the page's stack, never the arguments.
                raise RuntimeError(f'step {i + 1}: {str(err)[:200]}')


def fill_one(m, dev, uuid, page_handle, entry, folder):
    """Open the page, start a fill as the popup would, wait for its report."""
    m.send('WebDriver:SwitchToWindow', {'handle': page_handle})
    m.send('WebDriver:Navigate', {'url': entry['url']})
    time.sleep(entry.get('wait', 5))
    run_steps(m, folder, entry.get('steps'))
    # Where the page ended up: a board link can redirect to a careers site.
    landed = m.send('WebDriver:GetCurrentURL')['value']
    ext = m.send('WebDriver:NewWindow', {'type': 'tab'})['handle']
    m.send('WebDriver:SwitchToWindow', {'handle': ext})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(1.5)
    u = urlparse(landed or entry['url'])
    m.send('WebDriver:ExecuteScript', {'script': '''
        const [prefix] = arguments;
        chrome.tabs.query({}).then(tabs => {
          const tab = tabs.find(t => (t.url || '').startsWith(prefix));
          if (tab) chrome.runtime.sendMessage({ type: 'run-fill', payload: { tabId: tab.id, url: tab.url } });
        });''', 'args': [f'{u.scheme}://{u.hostname}']})
    # The page in front while it fills, as it is for a person: a tab in the
    # background runs its timers once a second and its animations not at
    # all, so its dropdowns open seconds late.
    m.send('WebDriver:SwitchToWindow', {'handle': page_handle})
    saved = dev.wait(r'Run saved: (\S+)', 300)
    try:
        m.send('WebDriver:SwitchToWindow', {'handle': ext})
        m.send('WebDriver:CloseWindow')
    except RuntimeError:
        pass
    m.send('WebDriver:SwitchToWindow', {'handle': page_handle})
    shot = None
    try:
        shot = m.send('WebDriver:TakeScreenshot', {'full': True, 'hash': False})['value']
    except RuntimeError:
        pass
    return (pathlib.Path(saved.group(1)) if saved else None), shot


def score_folder(folder, name):
    report = json.loads((folder / 'report.json').read_text())
    key = CORPUS / name / 'expected.json'
    expected = json.loads(key.read_text()) if key.exists() else None
    flagged, scored = runreport.write_page(folder, report, expected,
                                          screenshot='screenshot-full.png' if (folder / 'screenshot-full.png').exists() else None)
    rows = runreport.field_rows(report)
    s = report.get('summary') or {}
    return {'name': name, 'url': report.get('url'), 'system': runreport.ats_of(report.get('url')),
            'found': s.get('fieldsFound'), 'filled': s.get('filled'), 'ms': s.get('durationMs'),
            'rounds': s.get('modelCalls'), 'flagged': flagged, 'cents': (s.get('cost') or {}).get('cents'),
            'missed': len(s.get('possiblyMissed') or []),
            'capped': (s.get('cost') or {}).get('capped'), 'error': (report.get('error') or {}).get('message'),
            'scored': scored, 'keyed': expected is not None, 'rows': len(rows)}


def write_scorecard(run_dir, results):
    out = [f'# Corpus run {run_dir.name}', '']
    keyed = [r for r in results if r.get('keyed')]
    if keyed:
        right = sum(sum(1 for x in r['scored'] if x['verdict'] == 'ok') for r in keyed)
        total = sum(len(r['scored']) for r in keyed)
        out.append(f'**{right} of {total} keyed fields right** across {len(keyed)} page(s) with an answer key.')
        out.append('')
    timed = [r for r in results if r.get('ms')]
    if timed:
        cost = [r['cents'] or 0 for r in timed]
        out.append(f"Time: median {sorted(r['ms'] for r in timed)[len(timed) // 2] / 1000:.1f}s, slowest {max(r['ms'] for r in timed) / 1000:.1f}s. "
                   f"Cost: median {sorted(cost)[len(cost) // 2]:.3f}¢, highest {max(cost):.3f}¢, "
                   f"{sum(1 for r in timed if r.get('capped'))} page(s) at the cap.")
        out.append('')
    out += ['| Page | System | Filled | Flagged | Missed? | Score | Time | Rounds | Cost |', '|---|---|---|---|---|---|---|---|---|']
    for r in results:
        if r.get('missing'):
            out.append(f"| {r['name']} | | | | | no report: {r['missing']} | | | |")
            continue
        sc = f"{sum(1 for x in r['scored'] if x['verdict'] == 'ok')}/{len(r['scored'])}" if r['keyed'] else 'no key'
        out.append(f"| [{r['name']}]({r['name']}/page.md) | {r['system']} | {r['filled']}/{r['found']} | {r['flagged']} | {r.get('missed', 0)} | "
                   f"{sc}{' ERROR' if r['error'] else ''} | {(r['ms'] or 0) / 1000:.1f}s | {r['rounds']} | "
                   f"{(r['cents'] or 0):.3f}¢{' CAP' if r.get('capped') else ''} |")
    wrong = [(r['name'], x) for r in results for x in r.get('scored', []) if x['verdict'] != 'ok']
    if wrong:
        out += ['', '## Not as expected', '', '| Page | Field | Verdict | Expected | Page shows |', '|---|---|---|---|---|']
        for name, x in wrong:
            out.append(f"| {name} | {runreport.cell(x['key'], 45)} | {x['verdict']} | {runreport.cell(x['want'], 40)} | {runreport.cell(x['shown'], 40)} |")
    (run_dir / 'scorecard.md').write_text('\n'.join(out) + '\n')


def cmd_run(a):
    config = config_path(a.config)
    if getattr(a, 'structure', 'typesafe') == 'off':
        # The same profile, with the page-structure round switched off.
        data = json.loads(pathlib.Path(config).read_text())
        inner = data.get('data', data)
        inner['settings'] = {**(inner.get('settings') or {}), 'structure': 'off'}
        config = str(RUNS / 'config-structure-off.json')
        RUNS.mkdir(parents=True, exist_ok=True)
        pathlib.Path(config).write_text(json.dumps(data))
    todo = entries(a.names)
    if not todo:
        sys.exit('The corpus is empty. Add pages with: tools/corpus.py add URL')
    run_dir = RUNS / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    run_dir.mkdir(parents=True)
    origins = sorted({f"{urlparse(e['url']).scheme}://{urlparse(e['url']).hostname}" for _, e, _ in todo} |
                     {g for _, e, _ in todo for g in e.get('grant', [])})
    say(f'Filling {len(todo)} page(s) into {run_dir.relative_to(ROOT)}')
    dev = Dev(config, origins)
    results = []
    try:
        ready = dev.wait(r'marionette=(\d+)', 180)
        if not ready:
            sys.exit('tools/dev.py did not start.')
        m = Marionette(int(ready.group(1)))
        m.send('WebDriver:NewSession', {'capabilities': {}})
        m.send('WebDriver:SetTimeouts', {'pageLoad': 60000, 'script': 60000})
        m.send('Marionette:SetContext', {'value': 'chrome'})
        uuid = json.loads(m.send('WebDriver:ExecuteScript', {
            'script': "return Services.prefs.getStringPref('extensions.webextensions.uuids','{}');", 'args': []})['value'])['applicator@local.test']
        m.send('Marionette:SetContext', {'value': 'content'})
        page_handle = handles(m)[0]
        for name, entry, entry_dir in todo:
            say(f'{name}: {entry["url"]}')
            try:
                folder, shot = fill_one(m, dev, uuid, page_handle, entry, entry_dir)
            except RuntimeError as err:
                folder, shot = None, None
                say(f'  could not drive the page: {err}')
            if not folder:
                results.append({'name': name, 'missing': 'the fill did not report'})
                continue
            dest = run_dir / name
            shutil.copytree(folder, dest)
            if shot:
                (dest / 'screenshot-full.png').write_bytes(base64.b64decode(shot))
            r = score_folder(dest, name)
            results.append(r)
            sc = f", {sum(1 for x in r['scored'] if x['verdict'] == 'ok')}/{len(r['scored'])} right" if r['keyed'] else ''
            say(f"  {r['filled']}/{r['found']} filled, {r['flagged']} flagged{sc}, {(r['ms'] or 0) / 1000:.1f}s, {(r['cents'] or 0):.3f}¢")
    finally:
        dev.stop()
        write_scorecard(run_dir, results)
        latest = RUNS / 'latest'
        if latest.is_symlink() or latest.exists():
            latest.unlink()
        latest.symlink_to(run_dir.name)
    say(f'Scorecard: {(run_dir / "scorecard.md").relative_to(ROOT)}')


def cmd_score(a):
    run_dir = pathlib.Path(a.run).resolve() if a.run else (RUNS / 'latest').resolve()
    results = [score_folder(d, d.name) for d in sorted(run_dir.iterdir()) if (d / 'report.json').exists()]
    write_scorecard(run_dir, results)
    print((run_dir / 'scorecard.md').read_text())


def cmd_accept(a):
    """Write an answer key from what the last run's page shows, for review:
    every field gets its current value, so correcting the key means fixing
    only the fields that are wrong."""
    run_dir = (RUNS / 'latest').resolve() if not a.run else pathlib.Path(a.run).resolve()
    folder = run_dir / a.name
    report = json.loads((folder / 'report.json').read_text())
    rows = runreport.field_rows(report)
    key = CORPUS / a.name / 'expected.json'
    prior = json.loads(key.read_text()) if key.exists() else {'fields': {}}
    fields = {r['key']: (prior['fields'].get(r['key'], r['shown'] or '')) for r in rows}
    key.write_text(json.dumps({'fields': fields, 'from': str(folder.relative_to(ROOT))}, indent=1, ensure_ascii=False))
    say(f'Wrote {key.relative_to(ROOT)} with {len(fields)} fields. Correct any that are wrong.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('add'); p.add_argument('url'); p.add_argument('--name'); p.add_argument('--wait', type=float, default=5)
    p.add_argument('--grant', action='append', default=[], help='an embedded form origin to allow')
    p.set_defaults(fn=cmd_add)
    sub.add_parser('list').set_defaults(fn=cmd_list)
    p = sub.add_parser('run'); p.add_argument('names', nargs='*'); p.add_argument('--config')
    p.add_argument('--structure', choices=['typesafe', 'off'], default='typesafe',
                   help="who reads each field's question: TypeSafe (default) or the extractor's rules alone")
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser('accept'); p.add_argument('name'); p.add_argument('--run'); p.set_defaults(fn=cmd_accept)
    p = sub.add_parser('score'); p.add_argument('run', nargs='?'); p.set_defaults(fn=cmd_score)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
