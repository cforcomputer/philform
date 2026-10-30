#!/usr/bin/env bash
# Run every check. The extension's JavaScript tests run through the
# JavaScriptCore engine that ships with macOS, via osascript; only the
# backend's checks need Node, and are skipped without it.
set -euo pipefail
cd "$(dirname "$0")"

# The quick checks first, so a broken build fails in seconds.
echo "== syntax =="        && python3 tools/syntax-check.py
echo                       && echo "== wiring =="   && python3 tools/verify.py
echo                       && echo "== logic =="    && python3 tools/test-logic.py
echo                       && echo "== pipeline ==" && python3 tools/test-orchestrator.py
echo                       && echo "== self-healing ==" && python3 tools/test-autofix.py
# The service (backend/server.mjs) runs on Node; skipped where there is none.
if command -v node > /dev/null; then echo && node tools/test-backend.mjs; else echo && echo "== backend == skipped: no Node"; fi
# The password lock's encryption, on Node's WebCrypto.
if command -v node > /dev/null; then echo && node tools/test-vault.mjs; else echo && echo "== password lock == skipped: no Node"; fi

# The two Firefox tests use their own profiles, ports and build folders, so
# they run side by side; each one's output is printed whole when both end.
out=$(mktemp -d)
python3 tools/test-firefox.py > "$out/browser" 2>&1 & browser=$!
python3 tools/test-dev.py > "$out/dev" 2>&1 & devloop=$!
status=0
wait $browser || status=1
echo && echo "== browser ===" && cat "$out/browser"
wait $devloop || status=1
echo && echo "== dev loop ==" && cat "$out/dev"
rm -rf "$out"
[ $status -eq 0 ] || { echo; echo "Some checks failed."; exit 1; }
echo
echo "All checks passed."
