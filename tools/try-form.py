#!/usr/bin/env python3
"""Run a real fill against a live application page and report what happened.

    python3 tools/try-form.py URL                 # your answers from .dev/personal-config.json
    python3 tools/try-form.py URL --write         # also draft long answers
    python3 tools/try-form.py URL --config FILE   # another exported configuration
    python3 tools/try-form.py - --attach PORT     # the page open in a Firefox you started
                                                  # (signed in, on step 2 of an application)

Loads the built extension in headless Firefox, opens URL, and runs the real
orchestrator with the profile and settings from .dev/personal-config.json (or
--config) and the API keys in src/common/local-config.js. It prints a timeline of
every stage, every model request, and then what each field on the page shows.

It never submits: nothing in the extension can. Long answers are skipped
unless --write is given, so a diagnostic run does not spend on the writer.
It does send the profile to TypeSafe, exactly as a real run would.
"""
import argparse, json, os, pathlib, re, shutil, signal, subprocess, sys, tempfile, time
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from marionette import Marionette  # noqa: E402

FIREFOX = pathlib.Path('/Applications/Firefox.app/Contents/MacOS/firefox')
ADDON_ID = 'applicator@local.test'
def free_port():
    # Other agents may be running tools at the same time: never a fixed port.
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


PORT = free_port()

ap = argparse.ArgumentParser()
ap.add_argument('url')
ap.add_argument('--config', default=str(ROOT / '.dev' / 'personal-config.json'),
                help='an exported Applicator configuration file (default: .dev/personal-config.json)')
ap.add_argument('--write', action='store_true', help='draft long answers too')
ap.add_argument('--wait', type=float, default=6, help='seconds to let the page load')
ap.add_argument('--grant', action='append', default=[], help='a further match pattern to allow, e.g. https://*.greenhouse.io/*')
ap.add_argument('--probe', action='store_true', help='only read the page, opening dropdowns, and report the fields')
ap.add_argument('--attach', type=int, help='Marionette port of a running Firefox: fill the page its window shows '
                'instead of opening URL in a fresh browser, and leave that browser running')
ap.add_argument('--experiment', help='a script run in the page as a content script; it must set '
                'globalThis.__experiment to a promise of a JSON-able result')
args = ap.parse_args()

config = json.loads(pathlib.Path(args.config).expanduser().read_text())
data = config.get('data', config)
settings = {k: v for k, v in (data.get('settings') or {}).items() if not re.search(r'Key|Token', k)}
local = (ROOT / 'src/common/local-config.js').read_text()
for key in ('typesafeApiKey', 'deepseekApiKey'):
    m = re.search(key + r":\s*'([^']*)'", local)
    if m and m.group(1):
        settings[key] = m.group(1)
# With your own keys the models are called directly, not through philform's
# service (which also limits how often a new install may start).
if settings.get('typesafeApiKey'):
    settings['mode'] = 'direct'
if not args.write:
    settings['longTextMode'] = 'skip'

# Built in a folder of its own, so a running dev.py cannot replace it mid-copy.
build = pathlib.Path(tempfile.mkdtemp(prefix='applicator-try-')) / 'firefox'
subprocess.run(['./build.sh', 'firefox'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
               env={**os.environ, 'DIST': str(build.parent)})


def grant(url):
    """Give the test copy the origin the page ended up on, and return its match pattern."""
    origin = f'{urlparse(url).scheme}://{urlparse(url).hostname}/*'
    manifest = json.loads((build / 'manifest.json').read_text())
    manifest['host_permissions'] += [origin, *args.grant]
    (build / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    return origin

(build / 'try.js').write_text('''
const log = [];
window.__tryLog = log;
const t0 = () => window.__t0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const started = performance.now();
  const res = await realFetch(url, init);
  let questions = 0;
  try { questions = Object.keys(JSON.parse(init.body).questions || {}).length; } catch {}
  log.push({ at: Math.round(started - t0()), ms: Math.round(performance.now() - started),
             kind: 'request', host: new URL(url).host, questions, status: res.status });
  return res;
};
// Progress is written onto the page being filled, where the harness reads it
// without switching windows: moving focus away from the page blurs the box
// being typed into, and sites close their suggestion lists on blur.
let tabId = null;
const publish = state => {
  window.__try = state;
  if (tabId === null) return Promise.resolve();
  return chrome.scripting.executeScript({ target: { tabId }, func: (s, l) => {
    document.documentElement.setAttribute('data-applicator-try', s);
    document.documentElement.setAttribute('data-applicator-try-log', l);
  }, args: [state, JSON.stringify(log)] }).catch(() => {});
};
window.__try = 'idle';
window.addEventListener('hashchange', async () => {
  if (location.hash !== '#go') return;
  window.__try = 'running';
  try {
    const input = JSON.parse(sessionStorage.getItem('try') || '{}');
    const store = await import('./src/background/storage.js');
    await store.saveSettings(input.settings);
    await store.saveProfile(input.profile);
    // The saved CV and cover letter, so uploads are tried as in a real fill.
    for (const [kind, doc] of Object.entries(input.documents || {})) await store.saveDocument(kind, doc);
    const [tab] = await chrome.tabs.query({ url: input.match });
    tabId = tab.id;
    await publish('running');
    if (input.experiment) {
      // The extension's own page scripts first, so an experiment can call them.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['/src/content/extract.js', '/src/content/fill.js', '/experiment.js'] });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
        try { return JSON.stringify({ value: await globalThis.__experiment }); }
        catch (e) { return JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack) }); }
      } });
      await publish(JSON.stringify({ experiment: r && r.result ? JSON.parse(r.result) : { error: 'no result', raw: String(r && r.error) } }));
      return;
    }
    if (input.probeOnly) {
      const { extractAll } = await import('./src/background/frames.js');
      const started = performance.now();
      const x = await extractAll(tab.id, { probe: true });
      await publish(JSON.stringify({ probeMs: Math.round(performance.now() - started), fields: x.fields.map(f => ({
        label: f.label, type: f.type, widget: f.widget, combobox: f.combobox, searchable: f.searchable,
        options: (f.options || []).slice(0, 6).map(o => o.label), optionCount: (f.options || []).length, probe: f.probe,
        current: f.currentValue, section: f.section, name: f.name, idAttr: f.idAttr })) }));
      return;
    }
    const { runFill } = await import('./src/background/orchestrator.js');
    const { beginTrace, endTrace } = await import('./src/background/trace.js');
    window.__t0 = performance.now();
    beginTrace();
    const summary = await runFill({ tabId: tab.id, url: tab.url, signal: new AbortController().signal,
      onProgress: (stage, detail) => {
        log.push({ at: Math.round(performance.now() - t0()), kind: 'stage', stage, detail });
        publish('running');
      } });
    // The model's closest-entry picks and every write that failed, from the trace.
    const events = (endTrace() || {}).events || [];
    const notes = events.filter(e => e.kind === 'equivalents' || e.kind === 'listEntries').concat(events.filter(e => e.kind === 'filled')
      .flatMap(e => e.results.filter(r => !r.ok).map(r => ({ kind: 'failed', pass: e.pass, label: r.label, value: r.value, reason: r.reason, candidates: r.candidates }))));
    await publish(JSON.stringify({ summary, log, notes }));
  } catch (e) {
    await publish(JSON.stringify({ error: e.message, stack: String(e.stack).slice(0, 800), log }));
  }
});
''')
if args.experiment:
    shutil.copy(pathlib.Path(args.experiment).expanduser(), build / 'experiment.js')
options = build / 'src' / 'options' / 'options.html'
options.write_text(options.read_text().replace(
    '<script type="module" src="options.js"></script>',
    '<script type="module" src="options.js"></script>\n  <script type="module" src="../../try.js"></script>'))

profile_dir = tempfile.mkdtemp(prefix='applicator-try-ff-')
(pathlib.Path(profile_dir) / 'user.js').write_text('\n'.join([
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    f'user_pref("marionette.port", {PORT});',
]))
# Firefox 159 grants Marionette system access (chrome context) only through
# this variable; the command-line flag stopped working.
proc = None if args.attach else subprocess.Popen(
    [str(FIREFOX), '--headless', '--marionette', '-remote-allow-system-access', '--profile', profile_dir],
    env={**os.environ, 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS': '1'},
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

# What a field shows afterwards, read the way a person would read the page.
READ_PAGE = r'''
const text = n => (n?.textContent || '').replace(/\s+/g, ' ').trim();
const out = [];
const seen = new Set();
for (const input of document.querySelectorAll('input.select__input')) {
  const c = input.closest('.select__container') || input.closest('.select') || input.parentElement.parentElement.parentElement.parentElement;
  if (seen.has(c)) continue;
  seen.add(c);
  const label = text(c.querySelector('label')) || text(document.getElementById(c.querySelector('input')?.getAttribute('aria-labelledby') || ''));
  const value = Array.from(c.querySelectorAll('[class*="single-value"], [class*="multi-value__label"]')).map(text).join(' | ');
  out.push({ kind: 'dropdown', label, value, typed: c.querySelector('input')?.value || '' });
}
for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=file]):not(.select__input), textarea, select')) {
  if (el.getAttribute('aria-hidden') === 'true' || el.type === 'search') continue;
  const label = el.getAttribute('aria-label') || text(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.name;
  const value = el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : '') : el.value;
  out.push({ kind: el.type || el.tagName.toLowerCase(), label, value });
}
return out;
'''

requests = []
try:
    m = Marionette(args.attach or PORT)
    m.send('WebDriver:NewSession', {'capabilities': {}})
    m.send('WebDriver:SetTimeouts', {'script': 300000})
    handles = m.send('WebDriver:GetWindowHandles')
    handles = handles.get('value', handles) if isinstance(handles, dict) else handles
    if args.attach:
        # The page the user's own steps reached (signed in, a later step):
        # filled where it is, with the extension's pages in a window beside it.
        # The window showing a web page, not the extension's own (installing
        # it opens its settings).
        tab = handles[-1]
        for h in handles:
            m.send('WebDriver:SwitchToWindow', {'handle': h})
            if str(m.send('WebDriver:GetCurrentURL')['value']).startswith('http'):
                tab = h
                break
        home = m.send('WebDriver:NewWindow', {'type': 'window'})['handle']
        m.send('WebDriver:SwitchToWindow', {'handle': tab})
    else:
        home = handles[0]
        # Its own window, so it stays in front: background tabs throttle timers.
        # The page is opened first so a redirect to another host is followed and
        # that host, not the one typed, is the one granted.
        tab = m.send('WebDriver:NewWindow', {'type': os.environ.get('TRY_AS', 'window')})['handle']
        m.send('WebDriver:SwitchToWindow', {'handle': tab})
        m.send('WebDriver:Navigate', {'url': args.url})
        time.sleep(args.wait)
    landed = m.send('WebDriver:GetCurrentURL')['value'] or args.url
    if urlparse(landed).hostname != urlparse(args.url).hostname:
        print(f'Redirected to {landed}')
    origin = grant(landed)
    before = m.send('WebDriver:ExecuteScript', {'script': READ_PAGE, 'args': []})['value']

    m.send('Addon:Install', {'path': str(build), 'temporary': True})
    m.send('Marionette:SetContext', {'value': 'chrome'})
    uuid = json.loads(m.send('WebDriver:ExecuteScript', {
        'script': "return Services.prefs.getStringPref('extensions.webextensions.uuids','{}');", 'args': []})['value'])[ADDON_ID]
    m.send('Marionette:SetContext', {'value': 'content'})
    time.sleep(2)

    m.send('WebDriver:SwitchToWindow', {'handle': home})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(2)
    payload = json.dumps({'settings': settings, 'profile': data.get('profile') or {}, 'documents': data.get('documents') or {},
                          'match': origin, 'probeOnly': args.probe,
                          'experiment': bool(args.experiment)})
    m.send('WebDriver:ExecuteScript', {'script': "sessionStorage.setItem('try', arguments[0]); location.hash = '#go';",
                                       'args': [payload]})
    result = None
    shown = 0
    # The page stays in front while it fills: a background one is throttled,
    # and taking focus from it closes the suggestion list being typed into.
    # Progress is read from the page itself.
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    for _ in range(300):
        time.sleep(1)
        raw, live = m.send('WebDriver:ExecuteScript', {
            'script': "const h = document.documentElement; return [h.getAttribute('data-applicator-try'), "
                      "h.getAttribute('data-applicator-try-log') || '[]'];", 'args': []})['value']
        for e in json.loads(live)[shown:]:
            print('  live', json.dumps(e)[:140], flush=True)
        shown = len(json.loads(live))
        if raw not in (None, 'idle', 'running'):
            result = json.loads(raw)
            break
    result = result or {'error': 'did not finish within five minutes'}

    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    time.sleep(1)
    after = m.send('WebDriver:ExecuteScript', {'script': READ_PAGE, 'args': []})['value']
    # The page's own requests during the fill: a fill waits for them after every field.
    requests = m.send('WebDriver:ExecuteScript', {'script': '''
      return performance.getEntriesByType('resource').filter(e => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
        .map(e => ({ url: e.name.replace(/[?#].*$/, '').slice(0, 110), ms: Math.round(e.duration), at: Math.round(e.startTime) }));''', 'args': []})['value'] or []
finally:
    if args.attach:
        # Not ours to close: only the window this run opened goes.
        try:
            m.send('WebDriver:SwitchToWindow', {'handle': home})
            m.send('WebDriver:CloseWindow')
            m.send('WebDriver:DeleteSession')
        except Exception:
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            proc.terminate()
        time.sleep(1)
        subprocess.run(['pkill', '-f', profile_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(build.parent, ignore_errors=True)
    shutil.rmtree(profile_dir, ignore_errors=True)

if 'experiment' in result:
    print(json.dumps(result['experiment'], indent=1))
    sys.exit(0)

if 'fields' in result:
    print(f"Extraction with probing took {result['probeMs']} ms")
    for f in result['fields']:
        print(f"  {str(f.get('label'))[:48]:<48} {f.get('type') or '':<9} {f.get('widget') or '':<8} "
              f"cb={int(bool(f.get('combobox')))} n={f.get('optionCount')} cur={f.get('current')!r} probe={f.get('probe')} {f.get('options')}")
        if f.get('section') or f.get('name') or f.get('idAttr'):
            print(f"      section={f.get('section')!r} name={f.get('name')!r} id={f.get('idAttr')!r}")
    sys.exit(0)

if result.get('error'):
    print('RUN FAILED:', result['error'])
    print(result.get('stack', ''))

print('\nTimeline (ms from start)')
for e in result.get('log', []):
    if e['kind'] == 'stage':
        print(f"  {e['at']:>6}  stage    {e['stage']}  {json.dumps(e.get('detail') or {})[:90] if e['stage'] != 'done' else ''}")
    else:
        print(f"  {e['at']:>6}  request  {e['host']}  {e['questions']} questions, {e['ms']} ms, HTTP {e['status']}")

for n in result.get('notes', []):
    print('  note', json.dumps(n)[:400])

s = result.get('summary') or {}
if s:
    print(f"\nSummary: {s.get('filled')} of {s.get('fieldsFound')} filled, {s.get('passes')} passes, "
          f"{s.get('modelCalls')} model calls, {s.get('durationMs')} ms")
    print('\nDecisions')
    for d in s.get('decisions', []):
        print(f"  {'ok ' if d['ok'] else 'BAD'} {d['label'][:60]:<60} {d.get('profileKey') or '-':<34} {d.get('via')}")
    print('\nLeft empty')
    for u in s.get('unfilled', []):
        print(f"  {u['label'][:60]:<60} {u['reason']}")

if requests:
    from collections import defaultdict
    by = defaultdict(list)
    for r in requests:
        by[r['url']].append(r['ms'])
    print('\nPage requests (fetch/XHR): count, median ms, URL')
    for url, ms in sorted(by.items(), key=lambda kv: -sum(kv[1]))[:12]:
        print(f"  {len(ms):>4} {sorted(ms)[len(ms) // 2]:>6}  {url}")

print('\nWhat the page shows afterwards')
was = {(b['kind'], b['label']): b for b in before or []}
for a in after or []:
    if not a.get('label'):
        continue
    prior = was.get((a['kind'], a['label']), {})
    changed = '' if prior.get('value') == a.get('value') else '  (changed)'
    extra = f"  [typed: {a['typed']!r}]" if a.get('typed') and not a.get('value') else ''
    print(f"  {a['kind']:<9} {a['label'][:60]:<60} = {str(a.get('value'))[:60]!r}{extra}{changed}")
