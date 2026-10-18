#!/usr/bin/env bash
# ygl-trees end-to-end demo: research -> production -> knowledge reuse,
# plus the tech-tree node model (parent/child, required vs optional, indexes).
# Uses its OWN scratch workspace (mktemp'd by default; YGL_DEMO_HOME overrides —
# caller then owns the directory). Never point it at a workspace you care about.
set -euo pipefail
export YGL_TEST=1  # demo: skip DB lock
# Isolated scratch home (P1-3, REVIEW-0.84.0): mktemp guarantees uniqueness even
# when PID collides across shells/hosts; cleanup on exit. YGL_DEMO_HOME overrides
# (kept — caller then owns the directory and its lifetime).
CREATED_HOME=0
if [ -n "${YGL_DEMO_HOME:-}" ]; then
  export YGL_HOME="$YGL_DEMO_HOME"
else
  export YGL_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ygl-demo.XXXXXX")"
  CREATED_HOME=1
fi
cleanup() { [ "$CREATED_HOME" = 1 ] && rm -rf "$YGL_HOME" || true; }
trap cleanup EXIT
# Exercise the SHIPPED entry: the tsdown bundle (single file) when built,
# else the tsc tree (dev path). Both are the same code; the bundle is what
# `pnpm build` + the published `bin` field deliver.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$REPO/dist/bundle/bin.cjs" ]; then
  Y="node $REPO/dist/bundle/bin.cjs --no-color"
else
  Y="node $REPO/dist/apps/cli/src/bin.js --no-color"
fi
rm -rf "$YGL_HOME"

echo "── 1. workspace"
$Y db init
# 0.48：冷启动内置技能自动导入——全新工作区的 agent match 必须立即可用
sleep 2  # auto-import is async
NS=$($Y agent brief --json 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).counts.skills')
if [ "$NS" -ge 9 ]; then echo "  ✓ 冷启动内置技能自动导入（$NS 个，agent match 即可用）"; else echo "  ✗ 冷启动技能数：$NS（期望 ≥9）"; exit 1; fi
$Y project new techtree -q "科技树数据模型如何建模与索引"
$Y config set search.limit 5 >/dev/null
CL=$($Y config get search.limit --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).value))")
if [ "$CL" = "5" ]; then echo "  ✓ config set/get round-trip"; else echo "  ✗ config: $CL"; exit 1; fi
$Y config reset search.limit >/dev/null
S=$($Y project show --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s)).join(',')))")
if [ "$S" = "project,queries,claims,selection_source" ]; then echo "  ✓ project show (TypeORM pilot) shape ok"; else echo "  ✗ project show shape: $S"; exit 1; fi

echo "── 2. skill registry (L1/L2/L3)"
mkdir -p "$YGL_HOME/skills"
cat > "$YGL_HOME/skills/tech-tree-research.md" <<'EOF'
---
name: tech-tree-research
description: >-
  建模与校验科技树/技能树的依赖图（DAG）：设计节点与边、检测环、
  选择关系库或内存索引方案。触发词：科技树、技能树、依赖图、DAG、解锁条件。
version: 0.1.0
tags: modeling,dag,game
---
1. 静态图定义、玩家解锁状态、效果系统三层分开。
2. 规范数据用邻接表保真，读压力大时叠加闭包表。
3. 运行时维护拓扑序 + 双向邻接 + BitSet 已解锁集合 + 候选集。
EOF
$Y skill import "$YGL_HOME/skills/tech-tree-research.md"
$Y agent match "我要给游戏做一棵科技树，怎么建依赖图"

echo "── 3. research: source -> evidence -> claim"
$Y research source add --title "邻接表 vs 闭包表" --url https://ex.com/a \
   --abstract "邻接表保真，闭包表加速" --relevance 4 --confidence A
$Y research source add --title "运行时索引结构" --url https://ex.com/b \
   --abstract "拓扑序+双向邻接+BitSet+候选集" --relevance 5 --confidence A
$Y research source add --title "重复项" --url https://ex.com/a            # dedupe check
A=$($Y research source list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.find(x=>x.title.includes('闭包表')).id)})")
$Y research evidence add "$A" --quote "邻接表保真，闭包表加速查询" --locator "§2"
$Y research claim add "科技树本质是 DAG，应把静态定义、解锁状态、效果系统三层分开" --confidence A
C=$($Y research claim list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
E=$($Y research evidence list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
# 0.84：链接自动评估已 await 落账——demo 全程离线，保证确定性（无网络依赖）
YGL_EVAL_OFFLINE=1 $Y research claim link "$C" "$E"

echo "── 4. production"
$Y produce section "落地建议" --body "1. 邻接表保真
2. 读压力大时叠加闭包表
3. 运行时维护拓扑序+双向邻接+BitSet+候选集"
RPT=$($Y produce report)
echo "$RPT" | head -12
case "$RPT" in
  *"UTC by ygl-trees"*) echo "  ✓ report _generated marker is UTC-labeled";;
  *) echo "  ✗ report UTC marker missing"; exit 1;;
esac

echo "── 5. knowledge reuse"
R=$($Y produce list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(x=>x.kind==='report').id))")
$Y kb ingest "$R"
$Y kb search "科技树怎么判断能不能研究"

echo "── 5b. idempotency (retries must not duplicate)"
D=$($Y research claim add "幂等性测试断言" 2>&1); D2=$($Y research claim add "幂等性测试断言" 2>&1)
case "$D2" in *duplicate*) echo "  ✓ claim add idempotent";; *) echo "  ✗ claim add NOT idempotent: $D2"; exit 1;; esac
D=$($Y kb ingest "$R" 2>&1)
case "$D" in *duplicate*) echo "  ✓ kb ingest idempotent";; *) echo "  ✗ kb ingest NOT idempotent: $D"; exit 1;; esac

echo "── 5c. kb promote → agent match"
K=$($Y kb list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(x=>x.tags==='report').id))")
$Y kb promote "$K" --name techtree-report >/dev/null
M=$($Y agent match "科技树 建模" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).matches.map(x=>x.name).join(',')))")
case "$M" in *techtree-report*) echo "  ✓ promoted skill discoverable via agent match";; *) echo "  ✗ promoted skill NOT matched: $M"; exit 1;; esac

echo "── 5d. query attach + claim resolve (arbitration)"
$Y research query add "邻接表 闭包表 对比" >/dev/null
$Y research query attach "邻接表 闭包表 对比" "$A" >/dev/null
QS=$($Y research query list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const q=JSON.parse(s).find(x=>x.text.includes('对比'));console.log(q.sources)})")
if [ "$QS" = "1" ]; then echo "  ✓ query ↔ source attached (recalled=1)"; else echo "  ✗ query attach failed: $QS"; exit 1; fi
$Y research claim resolve "$C" --as contested --note "仲裁演示" >/dev/null
CS=$($Y research claim list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(x=>x.id===process.argv[1]).status))" "$C")
if [ "$CS" = "contested" ]; then echo "  ✓ claim resolved to contested"; else echo "  ✗ resolve failed: $CS"; exit 1; fi

echo "── 5e. predict audit (backtest pipeline)"
$Y research claim add "[预测·7天] 2026-12-31 前 kb≥1——demo 预测，判据可本地实测" >/dev/null
PA=$($Y research predict audit --offline --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.criterion.includes('kb≥1'));console.log(r?r.verdict+':'+r.actual:'missing')})")
case "$PA" in pending*kb=*/*) echo "  ✓ predict audit measured local criterion ($PA)";; *) echo "  ✗ predict audit failed: $PA"; exit 1;; esac

echo "── 5f. 0.79 feedback hardening (real-user report surfaces)"
# ① kb receipt self-verify + workspace echo (lost-notes incident class)
KBV=$($Y kb add --title "demo-verify" --body "receipt self-verify probe" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.verified===true?'ok':'verified='+r.verified)})")
case "$KBV" in ok) echo "  ✓ kb add receipt self-verified (verified:true)";; *) echo "  ✗ kb verify failed: $KBV"; exit 1;; esac
# ④ claim link with a SOURCE id must teach the taxonomy, not just fail
SRC4=$($Y db sql "SELECT source_id FROM evidence LIMIT 1" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].source_id))")
CL4=$($Y research claim link "$C" "$SRC4" 2>&1 || true)
case "$CL4" in *"that id is a SOURCE"*) echo "  ✓ claim link source-id mixup explains itself";; *) echo "  ✗ claim link enrichment failed: $CL4"; exit 1;; esac
# ④ --by-source links every evidence under the source
# (YGL_EVAL_OFFLINE: 0.84 评审 F2 后 by-source 同样触发自动评估——离线钉住确定性与零费用)
EV4=$($Y research evidence add "$SRC4" --quote "by-source probe quote" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
BYS=$(YGL_EVAL_OFFLINE=1 $Y research claim link "$C" "$SRC4" --by-source 2>&1 || true)
case "$BYS" in *"linked"*evidence*) echo "  ✓ claim link --by-source batch links";; *) echo "  ✗ by-source failed: $BYS"; exit 1;; esac
# ② db unlock on a dead-pid lock clears without --force
mkdir -p "$YGL_HOME/ygl-trees.db.ygllock" && echo "3900000" > "$YGL_HOME/ygl-trees.db.ygllock/pid"
UNL=$($Y db unlock 2>&1 || true); case "$UNL" in *"lock cleared"*|*"no lock present"*) echo "  ✓ db unlock clears stale lock ($UNL)";; *) echo "  ✗ db unlock failed: $UNL"; exit 1;; esac
# produce spec must reject --design-type (silent-ignore incident)
SP4=$($Y produce spec "t" --body b --design-type decision 2>&1; echo "rc=$?")
case "$SP4" in *"belongs to 'produce design'"*"rc=2") echo "  ✓ produce spec rejects --design-type (rc=2)";; *) echo "  ✗ spec flag check failed: $SP4"; exit 1;; esac

echo "── 5g. 0.79.1 lock identity + batch can + predict state bridge (real-user report)"
# ① serve --help must print usage and start NOTHING (random-port incident)
SH=$($Y webui serve --help 2>&1; echo "rc=$?")
case "$SH" in *--port*"rc=0") echo "  ✓ webui serve --help short-circuits (no server)";; *) echo "  ✗ serve --help: $SH"; exit 1;; esac
# ① a LIVE foreign holder reports its command line, and unlock refuses
HOLD_JS="$YGL_HOME/holder-791.js"
cat > "$HOLD_JS" <<'HOLD'
const fs = require("fs");
const lock = require("path").join(process.env.YGL_HOME, "ygl-trees.db.ygllock");
fs.mkdirSync(lock, { recursive: true });
fs.writeFileSync(require("path").join(lock, "pid"), String(process.pid));
fs.writeFileSync(require("path").join(lock, "cmd"), "node demo-holder.js (session B)");
setInterval(() => {}, 1000);
HOLD
HOLD_HOME="$YGL_HOME" node "$HOLD_JS" & HPID=$!
sleep 1.2
LUK=$($Y db unlock --json 2>&1 || true)
case "$LUK" in *'"holder_cmd": "node demo-holder.js (session B)"'*'"cleared": false'*)
  echo "  ✓ db unlock refuses live holder + echoes holder_cmd";; *)
  echo "  ✗ unlock live-holder failed: $LUK"; kill $HPID 2>/dev/null; exit 1;; esac
# lock-free process exiting next to the live holder must NOT clear it
$Y webui export --out "$YGL_HOME/probe-snapshot.json" >/dev/null 2>&1
LK2=$(ls "$YGL_HOME/ygl-trees.db.ygllock" 2>/dev/null | tr '\n' ' ')
case "$LK2" in *pid*) echo "  ✓ lock-less exit preserves foreign lock";; *) echo "  ✗ foreign lock nuked: $LK2"; kill $HPID 2>/dev/null; exit 1;; esac
kill $HPID 2>/dev/null || true
wait $HPID 2>/dev/null || true
# ② batch node can with per-node --state-file bags (probe cold-start cost)
$Y tree new probe-batch >/dev/null 2>&1
$Y node add pb0 -t probe-batch >/dev/null 2>&1
$Y node add pb1 -t probe-batch >/dev/null 2>&1
$Y node link pb0 pb1 -t probe-batch >/dev/null 2>&1
$Y node cond pb1 --name y_imported --op ">=" --value 40 -t probe-batch >/dev/null 2>&1
$Y node unlock pb0 -t probe-batch >/dev/null 2>&1
printf '{"pb1": {"y_imported": 40}}' > "$YGL_HOME/state-791.json"
BC=$($Y node can pb0 pb1 --state-file "$YGL_HOME/state-791.json" -t probe-batch 2>&1)
case "$BC" in *"can unlock × 2"*"✓ pb0"*"✓ pb1") echo "  ✓ batch can + per-node state bag (one process, N nodes)";; *) echo "  ✗ batch can: $BC"; exit 1;; esac
BC2=$($Y node can pb0 pb1 -t probe-batch --json 2>&1)
case "$BC2" in \[*\]) echo "  ✓ batch can --json → array";; *) echo "  ✗ batch json shape: $BC2"; exit 1;; esac
# ③ predict audit: --state suffix-binds nested keys; resolved hidden by default
$Y research claim add "[预测·7天] 2026-12-31 前 y_imported≥12——state 桥接 demo" >/dev/null
printf '{"counts": {"y_imported": 14}}' > "$YGL_HOME/pstate-791.json"
PRS=$($Y research predict audit --state "$YGL_HOME/pstate-791.json" --offline 2>&1)
case "$PRS" in *y_imported=14/12*) echo "  ✓ predict audit --state suffix-binds counts.y_imported";; *) echo "  ✗ predict --state: $PRS"; exit 1;; esac
PCID=$($Y research claim list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.text.includes('y_imported≥12'));console.log(r?r.id:'missing')})")
$Y research claim resolve "$PCID" --as supported >/dev/null 2>&1
PRA=$($Y research predict audit --offline 2>&1)
case "$PRA" in *resolved*隐藏*) echo "  ✓ resolved prediction hidden by default (--all for terminal table)";; *) echo "  ✗ resolved hiding: $PRA"; exit 1;; esac
PAA=$($Y research predict audit --offline --all --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.claim_id==='$PCID');console.log(r?r.verdict:'missing')})")
if [ "$PAA" = "resolved" ]; then echo "  ✓ --all exposes resolved terminal verdict"; else echo "  ✗ --all resolved: $PAA"; exit 1; fi

echo "── 5h. 0.81 command-surface fixes (real-user report)"
# ③ node list 未知 flag 静默吞掉并列出当前树 → rc=2 点名（--tree 在 0.83 成为合法别名，
#    这里用仍然未知的 --proj 验证守卫本身）
NL3=$($Y node list --proj probe-batch 2>&1; echo "rc=$?")
case "$NL3" in *"unknown flag --proj"*"rc=2") echo "  ✓ node list rejects unknown flag (rc=2)";; *) echo "  ✗ node list flag check: $NL3"; exit 1;; esac
# 0.83：--tree 长旗标现在是合法树选择别名（曾经是未知 flag 的那个词）
NL4=$($Y node list --tree probe-batch --json 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(Array.isArray(a)&&a.some(x=>x.key==='pb1')?'yes':'no')})")
[ "$NL4" = "yes" ] && echo "  ✓ node list --tree <t> 长旗标别名（0.83）" || { echo "  ✗ --tree alias: $NL4"; exit 1; }
# ④ cond verbs: `node cond add <key>` used to parse "add" as the key; rm didn't exist
CV1=$($Y node cond add pb1 --name t_ready --op ">=" --value 5 -t probe-batch 2>&1)
case "$CV1" in *"condition added: pb1"*) echo "  ✓ node cond add <key> action word";; *) echo "  ✗ cond add: $CV1"; exit 1;; esac
CV2=$($Y node cond rm pb1 --name t_ready -t probe-batch 2>&1)
case "$CV2" in *"condition removed: pb1 · t_ready"*) echo "  ✓ node cond rm removes by natural key";; *) echo "  ✗ cond rm: $CV2"; exit 1;; esac
# ② generic URL schemes: cross-agent references (a2a://) no longer rejected
A2A=$($Y research source add --url "a2a://peer1/task-42" --title "跨Agent任务引用" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.url:(r.url||'missing'))})")
case "$A2A" in a2a://peer1/task-42) echo "  ✓ source add accepts arbitrary scheme (a2a://)";; *) echo "  ✗ a2a url: $A2A"; exit 1;; esac
# ⑥ confidence letter grades OR numeric (0-1 / 0-100%)
CN1=$($Y research claim add "demo811 数值置信断言" --confidence 0.92 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.confidence||'missing')})")
if [ "$CN1" = "0.92" ]; then echo "  ✓ claim --confidence accepts 0-1 decimal"; else echo "  ✗ confidence numeric: $CN1"; exit 1; fi
CN2=$($Y research claim add "demo811 百分比断言" --confidence 85% 2>&1; echo "rc=$?")
case "$CN2" in *"claim added"*"rc=0") echo "  ✓ claim --confidence accepts percentage";; *) echo "  ✗ confidence pct: $CN2"; exit 1;; esac
CN3=$($Y research claim add "x" --confidence nonsense 2>&1; echo "rc=$?")
case "$CN3" in *"A|B|C or a number"*"rc=2") echo "  ✓ confidence garbage rejected rc=2";; *) echo "  ✗ confidence reject: $CN3"; exit 1;; esac
# ① kb rm leaves a reconcilable event — doctor write_integrity stays pass
KRID=$($Y kb add --title "demo-rm" --body "rm probe" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
$Y kb rm "$KRID" >/dev/null 2>&1
DOC1=$($Y doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).find(x=>x.name==='write_integrity');console.log(c.status)})")
if [ "$DOC1" = "pass" ]; then echo "  ✓ kb rm reconciled by doctor (write_integrity pass)"; else echo "  ✗ doctor after kb rm: $DOC1"; exit 1; fi
# unexplained orphan (no rm event) downgrades to warn — doctor itself still rc=0
$Y db sql "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('evdemo811','$(date -u +%Y-%m-%dT%H:%M:%SZ)','cli','kb.add','kb_note','kb_ghost_demo','{}','info')" >/dev/null
DOC2=$($Y doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).find(x=>x.name==='write_integrity');console.log(c.status)})")
$Y db sql "DELETE FROM events WHERE id='evdemo811'" >/dev/null
if [ "$DOC2" = "warn" ]; then echo "  ✓ unexplained write event downgrades to warn (doctor rc=0)"; else echo "  ✗ doctor warn path: $DOC2"; exit 1; fi
# ⑦ task add --node joins the relation fabric
TN=$($Y task add "demo 挂节点任务" --node probe-batch/pb1 2>&1)
case "$TN" in *"task added"*"tracked-by node:probe-batch/pb1"*) echo "  ✓ task add --node links tracked-by relation";; *) echo "  ✗ task --node: $TN"; exit 1;; esac
# ⑧ timeline --actor filters the stream and shows a raw tail
TL=$($Y db timeline --actor cli 2>&1)
case "$TL" in *"actor=cli"*"最近"*) echo "  ✓ db timeline --actor filter + raw tail";; *) echo "  ✗ timeline actor: $TL"; exit 1;; esac
# ⑤ bare node:<key> with no current tree names both ways out
#    （R16 后单树会自动命中——先造第二棵树让"未选择"态真实成立）
$Y tree new no-tree-demo >/dev/null 2>&1
$Y db sql "DELETE FROM meta WHERE key='current_tree' OR key LIKE 'current_tree@%'" >/dev/null
RN=$($Y rel add node:pb1 claim:x related 2>&1; echo "rc=$?")
case "$RN" in *"no current tree — qualify as node:<tree>/pb1"*"rc=1") echo "  ✓ bare node ref with no tree explains itself";; *) echo "  ✗ no-tree error: $RN"; exit 1;; esac
$Y tree use probe-batch >/dev/null 2>&1
$Y db sql "DELETE FROM trees WHERE name='no-tree-demo'" >/dev/null

echo "── 5i. 0.82 跨树 ready + 临期 eval 门槛 + doctor --fix 对账（真实用户报告）"
# ② node ready --all sweeps every tree without tree use / -t
#    （pb0 已解锁、pb1 有必检条件 —— 都不在就绪集；新增无前置的 pb2 才就绪）
$Y node add pb2 -t probe-batch >/dev/null 2>&1
RA=$($Y node ready --all 2>&1)
case "$RA" in *"Ready across"*"probe-batch"*"pb2"*) echo "  ✓ node ready --all 跨树扫描（无需 tree use）";; *) echo "  ✗ ready --all: $RA"; exit 1;; esac
# ③ node cond --due lists eval conds whose question carries a deadline
$Y node cond add pb1 --name due_probe --op eval --value "2026-10-19 前验证：demo 临期探针条件" -t probe-batch >/dev/null 2>&1
CD1=$($Y node cond --due --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);const r=a.find(x=>x.name==='due_probe');console.log(r?r.deadline:'missing')})")
if [ "$CD1" = "2026-10-19" ]; then echo "  ✓ cond --due 提取问题文本中的期限（deadline=2026-10-19）"; else echo "  ✗ cond --due: $CD1"; exit 1; fi
# --days 窗口：2027 远期条件不进 7 天窗
CD2=$($Y node cond --due --days 7 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.every(x=>x.days_left<=7))})")
if [ "$CD2" = "true" ]; then echo "  ✓ cond --due 尊重 --days 窗口"; else echo "  ✗ --days window: $CD2"; exit 1; fi
# --eval 离线安全：无凭证回落 pending，不崩溃
CD3=$(YGL_EVAL_OFFLINE=1 $Y node cond --due --eval --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);const r=a.find(x=>x.name==='due_probe');console.log(r?r.outcome:'missing')})")
if [ "$CD3" = "pending" ]; then echo "  ✓ cond --due --eval 离线安全（pending，不仲裁）"; else echo "  ✗ --eval offline: $CD3"; exit 1; fi
$Y node cond rm pb1 --name due_probe -t probe-batch >/dev/null 2>&1
# ① doctor --fix marks phantom write events reconciled (audit trail kept)
$Y db sql "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('evdemo821','$(date -u +%Y-%m-%dT%H:%M:%SZ)','cli','kb.add','kb_note','kb_ghost_821','{}','info')" >/dev/null
DF1=$($Y doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).find(x=>x.name==='write_integrity');console.log(c.status)})")
if [ "$DF1" = "warn" ]; then echo "  ✓ 幻影事件先降级 warn"; else echo "  ✗ pre-fix status: $DF1"; exit 1; fi
DF2=$($Y doctor --fix 2>&1 | grep -o "marked reconciled" | head -1)
if [ "$DF2" = "marked reconciled" ]; then echo "  ✓ doctor --fix 标记 reconciled（保留审计轨迹）"; else echo "  ✗ --fix: $DF2"; exit 1; fi
DF3=$($Y doctor --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).find(x=>x.name==='write_integrity');console.log(c.status)})")
if [ "$DF3" = "pass" ]; then echo "  ✓ --fix 后 write_integrity 回 pass"; else echo "  ✗ post-fix: $DF3"; exit 1; fi
$Y db sql "DELETE FROM events WHERE id='evdemo821'" >/dev/null

echo "── 5j. 0.82.1 预测生命周期护栏（真实用户报告：link 抢跑仲裁）"
# 预测 claim 挂证据不再自动晋升 —— 退出跟踪表的唯一路径是显式 resolve
PRED=$($Y research claim add "[预测·7天] 2026-10-24 前 demo 判据树≥1" --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
DEVSRC=$($Y research source list --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s)[0].id)})")
DEV=$($Y research evidence add "$DEVSRC" --quote "demo evidence for prediction guard" --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
PL1=$(YGL_EVAL_OFFLINE=1 $Y research claim link "$PRED" "$DEV" --stance supports --json 2>&1)
case "$PL1" in *'"status": "unverified"'*'"auto_promote": false'*) echo "  ✓ [预测· claim 挂证据不晋升（auto_promote:false）";; *) echo "  ✗ pred link: $PL1"; exit 1;; esac
# 普通 claim 仍然自动推导（回归护栏：guard 只拦预测）
PLAIN=$($Y research claim add "plain claim for guard regression" --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
PL2=$(YGL_EVAL_OFFLINE=1 $Y research claim link "$PLAIN" "$DEV" --stance supports --json 2>&1)
case "$PL2" in *'"status": "supported"'*'"auto_promote": true'*) echo "  ✓ 普通 claim 链接照常自动推导";; *) echo "  ✗ plain link: $PL2"; exit 1;; esac
# unresolve 复位通道：误晋升/抢跑仲裁可归位，幂等 duplicate:true
UR1=$($Y research claim unresolve "$PLAIN" --json 2>&1)
case "$UR1" in *'"status": "unverified"'*'"duplicate": false'*) echo "  ✓ claim unresolve 复位为 unverified";; *) echo "  ✗ unresolve: $UR1"; exit 1;; esac
UR2=$($Y research claim unresolve "$PLAIN" --json 2>&1)
case "$UR2" in *'"duplicate": true'*) echo "  ✓ unresolve 幂等（already unverified → duplicate）";; *) echo "  ✗ unresolve idem: $UR2"; exit 1;; esac
# 复位后预测仍在默认跟踪表（不被 resolved 隐藏）
PA=$($Y research predict audit --offline --json -p techtree 2>&1)
case "$PA" in *"$PRED"*'"verdict": "pending"'*) echo "  ✓ 预测复位后仍在跟踪表（pending，非 resolved）";; *) echo "  ✗ audit: $PA"; exit 1;; esac

echo "── 5j2. 0.90 predict list 投影 + channel 字段 + 结算三段式 note（direct-ce7e561b/ce9eaf7a）"
# ① 注册即登记台账通道 → 结算时防通道错配（39c93624f6 实例）
P90=$($Y research claim add "[预测·14天] 2027-01-01 前 demo 投影断言——npm 版本 ≥99" --channel npm-registry --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
PL90=$($Y research predict list --json -p techtree)
case "$PL90" in *"$P90"*'"outcome": "未结算"'*'"channel": "npm-registry"'*) echo "  ✓ predict list 投影：channel 登记 + outcome 未结算";; *) echo "  ✗ predict list: $PL90"; exit 1;; esac
# ② 结算三段式 note 尾部（outcome=…, brier=…, settler=…）→ 机器可读，校准曲线 SQL 直出
E90=$($Y research evidence add "$DEVSRC" --quote "demo settlement quote" --note "outcome=0, brier=0.25, settler=dsh/ae07421e" --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
YGL_EVAL_OFFLINE=1 $Y research claim link "$P90" "$E90" >/dev/null 2>&1
$Y research claim resolve "$P90" --as refuted -p techtree >/dev/null 2>&1
PL91=$($Y research predict list --json --all -p techtree)
case "$PL91" in *'"outcome": "0"'*'"brier": "0.25"'*'"settler": "dsh/ae07421e"'*) echo "  ✓ 结算三段式 note 解析（outcome=0 + brier + settler）";; *) echo "  ✗ settle parse: $PL91"; exit 1;; esac

echo "── 5k. 0.83 并发防护与帮助面（真实用户报告：指针互踩/半写/--help）"
# ① --project 长旗标：写命令可钉住目标项目，不依赖共享 current 指针
$Y project new projB -q "第二个项目（0.83 --project 钉住验证）" >/dev/null 2>&1
SPB=$($Y research source add --title "pinned-to-B" --url "https://ex.com/83-pin" --project projB --json 2>&1)
case "$SPB" in *'"url": "https://ex.com/83-pin"'*) echo "  ✓ source add --project projB 长旗标钉住写入";; *) echo "  ✗ --project: $SPB"; exit 1;; esac
SPB_CNT=$($Y research source list --json -p projB | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).filter(x=>x.title==='pinned-to-B').length)})")
[ "$SPB_CNT" = "1" ] && echo "  ✓ 资产落在 projB（非共享指针当前项目）" || { echo "  ✗ landed in wrong project: $SPB_CNT"; exit 1; }
# ① 半写防护：--query 引用不存在 → 拒绝写入（0 源落地），不再先落源再报错
set +e
$Y research source add --title "would-be-orphan" --url "https://ex.com/orph" --query "no-such-query" -p techtree >/dev/null 2>&1
ORPH_RC=$?
set -e
[ "$ORPH_RC" = "1" ] && echo "  ✓ 坏 --query 引用 rc=1 拒绝" || { echo "  ✗ half-write rc: $ORPH_RC"; exit 1; }
ORPH_CNT=$($Y research source list --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).filter(x=>x.title==='would-be-orphan').length)})")
[ "$ORPH_CNT" = "0" ] && echo "  ✓ 拒绝后无孤儿源落地（半写防护）" || { echo "  ✗ orphan landed: $ORPH_CNT"; exit 1; }
# ② --help 任意深度：组内子命令直接打组帮助 rc=0（0.81 曾 rc=2）
set +e
KH=$($Y kb add --help 2>&1)
KH_RC=$?
set -e
case "$KH" in *"add --title --body|-f"*) [ "$KH_RC" = "0" ] && echo "  ✓ kb add --help 打组帮助 rc=0";; *) echo "  ✗ --help: $KH"; exit 1;; esac
# ②b 0.88 单4: --help 在非 TTY 管道下必须零 ANSI 色码（曾 paint(...,true) 硬编码泄漏 16 行）
#    注意用裸 bin（不带 --no-color）——泄漏只在"无旗标 + 管道"组合下暴露
BIN="${Y%% --no-color}"
KH_ESC=$("$BIN" kb --help 2>&1 | grep -c $'\x1b' || true)
[ "$KH_ESC" = "0" ] && echo "  ✓ --help 非 TTY 零 ANSI 色码" || { echo "  ✗ ANSI leak: $KH_ESC lines"; exit 1; }
# ④ can --eval attachments 快照：评估吃了哪些 rel 证据一目了然
EV83=$($Y research evidence add "$DEVSRC" --quote "0.83 attachments snapshot evidence" --json -p techtree | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
$Y node cond add pb2 --name snap83 --op eval --value "demo attachments snapshot gate" -t probe-batch >/dev/null 2>&1
$Y rel add node:probe-batch/pb2 evidence:$EV83 --rel evidenced-by >/dev/null 2>&1
CAN83=$(YGL_EVAL_OFFLINE=1 $Y node can pb2 -t probe-batch --eval --json 2>&1)
case "$CAN83" in *'"eval_attachments"'*"$EV83"*) echo "  ✓ can --eval 携带本次 attachments 快照";; *) echo "  ✗ attachments: $CAN83"; exit 1;; esac
$Y node cond rm pb2 --name snap83 -t probe-batch >/dev/null 2>&1

echo "── 5l. 0.84 判定落账与校准读出（自动评估被进程退出截断的修复）"
# ① 离线 evaluate：rc=0、标"离线"、零事件（判定不落账就不算数）
set +e
EVLD=$(YGL_EVAL_OFFLINE=1 $Y research claim evaluate "$PRED" -p techtree 2>&1)
EVLD_RC=$?
set -e
case "$EVLD" in *离线*) [ "$EVLD_RC" = "0" ] && echo "  ✓ 离线 evaluate 安全回落（无模型不落账）";; *) echo "  ✗ offline evaluate: $EVLD"; exit 1;; esac
CE0=$($Y db sql "SELECT COUNT(*) AS n FROM events WHERE kind='claim.eval'" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s)[0].n)})")
[ "$CE0" = "0" ] && echo "  ✓ 离线判定零事件（不产生假数据）" || { echo "  ✗ offline wrote events: $CE0"; exit 1; }
# ② 校准读出：种子两条 claim.eval（最新覆盖旧的），档差与份额可对账
CAL_CL=$($Y research claim add "校准demo断言：模型档差" -p techtree --json 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.row?r.row.id:r.id)})")
$Y db sql "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('evdemo841a','2026-01-01T10:00:00.000Z','demo','claim.eval','claim','$CAL_CL','{\"model_confidence\":1.0,\"label\":\"D\",\"mode\":\"manual\"}','info')" >/dev/null 2>&1
$Y db sql "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('evdemo841b','2026-01-01T11:00:00.000Z','demo','claim.eval','claim','$CAL_CL','{\"model_confidence\":2.5,\"label\":\"C\",\"mode\":\"manual\"}','info')" >/dev/null 2>&1
$Y research claim resolve "$CAL_CL" --as supported -p techtree >/dev/null 2>&1
CALJ=$($Y research claim calibration -p techtree --json 2>&1)
CALROW=$(echo "$CALJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const r=j.rows.find(x=>x.claim==='$CAL_CL');console.log(r?r.gap:'(no-row)')})")
[ "$CALROW" = "模型低2档" ] && echo "  ✓ 校准读出：最新评估胜出（D→C），supported 下模型低 2 档" || { echo "  ✗ calibration gap: $CALROW"; exit 1; }
CALSH=$(echo "$CALJ" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).model_lower_1plus>=1?'yes':'no')})")
[ "$CALSH" = "yes" ] && echo "  ✓ 份额统计（模型低≥1档计数）服务 11-16 校准预测" || { echo "  ✗ share: $CALJ"; exit 1; }
$Y db sql "DELETE FROM events WHERE id IN ('evdemo841a','evdemo841b')" >/dev/null 2>&1

echo "── 5m. 0.85 会话选择分辨率（多项目未选择即拒绝，选择后放行）"
# ① 多项目工作区 + 无会话键：research 命令 rc=2 单错误对象
$Y project new demo-b >/dev/null 2>&1
$Y db sql "DELETE FROM meta WHERE key LIKE 'current_project@%'" >/dev/null 2>&1
set +e
AMB=$($Y research claim list --json 2>&1)
AMB_RC=$?
set -e
AMB_J=$(echo "$AMB" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.error?'ERR':'NOERR')})" 2>/dev/null)
[ "$AMB_RC" = "2" ] && [ "$AMB_J" = "ERR" ] && echo "  ✓ 未选择即拒绝：rc=2 + 单 JSON 错误对象（ambiguous project）" || { echo "  ✗ ambiguous gate: rc=$AMB_RC j=$AMB_J out=$AMB"; exit 1; }
# ② 工作区级命令豁免：doctor 照常 rc=0
$Y doctor >/dev/null 2>&1 && echo "  ✓ 工作区级命令豁免（doctor 未选择也放行）" || { echo "  ✗ doctor gated"; exit 1; }
# ③ 会话内选择后放行：claim list rc=0，选择来源可对账
$Y project use techtree >/dev/null 2>&1
SRC=$($Y project show --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).selection_source||'')})")
$Y research claim list --json >/dev/null 2>&1 && [ "$SRC" = "session" ] && echo "  ✓ project use 写会话键放行（selection_source=$SRC）" || { echo "  ✗ use/select: src=$SRC"; exit 1; }
# ④ 收尾：移除第二项目，恢复单项目演示态
$Y db sql "DELETE FROM projects WHERE name='demo-b'" >/dev/null 2>&1
echo "  ✓ 演示态恢复（第二项目已移除）"

echo "── 6. tech-tree node model"
$Y tree new demo
for n in mining smelting bronze; do $Y node add "$n"; done
$Y node add steel --tier 5
$Y node link mining smelting                    # required AND (default)
$Y node link smelting bronze
$Y node link bronze steel --optional            # optional gate
$Y node cond steel --name research_lab_level --kind level --value 3
$Y node cond steel --name has_engineer --kind flag --op has --optional --effect cost_mul --weight 0.8
$Y node link steel mining || echo "  (cycle correctly rejected)"
# 0.45：解锁态必须可从 CLI 对账（此前只有 WebUI/SQL 看得到，节奏纪律无从执行）。
# 用 smelting 探针后**立即锁回**——解锁会把它移出 node path 的待解锁集，后续断言依赖该集合。
$Y node unlock smelting >/dev/null 2>&1
ST=$($Y node list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.find(n=>n.key==='smelting')?.state||'?')})")
if [ "$ST" = "unlocked" ]; then echo "  ✓ node list 暴露解锁态（state=unlocked，可对账）"; else echo "  ✗ 解锁态不可见：$ST"; exit 1; fi
SST=$($Y node show smelting --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log((j.node.state||'?')+'/'+(j.node.unlocked_at?'ts':'no-ts'))})")
if [ "$SST" = "unlocked/ts" ]; then echo "  ✓ node show 带 state + unlocked_at 时间戳"; else echo "  ✗ node show 态不全：$SST"; exit 1; fi
$Y node lock smelting >/dev/null 2>&1
LC=$($Y node list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.find(n=>n.key==='smelting')?.state||'?')})")
if [ "$LC" = "locked" ]; then echo "  ✓ 锁回后态回归（node lock 可逆）"; else echo "  ✗ 锁回失败：$LC"; exit 1; fi

$Y node index
$Y node validate
$Y node ready
$Y node can steel --state "research_lab_level=3"
P=$($Y node path steel --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).order.join(',')))")
if [ "$P" = "mining,smelting,bronze,steel" ]; then
  echo "  ✓ path order correct: $P   (target last, optional ancestors in place)"
else
  echo "  ✗ path order wrong: $P"; exit 1
fi

echo "── 6a. gate decision-model boolean eval (offline → pending)"
$Y node cond steel --name quest_ready --kind quest --op eval --value "研究任务已完成且满足解锁门槛吗" >/dev/null
$Y node add quest-gate >/dev/null
$Y node cond quest-gate --name quest_only --kind quest --op eval --value "独立任务完成了吗" >/dev/null
EV=$(YGL_EVAL_OFFLINE=1 $Y node can steel --state "research_lab_level=3" --eval --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.pending&&j.pending.length&&j.evaluated[0].name)})")
if [ "$EV" = "quest_ready" ]; then echo "  ✓ op=eval gate offline → pending (gray/no-evaluator)"; else echo "  ✗ eval gate unexpected: $EV"; exit 1; fi
YGL_EVAL_OFFLINE=1 $Y node can steel --eval >/dev/null 2>&1
if [ "$?" = "0" ]; then echo "  ✓ offline rc=0"; else echo "  ✗ offline rc nonzero"; exit 1; fi
RD=$(YGL_EVAL_OFFLINE=1 $Y node ready --eval --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.eval_pending.length&&j.eval_pending[0].key)})")
if [ "$RD" = "quest-gate" ]; then echo "  ✓ ready --eval offline → 仅 eval 阻塞的 quest-gate 进 eval_pending（steel 因父链未满不入候选）"; else echo "  ✗ ready --eval: $RD"; exit 1; fi

echo "── 6a2. choice/score 题型（离线 → pending；信封 value 显示措辞）"
$Y node cond steel --name team_pick --kind quest --op eval-choice \
  --value "该派哪个团队处理" --options "proc=采购:ERP与供应商, ops=物流:账单核对" --answer proc >/dev/null
$Y node cond steel --name maturity --kind quest --op eval-score \
  --value "实现成熟度如何" --levels "原型:仅演示, 可用:有测试, 成熟:有用户" --min-score 2 >/dev/null
CS=$(YGL_EVAL_OFFLINE=1 $Y node can steel --state "research_lab_level=3" --eval --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const t=j.evaluated.filter(e=>e.type!=='boolean');console.log(t.length===2&&t.every(e=>e.outcome==='pending')&&t.map(e=>e.type).sort().join(','))})")
if [ "$CS" = "choice,score" ]; then echo "  ✓ eval-choice/eval-score offline → 双 pending（题型分派正确）"; else echo "  ✗ choice/score: $CS"; exit 1; fi
CD=$(YGL_EVAL_OFFLINE=1 $Y node can steel --state "research_lab_level=3" 2>&1)
case "$CD" in
  *team_pick*eval-choice*该派哪个团队处理*) echo "  ✓ missing_required 显示问题措辞而非 JSON 信封";;
  *) echo "  ✗ 信封显示泄漏"; exit 1;;
esac
$Y node cond quest-gate --name pick2 --kind quest --op eval-choice --value "选哪条路径" --options "a=路径甲, b=路径乙" --answer a >/dev/null
$Y node cond quest-gate --name score2 --kind quest --op eval-score --value "质量如何" --levels "低:返工, 高:可交付" --min-score 1 >/dev/null
RM=$(YGL_EVAL_OFFLINE=1 $Y node ready --eval --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const q=j.eval_pending.find(p=>p.key==='quest-gate');console.log(q&&q.results.length===3&&q.results.every(r=>r.outcome==='pending')?'ok':JSON.stringify(q))})")
if [ "$RM" = "ok" ]; then echo "  ✓ ready --eval 混批：quest-gate 三题型（boolean+choice+score）单节点聚合 pending"; else echo "  ✗ ready mixed: $RM"; exit 1; fi

echo "── 6b. export → import round-trip"
$Y node export --out "$YGL_HOME/demo-tree.json" >/dev/null
$Y node import --file "$YGL_HOME/demo-tree.json" --tree demo-copy >/dev/null
$Y node export --out "$YGL_HOME/demo-copy.json" >/dev/null
node - "$YGL_HOME/demo-tree.json" "$YGL_HOME/demo-copy.json" <<'EOF'
const fs = require("fs");
const sig = (d) => JSON.stringify({
  nodes: d.nodes.map((n) => [n.key, n.name, n.kind, n.tier, n.cost]),
  edges: d.edges.map((e) => [e.parent, e.child, e.rel, e.mode, e.required]),
  conditions: d.conditions.map((c) => [c.node, c.name, c.kind, c.op, c.value, c.required, c.effect]),
});
const a = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const b = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (sig(a) === sig(b)) console.log("  ✓ export → import round-trip semantically equal");
else {
  console.log("  ✗ round-trip mismatch");
  process.exit(1);
}
EOF

echo "── 7. scheduling"
$Y job add "nightly" -- "echo hello" --every 1440
D=$($Y job add "nightly" -- "echo hello" --every 1440 2>&1)
case "$D" in *duplicate*) echo "  ✓ job add idempotent";; *) echo "  ✗ job add NOT idempotent: $D"; exit 1;; esac
$Y job run nightly
# 0.83.1: run history must persist（jobFinish 曾漏传 runId，UPDATE 静默 no-op）
JH=$($Y db sql "SELECT rc FROM runs WHERE job_id=(SELECT id FROM jobs WHERE title='nightly') ORDER BY rowid DESC LIMIT 1" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s)[0];console.log(r&&r.rc===0?'ok':'bad')})")
[ "$JH" = "ok" ] && echo "  ✓ job run history persists (rc=0 recorded)" || { echo "  ✗ job history: $JH"; exit 1; }
$Y db stats

echo "── 8. webui"
# 0.88 单3: export is a service-form snapshot (JSON) — the single-file HTML
# dashboard is retired; React client is the only front end.
$Y webui export --out "$YGL_HOME/snapshot.json" >/dev/null
if node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!s.meta?.generated || !s.brief?.counts || !Array.isArray(s.claims)) process.exit(1)" "$YGL_HOME/snapshot.json" 2>/dev/null; then
  echo "  ✓ webui export: service snapshot.json (meta + brief + claims payload)"
else
  echo "  ✗ webui export failed"; exit 1
fi

echo "── 9. relation fabric（spec R9）"
K=$($Y kb list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
$Y rel add node:steel kb:"$K" --rel evidenced-by >/dev/null
DUP=$($Y rel add node:steel kb:"$K" --rel evidenced-by --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).duplicate))")
if [ "$DUP" = "true" ]; then echo "  ✓ rel add 幂等（同四元组 duplicate）"; else echo "  ✗ rel add not idempotent"; exit 1; fi
RL=$($Y rel list --src node:steel --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.length===1&&r[0].rel==='evidenced-by'&&r[0].dst_display?'ok':JSON.stringify(r))})")
if [ "$RL" = "ok" ]; then echo "  ✓ rel list --src 双向过滤 + 显示名解析"; else echo "  ✗ rel list: $RL"; exit 1; fi
RC1=0; $Y rel add node:zzz kb:"$K" >/dev/null 2>&1 || RC1=$?
RC2=0; $Y rel add bogus:zzz kb:"$K" >/dev/null 2>&1 || RC2=$?
if [ "$RC1" = "1" ] && [ "$RC2" = "2" ]; then echo "  ✓ 引用语义：404→rc1 坏类型→rc2"; else echo "  ✗ rc 语义: $RC1/$RC2"; exit 1; fi

echo "── 10. telemetry（spec R10：树域留痕 + cmd.run + level）"
NA=$($Y agent log --limit 200 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.some(e=>e.kind==='node.add')&&r.some(e=>e.kind==='node.link'))})")
if [ "$NA" = "true" ]; then echo "  ✓ 树域留痕：node.add/node.link 进 events（0.12 例外已推翻）"; else echo "  ✗ 树域留痕缺失"; exit 1; fi
$Y node show no-such-node >/dev/null 2>&1 || true
ER=$($Y agent log --level error --limit 5 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const c=r.find(e=>e.kind==='cmd.run'&&e.entity==='node');console.log(!!c&&JSON.parse(c.payload).rc===1)})")
if [ "$ER" = "true" ]; then echo "  ✓ cmd.run 事件：失败命令留 error 级（rc 映射 level）"; else echo "  ✗ cmd.run error 缺失"; exit 1; fi
LV=$($Y agent log --limit 3 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.every(e=>e.level==='info'||e.level==='warn'||e.level==='error'))})")
if [ "$LV" = "true" ]; then echo "  ✓ events.level 列生效（schema v7）"; else echo "  ✗ level 列异常"; exit 1; fi

echo "── 11. 工程产出形态（spec R12：task 状态机 + spec/design）"
TID=$($Y task add "演示任务：发布准备" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
$Y task doing "$TID" >/dev/null
$Y task done "$TID" >/dev/null
TS=$($Y task list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(x=>x.id===process.argv[1]);console.log(t&&t.status)})" "$TID")
if [ "$TS" = "done" ]; then echo "  ✓ task 状态机 todo→doing→done（勾销留痕）"; else echo "  ✗ task: $TS"; exit 1; fi
$Y produce spec "发布规格" --body "R1-R13 验收 + pnpm publish" >/dev/null
$Y produce design "视觉系统" --design-type ui-ux --body "DESIGN.md 单一事实源" >/dev/null
PK=$($Y produce list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.some(x=>x.kind==='spec')&&r.some(x=>x.kind==='design'))})")
if [ "$PK" = "true" ]; then echo "  ✓ produce spec/design 工程产出入库"; else echo "  ✗ spec/design"; exit 1; fi
$Y rel add node:steel artifact:"$TID" --rel tracked-by >/dev/null
TR=$($Y rel list --src node:steel --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.some(x=>String(x.dst).startsWith('artifact:')&&x.rel==='tracked-by'))})")
if [ "$TR" = "true" ]; then echo "  ✓ task 可 R9 关联到树节点（tracked-by）"; else echo "  ✗ task rel"; exit 1; fi

# 状态机必须可回退：假状态比缺状态更坏（0.45 教训：任务被演练走成 done 却并未完成）
$Y task todo "$TID" >/dev/null 2>&1
TS=$($Y task list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.find(t=>t.id==='$TID')?.status||'?')})")
if [ "$TS" = "todo" ]; then echo "  ✓ task 状态可回退（done→todo，修正假状态）"; else echo "  ✗ task 回退失败：$TS"; exit 1; fi
$Y task done "$TID" >/dev/null 2>&1

echo "── 12. user plugins（spec R14 L3：业务域扩展位）"
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
$Y plugin init >/dev/null
$Y plugin install "$REPO_ROOT/examples/plugin-demo" >/dev/null 2>&1 || { echo "  ✗ plugin install failed"; exit 1; }
PI=$($Y demo hello 2>&1)
case "$PI" in
  *"hello from the user layer"*) echo "  ✓ plugin install → 贡献命令组 demo 可达" ;;
  *) echo "  ✗ plugin command not reachable: $PI"; exit 1 ;;
esac
PL=$($Y plugin list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.length===1&&r[0].name==='ygl-plugin-demo'&&r[0].resolvable)})")
if [ "$PL" = "true" ]; then echo "  ✓ plugin list 显示版本与可解析态"; else echo "  ✗ plugin list: $PL"; exit 1; fi
PK2=$($Y plugin remove ygl-plugin-demo 2>&1)
case "$PK2" in *removed*) echo "  ✓ plugin remove 清依赖与 bundle";; *) echo "  ✗ plugin remove: $PK2"; exit 1;; esac

# 冻结契约：未知命令组必须干净退出 2（不是崩溃）；0.37.1 曾丢此守卫，此断言防复发
set +e
$Y definitely-not-a-group >/dev/null 2>&1
UG=$?
set -e
if [ "$UG" = "2" ]; then echo "  ✓ 未知组退出码契约 rc=2（干净用法错误）"; else echo "  ✗ 未知组 rc=$UG（期望 2）"; exit 1; fi

# 0.40：用户层 Entry-option 等价能力（config / enabled），无 loader 依赖
$Y plugin install "$REPO_ROOT/examples/plugin-demo" >/dev/null 2>&1
$Y plugin config ygl-plugin-demo '{"greeting":"demo","limit":3}' >/dev/null 2>&1
CFG=$($Y plugin config ygl-plugin-demo 2>&1 | tr -d '
 ')
case "$CFG" in *'"limit":3'*) echo "  ✓ plugin config 往返（apply 收到的 config 可查可改）";; *) echo "  ✗ plugin config: $CFG"; exit 1;; esac
$Y plugin disable ygl-plugin-demo >/dev/null 2>&1
set +e
$Y demo hello >/dev/null 2>&1
DG=$?
set -e
if [ "$DG" = "2" ]; then echo "  ✓ plugin disable 后命令组不可达（且仍是干净 rc=2）"; else echo "  ✗ disable 后 rc=$DG（期望 2）"; exit 1; fi
$Y plugin enable ygl-plugin-demo >/dev/null 2>&1
EN=$($Y demo hello 2>&1)
case "$EN" in *"hello from the user layer"*) echo "  ✓ plugin enable 恢复挂载";; *) echo "  ✗ enable: $EN"; exit 1;; esac
$Y plugin remove ygl-plugin-demo >/dev/null 2>&1

# 冻结契约：重复 node link 必须幂等（rc=0 + duplicate:true），不得崩。
# 复用 demo 里已建的 bronze→steel 边，正好命中"重复"路径。
RC=0
DUP=$($Y --json node link bronze steel --optional 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).duplicate===true)}catch(e){console.log('parse-fail')}})") || RC=$?
if [ "$DUP" = "true" ] && [ "$RC" = "0" ]; then
  echo "  ✓ 重复 node link 幂等（duplicate:true，rc=0，原地更新）"
else
  echo "  ✗ link 幂等契约：duplicate=$DUP rc=$RC"; exit 1
fi
