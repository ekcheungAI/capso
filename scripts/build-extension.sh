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

# -x excludes docs, OS cruft and tooling; the zip must contain only what Chrome
# loads. `node_modules` matters most: the moment apps/extension gained a
# package.json (to give it eslint and a smoke test) the zip grew from a handful
# of files to 495 and 3.2 MB of eslint.
( cd "$src" && zip -qr "$out_dir/capso-extension.zip" . \
    -x "README.md" ".DS_Store" "*/.DS_Store" \
       "node_modules/*" "package.json" "eslint.config.mjs" "*.check.mjs" )

# A packaging mistake is invisible until someone unpacks the download, so assert
# rather than trust the exclude list.
#
# Listed once into a variable rather than piped per check: under `pipefail`,
# `unzip -l | grep -q` fails the *pipeline* when grep matches and exits early,
# because unzip then dies of SIGPIPE. Read literally, that made the presence of a
# required file report as its absence.
listing="$(unzip -l "$out_dir/capso-extension.zip")"

if grep -q "node_modules/" <<<"$listing"; then
  echo "build-extension: node_modules leaked into the zip — fix the -x list." >&2
  exit 1
fi
for required in \
  manifest.json background.js capture.js capture-coordinator.js \
  capture-spec.generated.js config.js delivery.js outbox.js projects.js \
  popup-status.js popup.html popup.js tokens.generated.js; do
  if ! grep -q " ${required}$" <<<"$listing"; then
    echo "build-extension: $required is missing from the zip — the extension would not load." >&2
    exit 1
  fi
done

cat > "$out_dir/extension-version.json" <<JSON
{ "version": "$version", "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON

echo "capso-extension.zip v$version → apps/web/public/ ($(du -h "$out_dir/capso-extension.zip" | cut -f1))"
