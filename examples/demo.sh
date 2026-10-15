#!/usr/bin/env bash
# ygl-trees end-to-end demo: research -> production -> knowledge reuse,
# plus the tech-tree node model (parent/child, required vs optional, indexes).
set -euo pipefail
export YGL_HOME="${YGL_HOME:-/tmp/ygl-demo}"
Y="node $(cd "$(dirname "$0")/.." && pwd)/bin/ygl-trees.js --no-color"
rm -rf "$YGL_HOME"

echo "── 1. workspace"
$Y db init
$Y project new techtree -q "科技树数据模型如何建模与索引"

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
$Y produce report | head -20

echo "── 5. knowledge reuse"
R=$($Y produce list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(x=>x.kind==='report').id))")
$Y kb ingest "$R"
$Y kb search "科技树怎么判断能不能研究"

echo "── 5b. idempotency (retries must not duplicate)"
D=$($Y research claim add "幂等性测试断言" 2>&1); D2=$($Y research claim add "幂等性测试断言" 2>&1)
case "$D2" in *duplicate*) echo "  ✓ claim add idempotent";; *) echo "  ✗ claim add NOT idempotent: $D2"; exit 1;; esac
D=$($Y kb ingest "$R" 2>&1)
case "$D" in *duplicate*) echo "  ✓ kb ingest idempotent";; *) echo "  ✗ kb ingest NOT idempotent: $D"; exit 1;; esac

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

echo "── 7. scheduling"
$Y job add "nightly" -- "echo hello" --every 1440
D=$($Y job add "nightly" -- "echo hello" --every 1440 2>&1)
case "$D" in *duplicate*) echo "  ✓ job add idempotent";; *) echo "  ✗ job add NOT idempotent: $D"; exit 1;; esac
$Y job run nightly
$Y db stats
