#!/usr/bin/env python3
"""Static wiring checks: every path, import and DOM id actually resolves.

These are the failures that produce a silently broken extension rather than an
error at parse time - a renamed file still referenced by a manifest, an import
that points at nothing, a getElementById for an element that was removed.
"""
import json, os, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Built packages, the dev loop's folder (its build, and web-ext's
# node_modules) and the website in deploy/ are not the extension's source.
SKIP = {'dist', '.dev', 'node_modules', 'deploy'}


def walk(suffix):
    """Files ending in suffix, never descending into SKIP: a dev build being
    rebuilt there would vanish mid-walk."""
    out = []
    for folder, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP and d != '.git']
        out += [pathlib.Path(folder) / n for n in names if n.endswith(suffix)]
    return out


def source(pattern):
    return walk(pattern.lstrip('*'))  # every pattern here is "*.ext"
problems = []


def check(condition, message):
    if not condition:
        problems.append(message)


# --- manifests -------------------------------------------------------------


for manifest_path in ROOT.glob('manifest.*.json'):
    m = json.loads(manifest_path.read_text())
    name = manifest_path.name

    refs = list(m.get('icons', {}).values())
    refs += list(m.get('action', {}).get('default_icon', {}).values())
    if m.get('action', {}).get('default_popup'):
        refs.append(m['action']['default_popup'])
    if m.get('options_ui', {}).get('page'):
        refs.append(m['options_ui']['page'])
    bg = m.get('background', {})
    refs += bg.get('scripts', [])
    if bg.get('service_worker'):
        refs.append(bg['service_worker'])

    for ref in refs:
        check((ROOT / ref).exists(), f'{name}: references missing file {ref}')

    check(m.get('manifest_version') == 3, f'{name}: not manifest v3')
    check('<all_urls>' not in json.dumps(m), f'{name}: requests <all_urls>')
    for perm in m.get('permissions', []):
        check(perm in {'storage', 'activeTab', 'scripting'},
              f'{name}: unexpected permission "{perm}"')
    # Required hosts are the model APIs only, for direct mode; a release build
    # drops them, since Philform's service answers cross-origin requests. Web
    # pages are reached through activeTab, or through one origin the user grants
    # from the popup for a form embedded from another site; that is what the
    # optional list is for.
    for host in m.get('host_permissions', []):
        check(host.startswith('https://api.'), f'{name}: unexpected required host "{host}"')
    check(set(m.get('optional_host_permissions', [])) <= {'https://*/*', 'http://*/*'},
          f'{name}: unexpected optional hosts')
    check('optional_permissions' not in m, f'{name}: optional API permissions are not expected')

popup_js = (ROOT / 'src/popup/popup.js').read_text()
# Only the blocked embeds, each as its whole site, so a redirect within the
# site (boards.greenhouse.io to job-boards.greenhouse.io) is covered.
check('permissions.request({ origins: [...new Set(blockedOrigins.map(sitePattern))] })' in popup_js,
      'popup.js no longer requests only the blocked frames\' sites')

chrome_m = json.loads((ROOT / 'manifest.chrome.json').read_text())
firefox_m = json.loads((ROOT / 'manifest.firefox.json').read_text())
check(chrome_m['version'] == firefox_m['version'], 'manifest versions differ between browsers')
check('service_worker' in chrome_m['background'], 'chrome manifest must use a service worker')
check('scripts' in firefox_m['background'], 'firefox manifest must use background scripts')
check('gecko' in firefox_m.get('browser_specific_settings', {}), 'firefox manifest needs a gecko id')

# --- imports ---------------------------------------------------------------
IMPORT_FROM = re.compile(r"""^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]""", re.M)
for js in source('*.js'):
    for spec in IMPORT_FROM.findall(js.read_text()):
        if not spec.startswith('.'):
            problems.append(f'{js.relative_to(ROOT)}: bare import "{spec}" cannot resolve in a browser')
            continue
        target = (js.parent / spec).resolve()
        check(target.exists(), f'{js.relative_to(ROOT)}: import "{spec}" does not exist')

# --- content scripts must not be ES modules --------------------------------
for name in ['src/content/extract.js', 'src/content/fill.js']:
    src = (ROOT / name).read_text()
    check(not IMPORT_FROM.search(src),
          f'{name}: injected content scripts run as classic scripts and cannot use import')
    check('globalThis.__applicator' in src, f'{name}: does not publish its entry point')

# --- html references and DOM ids -------------------------------------------
ID_RE = re.compile(r"""\$\(['"]([\w-]+)['"]\)|getElementById\(['"]([\w-]+)['"]\)""")

for html_path in source('*.html'):
    if 'dist/' in str(html_path.relative_to(ROOT)):
        continue
    html = html_path.read_text()
    rel = html_path.relative_to(ROOT)

    for ref in re.findall(r"""(?:src|href)=['"]([^'":]+)['"]""", html):
        check((html_path.parent / ref).exists(), f'{rel}: references missing file {ref}')

    ids = set(re.findall(r"""\bid=['"]([^'"]+)['"]""", html))

    for js_ref in re.findall(r"""<script[^>]+src=['"]([^'"]+)['"]""", html):
        js_path = html_path.parent / js_ref
        if not js_path.exists():
            continue
        js = js_path.read_text()
        used = {a or b for a, b in ID_RE.findall(js)}
        # Ids the script builds itself, in a template literal, count as defined.
        built = set(re.findall(r"""\bid=['\"]([\w-]+)['\"]""", js))
        for element_id in sorted(used - ids - built):
            problems.append(f'{js_path.relative_to(ROOT)}: uses #{element_id}, absent from {rel.name}')

# --- the two jobs stay on their own models ---------------------------------
# Field matching runs on the classify model, written answers on the writer
# model. Crossing these silently would put every ordinary field through the
# pricier model without anything failing.
classify_src = (ROOT / 'src/background/classify.js').read_text()
write_src = (ROOT / 'src/background/write.js').read_text()
check('settings.deepseekModel' in classify_src,
      'classify.js does not use the field-matching model')
check('deepseekWriterModel' not in classify_src,
      'classify.js reaches for the writer model')
check('settings.deepseekWriterModel' in write_src,
      'write.js does not use the writer model')
# TypeSafe may check drafts (a choice per sentence), never write them: every
# call that produces answer text goes to DeepSeek.
draft_calls = re.findall(r'hedgedWrite\(|callDeepSeek\(', write_src)
check(bool(draft_calls) and 'askTypeSafe(' not in write_src.split('export async function checkFacts')[0],
      'write.js drafts with TypeSafe, which is not a text-generation model')
check('settings.deepseekModel' not in write_src,
      'write.js reaches for the field-matching model')

orchestrator_src = (ROOT / 'src/background/orchestrator.js').read_text()
check('matchResponse' in orchestrator_src,
      'saved responses are never consulted during a run')
check(orchestrator_src.index('matchResponse') < orchestrator_src.index('writeAnswers('),
      'saved responses must be tried before the writing model, not after')

# --- no credential outside the gitignored local config ---------------------
# local-config.js is the one place a real key may sit, and it is gitignored and
# dropped from a RELEASE build. Anywhere else is a key on its way to a commit.
KEY_RE = re.compile(r'sk-[A-Za-z0-9]{20,}|apikey_[A-Za-z0-9_]{20,}')
ALLOWED_KEY_FILE = ROOT / 'src/common/local-config.js'
for path in source('*.js') + source('*.json') + source('*.md'):
    rel = path.relative_to(ROOT)
    if 'dist/' in str(rel) or path == ALLOWED_KEY_FILE:
        continue
    if KEY_RE.search(path.read_text(errors='ignore')):
        problems.append(f'{rel}: contains what looks like an API key')

# Any credential-shaped setting must be on the list that exports strip, or a
# shared configuration file quietly carries somebody's API key.
storage_src = (ROOT / 'src/background/storage.js').read_text()
defaults = re.search(r'DEFAULT_SETTINGS = \{(.*?)\n\};', storage_src, re.S).group(1)
secret_settings = set(re.findall(r'^\s{2}(\w*(?:ApiKey|Token))\s*:', defaults, re.M))
stripped = set(re.findall(r"'(\w+)'", re.search(r'CREDENTIAL_KEYS = \[(.*?)\]', storage_src, re.S).group(1)))
for name in sorted(secret_settings - stripped):
    problems.append(f'storage.js: {name} is a credential but exports do not strip it')

gitignore = (ROOT / '.gitignore').read_text() if (ROOT / '.gitignore').exists() else ''
check('src/common/local-config.js' in gitignore,
      '.gitignore does not exclude src/common/local-config.js')
check((ROOT / 'src/common/local-config.example.js').exists(),
      'local-config.example.js is missing, so the setup is undocumented')

# --- development hooks stay in the development build --------------------------
# tools/dev.py writes dev-config.js into its own build in .dev/ only. In src/
# it would ship with every package and send reports of fills to a local port.
check(not (ROOT / 'src/common/dev-config.js').exists(),
      'src/common/dev-config.js exists; it belongs only in the .dev/ build')
check('src/common/dev-config.js' in gitignore and '.dev/' in gitignore,
      '.gitignore must exclude the dev build, its config and saved runs')

# --- the promise that it never submits -------------------------------------
storage = (ROOT / 'src/background/storage.js').read_text()
check('autoSubmit: false' in storage, 'storage.js no longer forces autoSubmit off')
check(storage.count('autoSubmit: false') >= 3,
      'autoSubmit must be forced off on read and on every write')
for js in (ROOT / 'src').rglob('*.js'):
    body = js.read_text()
    check('.submit()' not in body, f'{js.relative_to(ROOT)}: calls submit()')
    check('requestSubmit' not in body, f'{js.relative_to(ROOT)}: calls requestSubmit()')

html_count = len(source('*.html'))
print(f'Checked manifests, imports, {html_count} HTML files and the no-submit guarantee.')
if problems:
    print(f'\n{len(problems)} problem(s):')
    for p in problems:
        print('  -', p)
    sys.exit(1)
print('All references resolve.')
