#!/usr/bin/env python3
"""Sign a Firefox store build with Mozilla and publish it for self-distribution.

    python3 tools/publish-firefox.py            # build, sign, upload, list in updates.json
    python3 tools/publish-firefox.py --dry-run  # build and lint only

1. `RELEASE=1 ./build.sh firefox` into its own folder (no API keys, no host
   permissions, the store id and update_url).
2. web-ext lint in self-hosted mode; any error stops here.
3. web-ext sign on the unlisted channel: Mozilla signs it, usually in minutes.
4. The signed .xpi goes to the server at /firefox/philform-<version>.xpi and
   is added to /firefox/updates.json, where installed copies look for updates.

The version in manifest.firefox.json must be higher than every signed one.
Keys come from .creds.env (issuer, secret), never printed. The server is
reached through .dev/ssh/config (host "philform").
"""
import json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEV = ROOT / '.dev'
DIST = DEV / 'publish-dist'
SIGNED = DEV / 'signed'
WEB_EXT = DEV / 'tools/node_modules/.bin/web-ext'
SSH = ['ssh', '-F', str(DEV / 'ssh/config'), 'philform']
SITE = 'https://philformapp.com/firefox'
ADDON_ID = 'philform@philform'


def creds():
    env = {}
    for line in (ROOT / '.creds.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"\'')
    return env


def run(cmd, **kw):
    print('  $', ' '.join(str(c) for c in cmd[:4]), '...' if len(cmd) > 4 else '')
    return subprocess.run(cmd, check=True, **kw)


def remote_updates():
    out = subprocess.run(SSH + ['cat /opt/philform/site/firefox/updates.json'], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    dry = '--dry-run' in sys.argv
    if not WEB_EXT.exists():
        sys.exit('web-ext is not installed: run tools/dev.py once, which installs it into .dev/tools.')

    version = json.loads((ROOT / 'manifest.firefox.json').read_text())['version']
    print(f'Philform {version} for Firefox')

    updates = remote_updates()
    known = [u['version'] for u in updates['addons'][ADDON_ID]['updates']]
    if version in known:
        sys.exit(f'{version} is already published. Raise "version" in manifest.firefox.json first.')

    print('Building the store package')
    run([str(ROOT / 'build.sh'), 'firefox'], cwd=ROOT, env={**os.environ, 'RELEASE': '1', 'DIST': str(DIST)},
        stdout=subprocess.DEVNULL)
    source = DIST / 'firefox'

    print('Linting')
    lint = subprocess.run([str(WEB_EXT), 'lint', '-s', str(source), '--self-hosted', '--output', 'json'],
                          capture_output=True, text=True)
    report = json.loads(lint.stdout or '{}')
    for err in report.get('errors', []):
        print('  error:', err.get('code'), err.get('message'))
    if report.get('errors'):
        sys.exit('The package does not pass Mozilla\'s checks.')
    print(f"  {report.get('summary', {}).get('warnings', 0)} warnings, no errors")
    if dry:
        print('Dry run: stopping before signing.')
        return

    print('Signing with Mozilla (unlisted)')
    keys = creds()
    SIGNED.mkdir(parents=True, exist_ok=True)
    before = set(SIGNED.glob('*.xpi'))
    run([str(WEB_EXT), 'sign', '-s', str(source), '--channel', 'unlisted', '--artifacts-dir', str(SIGNED),
         '--approval-timeout', '900000'],
        env={**os.environ, 'WEB_EXT_API_KEY': keys['issuer'], 'WEB_EXT_API_SECRET': keys['secret']})
    made = sorted(set(SIGNED.glob('*.xpi')) - before, key=lambda p: p.stat().st_mtime)
    if not made:
        sys.exit('web-ext finished without a signed file.')
    xpi = made[-1]

    name = f'philform-{version}.xpi'
    print(f'Uploading {name}')
    run(['rsync', '-az', '-e', f"ssh -F {DEV / 'ssh/config'}", '--rsync-path=sudo rsync',
         str(xpi), f'philform:/opt/philform/site/firefox/{name}'])

    updates['addons'][ADDON_ID]['updates'].append({'version': version, 'update_link': f'{SITE}/{name}'})
    body = json.dumps(updates, indent=2) + '\n'
    run(SSH + ['sudo tee /opt/philform/site/firefox/updates.json >/dev/null'], input=body, text=True)

    print(f'\nPublished {version}: {SITE}/{name}')
    print('Installed copies pick it up on their next update check (about a day, or Check for Updates).')


if __name__ == '__main__':
    main()
