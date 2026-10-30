#!/usr/bin/env bash
# Build loadable and uploadable packages for Chrome and Firefox.
#
# There is no compile step: the extension ships the same plain JavaScript that
# lives in src/. The only per-browser difference is the manifest, because
# Chrome's Manifest V3 background is a service worker and Firefox's is a set of
# scripts.
#
#   ./build.sh                build both, produce dist/philform-{chrome,firefox}.zip
#   ./build.sh chrome         build one
#   RELEASE=1 ./build.sh      omit src/common/local-config.js, so a development
#                             API key cannot be published by accident
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${DIST:-$ROOT/dist}"  # a caller may build elsewhere, so two builds never share a folder
TARGETS=("${@:-chrome firefox}")
read -r -a TARGETS <<< "${TARGETS[*]}"

# The version is deliberately not part of the package name. Reloading an
# unpacked extension should never mean removing and re-adding it, and a bumped
# version in Firefox's temporary add-on list is exactly what causes that.

for TARGET in "${TARGETS[@]}"; do
  MANIFEST="$ROOT/manifest.$TARGET.json"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "No manifest for target '$TARGET'" >&2
    exit 1
  fi

  OUT="$DIST/$TARGET"
  rm -rf "$OUT"
  mkdir -p "$OUT"

  cp -R "$ROOT/src" "$OUT/src"
  cp -R "$ROOT/icons" "$OUT/icons"
  cp "$MANIFEST" "$OUT/manifest.json"
  cp "$ROOT/PRIVACY.md" "$OUT/PRIVACY.md"

  # Keep editor and OS clutter out of the uploaded package.
  find "$OUT" \( -name '.DS_Store' -o -name '*.map' -o -name '*~' \) -delete

  # The local config holds real API keys. A release build must not carry them.
  LOCAL_CONFIG="$OUT/src/common/local-config.js"
  if [[ -f "$LOCAL_CONFIG" ]]; then
    if [[ -n "${RELEASE:-}" ]]; then
      rm -f "$LOCAL_CONFIG"
      echo "  release build: local-config.js removed from the package"
    else
      echo "  WARNING: this package contains src/common/local-config.js and any"
      echo "           API key in it. Fine for loading locally. Before uploading"
      echo "           to a store, build with: RELEASE=1 ./build.sh"
    fi
  fi

  # A store build talks only to Philform's service, which answers cross-origin
  # requests, so it needs no host permission: the model APIs are for direct
  # mode, which only a development build offers.
  if [[ -n "${RELEASE:-}" ]]; then
    python3 - "$OUT/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
m = json.load(open(path))
m.pop('host_permissions', None)
# Firefox: the store build has its own id (the dev build keeps the old one, so
# a dev profile keeps its data), and self-distributed copies find updates on
# Philform's service. Neither can change once a version is signed.
gecko = m.get('browser_specific_settings', {}).get('gecko')
if gecko is not None:
    gecko['id'] = 'philform@philform'
    gecko['update_url'] = 'https://philformapp.com/firefox/updates.json'
json.dump(m, open(path, 'w'), indent=2)
PY
    echo "  release build: no required host permissions"
  fi

  python3 -c "import json,sys; json.load(open('$OUT/manifest.json'))" \
    || { echo "manifest.json for $TARGET is not valid JSON" >&2; exit 1; }

  ZIP="$DIST/philform-$TARGET.zip"
  rm -f "$ZIP"
  (cd "$OUT" && zip -qr "$ZIP" . -x '.*')

  echo "$TARGET -> $OUT  (zip: ${ZIP#$ROOT/})"
done

echo
echo "Load unpacked:"
echo "  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> dist/chrome"
echo "  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> dist/firefox/manifest.json"
