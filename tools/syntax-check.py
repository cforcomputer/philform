#!/usr/bin/env python3
"""Parse-check every JavaScript file using the JavaScriptCore engine on macOS.

JavaScriptCore's `new Function` cannot parse ES module syntax, so import and
export have to be removed before the check. An earlier version of this script
stripped the `export` keyword unconditionally, which quietly turned a genuine
syntax error into valid code: a stray `export` left before a comment parsed
clean here and broke the extension in every browser.

So the stripping is now strict. Every `export` must be followed by something
that can actually be exported, and anything else is reported as the syntax
error it is.
"""
import json, os, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Built packages and the dev loop's folder (its build, and web-ext's
# node_modules) are not this project's source.
SKIP = {'dist', '.dev', 'node_modules'}
def walk(suffix):
    """Files ending in suffix, never descending into SKIP: a dev build being
    rebuilt there would vanish mid-walk."""
    out = []
    for folder, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP and d != '.git']
        out += [pathlib.Path(folder) / n for n in names if n.endswith(suffix)]
    return out


files = sorted(walk('.js'))

IMPORT_MULTI = re.compile(r'^\s*import\s*\{[^}]*\}\s*from\s*[^;]+;?\s*$', re.M | re.S)
IMPORT_ONE = re.compile(r'^\s*import\s[^;]*;?\s*$', re.M)
EXPORT_LIST = re.compile(r'^\s*export\s*\{[^}]*\}\s*(from\s*[^;]+)?;?\s*$', re.M)
# What may legally follow `export` at the start of a statement.
EXPORT_DECL = re.compile(r'^(\s*)export\s+(?=(default|function|async|class|const|let|var|\*)\b)', re.M)
EXPORT_ANY = re.compile(r'^\s*export\b', re.M)

failures = []

for path in files:
    src = path.read_text()
    rel = path.relative_to(ROOT)

    stripped = IMPORT_MULTI.sub('', src)
    stripped = IMPORT_ONE.sub('', stripped)
    stripped = EXPORT_LIST.sub('', stripped)
    stripped = EXPORT_DECL.sub(r'\1', stripped)

    # Anything still starting with `export` had nothing valid after it.
    leftover = EXPORT_ANY.search(stripped)
    if leftover:
        line = stripped[:leftover.start()].count('\n') + 1
        text = stripped.splitlines()[line - 1].strip()
        print(f'  FAIL {rel}:{line}: `export` with no declaration after it: {text[:60]}')
        failures.append(rel)
        continue

    script = 'try { new Function(%s); "OK" } catch (e) { "ERR: " + e.message }' % json.dumps(stripped)
    result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', script],
                            capture_output=True, text=True)
    out = (result.stdout or result.stderr).strip()
    if out == 'OK':
        print(f'  ok   {rel}')
    else:
        print(f'  FAIL {rel}: {out}')
        failures.append(rel)

print()
if failures:
    print(f'{len(failures)} file(s) failed to parse.')
    sys.exit(1)
print(f'All {len(files)} JavaScript files parse cleanly.')
