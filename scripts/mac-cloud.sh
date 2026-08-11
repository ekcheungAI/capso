#!/usr/bin/env bash
# Build or run the Capso Mac app with cloud sync and native sign-in enabled.
#
# apps/mac/src-tauri/build.rs reads CAPSO_SUPABASE_URL,
# CAPSO_SUPABASE_PUBLISHABLE_KEY, and CAPSO_AUTH_SITE_URL from the *process*
# environment at compile time — it does not read .env.local. A plain
# `pnpm --filter mac tauri dev` therefore produces an app that cannot sign in
# or sync, with no obvious error. This script loads .env.local and passes them
# through, so the app you run is the one the AI-01 proof needs.
#
# Usage:
#   scripts/mac-cloud.sh dev      # run the app (default)
#   scripts/mac-cloud.sh build    # produce a debug .app bundle
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-dev}"
env_file="$root/.env.local"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file — copy .env.example and fill the three CAPSO_* native values." >&2
  exit 2
fi

# Only export the public native build values. Anything else in .env.local
# (including server-only secrets) is deliberately left out of this process.
for key in CAPSO_SUPABASE_URL CAPSO_SUPABASE_PUBLISHABLE_KEY CAPSO_AUTH_SITE_URL; do
  value="$(grep -E "^${key}=" "$env_file" | head -1 | cut -d= -f2- || true)"
  if [ -z "$value" ]; then
    echo "Missing $key in $env_file. The Mac app cannot sign in or sync without it." >&2
    exit 2
  fi
  export "$key=$value"
done

case "$CAPSO_SUPABASE_PUBLISHABLE_KEY" in
  sb_publishable_*) ;;
  *)
    echo "CAPSO_SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key." >&2
    echo "A legacy anon JWT (eyJ...) is rejected by the native build." >&2
    exit 2
    ;;
esac

echo "Cloud config: $CAPSO_SUPABASE_URL"
echo "Auth site:    $CAPSO_AUTH_SITE_URL"

case "$mode" in
  dev)   exec pnpm --filter mac tauri dev ;;
  build) exec pnpm --filter mac tauri build --debug --bundles app ;;
  *)
    echo "Unknown mode '$mode'. Use 'dev' or 'build'." >&2
    exit 2
    ;;
esac
