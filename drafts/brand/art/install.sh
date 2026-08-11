#!/usr/bin/env bash
# Install the generated Capso art into apps/.
#
# Deliberately separate from ../mark/install.sh rather than folded into it: that
# script's contract is "the icon set", and one script copying both would let a
# partial art rebuild clobber icons. Run from anywhere:
#
#     bash drafts/brand/art/install.sh          # dry run, shows what would change
#     bash drafts/brand/art/install.sh --apply  # actually copy
#
# Destinations come from manifest.json, so this script never needs editing when
# an asset is added — the manifest is the single place a new asset is declared.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/drafts/brand/art"
OUT="$HERE/out"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

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

# One line per install target: "<basename-in-out> <dest>".
# Plain `while read` rather than `mapfile`, which is bash 4+ and this machine's
# /usr/bin/env bash is 3.2.
TARGETS="$(
  python3 - "$HERE/manifest.json" <<'PY'
import json, sys
from pathlib import Path
m = json.loads(Path(sys.argv[1]).read_text())
for a in m["assets"]:
    for i in a["install"]:
        print(Path(i["to"]).name, i["to"])
PY
)"

# Checked after the manifest, not before it: an empty manifest is a valid state
# (the mechanism lands before the art does), and it should dry-run cleanly rather
# than error about a directory nothing has asked for yet.
if [[ -z "$TARGETS" ]]; then
  echo "manifest has no assets yet — nothing to install."
  exit 0
fi

[[ -d "$OUT" ]] || { echo "error: $OUT missing — run build_art.py first" >&2; exit 1; }

while read -r name dest; do
  [[ -n "$name" ]] && copy "$name" "$dest"
done <<< "$TARGETS"

echo
if [[ $APPLY -eq 1 ]]; then
  echo "Done. Verify with: pnpm brand:check && pnpm --filter web build"
else
  echo "Dry run. Re-run with --apply to copy."
fi
