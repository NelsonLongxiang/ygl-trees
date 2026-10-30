#!/usr/bin/env bash
# G1 离线门（roadmap/#96 条目 1）——干净克隆 + 无凭证环境跑完整 pnpm test。
# 判据：env -i 只留 HOME/PATH/TMPDIR（Windows 额外放行 SystemRoot/COMSPEC——node 运行时需要，
# 属平台必需非凭证），install rc0 + pnpm test rc0。任何失败 rc≠0。
# 用法：bash scripts/offline-gate.sh [ref]     # 缺省 HEAD
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REF="${1:-HEAD}"
WORK_PARENT="$(pwd -P)/tmp"
mkdir -p "$WORK_PARENT" || { echo "✗ cannot create work parent directory" >&2; exit 1; }
WORK="$(mktemp -d "$WORK_PARENT/offline-gate.XXXXXX")" || { echo "✗ cannot create work directory" >&2; exit 1; }
[[ "$WORK" == "$WORK_PARENT/offline-gate."* && "${WORK##*/}" =~ ^offline-gate[.][[:alnum:]]{6}$ && -d "$WORK" ]] || { echo "✗ invalid work directory" >&2; exit 1; }
trap 'rm -rf -- "$WORK"' EXIT
echo "offline-gate: cloning $REF into $WORK"
git clone -q "$(git rev-parse --show-toplevel)" "$WORK/repo" || { echo "✗ clone failed"; exit 1; }
git -C "$WORK/repo" checkout -q "$REF" || { echo "✗ checkout $REF failed"; exit 1; }
cd "$WORK/repo" || exit 1
# 干净环境：只留平台必需（HOME/PATH/TMPDIR + Windows SystemRoot/COMSPEC/PATHEXT）。
# 剥掉一切 YGL_*、AI_GATEWAY_*、凭据类变量。
run_clean() {
  # #98 家族第三例（验证席 direct-f720918e）：Windows PATH 含空格，字符串拼 env 会被拆参。
  # 正解：**数组**传参——每个 NAME=VALUE 是一个元素，不经 word splitting。
  local -a args=("HOME=$HOME" "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp}")
  local v val
  for v in SYSTEMROOT SystemRoot COMSPEC PATHEXT NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE USERPROFILE LOCALAPPDATA APPDATA; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && args+=("$v=$val")
  done
  env -i "${args[@]}" bash -c "$1"
}
echo "offline-gate: env -i install --frozen-lockfile"
run_clean "pnpm install --frozen-lockfile" || { echo "✗ offline install failed (G1)"; exit 1; }
echo "offline-gate: env -i pnpm test (full chain)"
run_clean "pnpm test" || { echo "✗ offline pnpm test failed (G1)"; exit 1; }
echo "✓ offline-gate: $REF clean under env -i (G1)"
