#!/usr/bin/env bash
# Zips apps/extension into apps/web/public so the running app can serve it.
# Chrome refuses .crx installs from outside the Web Store, so a plain .zip the
# user unpacks is the only self-hosted path that actually works.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/apps/extension"
out_dir="$root/apps/web/public"
version="$(node -p "require('$src/manifest.json').version")"

# Runs inside the Vercel build too, so it must fail loudly rather than leave the
# download page serving a 404 — which is precisely what happened when this only
# ever ran on a developer's machine.
if ! command -v zip >/dev/null 2>&1; then
  echo "build-extension: 'zip' not found — /extension would serve a broken download." >&2
  exit 1
fi

mkdir -p "$out_dir"
rm -f "$out_dir/capso-extension.zip"

# -x excludes docs and OS cruft; the zip must contain only what Chrome loads.
( cd "$src" && zip -qr "$out_dir/capso-extension.zip" . -x "README.md" ".DS_Store" "*/.DS_Store" )

cat > "$out_dir/extension-version.json" <<JSON
{ "version": "$version", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON

echo "capso-extension.zip v$version → apps/web/public/ ($(du -h "$out_dir/capso-extension.zip" | cut -f1))"
