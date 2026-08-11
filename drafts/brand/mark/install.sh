#!/usr/bin/env bash
# Install the generated Capso icon set into apps/.
#
# Copies files only. The manifest.json / layout.tsx / tauri wire-up still has to
# be done by hand — see README.md. Run from the repo root:
#
#     bash drafts/brand/mark/install.sh          # dry run, shows what would change
#     bash drafts/brand/mark/install.sh --apply  # actually copy
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/drafts/brand/mark/out"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

[[ -d "$OUT" ]] || { echo "error: $OUT missing — run build_icons.py first" >&2; exit 1; }

copy() {  # copy <src-in-out> <dest-relative-to-root>
  local src="$OUT/$1" dst="$ROOT/$2"
  [[ -f "$src" ]] || { echo "  MISSING SOURCE  $1" >&2; return 1; }
  if [[ $APPLY -eq 1 ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "  wrote  $2"
  else
    if [[ -f "$dst" ]]; then echo "  replace  $2"; else echo "  create   $2"; fi
  fi
}

echo "web:"
copy favicon.ico   apps/web/app/favicon.ico
copy icon-180.png  apps/web/public/apple-touch-icon.png
copy icon-192.png  apps/web/public/icon-192.png
copy icon-512.png  apps/web/public/icon-512.png
copy og-image.png  apps/web/public/og-image.png

echo "extension:"
copy icon-16.png   apps/extension/icons/icon16.png
copy icon-32.png   apps/extension/icons/icon32.png
copy icon-48.png   apps/extension/icons/icon48.png
copy icon-128.png  apps/extension/icons/icon128.png

echo "mac (tauri):"
copy 32x32.png            apps/mac/src-tauri/icons/32x32.png
copy 128x128.png          apps/mac/src-tauri/icons/128x128.png
copy 128x128@2x.png       apps/mac/src-tauri/icons/128x128@2x.png
copy icon.icns            apps/mac/src-tauri/icons/icon.icns
copy icon.ico             apps/mac/src-tauri/icons/icon.ico
copy icon-1024.png        apps/mac/src-tauri/icons/icon.png
copy trayTemplate.png     apps/mac/src-tauri/icons/trayTemplate.png
copy trayTemplate@2x.png  apps/mac/src-tauri/icons/trayTemplate@2x.png

echo
if [[ $APPLY -eq 1 ]]; then
  echo "Done. Still to do by hand (see README.md):"
  echo "  - apps/extension/manifest.json  — icons 16/32/48 + action.default_icon"
  echo "  - apps/web/app/layout.tsx       — metadataBase, icons, openGraph"
  echo "  - (2026-08-12: the old 'amend the NO mascot rule' follow-up is done —"
  echo "     see 15_DESIGN_SYSTEM_AND_UX.md 'Generated art'. Art shipped; character did not.)"
else
  echo "Dry run. Re-run with --apply to copy."
fi
