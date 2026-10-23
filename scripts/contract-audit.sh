#!/usr/bin/env bash
# Contract audit: the frozen write-path contract, enforced mechanically.
#
#   contract 1  idempotency  — re-running a write returns rc=0 (never a crash)
#   contract 2  duplicate    — in --json, a repeat says duplicate:true
#   contract 3  references   — a bad/foreign id yields a NAMED not-found, never
#                              a raw SqliteError (FOREIGN KEY / UNIQUE)
#   contract 4  usage        — bad usage exits 2, not 1
#
# Why this exists: `node link` and `project new`/`tree new` violated contracts
# 1-3 in production while every unit test was green — the defects only showed
# up when someone ran the commands twice by hand. This script is that hand,
# every time. Usage: bash scripts/contract-audit.sh   (pnpm contract:audit)
set -uo pipefail
cd "$(dirname "$0")/.."
export YGL_TEST=1  # test scripts: skip DB lock (process-exit race on Windows)

mkdir -p "$(pwd)/tmp"
WS="$(mktemp -d "$(pwd)/tmp/contract-audit.XXXXXX")"
export YGL_HOME="$WS"
trap 'rm -rf "$WS"' EXIT
Y="node dist/bundle/bin.cjs --no-color"
FAIL=0; N=0
pass() { N=$((N+1)); echo "  ✓ $1"; }
fail() { N=$((N+1)); FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "      $2"; }

# ── idempotency: run the same write twice, both must be rc=0
idem() { # idem <desc> -- cmd...
  local desc="$1"; shift 2
  "$@" >/dev/null 2>&1; local r1=$?
  local out; out=$("$@" 2>&1); local r2=$?
  if [ "$r1" = "0" ] && [ "$r2" = "0" ]; then pass "idempotent: $desc"
  else fail "idempotent: $desc" "rc=$r1/$r2  $(echo "$out" | head -1 | cut -c1-70)"; fi
}

# ── duplicate flag in --json
dup_flag() { # dup_flag <desc> <jq-ish node expr> -- cmd...
  local desc="$1"; local expr="$2"; shift 3
  "$@" >/dev/null 2>&1
  local got; got=$("$@" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log($expr)}catch(e){console.log('parse-fail')}})")
  if [ "$got" = "true" ]; then pass "duplicate flag: $desc"
  else fail "duplicate flag: $desc" "expected duplicate:true, got '$got'"; fi
}

# ── bad reference: rc must be 1 AND the message must name the entity, with no
#    raw driver error leaking through
badref() { # badref <desc> <expected-substring> -- cmd...
  local desc="$1"; local want="$2"; shift 3
  local out; out=$("$@" 2>&1); local rc=$?
  # 0.114.23 (#61): stderr may carry selection-observation notes before the
  # error line; match the EXPECTED substring against the WHOLE output, not
  # head -1 (timing-dependent release-gate flake). Raw driver errors are still
  # rejected wherever they appear.
  local first; first=$(echo "$out" | head -1)
  if echo "$out" | grep -qE 'SqliteError|constraint failed|TypeError'; then
    fail "bad ref: $desc" "raw driver error leaked: $first"
  elif [ "$rc" = "1" ] && echo "$out" | grep -q "$want"; then pass "bad ref: $desc"
  else fail "bad ref: $desc" "rc=$rc want=1 and output~'$want', got: $first"; fi
}

# ── usage errors must be rc=2
usage2() { # usage2 <desc> -- cmd...
  local desc="$1"; shift 2
  "$@" >/dev/null 2>&1
  if [ "$?" = "2" ]; then pass "usage rc=2: $desc"; else fail "usage rc=2: $desc" "expected 2"; fi
}

echo "── setup"
$Y db init >/dev/null 2>&1 || { echo "db init failed"; exit 1; }
$Y project new audit -q "契约审计" >/dev/null 2>&1
$Y tree new audit >/dev/null 2>&1
$Y node add a >/dev/null 2>&1; $Y node add b >/dev/null 2>&1

echo "── contract 1+2: idempotency & duplicate flag"
idem "project new (same name)"   -- $Y project new audit -q "契约审计"
idem "tree new (same name)"      -- $Y tree new audit
idem "node add (same key)"       -- $Y node add a
idem "node cond (same name)"     -- $Y node cond a --name lvl --kind level --value 1
idem "node link (same edge)"     -- $Y node link a b
idem "node unlock (already)"     -- $Y node unlock a
idem "node lock (already)"       -- $Y node lock a
idem "research query add"        -- $Y research query add "同一检索式"
idem "research source add"       -- $Y research source add --title S --url https://e.com/audit
idem "claim add"                 -- $Y research claim add "同一断言"
idem "kb add"                    -- $Y kb add --title N --body B
idem "task add"                  -- $Y task add "同一任务"
idem "job add"                   -- $Y job add audit-job -- "echo hi" --every 60
idem "config set"                -- $Y config set search.limit 7
idem "skill add"                 -- $Y skill add --name sk-audit --description d --body b
idem "produce spec"              -- $Y produce spec "审计规格" --body y
idem "job tick"                  -- $Y job tick

dup_flag "project new (same name)" "j.duplicate===true" -- $Y project new audit
dup_flag "tree new (same name)"    "j.duplicate===true" -- $Y tree new audit
dup_flag "node link (same edge)"   "j.duplicate===true" -- $Y node link a b

echo "── contract 3: bad references name the entity (no raw driver error)"
SID=$($Y --json research source add --title SA --url https://e.com/audit2 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.row?.id||j.id||'')})")
EID=$($Y --json research evidence add "$SID" --quote "审计摘录" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.row?.id||j.id||'')})")
CID=$($Y --json research claim add "审计断言" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.id||j.row?.id||'')})")
idem "research claim link (same pair)" -- $Y research claim link "$CID" "$EID" --stance supports
badref "claim link → missing evidence" "evidence not found" -- $Y research claim link "$CID" no-such-ev
badref "claim link → missing claim"    "claim not found"    -- $Y research claim link no-such-claim "$EID"
badref "claim link → source id (typed)" "evidence not found" -- $Y research claim link "$CID" "$SID"
badref "evidence add → missing source" "source not found"   -- $Y research evidence add no-such-src --quote Q
badref "claim resolve → missing claim" "claim not found"    -- $Y research claim resolve no-such-claim --as supported
badref "query attach → missing query"  "query not found"    -- $Y research query attach no-such-q "$SID"
badref "kb ingest → missing artifact"  "artifact not found" -- $Y kb ingest no-such-art
badref "kb link → missing note"        "must exist"         -- $Y kb link no-such-a no-such-b
badref "rel add → missing target"      "not found"          -- $Y rel add node:audit/a claim:no-such
badref "task doing → missing task"     "task not found"     -- $Y task doing no-such-task
badref "node link → missing parent"    "parent not found"   -- $Y node link no-such-parent b

# ── JSON channel: in --json mode stdout must parse WHOLE, carry no camelCase
#    field, and stay parseable on failures too ({"error": ...}).
json_ok() { # json_ok <desc> -- cmd...
  local desc="$1"; shift 2
  local verdict; verdict=$("$@" --json 2>/dev/null | node scripts/json-check.mjs)
  case "$verdict" in
    OK) pass "json channel: $desc" ;;
    *) fail "json channel: $desc" "$verdict" ;;
  esac
}
json_err() { # json_err <desc> <rc> -- cmd...   (failure must still parse on stdout)
  local desc="$1"; local want="$2"; shift 3
  local rc verdict
  verdict=$("$@" --json 2>/dev/null | node scripts/json-check.mjs --error); rc=$?
  if [ "$verdict" = "OK" ] && [ "$rc" = "$want" ]; then
    pass "json error: $desc (rc=$rc, {error})"
  else
    fail "json error: $desc" "rc=$rc want=$want, stdout verdict: ${verdict:-<empty>}"
  fi
}

echo "── contract 5: JSON channel (whole-stdout parse + snake_case + failure shape)"
json_ok "agent brief"          -- $Y agent brief
json_ok "db stats"             -- $Y db stats
json_ok "db path"              -- $Y db path
json_ok "db dups"              -- $Y db dups
json_ok "project show"         -- $Y project show
json_ok "project list"         -- $Y project list
json_ok "tree list"            -- $Y tree list
json_ok "node list"            -- $Y node list
json_ok "node show"            -- $Y node show a
json_ok "node parents"         -- $Y node parents b
json_ok "node children"        -- $Y node children a
json_ok "node ancestors"       -- $Y node ancestors b
json_ok "node descendants"     -- $Y node descendants a
json_ok "node path"            -- $Y node path b
json_ok "node ready"           -- $Y node ready
json_ok "node export"          -- $Y node export
json_ok "node can"             -- $Y node can b
json_ok "node validate"        -- $Y node validate
json_ok "rel list"             -- $Y rel list
json_ok "task list"            -- $Y task list
json_ok "kb list"              -- $Y kb list
json_ok "config list"          -- $Y config list
json_ok "config get"           -- $Y config get search.limit
json_ok "doctor"               -- $Y doctor
json_ok "plugin list"          -- $Y plugin list
json_ok "skill list"           -- $Y skill list
json_ok "job list"             -- $Y job list
json_ok "job logs"             -- $Y job logs
json_ok "agent log"            -- $Y agent log
json_ok "produce list"         -- $Y produce list
json_err "bad reference"          1 -- $Y node link no-such-a no-such-b
json_err "claim not found"        1 -- $Y research claim resolve no-such --as supported
json_err "task not found"         1 -- $Y task doing no-such
json_err "claim link bad evidence" 1 -- $Y research claim link no-such no-such2
json_err "usage: node add"        2 -- $Y node add
json_err "usage: unknown group"   2 -- $Y no-such-group-at-all
# P1-4 (REVIEW-0.84.0): missing db must keep stdout a single {"error":…} object
json_err "usage: db missing"      2 -- env YGL_HOME="$WS-no-db" $Y kb add --title T --body B

# ── flag validation: bare flags and bad enums must be rejected (rc=2),
#    never silently stored as "true"/"nonsense" (0.54 cold-user audit class).
flag_reject() { # flag_reject <desc> -- cmd...
  local desc="$1"; shift 2
  local out rc; out=$("$@" 2>&1); rc=$?
  if [ "$rc" = "2" ] && echo "$out" | grep -q "needs a value\|must be one of\|must be an integer"; then
    pass "flag reject: $desc"
  else
    fail "flag reject: $desc" "rc=$rc (want 2), msg: $(echo "$out" | head -1 | cut -c1-50)"
  fi
}

echo "── contract 6: flag validation (bare + enum → rc=2, no write)"
flag_reject "source --abstract (bare)"   -- $Y research source add --title T --url https://e.com/v --abstract
flag_reject "claim --confidence (bare)"  -- $Y research claim add T --confidence
flag_reject "kb --body (bare)"           -- $Y kb add --title T --body
flag_reject "kb --tags (bare)"           -- $Y kb add --title T --body B --tags
flag_reject "node --name (bare)"         -- $Y node add fn1 --name
flag_reject "node --kind (bare)"         -- $Y node add fn2 --kind
flag_reject "cond --value (bare)"        -- $Y node cond a --name FX --kind level --value
flag_reject "task --note (bare)"         -- $Y task add T --note
flag_reject "node --kind nonsense"       -- $Y node add fn3 --kind nonsense
flag_reject "cond --op nonsense"         -- $Y node cond a --name FZ --kind flag --op nonsense --value 1
flag_reject "cond --effect nonsense"     -- $Y node cond a --name FW --kind flag --op has --value 1 --effect nonsense

flag_reject "relevance 0.95 (REAL)"  -- $Y research source add --title T --url https://e.com/rel --relevance 0.95
flag_reject "relevance 99 (range)"    -- $Y research source add --title T --url https://e.com/rel2 --relevance 99

echo "── contract 4: usage errors exit 2"
usage2 "unknown group"          -- $Y no-such-group
usage2 "node add without key"   -- $Y node add
usage2 "node link missing arg"  -- $Y node link a
usage2 "job add without title"  -- $Y job add
usage2 "source fetch bad url"   -- $Y research source fetch not-a-url

# ── R16 selection resolution: multi-project unselected fails closed;
#    workspace-level commands stay open; session selection restores.
echo "── contract 7: R16 会话选择分辨率（多项目未选择 fail-closed）"
$Y project new audit-b >/dev/null 2>&1
$Y db sql "DELETE FROM meta WHERE key LIKE 'current_project@%'" >/dev/null 2>&1
json_err "R16 ambiguous research gate" 2 -- $Y research claim list
json_err "R16 ambiguous agent brief"   2 -- $Y agent brief
json_ok  "R16 exemption doctor"        -- $Y doctor
json_ok  "R16 exemption project list"  -- $Y project list
json_ok  "R16 exemption calibration --all (workspace scope)" -- $Y research claim calibration --all
$Y project use audit >/dev/null 2>&1
json_ok  "R16 session selection restores research" -- $Y research claim list
$Y db sql "DELETE FROM projects WHERE name='audit-b'" >/dev/null 2>&1

# ── 0.90 predict list projection: JSON array + machine-readable settlement.
echo "── contract 8: 0.90 predict list 投影（channel/outcome/三段式 note）"
PC90=$($Y research claim add "[预测·14天] 2027-01-01 前 审计投影——npm 版本 ≥99" --channel review-rounds --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.id||j.row?.id||'')})")
PLJ=$($Y research predict list --json 2>/dev/null)
case "$PLJ" in *"$PC90"*'"outcome": "未结算"'*'"channel": "review-rounds"'*) pass "predict list JSON 投影（channel + outcome）";; *) fail "predict list projection" "$PLJ";; esac
# 单T1 (direct-ef742b29): predict list --all is workspace-scoped — unselected rc=0.
# audit home has 2 projects (audit + audit-b deleted only AFTER contract 7) —
# but audit-b is gone by now, so seed a throwaway second project to make the
# unselected state genuinely ambiguous, then clear ALL selection keys.
$Y project new audit-t2 >/dev/null 2>&1
$Y db sql "DELETE FROM meta WHERE key LIKE 'current_project@%'" >/dev/null 2>&1
PLW=$($Y research predict list --all --json 2>/dev/null); PLC=$?
if [ "$PLC" = "0" ]; then
  case "$PLW" in *"$PC90"*) pass "predict list --all 工作区豁免（未选择 rc=0 跨项目可见）";; *) fail "predict list --all workspace" "$PLW";; esac
else
  fail "predict list --all rc" "rc=$PLC"
fi
# 单T2: claim list projection carries channel (explicit, null or set).
$Y project use audit >/dev/null 2>&1
CLJ=$($Y research claim list --json 2>/dev/null)
case "$CLJ" in *'"channel": "review-rounds"'*|*'"channel": null'*) pass "claim list 投影含 channel";; *) fail "claim list channel" "$CLJ";; esac
$Y db sql "DELETE FROM projects WHERE name='audit-t2'" >/dev/null 2>&1
$Y db sql "DELETE FROM claims WHERE id='$PC90'" >/dev/null 2>&1

# ── contract 9: patrol 命令族（0.93-T2）——SQL 门 rc=2 / 生命周期 JSON 纯净 ──
echo "── contract 9: patrol 边界断言（SQL 门 + JSON）"
json_err "patrol non-SELECT gate" 2 -- $Y patrol add evil --sql "DELETE FROM artifacts"
json_err "patrol semicolon gate"  2 -- $Y patrol add evil2 --sql "SELECT 1; DROP TABLE events"
PATJ=$($Y patrol add pc-audit --sql "SELECT id FROM projects WHERE status='zombie'" --severity S1 --json 2>/dev/null); PATC=$?
if [ "$PATC" = "0" ] && printf '%s' "$PATJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.name==='pc-audit'?0:1)})"; then
  pass "patrol add json 单对象"
else
  fail "patrol add json" "$PATJ"
fi
PATR=$($Y patrol run --json 2>/dev/null); PATRC=$?
if [ "$PATRC" = "0" ] && printf '%s' "$PATR" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(typeof j.open_total==='number'?0:1)})"; then
  pass "patrol run json open_total"
else
  fail "patrol run json" "$PATR"
fi
$Y patrol rm pc-audit >/dev/null 2>&1 || true

# ── contract 10: 批九增补写命令（node move / claim unlink / evidence rm / source rm）
#    verification-seat P2: these four had ZERO contract-audit coverage — rerun
#    behavior, usage rc=2, named bad refs and single-object JSON errors are now
#    pinned here (they only showed up when run by hand, same reason this script
#    exists at all).
echo "── contract 10: 批九增补命令（move/unlink/rm 契约）"
jid() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.id||j.row?.id||'')}catch(e){console.log('')}})"; }

$Y tree new mv-target >/dev/null 2>&1
$Y node add lonely-move -t audit >/dev/null 2>&1
idem "node move (retry idempotent)" -- $Y node move lonely-move --to mv-target -t audit
dup_flag "node move (retry duplicate flag)" "j.duplicate===true" -- $Y node move lonely-move --to mv-target -t audit
badref "node move → missing node" "node not found" -- $Y node move no-such-node --to mv-target -t audit
badref "node move → missing target tree" "tree not found" -- $Y node move a --to no-such-tree -t audit
usage2 "node move without --to" -- $Y node move a -t audit
json_err "node move bad ref" 1 -- $Y node move no-such-node --to mv-target -t audit

MVS=$($Y --json research source add --title MVS --url https://e.com/mv-s 2>/dev/null | jid)
MVE=$($Y --json research evidence add "$MVS" --quote "mv quote" 2>/dev/null | jid)
MVC=$($Y --json research claim add "mv 断言" 2>/dev/null | jid)
$Y research claim link "$MVC" "$MVE" --stance supports >/dev/null 2>&1
json_ok "claim unlink" -- $Y research claim unlink "$MVC" "$MVE"
badref "claim unlink → not linked" "link not found" -- $Y research claim unlink "$MVC" "$MVE"
json_err "claim unlink not linked" 1 -- $Y research claim unlink "$MVC" "$MVE"
badref "claim unlink → missing claim" "claim not found" -- $Y research claim unlink no-such "$MVE"
badref "claim unlink → missing evidence" "evidence not found" -- $Y research claim unlink "$MVC" no-such
usage2 "claim unlink missing args" -- $Y research claim unlink "$MVC"

RME=$($Y --json research evidence add "$MVS" --quote "rm quote" 2>/dev/null | jid)
RMC=$($Y --json research claim add "rm 断言" 2>/dev/null | jid)
$Y research claim link "$RMC" "$RME" --stance supports >/dev/null 2>&1
badref "evidence rm → linked refuses" "is linked to 1 claim" -- $Y research evidence rm "$RME"
json_err "evidence rm linked" 1 -- $Y research evidence rm "$RME"
json_ok "evidence rm --force" -- $Y research evidence rm "$RME" --force
badref "evidence rm → gone" "evidence not found" -- $Y research evidence rm "$RME"
usage2 "evidence rm without id" -- $Y research evidence rm

RMS=$($Y --json research source add --title RMS --url https://e.com/rm-s 2>/dev/null | jid)
$Y --json research evidence add "$RMS" --quote "src rm quote" >/dev/null 2>&1
badref "source rm → evidence refuses" "still has 1 evidence row" -- $Y research source rm "$RMS"
json_err "source rm with evidence" 1 -- $Y research source rm "$RMS"
json_ok "source rm --force" -- $Y research source rm "$RMS" --force
badref "source rm → gone" "source not found" -- $Y research source rm "$RMS"
usage2 "source rm without id" -- $Y research source rm

# ── contract 11: 0.110.0 可发现性命令（example / lint-candidates / predict --due）
echo "── contract 11: 0.110.0 可发现性（example/lint/predict --due）"
EX=$($Y verify example --json 2>/dev/null); EXRC=$?
if [ "$EXRC" = "0" ] && printf '%s' "$EX" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(/corpus/.test(j._derived_from||'')&&Array.isArray(j.examples)&&j.examples.length===7?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify example 七型派生（自declare corpus 来源）"
else
  fail "verify example" "rc=$EXRC $(printf '%s' "$EX" | head -c 120)"
fi
json_err "verify example unknown checker" 2 -- $Y verify example --checker nope
json_err "verify example unknown flag" 2 -- $Y verify example --bogus

cat > "$WS/lint-cands.json" <<'JSON'
{"candidates":[{"source_clause":"X","anchor":{"quote":"X","locator":"m#L1"},"checker":{"type":"bogus"}}]}
JSON
LJ=$($Y verify lint-candidates "$WS/lint-cands.json" --json 2>/dev/null); LRC=$?
if [ "$LRC" = "0" ] && printf '%s' "$LJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ok===false&&j.issues.length===1?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify lint-candidates 只读投影（rc=0、ok:false、单条 issue）"
else
  fail "verify lint-candidates" "rc=$LRC $(printf '%s' "$LJ" | head -c 120)"
fi
json_err "verify lint unknown flag" 2 -- $Y verify lint-candidates "$WS/lint-cands.json" --bogus

json_err "predict list unknown flag" 2 -- $Y research predict list --bogus
json_err "predict audit unknown flag" 2 -- $Y research predict audit --bogus
PD=$($Y research predict list --due --json 2>/dev/null); PDRC=$?
if [ "$PDRC" = "0" ] && printf '%s' "$PD" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(Array.isArray(j)?0:1)}catch(e){process.exit(1)}})"; then
  pass "predict list --due 空集 rc=0（JSON 数组）"
else
  fail "predict list --due" "rc=$PDRC $(printf '%s' "$PD" | head -c 120)"
fi

# ── contract 12: verify meta（charter §4.1，0.111.0）
echo "── contract 12: verify meta R1-R3"
json_ok "verify meta 本仓 PASS（rc 镜像 verdict）" -- $Y verify meta .
mkdir -p "$WS/meta-bad"
METAJ=$($Y verify meta "$WS/meta-bad" --json 2>/dev/null); METARC=$?
if [ "$METARC" = "1" ] && printf '%s' "$METAJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.verdict==='FAIL'&&j.rules.some(r=>r.id==='R1'&&r.verdict==='FAIL')?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify meta 缺 AGENTS.md → rc=1 + R1 FAIL（JSON）"
else
  fail "verify meta FAIL path" "rc=$METARC $(printf '%s' "$METAJ" | head -c 120)"
fi
json_err "verify meta missing repo" 2 -- $Y verify meta "$WS/no-such-repo"

# 12c: tooling 登记漂移（meta-tooling --check 与 verify meta R3 同源；GLM Q3：禁 auto-rehash）
echo "── contract 12c: tooling 登记漂移"
if node scripts/meta-tooling.mjs --check >/dev/null 2>&1 && node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const sha = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const byPath = new Map((j.tooling || []).map((t) => [t.path, t.sha256]));
const last = new Map();
for (const e of j.reregistrations || []) {
  if (!byPath.has(e.path)) process.exit(1);          // audit entry for an unregistered path
  if (!e.reason || !String(e.reason).trim()) process.exit(1);
  if (!sha(e.old_sha256) || !sha(e.new_sha256)) process.exit(1);
  if (Number.isNaN(Date.parse(e.at))) process.exit(1);
  last.set(e.path, e.new_sha256);
}
for (const [p, s] of byPath) if (last.has(p) && last.get(p) !== s) process.exit(1); // chain must end at the live sha
' verify/meta.json; then
  pass "meta-tooling --check 0 drift + reregistrations[] 链与活 sha 一致（随仓库审计）"
else
  fail "tooling drift / audit chain" "$(node scripts/meta-tooling.mjs --check 2>&1 | head -2; node -e 'const j=require("./verify/meta.json");process.stdout.write("reregistrations="+(j.reregistrations||[]).length)' 2>&1)"
fi

# ── contract 12b: meta_index_version 2 登记制（charter §4.4 R3 登记豁免 + v1.2 R5a 静态合规；#27 方案 T7a）
#    登记的 orchestration（verify/orchestration/ 下、sha 一致、replaced_by ∈ §4.7 闭集、完整 semver sunset）
#    与 tooling（sha 一致）放行；replaced_by 不在闭集 → R5a FAIL（rc=1，JSON 点名）。
SHA256_OF() { node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" "$1"; }
mkdir -p "$WS/meta-v2/verify/orchestration"
printf '# fixture\n' > "$WS/meta-v2/AGENTS.md"
printf 'export const run = () => 0;\n' > "$WS/meta-v2/verify/orchestration/run.mjs"
printf '#!/bin/sh\necho build\n' > "$WS/meta-v2/build.sh"
V2_ORCH_SHA=$(SHA256_OF "$WS/meta-v2/verify/orchestration/run.mjs")
V2_TOOL_SHA=$(SHA256_OF "$WS/meta-v2/build.sh")
write_meta_v2() { # write_meta_v2 <replaced_by>
  printf '{"meta_index_version":2,"specs":[],"orchestration":[{"path":"verify/orchestration/run.mjs","sha256":"%s","role":"invoke","replaced_by":"%s","sunset":"0.120.0"}],"tooling":[{"path":"build.sh","sha256":"%s","role":"build"}]}\n' "$V2_ORCH_SHA" "$1" "$V2_TOOL_SHA" > "$WS/meta-v2/verify/meta.json"
}
write_meta_v2 "verify tree run"
METAV2J=$($Y verify meta "$WS/meta-v2" --json 2>/dev/null); METAV2RC=$?
if [ "$METAV2RC" = "0" ] && printf '%s' "$METAV2J" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const ids=j.rules.map(r=>r.id).join(',');process.exit(j.verdict==='PASS'&&j.meta_index_version===2&&ids==='R1,R2,R3,R5a'?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify meta v2 登记制 PASS（orchestration + tooling 放行，报告 R1,R2,R3,R5a，R5a 无时钟）"
else
  fail "verify meta v2 PASS path" "rc=$METAV2RC $(printf '%s' "$METAV2J" | head -c 160)"
fi
write_meta_v2 "verify tree-run"
METAV2J=$($Y verify meta "$WS/meta-v2" --json 2>/dev/null); METAV2RC=$?
if [ "$METAV2RC" = "1" ] && printf '%s' "$METAV2J" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const r=j.rules.find(x=>x.id==='R5a');process.exit(j.verdict==='FAIL'&&r&&r.verdict==='FAIL'&&JSON.stringify(r.evidence).includes('verify tree-run')?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify meta v2 replaced_by 不在 §4.7 闭集 → rc=1 + R5a FAIL 点名"
else
  fail "verify meta v2 R5a FAIL path" "rc=$METAV2RC $(printf '%s' "$METAV2J" | head -c 160)"
fi

# ── contract 13: verify probe matrix（charter §4.3，0.112.0）
echo "── contract 13: verify probe --matrix"
PROBEJ=$($Y verify probe --matrix --json 2>/dev/null); PROBERC=$?
if [ "$PROBERC" = "0" ] && printf '%s' "$PROBEJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const want=['envelope','signature','digest','timestamp','escalation','injection','cross-machine','replay','tamper-spec','tamper-engine','tamper-footer','noncanon','sig-byte','unknown-key','retired-key','resign-fv'];process.exit(j.verdict==='PASS'&&JSON.stringify(j.probes.map(p=>p.probe))===JSON.stringify(want)?0:1)}catch(e){process.exit(1)}})"; then
  pass "verify probe --matrix 16 向全 PASS（离线 RFC8032 种子）"
else
  fail "verify probe matrix" "rc=$PROBERC $(printf '%s' "$PROBEJ" | head -c 120)"
fi
json_err "verify probe unknown probe" 2 -- $Y verify probe --matrix --only nope

# ── contract 14: 0.113.0 版本键控机械门（charter §4.2）
echo "── contract 14: meta 默认硬（版本键控）"
VERSION=$(node -e "console.log(require('./package.json').version)")
if node -e "const v=require('./package.json').version.split('.').map(Number);process.exit(v[0]>0||v[1]>113||(v[1]===113&&v[2]>=0)?0:1)"; then
  if grep -q 'META_DEFAULT_POLICY = "hard-for-verifier-repos"' packages/ops/tools/src/meta-gate.ts && grep -q 'gitRootOf' packages/ops/tools/src/meta-gate.ts && grep -q 'meta.bypass' packages/ops/tools/src/meta-gate.ts; then
    pass "版本 $VERSION ≥ 0.113.0：meta 默认 = hard-for-verifier-repos（阶梯 2）+ bypass 落账"
  else
    fail "version-keyed meta gate" "0.113.0+ but default policy markers missing"
  fi
else
  pass "版本 $VERSION < 0.113.0：翻转门未到期（键控断言待 0.113.0）"
fi

# ── contract 15: #34 子句覆盖（判据不静默消失）——#34 修正后子句按规则界定：
#    匹配 `^([A-Z][0-9]+) ` 的行才是子句（标题/散文不是）；#<id> 先按子句 id 解析，行引用写 #line=<n>；
#    豁免只认 id / 原文 + 必填 reason，不认行号；舰队真实材料（tests/fixtures/fleet）必须 lint ok 且 prepare ready。
echo "── contract 15: 子句覆盖（clause coverage）"
mkdir -p "$WS/cov"
printf '# 账单验收\n\n验收对象：bills 表。\n\n## 判据\nS1 账面必须平衡。\nL2 金额不得为负。\nS3 日期必须完整。\n' > "$WS/cov/material.txt"
node -e '
const fs = require("fs");
const dir = process.argv[1];
const mk = (quote, id) => ({ source_clause: quote, anchor: { quote, locator: `material.txt#${id}` }, checker: { type: "count", predicate: { from: "bills", select: [] }, op: ">=", value: 0 } });
fs.writeFileSync(`${dir}/candidates.json`, JSON.stringify({ candidates: [mk("S1 账面必须平衡。", "S1"), mk("L2 金额不得为负。", "L2")] }));
fs.writeFileSync(`${dir}/exempt.json`, JSON.stringify({ exempt: [{ id: "S3", reason: "enforced upstream" }] }));
fs.writeFileSync(`${dir}/exempt-line.json`, JSON.stringify({ exempt: [{ locator: "#line=8", reason: "line anchor" }] }));
' "$WS/cov"
COVJ=$($Y verify lint-candidates "$WS/cov/candidates.json" --text "$WS/cov/material.txt" --json 2>/dev/null); COVRC=$?
if [ "$COVRC" = "0" ] && printf '%s' "$COVJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ok===false&&j.coverage_skipped===false&&j.coverage&&j.coverage.clauses===3&&j.coverage.covered===2&&j.coverage.uncovered.length===1&&j.coverage.uncovered[0].id==='S3'&&j.issues.every(i=>i.stage==='COVERAGE')?0:1)}catch(e){process.exit(1)}})"; then
  pass "lint 子句未覆盖 → ok:false + COVERAGE S3（标题/散文不计子句；#S1/#L2 按 id 解析）"
else
  fail "coverage lint" "rc=$COVRC $(printf '%s' "$COVJ" | head -c 160)"
fi
COVJ2=$($Y verify lint-candidates "$WS/cov/candidates.json" --text "$WS/cov/material.txt" --coverage-exempt "$WS/cov/exempt.json" --json 2>/dev/null); COVRC2=$?
if [ "$COVRC2" = "0" ] && printf '%s' "$COVJ2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ok===true&&j.coverage&&j.coverage.exempted===1?0:1)}catch(e){process.exit(1)}})"; then
  pass "具名豁免（按子句 id）→ ok:true（豁免计数可审计）"
else
  fail "coverage exempt" "rc=$COVRC2 $(printf '%s' "$COVJ2" | head -c 160)"
fi
COVJ3=$($Y verify lint-candidates "$WS/cov/candidates.json" --text "$WS/cov/material.txt" --coverage-exempt "$WS/cov/exempt-line.json" --json 2>/dev/null)
if printf '%s' "$COVJ3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ok===false&&j.coverage.exempted===0&&/line number/.test(j.coverage.problems[0]||'')?0:1)}catch(e){process.exit(1)}})"; then
  pass "按行号豁免 → 拒（编辑会静默改靶）"
else
  fail "coverage exempt by line" "$(printf '%s' "$COVJ3" | head -c 160)"
fi
printf '# 无编号材料\n\n验收对象：bills 表。账面必须平衡。\n' > "$WS/cov/prose.md"
printf '{"candidates":[{"source_clause":"账面必须平衡。","anchor":{"quote":"账面必须平衡。","locator":"prose.md#line=3"},"checker":{"type":"count","predicate":{"from":"bills","select":[]},"op":">=","value":0}}]}' > "$WS/cov/prose-c.json"
COVJ4=$($Y verify lint-candidates "$WS/cov/prose-c.json" --text "$WS/cov/prose.md" --json 2>/dev/null)
if printf '%s' "$COVJ4" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.exit(j.ok===true&&j.coverage_skipped===true&&j.coverage.enforced===false&&j.coverage.clauses===0&&j.issues.length===1&&j.issues[0].stage==='COVERAGE'&&j.issues[0].level==='warning'?0:1)}catch(e){process.exit(1)}})"; then
  pass "无编号材料 → coverage_skipped:true + COVERAGE warning issue（跳过≠通过，机器可读）"
else
  fail "coverage skip visible" "$(printf '%s' "$COVJ4" | head -c 160)"
fi
# 舰队真实材料（tests/fixtures/fleet，24 份：review 7 + webui 6（含 view）+ fleet 2 + design 9，全部带标题/散文/纪律节）：
# 每份 lint --text --reviews 必须 ok，submit → prepare --draft 必须 ready（快照 schema 由候选谓词合成，P4 空库红队照跑）。
# 任何 not-ok / not-ready 都是发布阻断。
FLEETOUT=$(Y_BIN="dist/bundle/bin.cjs" FX="packages/verify/core/tests/fixtures/fleet" node - "$WS/fleet" <<'NODE' 2>&1
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const y = (args) => {
  const r = spawnSync(process.execPath, [process.env.Y_BIN, "--no-color", ...args, "--json"], { encoding: "utf8" });
  try { return { rc: r.status, j: JSON.parse(r.stdout.trim()) }; } catch { return { rc: r.status, j: null, raw: (r.stdout + r.stderr).slice(0, 200) }; }
};
const schema = (cands) => {
  const t = new Map();
  const tb = (n) => t.get(n) ?? t.set(n, new Set()).get(n);
  const cols = (n, acc) => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach((x) => cols(x, acc)); for (const [k, v] of Object.entries(n)) k === "col" && typeof v === "string" ? acc.add(v.split(".").pop()) : cols(v, acc); };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const p = n.predicate;
    if (p && typeof p.from === "string" && !p.from.startsWith("$vu:")) { const s = tb(p.from); (p.select ?? []).forEach((c) => s.add(String(c).split(".").pop())); cols(p.where, s); cols(p.scan, s); cols(p.agg, s); }
    if (n.against && n.against.from) tb(n.against.from).add(n.against.col);
    Object.values(n).forEach(walk);
  };
  cands.forEach((c) => walk(c.checker));
  return t;
};
let n = 0, bad = 0;
for (const repo of fs.readdirSync(process.env.FX)) {
  const rd = path.join(process.env.FX, repo);
  if (!fs.statSync(rd).isDirectory()) continue;
  for (const spec of fs.readdirSync(rd)) {
    const d = path.join(rd, spec), name = `${repo}/${spec}`;
    const c = path.join(d, "candidates.json"), r = path.join(d, "reviews.json"), m = path.join(d, "material.md");
    const db = path.join(out, `${repo}-${spec}.sqlite`);
    const h = new DatabaseSync(db);
    for (const [t, cs] of schema(JSON.parse(fs.readFileSync(c, "utf8")).candidates)) h.exec(`CREATE TABLE "${t}" (${[...cs].map((x) => `"${x}"`).join(", ") || "x"})`);
    h.close();
    n++;
    const lint = y(["verify", "lint-candidates", c, "--text", m, "--reviews", r, "--db", db]);
    if (lint.rc !== 0 || lint.j?.ok !== true || lint.j?.coverage_skipped !== false) { bad++; console.log(`✗ ${name} lint ${JSON.stringify(lint.j?.issues ?? lint.raw).slice(0, 160)}`); continue; }
    const sub = y(["verify", "submit", "--title", name, "--text", m, "--no-meta"]);
    const prep = y(["verify", "prepare", sub.j?.material_id ?? "", "--candidates", c, "--reviews", r, "--db", db, "--no-meta", "--draft"]);
    if (prep.rc !== 0 || prep.j?.verdict !== "ready") { bad++; console.log(`✗ ${name} prepare ${JSON.stringify(prep.j?.diagnostics ?? prep.raw).slice(0, 160)}`); }
  }
}
console.log(`fleet fixtures: ${n - bad}/${n}`);
process.exit(bad || n === 0 ? 1 : 0);
NODE
); FLEETRC=$?
if [ "$FLEETRC" = "0" ]; then
  pass "舰队真实材料 lint --text --reviews ok + prepare ready（$(printf '%s' "$FLEETOUT" | tail -1)）"
else
  fail "fleet fixtures lint+prepare" "$(printf '%s' "$FLEETOUT" | head -c 400)"
fi

rm -rf "$WS"
echo "contract-audit: $((N-FAIL))/$N 通过"
[ "$FAIL" = "0" ] || exit 1
