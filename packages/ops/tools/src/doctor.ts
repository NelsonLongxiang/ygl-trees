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
import { parseEvalSpec } from "../../../techtree/eval/src/eval";
import { SCHEMA_VERSION, pidAlive } from "../../../core/database/src/db";
import { listPlugins, profileDir } from "./plugins";
import * as fs from "node:fs";

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
  const LATEST = SCHEMA_VERSION; // single source of truth in db.ts (v7 era)
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
  // Real-user report ②: a residual lock with a DEAD pid earned an ambiguous
  // "remove if no other process is running" warning, and a LIVE holder
  // (parallel session / serve) was indistinguishable from garbage. Now the
  // pid liveness probe (same one lock acquisition uses) decides:
  //   dead holder → warn (clearable via `db unlock` / doctor --fix)
  //   live holder → PASS (a live write-lock is a legitimate parallel session)
  const dbPath = db.path;
  const lockPath = `${dbPath}.ygllock`;
  {
    // Report ②: a foreign LIVE holder is normal multi-session usage; only a
    // DEAD holder is stale residue (db unlock / doctor --fix clear it).
    let lockHolder = "";
    try { lockHolder = fs.readFileSync(`${lockPath}/pid`, "utf8").trim(); } catch { /* absent/unreadable */ }
    const mine = lockHolder === String(process.pid);
    const foreignLock = fs.existsSync(lockPath) && !mine;
    const holderAlive = !!lockHolder && pidAlive(lockHolder);
    let status: Check["status"] = "pass";
    let detail = "no stale locks";
    if (foreignLock && holderAlive) {
      status = "pass";
      detail = `lock held by live pid ${lockHolder} (parallel session / serve) — normal in multi-session use`;
    } else if (foreignLock) {
      status = "warn";
      detail = `stale lock (pid ${lockHolder || "?"} dead) — ygl-trees db unlock or doctor --fix clears it`;
    }
    checks.push({ name: "stale_lock", status, detail });
  }

  // ── 8. eval-family envelope sanity (0.28.0) ──
  // A malformed envelope silently degrades: evalChoice/evalScore fall back to
  // empty options/levels → the gate can never resolve (always pending).
  {
    const evalConds = db.all(
      `SELECT c.id, c.name, c.op, c.value, n.key AS node
         FROM node_conditions c JOIN nodes n ON n.id=c.node_id
        WHERE c.op IN ('eval','eval-choice','eval-score')`
    );
    const bad: string[] = [];
    for (const c of evalConds) {
      const spec = parseEvalSpec(c.value);
      if (c.op === "eval-choice") {
        if (!spec.options || !Object.keys(spec.options).length) bad.push(`${c.name}(${c.node}): no options in envelope`);
        else if (!spec.answer || !(spec.answer in spec.options)) bad.push(`${c.name}(${c.node}): answer '${spec.answer}' not in options`);
      } else if (c.op === "eval-score") {
        if (!spec.levels || spec.levels.length < 2 || spec.levels.length > 10)
          bad.push(`${c.name}(${c.node}): levels must be 2-10, got ${spec.levels?.length ?? 0}`);
        else if (typeof spec.min !== "number" || spec.min < 0 || spec.min > spec.levels.length - 1)
          bad.push(`${c.name}(${c.node}): min=${spec.min} outside [0, ${spec.levels.length - 1}]`);
      }
      // op=eval keeps plain wording (envelope tolerated, fields not required)
    }
    checks.push({
      name: "eval_envelopes",
      status: bad.length ? "fail" : "pass",
      detail: bad.length
        ? `${bad.length} malformed: ${bad.slice(0, 3).join("; ")}${bad.length > 3 ? " …" : ""}`
        : `all ${evalConds.length} eval-family condition envelope(s) valid`,
    });
  }

  // ── 9. User plugin profile integrity (R14 L3) ──
  {
    try {
      if (!require("node:fs").existsSync(profileDir(env.home))) {
        checks.push({ name: "plugin_profile", status: "pass", detail: "no user plugin profile (plugin init to create)" });
      } else {
        const rows = listPlugins(env.home);
        const broken = rows.filter((r: any) => !r.resolvable);
        checks.push({
          name: "plugin_profile",
          status: broken.length ? "fail" : "pass",
          detail: broken.length
            ? `unresolvable: ${broken.map((r: any) => r.name).join(", ")} — plugin remove <name> or fix install`
            : `${rows.length} user plugin(s) resolvable from ${profileDir(env.home)}`,
        });
      }
    } catch (e: any) {
      checks.push({ name: "plugin_profile", status: "fail", detail: `profile read failed: ${e?.message || e}` });
    }
  }

  // ── 10. Write integrity: recent write events whose rows are missing ──
  // Real-user report ①: `kb add` returned ✓ but the note was never found
  // again (search/list/promote all missed it). If a write event landed but
  // the row did not, the write path lost data (rollback / crash between
  // commit and receipt / a different workspace). This check replays recent
  // write events against the base tables and names the phantom ids.
  {
    const PHANTOM_SPECS = [
      { kind: "kb.add", table: "kb_notes", label: "kb" },
      { kind: "source.add", table: "sources", label: "source" },
      { kind: "evidence.add", table: "evidence", label: "evidence" },
    ];
    const phantoms: string[] = [];
    for (const spec of PHANTOM_SPECS) {
      const rows = db.all(
        `SELECT e.entity_id id, e.ts FROM events e
          WHERE e.kind='${spec.kind}'
            AND e.ts >= datetime('now', '-2 days')
            AND NOT EXISTS (SELECT 1 FROM ${spec.table} t WHERE t.id = e.entity_id)`
      );
      for (const r of rows) phantoms.push(`${spec.label} ${r.id} (${String(r.ts).slice(0, 16)})`);
    }
    checks.push({
      name: "write_integrity",
      status: phantoms.length ? "fail" : "pass",
      detail: phantoms.length
        ? `${phantoms.length} phantom write event(s) in last 48h: ${phantoms.slice(0, 3).join(", ")}${phantoms.length > 3 ? " …" : ""} — event logged but row missing (rollback or different workspace; check receipts' workspace line)`
        : "recent write events all match stored rows",
    });
  }

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
  // ⑥ cold-user report: "all checks passed" alongside "1 warning(s)" is
  // semantically contradictory — qualify the success message.
  if (warned > 0) {
    out(ctx, paint(C.yellow, `  ${warned} warning(s) — see above`, ctx.color));
    ok(ctx, `checks passed (${warned} warning${warned > 1 ? "s" : ""})`);
  } else {
    ok(ctx, "all checks passed");
  }

  // ⑥ doctor --fix: safe auto-remediation
  if (args?.flags?.fix && warned > 0) {
    const fixes: string[] = [];
    // dirty index → suggest rebuild command (sync, no ORM needed here)
    const idx = db.get("SELECT value FROM meta WHERE key='index_dirty'") as any;
    if (idx?.value === "1") {
      db.run("UPDATE meta SET value='0' WHERE key='index_dirty'");
      fixes.push("index dirty flag cleared (run: ygl-trees node index)");
    }
    // stale lock → remove ONLY if the holder pid is dead (report ②: --fix used
    // to nuke ANY non-self lock — including a live parallel session's, which
    // reintroduced exactly the double-writer corruption the lock prevents)
    {
      const { pidAlive } = require("../../../core/database/src/db");
      const lockDir = `${env.db.path}.ygllock`;
      let holder = "";
      try { holder = fs.readFileSync(`${lockDir}/pid`, "utf8").trim(); } catch { /* */ }
      if (fs.existsSync(lockDir) && holder !== String(process.pid) && !pidAlive(holder)) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); fixes.push("stale lock removed (holder pid dead)"); } catch { /* */ }
      }
    }
    if (fixes.length) {
      for (const f of fixes) ok(ctx, `  fixed: ${f}`);
    } else {
      out(ctx, paint(C.dim, "  (--fix: no auto-fixable issues found)", ctx.color));
    }
  }
  return 0;
}
