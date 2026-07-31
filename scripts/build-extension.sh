#!/usr/bin/env bash
# Zips apps/extension into apps/web/public so the running app can serve it.
# Chrome refuses .crx installs from outside the Web Store, so a plain .zip the
# user unpacks is the only self-hosted path that actually works.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/apps/extension"
out_dir="$root/apps/web/public"
version="$(node -p "require('$src/manifest.json').version")"

mkdir -p "$out_dir"
rm -f "$out_dir/capso-extension.zip"

# -x excludes docs and OS cruft; the zip must contain only what Chrome loads.
( cd "$src" && zip -qr "$out_dir/capso-extension.zip" . -x "README.md" ".DS_Store" "*/.DS_Store" )

cat > "$out_dir/extension-version.json" <<JSON
{ "version": "$version", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON

echo "capso-extension.zip v$version → apps/web/public/ ($(du -h "$out_dir/capso-extension.zip" | cut -f1))"
