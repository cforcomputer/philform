#!/usr/bin/env python3
"""Look at Philform's accounts on the server, and give one unlimited fills.

    python3 tools/accounts.py                    # every account, newest first
    python3 tools/accounts.py unlimited ID       # fills on the house (an id prefix will do)
    python3 tools/accounts.py unlimited ID --off # back to the normal wallet
    python3 tools/accounts.py waitlist           # the website's early-access sign-ups
    python3 tools/accounts.py reports [--all]    # thumbs down (and up) on filled pages, newest first

Accounts are anonymous: tell a friend's from the time it was made (their
first fill) and how many applications it has filled. An unlimited wallet is
never charged; what its fills cost us is kept as "gifted".

The service holds its data in memory and writes it on every change, so a
change here stops it for a moment, edits the file, and starts it again.
Reached through .dev/ssh/config (host "philform").
"""
import json, pathlib, subprocess, sys, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-F', str(ROOT / '.dev/ssh/config'), 'philform']
DB = '/var/lib/philform/db.json'


def remote(cmd, **kw):
    return subprocess.run(SSH + [cmd], capture_output=True, text=True, check=True, **kw).stdout


def load():
    text = remote(f'sudo cat {DB} 2>/dev/null || echo {{}}')
    return json.loads(text or '{}')


def when(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M') if ms else '-'


def show(db):
    accounts = sorted(db.get('accounts', {}).values(), key=lambda a: a.get('createdAt', 0), reverse=True)
    if not accounts:
        print('No accounts yet.')
        return
    last_run = {}
    for run in db.get('runs', {}).values():
        last_run[run['account']] = max(last_run.get(run['account'], 0), run.get('startedAt', 0))
    print(f"{'id':10} {'made':16} {'last fill':16} {'free left':>9} {'balance':>8} {'spent':>7}  notes")
    for a in accounts:
        w = a.get('wallet', {})
        notes = []
        if w.get('unlimited'):
            notes.append(f"unlimited, gifted {w.get('giftedCents', 0):.2f}¢")
        print(f"{a['id'][:8]:10} {when(a.get('createdAt')):16} {when(last_run.get(a['id'])):16} "
              f"{w.get('freeLeft', 0):>9} ${w.get('balanceCents', 0) / 100:>7.2f} ${w.get('spentCents', 0) / 100:>6.2f}  {' '.join(notes)}")


def set_unlimited(prefix, on):
    db = load()
    found = [a for a in db.get('accounts', {}).values() if a['id'].startswith(prefix)]
    if len(found) != 1:
        sys.exit(f'{len(found)} accounts start with "{prefix}": give more of the id.')
    account_id = found[0]['id']
    # Edited on the server while the service is stopped, so it cannot write over the change.
    script = f'''
import json
path = {DB!r}
db = json.load(open(path))
w = db["accounts"][{account_id!r}]["wallet"]
if {on!r}:
    w["unlimited"] = True
else:
    w.pop("unlimited", None)
json.dump(db, open(path + ".tmp", "w"))
'''
    remote(f'sudo systemctl stop philform && sudo python3 -c {sh(script)} && sudo mv {DB}.tmp {DB} '
           f'&& sudo chown philform:philform {DB}; sudo systemctl start philform')
    print(f"{account_id[:8]} is {'unlimited' if on else 'back to the normal wallet'}.")
    show(load())


def sh(text):
    return "'" + text.replace("'", "'\\''") + "'"


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        show(load())
    elif args[0] == 'waitlist':
        signups = load().get('waitlist', [])
        for s in signups:
            print(f"{when(s.get('at')):16}  {s.get('browser', ''):8}  {s['email']}")
        print(f'{len(signups)} on the early-access list.')
    elif args[0] == 'reports':
        reports = load().get('reports', [])
        shown = reports if '--all' in args else [r for r in reports if r.get('verdict') == 'down'][:40]
        for r in shown:
            c = r.get('counts', {})
            print(f"{when(r.get('at')):16}  {r.get('verdict', ''):4}  {r.get('account', '')[:8]:8}  filled {c.get('filled', '?')}/{c.get('total', '?')}"
                  f"  {r.get('platform') or '-':14} {r.get('browser', ''):7} {r.get('build', ''):6}  {r.get('url', '')}")
            if r.get('error'):
                print(f"{'':16}  error: {r['error'][:160]}")
            if r.get('note'):
                print(f"{'':16}  note: {r['note'][:300]}")
            if r.get('possiblyMissed'):
                print(f"{'':16}  missed? {'; '.join(r['possiblyMissed'][:5])[:200]}")
        ups = sum(1 for r in reports if r.get('verdict') == 'up')
        print(f"{len(reports) - ups} thumbs down, {ups} up in all.")
    elif args[0] == 'unlimited' and len(args) >= 2:
        set_unlimited(args[1], '--off' not in args)
    else:
        sys.exit(__doc__)
