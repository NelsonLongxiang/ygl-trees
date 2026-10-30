#!/usr/bin/env bash
# G7 真 PG 矩阵门（roadmap/#96 条目 6；总工裁 direct-2c7c431a：本地 docker 门，非 GitHub Actions）。
# 起 pinned postgres:16 容器 → B8 真库零跳过 → 固定 npm SQLite 黄金 → dual-backend-matrix --strict → 清理。
# 发版必跑；结果（rc、腿、镜像）贴进发布记录。"矩阵绿"是发布收口条件的一部分。
set -uo pipefail
cd "$(dirname "$0")/.."
PG_IMAGE="${PG_IMAGE:-postgres:16.4-alpine}"   # 钉装：镜像 tag 显式记录，漂移即换门
PG_PORT="${PG_PORT:-0}"
PG_PW="gategate"
CONTAINER="ygl-pg-gate-$$"
CONTAINER_ID=""
SEED_HOME=""
cleanup() {
  if [[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]]; then docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true; fi
  if [[ "$SEED_HOME" == "$PWD/tmp/g7-seed."* ]]; then rm -rf -- "$SEED_HOME"; fi
}
trap cleanup EXIT
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "✗ docker unavailable (G7 cannot skip PG)"; exit 1; }
echo "pg-gate: starting $PG_IMAGE on loopback :$PG_PORT"
CONTAINER_ID=$(docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PG_PW" -e POSTGRES_DB=ygl -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE") || { CONTAINER_ID=""; echo "✗ docker run failed"; exit 1; }
[[ "$CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || { CONTAINER_ID=""; echo "✗ invalid created container ID"; exit 1; }
for i in $(seq 1 30); do
  docker exec "$CONTAINER_ID" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER_ID" pg_isready -U postgres >/dev/null 2>&1 || { echo "✗ postgres not ready in 30s"; exit 1; }
PG_PORT=$(docker port "$CONTAINER_ID" 5432/tcp | sed -n 's/^127\.0\.0\.1://p')
[ -n "$PG_PORT" ] || { echo "✗ missing loopback PG port"; exit 1; }
export YGL_PG_URL="postgres://postgres:$PG_PW@127.0.0.1:$PG_PORT/ygl"
export B8_TEST_PG_ADMIN_URL="postgres://postgres:$PG_PW@127.0.0.1:$PG_PORT/postgres"
node scripts/dual-backend-matrix.mjs --b8-pg-only || exit $?
node scripts/dual-backend-matrix.mjs --b8-sqlite-only || exit $?
unset B8_TEST_PG_ADMIN_URL  # dedicated report above owns B8 counts; matrix must not rerun the same suite
# Only the disposable container receives schema: PG init is intentionally unsupported.
mkdir -p tmp
SEED_HOME=$(mktemp -d "$PWD/tmp/g7-seed.XXXXXX") || exit 1
YGL_HOME="$SEED_HOME" YGL_DB_URL="" YGL_SESSION="g7-seed" node dist/bundle/bin.cjs db init --json > "$SEED_HOME/init.json" || { echo "✗ G7 seed init failed"; exit 1; }
YGL_HOME="$SEED_HOME" YGL_DB_URL="" YGL_SESSION="g7-seed" node dist/bundle/bin.cjs db migrate pg --json > "$SEED_HOME/migrate.json" || { echo "✗ G7 seed migration failed"; exit 1; }
export YGL_SESSION="g7-matrix"
echo "pg-gate: dual-backend-matrix --strict (image=$PG_IMAGE)"
node scripts/dual-backend-matrix.mjs --strict
RC=$?
echo "pg-gate: rc=$RC image=$PG_IMAGE legs=sqlite+pg (G7)"
exit $RC
