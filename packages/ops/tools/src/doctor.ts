/**
 * doctor — one-stop health check for a ygl-trees workspace.
 * Checks: schema version, index freshness, FTS sync, duplicate content,
 * orphaned data, config validity, and stale locks.
 *
 * --json: pure JSON array of check results.
 * rc=0 all green, rc=1 any check failed.
 *
 * @module @ygl/ops-tools/doctor
 */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, paint, C } from "../../../core/text/src/fmt";
import { CONFIG_REGISTRY } from "./config";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, db, store } = env;
  const checks: Check[] = [];

  // ── 1. Schema version ──
  const sv = db.get("PRAGMA user_version")?.user_version ?? 0;
  const LATEST = 6;
  checks.push({
    name: "schema_version",
    status: sv === LATEST ? "pass" : sv < LATEST ? "warn" : "fail",
    detail: sv === LATEST ? `v${sv} (latest)` : `v${sv}, latest is v${LATEST} — open with newer CLI to auto-migrate`,
  });

  // ── 2. Index freshness ──
  const dirtyTrees = db.all("SELECT t.name FROM trees t JOIN node_index i ON i.tree_id=t.id WHERE i.dirty=1");
  checks.push({
    name: "index_freshness",
    status: dirtyTrees.length === 0 ? "pass" : "warn",
    detail: dirtyTrees.length === 0
      ? "all tree indexes clean"
      : `${dirtyTrees.length} tree(s) with dirty index: ${dirtyTrees.map((t: any) => t.name).join(", ")} — run: ygl-trees node index`,
  });

  // ── 3. FTS sync (spot check: sources vs sources_fts) ──
  const srcCount = db.get("SELECT COUNT(*) c FROM sources")?.c ?? 0;
  const srcFtsCount = db.get("SELECT COUNT(*) c FROM sources_fts")?.c ?? 0;
  const ftsSynced = srcCount === srcFtsCount;
  checks.push({
    name: "fts_sync",
    status: ftsSynced ? "pass" : "fail",
    detail: ftsSynced
      ? `sources_fts synced (${srcCount} rows)`
      : `sources=${srcCount} but sources_fts=${srcFtsCount} — re-add sources or rebuild FTS`,
  });

  // Also check kb_notes
  const kbCount = db.get("SELECT COUNT(*) c FROM kb_notes")?.c ?? 0;
  const kbFtsCount = db.get("SELECT COUNT(*) c FROM kb_fts")?.c ?? 0;
  if (kbCount !== kbFtsCount) {
    checks.push({
      name: "fts_sync_kb",
      status: "fail",
      detail: `kb_notes=${kbCount} but kb_fts=${kbFtsCount} — FTS out of sync`,
    });
  }

  // ── 4. Duplicate content ──
  const dupChecks = [
    { table: "claims", group: "project_id, text", label: "claims" },
    { table: "evidence", group: "source_id, quote", label: "evidence" },
    { table: "kb_notes", group: "title, body", label: "kb_notes" },
    { table: "jobs", group: "title", label: "jobs" },
  ];
  let dupTotal = 0;
  for (const dc of dupChecks) {
    const rows = db.all(`SELECT COUNT(*) c FROM (SELECT 1 FROM ${dc.table} GROUP BY ${dc.group} HAVING COUNT(*)>1)`);
    const n = Number(rows[0]?.c ?? 0);
    dupTotal += n;
    if (n > 0) {
      checks.push({
        name: `duplicates_${dc.label}`,
        status: "warn",
        detail: `${n} duplicate group(s) in ${dc.table} — run: ygl-trees db dups`,
      });
    }
  }
  if (dupTotal === 0) {
    checks.push({ name: "duplicates", status: "pass", detail: "no duplicate content rows" });
  }

  // ── 5. Orphaned data (evidence referencing missing sources, etc.) ──
  const orphanEvidence = db.get(
    "SELECT COUNT(*) c FROM evidence e WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=e.source_id)"
  )?.c ?? 0;
  const orphanEdges = db.get(
    "SELECT COUNT(*) c FROM node_edges e WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.parent_id) OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id=e.child_id)"
  )?.c ?? 0;
  const orphans = orphanEvidence + orphanEdges;
  checks.push({
    name: "orphans",
    status: orphans === 0 ? "pass" : "fail",
    detail: orphans === 0
      ? "no orphaned rows"
      : `${orphanEvidence} orphan evidence, ${orphanEdges} orphan edges — run: ygl-trees node validate`,
  });

  // ── 6. Config validity ──
  const configRows = db.all("SELECT key, value FROM config");
  let configIssues = 0;
  for (const row of configRows) {
    const spec = CONFIG_REGISTRY.find((c) => c.key === row.key);
    if (!spec) {
      configIssues++;
      checks.push({ name: `config_unknown:${row.key}`, status: "warn", detail: `unknown key in config table: ${row.key}` });
    } else if (spec.type === "number" && !Number.isFinite(Number(row.value))) {
      configIssues++;
      checks.push({ name: `config_invalid:${row.key}`, status: "fail", detail: `${row.key}='${row.value}' is not a valid number` });
    }
  }
  if (configIssues === 0) {
    checks.push({
      name: "config",
      status: "pass",
      detail: configRows.length === 0 ? "no overrides (all defaults)" : `${configRows.length} override(s), all valid`,
    });
  }

  // ── 7. Stale lock check ──
  const dbPath = db.path;
  const lockPath = `${dbPath}.lock`;
  const hasLock = require("node:fs").existsSync(lockPath);
  checks.push({
    name: "stale_lock",
    status: hasLock ? "warn" : "pass",
    detail: hasLock
      ? `lock dir detected: ${lockPath} — remove if no other ygl-trees process is running`
      : "no stale locks",
  });

  // ── Output ──
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;

  if (ctx.json) {
    console.log(JSON.stringify(checks, null, 2));
    return failed > 0 ? 1 : 0;
  }

  head(ctx, `Doctor — ${passed} pass · ${warned} warn · ${failed} fail`);
  out(ctx, "");
  for (const c of checks) {
    const icon = c.status === "pass" ? paint(C.green, "✓", ctx.color)
      : c.status === "warn" ? paint(C.yellow, "!", ctx.color)
      : paint(C.red, "✗", ctx.color);
    out(ctx, `  ${icon} ${c.name}: ${c.detail}`);
  }
  out(ctx, "");
  if (failed > 0) {
    bad(ctx, `${failed} check(s) failed`);
    return 1;
  }
  if (warned > 0) {
    out(ctx, paint(C.yellow, `  ${warned} warning(s) — see above`, ctx.color));
  }
  ok(ctx, failed === 0 ? "all checks passed" : "");
  return 0;
}
