#!/usr/bin/env bash
# README doc-truth gate: run the command examples from README.md against a
# scratch workspace and assert exit codes. Docs drift silently; this catches
# "example references a node that is created later" class of defect.
#
# Usage: bash scripts/readme-verify.sh   (or: pnpm readme:verify)
set -uo pipefail
cd "$(dirname "$0")/.."
export YGL_TEST=1  # test scripts: skip DB lock (process-exit race on Windows)
export YGL_HOME="$(pwd)/tmp/readme-verify-ws"
rm -rf "$YGL_HOME"
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
chk "webui export"        0 -- $Y webui export --out "$YGL_HOME/d.html"
# §0.79.1 命令面
chk "serve --help 短路"  0 -- $Y webui serve --help
chk "predict audit --all" 0 -- $Y research predict audit --offline --all
printf '{"counts": {"y_imported": 14}}' > "$YGL_HOME/pstate.json"
chk "can --state-file"    0 -- $Y node can steel --state-file "$YGL_HOME/pstate.json"
chk "can 批量多键"       0 -- $Y node can steel steel
# §0.82 命令面
chk "ready --all"         0 -- $Y node ready --all
chk "cond --due"          0 -- $Y node cond --due --days 30
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
rm -rf "$YGL_HOME"
echo "readme-verify: $((N-F))/$N 通过"
[ "$F" = "0" ] || exit 1
