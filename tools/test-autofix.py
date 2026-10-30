#!/usr/bin/env python3
"""Offline checks for the self-healing loop (tools/autofix.py), without a real
Claude Code session or any model call: a stand-in "claude" edits the copy the
way a fix session would, and a stand-in project has its own ./test.sh.

    python3 tools/test-autofix.py
"""
import json, os, pathlib, stat, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import autofix  # noqa: E402

failures = []


def check(name, ok, detail=''):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{'' if ok else ': ' + str(detail)}")
    if not ok:
        failures.append(name)


def project(root, test_passes=True):
    """A tiny stand-in for the repository: one source file and a test.sh."""
    (root / 'src').mkdir(parents=True)
    (root / 'tools').mkdir()
    (root / 'src' / 'a.js').write_text('export const a = 1;\n')
    (root / 'tools' / 'dev.py').write_text('# the loop itself\n')
    (root / 'test.sh').write_text('#!/bin/sh\n' + ('exit 0\n' if test_passes else 'echo "  FAIL a check"; exit 1\n'))
    (root / 'test.sh').chmod(0o755)
    (root / '.dev' / 'runs' / 'r1').mkdir(parents=True)


def fake_claude(path, edit):
    """A "claude" that applies one edit in its working directory and reports."""
    path.write_text(f'#!/bin/sh\n{edit}\necho "Cause: x"; echo "Fix: y"; echo "Tests: z"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def use(root):
    autofix.ROOT = root
    autofix.DEV = root / '.dev'
    autofix.BACKLOG = autofix.DEV / 'backlog.json'
    autofix.WORK = autofix.DEV / 'autofix'


def seed(slug='some-fault'):
    autofix.record(autofix.DEV / 'runs' / 'r1', [{'slug': slug, 'severity': 'high', 'summary': 'Something goes wrong.'}], 'acme.test')


quiet = lambda message: None

with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)

    # The review's list is read from its last JSON block.
    text = 'Review...\n```json\n[{"slug": "x-fault", "severity": "high", "summary": "s"}]\n```\n'
    check('a review\'s problem list is read', [p['slug'] for p in autofix.parse_problems(text)] == ['x-fault'])
    check('a review without one adds nothing', autofix.parse_problems('All good.') == [])

    # The backlog merges by slug, counts runs, ranks, and reopens a regression.
    root = tmp / 'b'
    project(root)
    use(root)
    seed('one')
    autofix.record(root / '.dev' / 'runs' / 'r2', [{'slug': 'one', 'severity': 'medium', 'summary': 'again'},
                                                  {'slug': 'two', 'severity': 'low', 'summary': 'minor'}], 'globex.test')
    b = autofix.load()
    check('the same problem from two runs is one entry seen twice', len(b['one']['runs']) == 2 and len(b) == 2, b)
    check('the most pressing problem is picked first', autofix.pick()[0] == 'one')
    (root / '.dev' / 'runs' / 'r2').mkdir(parents=True, exist_ok=True)
    autofix.update('one', status='fixed')
    check('a fixed problem drops its old runs', 'runs' not in autofix.load()['one'] and autofix.load()['one']['summary'])
    check('but not one an open problem still uses', (root / '.dev' / 'runs' / 'r2').exists() == ('r2' in autofix.load()['two']['runs']))
    autofix.record(root / '.dev' / 'runs' / 'r3', [{'slug': 'one', 'severity': 'high', 'summary': 'back'}], 'acme.test')
    check('a fixed problem seen again is reopened', autofix.load()['one']['status'] == 'reopened')
    check('and is picked before older open ones', autofix.pick()[0] == 'one')
    check('backlog.md is written', (root / '.dev' / 'backlog.md').read_text().startswith('# Backlog'))

    # A fix that passes the checks is applied to the working tree.
    root = tmp / 'pass'
    project(root)
    use(root)
    seed()
    claude = fake_claude(tmp / 'claude-pass', "echo 'export const a = 2;' > src/a.js")
    status = autofix.attempt('some-fault', claude, quiet, corpus_check=False)
    check('a fix that passes the checks is applied', status == 'fixed' and '2' in (root / 'src' / 'a.js').read_text(), status)
    check('and its patch is kept', any(p.read_text() for p in (root / '.dev' / 'autofix').glob('*/fix.patch')))
    check('and the backlog says so', autofix.load()['some-fault']['status'] == 'fixed')

    # A fix whose checks fail is not applied.
    root = tmp / 'fail'
    project(root, test_passes=False)
    use(root)
    seed()
    status = autofix.attempt('some-fault', claude, quiet, corpus_check=False)
    check('a fix whose checks fail is not applied', status == 'failed' and '1' in (root / 'src' / 'a.js').read_text(), status)
    check('and stays open for one more try', autofix.load()['some-fault']['status'] == 'open')

    # A fix that edits the loop itself is refused.
    root = tmp / 'protected'
    project(root)
    use(root)
    seed()
    sneaky = fake_claude(tmp / 'claude-sneaky', "echo 'changed' >> tools/dev.py")
    status = autofix.attempt('some-fault', sneaky, quiet, corpus_check=False)
    check('a fix that edits the loop itself is refused', status == 'failed' and 'changed' not in (root / 'tools' / 'dev.py').read_text(), status)

    # A file changed in the working tree meanwhile is never overwritten.
    root = tmp / 'conflict'
    project(root)
    use(root)
    seed()
    racing = fake_claude(tmp / 'claude-race', f"echo 'export const a = 2;' > src/a.js; echo 'export const a = 3; // mine' > {root}/src/a.js")
    status = autofix.attempt('some-fault', racing, quiet, corpus_check=False)
    check('a file someone changed meanwhile is not overwritten', status == 'conflict' and 'mine' in (root / 'src' / 'a.js').read_text(), status)

    # Nothing changed: nothing applied.
    root = tmp / 'nothing'
    project(root)
    use(root)
    seed()
    idle = fake_claude(tmp / 'claude-idle', 'true')
    check('a session that changes nothing is a failed attempt', autofix.attempt('some-fault', idle, quiet, corpus_check=False) == 'failed')

if failures:
    sys.exit(f'{len(failures)} self-healing check(s) failed.')
print('Self-healing checks passed.')
