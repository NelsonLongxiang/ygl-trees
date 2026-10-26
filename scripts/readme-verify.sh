#!/usr/bin/env bash
# README doc-truth gate: run the command examples from README.md against a
# scratch workspace and assert exit codes. Docs drift silently; this catches
# "example references a node that is created later" class of defect.
#
# Usage: bash scripts/readme-verify.sh   (or: pnpm readme:verify)
set -uo pipefail
cd "$(dirname "$0")/.."
export YGL_TEST=1  # test scripts: skip DB lock (process-exit race on Windows)
mkdir -p "$(pwd)/tmp"
export YGL_HOME="$(mktemp -d "$(pwd)/tmp/readme-verify-ws.XXXXXX")"
trap 'rm -rf "$YGL_HOME"' EXIT
Y="node dist/bundle/bin.cjs --no-color"
F=0; N=0
chk() { # chk "<desc>" <expected-rc> -- cmd...
  local desc="$1"; local want="$2"; shift 3
  N=$((N+1))
  local out; out=$("$@" 2>&1); local rc=$?
  if [ "$rc" = "$want" ]; then echo "  ✓ $desc"; else echo "  ✗ $desc (rc=$rc want=$want)"; echo "$out" | head -2 | sed 's/^/      /'; F=$((F+1)); fi
}
$Y db init >/dev/null 2>&1
$Y tree new demo >/dev/null 2>&1   # README §一 前置
# §一 科技树
chk "node add steel"      0 -- $Y node add steel
chk "node cond 必检"      0 -- $Y node cond steel --name research_lab_level --kind level --value 3
chk "node cond 可选打折"  0 -- $Y node cond steel --name has_engineer --kind flag --op has --optional --effect cost_mul --weight 0.8
chk "node index"          0 -- $Y node index
chk "node validate"       0 -- $Y node validate
# §二 研究/产出/kb/skill
chk "project new"         0 -- $Y project new rt -q "README 校验"
chk "research query add"  0 -- $Y research query add "校验用检索式"
chk "source --adjudication" 0 -- $Y research source add --adjudication "README 校验会话裁决：三条件已核对"
chk "produce outline"     0 -- $Y produce outline
chk "produce spec"        0 -- $Y produce spec "演示规格" --body "# 规格"
chk "produce design"      0 -- $Y produce design "演示设计" --body "# 设计" --design-type arch
chk "kb add"              0 -- $Y kb add --title "校验笔记" --body "内容"
chk "kb search"           0 -- $Y kb search "校验"
chk "agent match"         0 -- $Y agent match "科技树建模"
chk "agent brief"         0 -- $Y agent brief
chk "rel add + list"      0 -- $Y rel list
chk "task add"            0 -- $Y task add "校验任务"
chk "task list"           0 -- $Y task list
TID=$($Y task list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r[0]?.id||'')})")
chk "task doing"          0 -- $Y task doing "$TID"
# §四 调度
chk "job add"             0 -- $Y job add "nightly" -- "$Y produce report" --every 1440
chk "job tick"            0 -- $Y job tick
chk "job logs"            0 -- $Y job logs
# §五 Agent / 五b 运维
chk "agent log"           0 -- $Y agent log
chk "doctor 9 项"         0 -- $Y doctor
chk "webui export"        0 -- $Y webui export --out "$YGL_HOME/d.json"
# §0.79.1 命令面
chk "serve --help 短路"  0 -- $Y webui serve --help
chk "verify:run --help"   0 -- node scripts/verify-run.mjs --help
chk "predict audit --all" 0 -- $Y research predict audit --offline --all
printf '{"counts": {"y_imported": 14}}' > "$YGL_HOME/pstate.json"
chk "can --state-file"    0 -- $Y node can steel --state-file "$YGL_HOME/pstate.json"
chk "can 批量多键"       0 -- $Y node can steel steel
# §0.82 命令面
chk "ready --all"         0 -- $Y node ready --all
chk "cond --due"          0 -- $Y node cond --due --days 30
# §0.82.1 命令面
chk "claim add"           0 -- $Y research claim add "README 校验断言" --confidence A
chk "claim unresolve"     2 -- $Y research claim unresolve
# §0.83 并发钉住 + 帮助面（rt 项目由上方 "project new" 检查创建）
chk "kb add --help"       0 -- $Y kb add --help
chk "source add --project" 0 -- $Y research source add --title "README 校验" --url "https://ex.com/readme-83" --project rt
# §#83 批量与文件入参（README「批量与文件入参」示例块的真值锚）
printf '%s
' '{"title":"README 批量示例","url":"https://ex.com/readme-batch"}' '{"title":"README 批量示例","url":"https://ex.com/readme-batch"}' > "$YGL_HOME/rm-batch.jsonl"
chk "source --batch jsonl" 0 -- $Y research source add --batch "$YGL_HOME/rm-batch.jsonl" --project rt
printf '%s' '{"text":"README 数值置信度走文件","confidence":0.92}' > "$YGL_HOME/rm-one.json"
chk "claim --file 数值置信度" 0 -- $Y research claim add --file "$YGL_HOME/rm-one.json" --project rt
printf '%s' '{"title":"README 单对象文件","url":"https://ex.com/readme-file","bogus":"点名未知字段"}' > "$YGL_HOME/rm-src.json"
chk "source --file 单对象" 0 -- $Y research source add --file "$YGL_HOME/rm-src.json" --project rt
printf '%s' 'not json' > "$YGL_HOME/rm-bad.json"
chk "--file 畸形 JSON rc2" 2 -- $Y research claim add --file "$YGL_HOME/rm-bad.json" --project rt
chk "--batch 文件缺失 rc1" 1 -- $Y research source add --batch "$YGL_HOME/definitely-missing.jsonl" --project rt
chk "node list --tree"    1 -- $Y node list --tree nonexist-tree
# §0.84 判定落账（离线安全：evaluate 不存在的 claim → rc=1 点名；calibration 空表 rc=0）
chk "claim add 校准"      0 -- $Y research claim add "README 校准断言" -p rt
chk "claim evaluate"      1 -- env YGL_EVAL_OFFLINE=1 $Y research claim evaluate no-such-claim -p rt
chk "claim calibration"   0 -- $Y research claim calibration --all
# §0.85 会话选择分辨率（tree show 汇报来源；use --global 显式全局）
chk "tree show"           0 -- $Y tree show
chk "project use --global" 0 -- $Y project use rt --global
chk "project show --json" 0 -- $Y project show --json
# §plugin
chk "plugin init"         0 -- $Y plugin init
chk "plugin install"      0 -- $Y plugin install ./examples/plugin-demo
chk "plugin 命令组"       0 -- $Y demo hello
chk "plugin config"       0 -- $Y plugin config ygl-plugin-demo '{"k":1}'
chk "plugin disable"      0 -- $Y plugin disable ygl-plugin-demo
chk "plugin enable"       0 -- $Y plugin enable ygl-plugin-demo
chk "plugin list"         0 -- $Y plugin list
# 契约
chk "未知组 rc=2"         2 -- $Y nope-not-a-group
chk "config list"         0 -- $Y config list
chk "db export"           0 -- $Y db export "$YGL_HOME/dump.sql"
# llms.txt 发布面新鲜度（0.84 评审 #6：版本头必须与 package.json 同步）
N=$((N+1))
PV=$(node -p "require('./package.json').version")
if head -1 llms.txt | grep -q "v$PV"; then echo "  ✓ llms.txt 版本头 = v$PV"; else echo "  ✗ llms.txt 版本头 ≠ v$PV（run: ygl-trees llms 刷新后提交）"; F=$((F+1)); fi
# #75: unit 计数门锚（0.114.31 修）——README "vitest N 例" 与实测一致。
# 修三件：a) grep -P → POSIX sed（macOS 兼容）b) 取 total 非 passed（含 skipped）
# c) 发布路径（pack:check）默认开；日常 readme:verify 跳过避免双跑 vitest。
# 发布脚本另有 readme:count 自动写（单一事实源=测量值）。
if [ "${README_UNIT_COUNT_GATE:-1}" != "0" ]; then
  N=$((N+1))
  README_NUM=$(sed -n 's/.*vitest \([0-9][0-9]*\) 例.*/\1/p' README.md | head -1)
  # ANSI 色码鲁棒化（#88 轮）：vitest 在控制台附属环境（WMI/计划任务派生等）会输出
  # 带 ESC 序列的 "Tests  1062 passed" 行，正则不解色则提取为空 → 假红。
  ACTUAL=$(node node_modules/vitest/vitest.mjs run --maxWorkers=1 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | sed -n 's/.*Tests[[:space:]]*[0-9][0-9]* passed.*(\([0-9][0-9]*\)).*/\1/p' | tail -1)
  if [ -n "$README_NUM" ] && [ -n "$ACTUAL" ] && [ "$README_NUM" = "$ACTUAL" ]; then
    echo "  ✓ unit 计数门锚: README $README_NUM == vitest $ACTUAL"
  else
    echo "  ✗ unit 计数漂移: README=$README_NUM vitest=$ACTUAL（run: pnpm readme:count）"
    F=$((F+1))
  fi
fi
echo "readme-verify: $((N-F))/$N 通过"
[ "$F" = "0" ] || exit 1
