#!/usr/bin/env bash
# ygl-trees end-to-end demo: research -> production -> knowledge reuse,
# plus the tech-tree node model (parent/child, required vs optional, indexes).
# Uses its OWN scratch workspace (YGL_DEMO_HOME, default /tmp/ygl-demo) and
# wipes it — never point it at a workspace you care about.
set -euo pipefail
export YGL_HOME="${YGL_DEMO_HOME:-/tmp/ygl-demo}"
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
$Y db stats

echo "── 8. webui"
$Y webui export --out "$YGL_HOME/dashboard.html" >/dev/null
if grep -q "ygl-trees dashboard" "$YGL_HOME/dashboard.html" && grep -q "const FALLBACK" "$YGL_HOME/dashboard.html"; then
  echo "  ✓ webui export: single-file dashboard.html with embedded data"
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
