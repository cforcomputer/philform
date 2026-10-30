#!/usr/bin/env python3
"""Check the development loop end to end: tools/dev.py builds and installs the
dev build, a fill sends a report that is saved as a run, and saving a source
file reloads the add-on without losing the profile.

    python3 tools/test-dev.py

Runs dev.py headless in a throwaway home, never in your .dev/ folder, against
a local fixture page. No model is reached: the seeded TypeSafe key is a dummy,
so the local rules do the filling.
"""
import functools, http.server, json, os, pathlib, queue, re, shutil, socket, subprocess, sys, tempfile, threading, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from marionette import Marionette  # noqa: E402

if not pathlib.Path('/Applications/Firefox.app/Contents/MacOS/firefox').exists():
    print('Firefox is not installed; skipping the dev loop test.')
    sys.exit(0)

failures = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else f': {detail}'))
    if not ok:
        failures.append(name)


home = pathlib.Path(tempfile.mkdtemp(prefix='applicator-devtest-'))
site = home / 'site'
site.mkdir()
(site / 'apply.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<h1>Apply</h1><h2>Your details</h2>
<label for="fn">First name</label><input id="fn" autocomplete="given-name">
<label for="em">Email</label><input id="em" name="email" type="email">
<label for="ct">City</label><input id="ct" name="city">
<h2>References</h2>
<label for="rn">Name</label><input id="rn" name="ref_name">
<label for="rp">Phone</label><input id="rp" name="ref_phone">
</body>''')


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(site)))
# A connection Firefox leaves open must not keep this script from exiting.
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
page = f'http://127.0.0.1:{server.server_address[1]}/apply.html'

config = home / 'config.json'
config.write_text(json.dumps({'data': {
    'profile': {'identity.firstName': 'Pat', 'contact.email': 'pat@example.com', 'address.city': 'Oakland',
                'references': [{'fullName': 'Alice Ng', 'phone': '4155550101'}]},
    'settings': {'typesafeApiKey': 'offline-test', 'longTextMode': 'skip'}}}))

env = {**os.environ, 'APPLICATOR_DEV_HOME': str(home / 'dev')}
dev = subprocess.Popen([sys.executable, '-u', str(ROOT / 'tools/dev.py'), '--headless', '--automation', '--fresh', '--direct',
                        '--config', str(config), '--grant', 'http://127.0.0.1'],
                       cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lines = queue.Queue()
log = []


def pump():
    for line in dev.stdout:
        log.append(line.rstrip())
        lines.put(line.rstrip())


threading.Thread(target=pump, daemon=True).start()


def wait_for(pattern, seconds=90):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            line = lines.get(timeout=max(0.1, deadline - time.time()))
        except queue.Empty:
            break
        m = re.search(pattern, line)
        if m:
            return m
    return None


def fill(m, uuid, home_handle):
    """Start a fill the way the popup does, from an extension page in a tab of
    its own: reloading the add-on closes its pages, so none is kept open."""
    m.send('WebDriver:SwitchToWindow', {'handle': home_handle})
    ext = m.send('WebDriver:NewWindow', {'type': 'tab'})['handle']
    m.send('WebDriver:SwitchToWindow', {'handle': ext})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(1.5)
    m.send('WebDriver:ExecuteScript', {'script': '''
        // Match patterns cannot name a port, so the tab is found by its URL.
        // A background that has just been reloaded may still be starting, and
        // refuses a message until it is; the popup retries the same way.
        const [url] = arguments;
        (async () => {
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
              const tab = tabs.find(t => t.url === url);
              if (tab) { await chrome.runtime.sendMessage({ type: 'run-fill', payload: { tabId: tab.id, url: tab.url } }); return; }
            } catch (e) { /* not ready yet */ }
            await new Promise(r => setTimeout(r, 250));
          }
        })();''',
        'args': [page]})
    return ext


def close(m, handle, home_handle):
    try:
        m.send('WebDriver:SwitchToWindow', {'handle': handle})
        m.send('WebDriver:CloseWindow')
    except RuntimeError:
        pass  # already closed by a reload
    m.send('WebDriver:SwitchToWindow', {'handle': home_handle})


try:
    ready = wait_for(r'Ready\. Build (\d+) installed.*marionette=(\d+)')
    check('dev.py builds, starts Firefox and installs the dev build', bool(ready), '\n'.join(log[-15:]))
    if not ready:
        raise SystemExit(1)

    m = Marionette(int(ready.group(2)))
    m.send('WebDriver:NewSession', {'capabilities': {}})
    m.send('Marionette:SetContext', {'value': 'chrome'})
    uuid = json.loads(m.send('WebDriver:ExecuteScript', {
        'script': "return Services.prefs.getStringPref('extensions.webextensions.uuids','{}');", 'args': []})['value']).get('applicator@local.test')
    m.send('Marionette:SetContext', {'value': 'content'})
    check('the dev build is installed under the usual id', bool(uuid))

    handles = m.send('WebDriver:GetWindowHandles')
    handles = handles.get('value', handles) if isinstance(handles, dict) else handles
    home_handle = handles[0]
    m.send('WebDriver:SwitchToWindow', {'handle': home_handle})
    m.send('WebDriver:Navigate', {'url': page})
    time.sleep(1)

    # --- a fill is reported and saved ------------------------------------
    ext = fill(m, uuid, home_handle)
    saved = wait_for(r'Run saved: (\S+)\s+\((.*)\)', 60)
    close(m, ext, home_handle)
    check('a fill is reported to the dev server and saved', bool(saved), '\n'.join(log[-10:]))
    if saved:
        folder = pathlib.Path(saved.group(1))
        folder = folder if folder.is_absolute() else ROOT / folder
        names = {p.name for p in folder.iterdir()}
        check('the run folder holds the summary, the trace and both page snapshots',
              {'page.md', 'report.json', 'before.html', 'after.html'} <= names, sorted(names))
        report = json.loads((folder / 'report.json').read_text())
        kinds = [e['kind'] for e in report['trace']['events']]
        check('the trace has the extraction, decisions and fill results',
              {'extraction', 'decided', 'filled'} <= set(kinds), kinds)
        check('the report says which build made it', (report.get('build') or {}).get('number') == 1, report.get('build'))
        charge = (report.get('summary') or {}).get('wallet') or {}
        check('the dev build has a test wallet: the first fill is a free application, 9 left',
              charge.get('free') is True and charge.get('freeLeft') == 9 and charge.get('balanceCents') == 500, charge)
        summary = (folder / 'page.md').read_text()
        check('page.md lists the fields and what the page shows',
              'First name' in summary and 'Pat' in summary and 'Alice Ng' in summary, summary[:600])
        check('the page before the fill was empty, the page after is not',
              'value="Pat"' not in (folder / 'before.html').read_text())
        check('latest points at the newest run', (folder.parent / 'latest').resolve() == folder.resolve())

    # --- Export in the dev build saves to the project ---------------------
    m.send('WebDriver:SwitchToWindow', {'handle': home_handle})
    opts = m.send('WebDriver:NewWindow', {'type': 'tab'})['handle']
    m.send('WebDriver:SwitchToWindow', {'handle': opts})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(2)
    label = m.send('WebDriver:ExecuteScript', {'script': "return document.getElementById('export').textContent;", 'args': []})['value']
    m.send('WebDriver:ExecuteScript', {'script': "document.getElementById('export').click();", 'args': []})
    exported = wait_for(r'Personal configuration saved: (\S+)', 20)
    said = m.send('WebDriver:ExecuteScript', {'script': "return document.getElementById('import-result').textContent;", 'args': []})['value']
    close(m, opts, home_handle)
    personal = home / 'dev' / 'personal-config.json'
    text = personal.read_text() if personal.exists() else ''
    check('the dev build offers to save to the project', 'Save to project' in (label or ''), label)
    check('Export in the dev build saves the configuration into the project', bool(exported) and 'Oakland' in text,
          '\n'.join(log[-6:]))
    check('the saved configuration holds no API keys', bool(text) and 'offline-test' not in text)
    check('the settings page says where it went', 'personal-config.json' in (said or ''), said)

    # --- saving a file reloads the add-on --------------------------------
    os.utime(ROOT / 'src/background/trace.js')
    reloaded = wait_for(r'Reloaded build (\d+)', 60)
    check('touching a source file rebuilds and reloads the add-on', bool(reloaded) and reloaded.group(1) == '2',
          '\n'.join(log[-6:]))

    # The same fill again on a fresh copy of the page, from the reloaded build.
    m.send('WebDriver:SwitchToWindow', {'handle': home_handle})
    m.send('WebDriver:Navigate', {'url': page})
    time.sleep(1)
    ext = fill(m, uuid, home_handle)
    again = wait_for(r'Run saved: (\S+)\s+\((.*)\)', 60)
    close(m, ext, home_handle)
    if again:
        folder = pathlib.Path(again.group(1))
        folder = folder if folder.is_absolute() else ROOT / folder
        report = json.loads((folder / 'report.json').read_text())
        check('the reloaded build reports as build 2', (report.get('build') or {}).get('number') == 2, report.get('build'))
        check('the profile survived the reload', (report.get('summary') or {}).get('filled', 0) >= 3, report.get('summary'))
    else:
        check('a fill after the reload is reported', False, '\n'.join(log[-10:]))

    # --- a broken edit is refused, the running build kept ---------------
    broken = ROOT / 'src/background/zz-devtest-broken.js'
    broken.write_text('export const = ;\n')
    try:
        refused = wait_for(r'Not reloaded', 60)
        check('a change that does not parse is not loaded', bool(refused), '\n'.join(log[-6:]))
    finally:
        broken.unlink()
    wait_for(r'Reloaded build', 60)
finally:
    dev.terminate()
    try:
        dev.wait(10)
    except subprocess.TimeoutExpired:
        dev.kill()
    subprocess.run(['pkill', '-f', str(home)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server.shutdown()
    shutil.rmtree(home, ignore_errors=True)

print()
if failures:
    print(f'{len(failures)} dev loop check(s) failed.')
    sys.exit(1)
print('The development loop works.')
