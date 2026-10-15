#!/usr/bin/env bash
# ygl-trees end-to-end demo: research -> production -> knowledge reuse,
# plus the tech-tree node model (parent/child, required vs optional, indexes).
# Uses its OWN scratch workspace (YGL_DEMO_HOME, default /tmp/ygl-demo) and
# wipes it — never point it at a workspace you care about.
set -euo pipefail
export YGL_HOME="${YGL_DEMO_HOME:-/tmp/ygl-demo}"
Y="node $(cd "$(dirname "$0")/.." && pwd)/bin/ygl-trees.js --no-color"
rm -rf "$YGL_HOME"

echo "── 1. workspace"
$Y db init
$Y project new techtree -q "科技树数据模型如何建模与索引"
$Y config set search.limit 5 >/dev/null
CL=$($Y config get search.limit --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).value))")
if [ "$CL" = "5" ]; then echo "  ✓ config set/get round-trip"; else echo "  ✗ config: $CL"; exit 1; fi
$Y config reset search.limit >/dev/null
S=$($Y project show --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.keys(JSON.parse(s)).join(',')))")
if [ "$S" = "project,queries,claims" ]; then echo "  ✓ project show (TypeORM pilot) shape ok"; else echo "  ✗ project show shape: $S"; exit 1; fi

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
$Y research claim link "$C" "$E"

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
$Y db stats

echo "── 8. webui"
$Y webui export --out "$YGL_HOME/dashboard.html" >/dev/null
if grep -q "ygl-trees dashboard" "$YGL_HOME/dashboard.html" && grep -q "const FALLBACK" "$YGL_HOME/dashboard.html"; then
  echo "  ✓ webui export: single-file dashboard.html with embedded data"
else
  echo "  ✗ webui export failed"; exit 1
fi
