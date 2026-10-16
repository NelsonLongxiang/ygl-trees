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

WS="$(pwd)/tmp/contract-audit"
rm -rf "$WS"
export YGL_HOME="$WS"
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
  local msg; msg=$(echo "$out" | head -1)
  case "$msg" in
    *SqliteError*|*constraint*|*TypeError*)
      fail "bad ref: $desc" "raw driver error leaked: $msg" ;;
    *)
      if [ "$rc" = "1" ] && echo "$msg" | grep -q "$want"; then pass "bad ref: $desc"
      else fail "bad ref: $desc" "rc=$rc want=1 and msg~'$want', got: $msg"; fi ;;
  esac
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

echo "── contract 4: usage errors exit 2"
usage2 "unknown group"          -- $Y no-such-group
usage2 "node add without key"   -- $Y node add
usage2 "node link missing arg"  -- $Y node link a
usage2 "job add without title"  -- $Y job add
usage2 "source fetch bad url"   -- $Y research source fetch not-a-url

rm -rf "$WS"
echo "contract-audit: $((N-FAIL))/$N 通过"
[ "$FAIL" = "0" ] || exit 1
