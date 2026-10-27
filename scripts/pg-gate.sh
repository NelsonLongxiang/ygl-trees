#!/usr/bin/env bash
# G7 真 PG 矩阵门（roadmap/#96 条目 6；总工裁 direct-2c7c431a：本地 docker 门，非 GitHub Actions）。
# 起 pinned postgres:16 容器 → dual-backend-matrix --strict → 记录 rc/legs/image → 清理。
# 发版必跑；结果（rc、腿、镜像）贴进发布记录。"矩阵绿"是发布收口条件的一部分。
set -uo pipefail
cd "$(dirname "$0")/.."
PG_IMAGE="${PG_IMAGE:-postgres:16.4-alpine}"   # 钉装：镜像 tag 显式记录，漂移即换门
PG_PORT="${PG_PORT:-55432}"
PG_PW="gategate"
CONTAINER="ygl-pg-gate-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
echo "pg-gate: starting $PG_IMAGE on :$PG_PORT"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PG_PW" -p "$PG_PORT:5432" "$PG_IMAGE" >/dev/null || { echo "✗ docker run failed"; exit 1; }
for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || { echo "✗ postgres not ready in 30s"; exit 1; }
export YGL_PG_URL="postgres://postgres:$PG_PW@127.0.0.1:$PG_PORT/ygl"
echo "pg-gate: dual-backend-matrix --strict (image=$PG_IMAGE)"
node scripts/dual-backend-matrix.mjs --strict
RC=$?
echo "pg-gate: rc=$RC image=$PG_IMAGE legs=sqlite+pg (G7)"
exit $RC
