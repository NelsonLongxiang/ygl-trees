#!/usr/bin/env bash
# Publish-readiness gate: pack the real tarball, install it in an ISOLATED
# consumer, and drive the shipped binary through the core surface. Catches
# the class of bug a source-tree test cannot: workspace: protocol rewriting,
# missing files in the tarball, undeclared runtime deps, bin path errors.
#
# Usage: bash scripts/pack-check.sh   (or: pnpm pack:check)
# Exits non-zero on any failed assertion. Uses tmp/pack-check/ (gitignored).
set -uo pipefail

export YGL_TEST=1  # test scripts: skip DB lock (process-exit race on Windows)
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
TGZ=$(ls "$WORK"/*ygl-trees-*.tgz 2>/dev/null | head -1)
[ -n "$TGZ" ] && pass "tarball: $(basename "$TGZ")" || { fail "no tarball produced"; exit 1; }

echo "── 2. dependencies rewritten off workspace: (consumer installs from npm)"
DEPS=$(tar -xzOf "$TGZ" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const bad=Object.entries(j.dependencies||{}).filter(([,v])=>String(v).startsWith('workspace:'));console.log(bad.length?('BAD '+JSON.stringify(bad)):'OK')})")
if [ "$DEPS" = "OK" ]; then pass "no workspace: protocol left in published deps"; else fail "workspace: protocol survived publish: $DEPS"; fi

echo "── 3. isolated install"
mkdir -p "$WORK/consumer"
cat > "$WORK/consumer/package.json" <<'EOF'
{ "name": "ygl-pack-consumer", "version": "1.0.0", "private": true }
EOF
# stderr survives into tmp/npm-packcheck.log — a gate that swallows its own
# failure reason (npm network blip vs real defect) is anti-diagnostic.
# unset npm_config_allow_scripts: `pnpm run` injects pnpm's allow-scripts
# whitelist (e.g. @deepseek-ai/dsh-subprocess-local,koffi) into the child
# env; npm ≥10 then rejects project-scoped installs with EALLOWSCRIPTS —
# an artifact of HOW the gate is invoked, not of the tarball.
(cd "$WORK/consumer" && unset npm_config_allow_scripts && npm install "$TGZ" --no-audit --no-fund --registry=https://registry.npmjs.org/ >"$REPO/tmp/npm-packcheck.log" 2>&1) \
  && pass "installed from tarball (52-package closure resolves)" \
  || { fail "npm install from tarball failed (see tmp/npm-packcheck.log)"; exit 1; }

BIN=$(ls "$WORK"/consumer/node_modules/ygl-trees/dist/bundle/bin.cjs \
      "$WORK"/consumer/node_modules/@*/ygl-trees/dist/bundle/bin.cjs 2>/dev/null | head -1)
[ -n "$BIN" ] && [ -f "$BIN" ] && pass "shipped bundle present in tarball" || fail "dist/bundle/bin.cjs missing from tarball"

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

# #76: R3 完整入发布门禁——分两层：
#  ①已登记项漂移（meta-tooling --check）
#  ②**未登记可执行**（verify meta R3）——meta-tooling --check 抓不到后者（监督席复现：
#    dual-backend-matrix.mjs 未登记时 --check rc0 而 verify meta rc1）
node scripts/meta-tooling.mjs --check > /dev/null 2>&1 || fail "R3 tooling drift — run: node scripts/meta-tooling.mjs --check"
R3TMP=$(mktemp -d)
if ! YGL_HOME="$R3TMP" node dist/bundle/bin.cjs db init >/dev/null 2>&1; then
  rm -rf "$R3TMP"; fail "R3 gate: cannot init scratch workspace"
else
  if YGL_HOME="$R3TMP" node dist/bundle/bin.cjs verify meta . --json > "$R3TMP/meta.json" 2>/dev/null; then
    rm -rf "$R3TMP"
  else
    echo "$(cat "$R3TMP/meta.json" | head -3)" >&2
    rm -rf "$R3TMP"
    fail "R3 meta gate red — unregistered executable or rule failure (verify meta . --json)"
  fi
fi

# 0.114.30: 冲突标记防复发（发版席建议——0.114.29 README 残留 <<<<<<< 随 tarball 出厂）
if grep -r "<<<<<<< " README.md CHANGELOG.md docs/*.md 2>/dev/null; then
  fail "conflict markers present in shipped docs (grep '<<<<<<< ')"
fi

echo "── 5b. reproducible tarball (same bytes twice, same entries as npm pack)"
node scripts/pack-repro.mjs --out "$WORK/repro1.tgz" 2>"$WORK/repro1.err" || { cat "$WORK/repro1.err" >&2; fail "pack:repro failed to build tarball"; }
node scripts/pack-repro.mjs --out "$WORK/repro2.tgz" 2>"$WORK/repro2.err" || { cat "$WORK/repro2.err" >&2; fail "pack:repro failed on second run"; }
if [ -f "$WORK/repro1.tgz" ] && [ -f "$WORK/repro2.tgz" ]; then
  SHA1=$(node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$WORK/repro1.tgz")
  SHA2=$(node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$WORK/repro2.tgz")
  [ "$SHA1" = "$SHA2" ] && pass "pack:repro is deterministic (sha256 $SHA1)" || fail "pack:repro produced two different hashes: $SHA1 vs $SHA2"
  # Entry lists must stay identical: a file that only npm's packer ships (or only
  # ours) means the two packers have drifted apart.
  NPM_LIST=$(tar -tzf "$TGZ" | sort)
  REPRO_LIST=$(tar -tzf "$WORK/repro1.tgz" | sort)
  [ "$NPM_LIST" = "$REPRO_LIST" ] && pass "repro tarball ships the same entries as npm pack" || fail "repro tarball entry list differs from npm pack"
  # End-to-end publishability: the sealed bytes must install from an EMPTY
  # directory through npm itself. 0.105.0 shipped `workspace:` deps to npm and
  # no gate noticed — this section compared hashes and entry lists only, i.e.
  # byte stability, not installability.
  PROBE="$WORK/probe-consumer"
  mkdir -p "$PROBE"
  printf '{"name":"repro-probe","version":"1.0.0","private":true}' > "$PROBE/package.json"
  # Same env hygiene as the section-3 install: pnpm injects its allow-scripts
  # whitelist into the child env and npm >=10 then rejects the install with
  # EALLOWSCRIPTS; pin the public registry so a mirror hijack cannot masquerade
  # as a packaging bug.
  if ( cd "$PROBE" && unset npm_config_allow_scripts && npm i "$WORK/repro1.tgz" --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ >"$REPO/tmp/npm-repro-install.log" 2>&1 ); then
    PV=$(node "$PROBE/node_modules/ygl-trees/dist/bundle/bin.cjs" --version 2>/dev/null | tail -1)
    EXPECT=$(node -e "const f=require('fs');console.log(JSON.parse(f.readFileSync(process.argv[1],'utf8')).version)" "$REPO/package.json")
    [ "$PV" = "$EXPECT" ] && pass "npm installs the sealed tarball; shipped bin reports $PV" || fail "installed bin reported '$PV', expected '$EXPECT'"
  else
    fail "npm install of the pack:repro tarball failed (see tmp/npm-repro-install.log)"
  fi
fi

echo "── 6. cleanup"
rm -rf "$WORK" 2>/dev/null && pass "scratch removed" || echo "  (scratch left: $WORK — Windows handle)"

if [ "$FAILED" -eq 0 ]; then
  echo "pack-check: PASS"
  exit 0
fi
echo "pack-check: $FAILED FAILURE(S)"
exit 1
