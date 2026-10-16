#!/usr/bin/env bash
# Publish-readiness gate: pack the real tarball, install it in an ISOLATED
# consumer, and drive the shipped binary through the core surface. Catches
# the class of bug a source-tree test cannot: workspace: protocol rewriting,
# missing files in the tarball, undeclared runtime deps, bin path errors.
#
# Usage: bash scripts/pack-check.sh   (or: pnpm pack:check)
# Exits non-zero on any failed assertion. Uses tmp/pack-check/ (gitignored).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$REPO/tmp/pack-check"
FAILED=0
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }
pass() { echo "  ✓ $1"; }

rm -rf "$WORK"
mkdir -p "$WORK"

echo "── 1. build + pack"
(cd "$REPO" && pnpm build >/dev/null 2>&1) || { echo "BUILD FAILED"; exit 1; }
(cd "$REPO" && pnpm pack --pack-destination "$WORK" >/dev/null 2>&1) || { echo "PACK FAILED"; exit 1; }
TGZ=$(ls "$WORK"/ygl-trees-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] && pass "tarball: $(basename "$TGZ")" || { fail "no tarball produced"; exit 1; }

echo "── 2. dependencies rewritten off workspace: (consumer installs from npm)"
DEPS=$(tar -xzOf "$TGZ" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const bad=Object.entries(j.dependencies||{}).filter(([,v])=>String(v).startsWith('workspace:'));console.log(bad.length?('BAD '+JSON.stringify(bad)):'OK')})")
if [ "$DEPS" = "OK" ]; then pass "no workspace: protocol left in published deps"; else fail "workspace: protocol survived publish: $DEPS"; fi

echo "── 3. isolated install"
mkdir -p "$WORK/consumer"
cat > "$WORK/consumer/package.json" <<'EOF'
{ "name": "ygl-pack-consumer", "version": "1.0.0", "private": true }
EOF
(cd "$WORK/consumer" && npm install "$TGZ" --no-audit --no-fund --registry=https://registry.npmjs.org/ >/dev/null 2>&1) \
  && pass "installed from tarball (52-package closure resolves)" \
  || { fail "npm install from tarball failed"; exit 1; }

BIN="$WORK/consumer/node_modules/ygl-trees/dist/bundle/bin.cjs"
[ -f "$BIN" ] && pass "shipped bundle present in tarball" || fail "dist/bundle/bin.cjs missing from tarball"

# Invoke via node directly: the .cmd shim is polluted by a host-level cmd
# AutoRun ("Active code page: ...") that would break --json parsing.
export YGL_HOME="$WORK/ws"
Y() { node "$BIN" --no-color "$@"; }
rm -rf "$YGL_HOME"

echo "── 4. shipped surface (core flow)"
Y db init >/dev/null 2>&1 && pass "db init" || fail "db init"
Y project new packcheck -q "发布包验证" >/dev/null 2>&1 && pass "project new" || fail "project new"
Y research query add "发布验证检索式" >/dev/null 2>&1 && pass "research query add" || fail "research query add"
Y tree new packtree >/dev/null 2>&1 && pass "tree new" || fail "tree new"
Y node add root --name 根节点 >/dev/null 2>&1 && pass "node add" || fail "node add"
Y agent brief >/dev/null 2>&1 && pass "agent brief" || fail "agent brief"
Y plugin init >/dev/null 2>&1 && pass "plugin init" || fail "plugin init"
Y plugin list >/dev/null 2>&1 && pass "plugin list" || fail "plugin list"
Y doctor 2>&1 | grep -q "checks passed" && pass "doctor all checks passed" || fail "doctor reported problems"

echo "── 5. --json purity (parse the whole stdout, node invocation)"
JSONOK=$(Y --json db stats 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s);console.log('OK')}catch(e){console.log('BAD')}})")
[ "$JSONOK" = "OK" ] && pass "--json stdout is parseable as a whole" || fail "--json output polluted"

echo "── 6. cleanup"
rm -rf "$WORK" 2>/dev/null && pass "scratch removed" || echo "  (scratch left: $WORK — Windows handle)"

if [ "$FAILED" -eq 0 ]; then
  echo "pack-check: PASS"
  exit 0
fi
echo "pack-check: $FAILED FAILURE(S)"
exit 1
