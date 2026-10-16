#!/usr/bin/env bash
# Bun runtime compatibility probe for ygl-trees CLI.
#
# STATUS (2026-10-16): BLOCKED on Windows.
#   bun 1.3.0 (win32 x64): fs.openSync(path, O_RDWR|O_CREAT) on a not-yet-existing
#   file throws ENOENT instead of creating it. node-sqlite3-wasm's VFS
#   (_nodejs_open -> fs.openSync) therefore cannot create a database, so even
#   `db init` fails. Node runs the same code green. See docs/bun-compat.md.
#
# Usage: bash scripts/bun-smoke.sh   (exit code = number of failed checks)
# Re-run when a new Bun release lands; all green = migration unblocked.
set -uo pipefail
cd "$(dirname "$0")/.."
export YGL_HOME="$PWD/tmp/bun-smoke"
command -v bun >/dev/null 2>&1 || { echo "bun not installed"; exit 1; }
rm -rf "$YGL_HOME"
Y="bun dist/apps/cli/src/bin.js --no-color"
pass=0; fail=0
t() { # t <name> <cmd...>
  local name="$1"; shift
  if out=$("$@" 2>&1); then
    echo "  ✓ $name"; pass=$((pass+1)); return 0
  else
    echo "  ✗ $name"; echo "$out" | head -3 | sed 's/^/    /'; fail=$((fail+1)); return 1
  fi
}

echo "── bun $(bun --version) smoke: $YGL_HOME"
t "fs.openSync O_CREAT creates file"  bun -e "require('node:fs').closeSync(require('node:fs').openSync(process.env.YGL_HOME+'/fs.db',require('node:fs').constants.O_RDWR|require('node:fs').constants.O_CREAT,420))"
t "db init"            $Y db init
t "project new"        $Y project new bun-smoke -q "bun 兼容性"
t "project show (ORM/better-sqlite3)"  $Y project show
t "source add"         $Y research source add --title "Bun 运行时" --url https://ex.com/bun --abstract "wasm sqlite 兼容" --relevance 4
t "claim add"          $Y research claim add "wasm 驱动让 CLI 运行时无关" --confidence B
t "kb search (FTS5)"   $Y kb search "运行时"
t "tree/node+index"    $Y node index
t "doctor"             $Y doctor
t "webui export"       $Y webui export --out "$YGL_HOME/dash.html"
t "agent brief"        $Y agent brief
echo "── pass=$pass fail=$fail"
[ "$fail" -gt 0 ] && echo "  blocked: see docs/bun-compat.md (Windows fs.openSync O_CREAT bug)"
exit $fail
