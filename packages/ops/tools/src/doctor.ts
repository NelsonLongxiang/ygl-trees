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
import { redactPgUrl } from "../../../core/database/src/asyncdb";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, paint, C } from "../../../core/text/src/fmt";
import { CONFIG_REGISTRY } from "./config";
import { parseEvalSpec } from "../../../techtree/eval/src/eval";
import { SCHEMA_VERSION, pidAlive } from "../../../core/database/src/db";
import { resolveProject, projectSessionKey, projectCount, sessionId } from "../../../core/database/src/selection";
import { listPlugins, profileDir } from "./plugins";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { orphanRelations } from "./rels";
import { updateHintFromCache } from "./update-check";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** Documentation drift audit (#85): skills/<name>/SKILL.md frontmatter version
 *  vs the running CLI. Only the source checkout has `skills/` + `package.json`
 *  at the same root; a workspace home has neither, so this returns null and
 *  doctor omits the row. */
export interface SkillVersionAudit {
  dir: string;
  total: number;
  lagging: Array<{ name: string; version: string }>;
  malformed: string[];
}

export function auditSkillVersions(cliVersion: string, root = process.cwd()): SkillVersionAudit | null {
  const cli = cliVersion.split(".").map((n) => Number(n) || 0);
  let dir = root;
  for (let i = 0; i < 6; i++, dir = dirname(dir)) {
    if (!fs.existsSync(join(dir, "skills")) || !fs.existsSync(join(dir, "package.json"))) {
      if (dirname(dir) === dir) break;
      continue;
    }
    const skillsDir = join(dir, "skills");
    const lagging: SkillVersionAudit["lagging"] = [];
    const malformed: string[] = [];
    let total = 0;
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const file = join(skillsDir, ent.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      total++;
      const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 20).join("\n");
      const m = /^version:\s*(\d+)\.(\d+)\.(\d+)\s*$/m.exec(head);
      if (!m) { malformed.push(ent.name); continue; }
      const got = [Number(m[1]), Number(m[2]), Number(m[3])];
      // major/minor lag is the actionable drift; patch-level diffs are noise.
      if (got[0] < cli[0] || (got[0] === cli[0] && got[1] < cli[1])) {
        lagging.push({ name: ent.name, version: `${m[1]}.${m[2]}.${m[3]}` });
      }
    }
    return { dir: skillsDir, total, lagging, malformed };
  }
  return null;
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, db, store } = env;
  const checks: Check[] = [];

  // 0.91.0 (cold-run friction log): doctor is a single-purpose group — an
  // unknown positional is a usage error (rc 2), not a silently-ignored token.
  if (action) {
    bad(ctx, `doctor takes no subcommands (got '${action}') — flags only: --json / --fix / --strict`);
    return 2;
  }

  // ── B7（总工 direct-f7d3b5da）：PG 直连 doctor ──
  // PG 模式（boot 已路由至此）：连通性 + 方言/目标报告；SQLite 专项检查
  // 显式 N/A（每项都有归属，不静默跳过）。
  if (db === null || db === undefined) {
    return (async (): Promise<number> => {
      const pgUrl = String(process.env.YGL_DB_URL || "");
      const redacted = redactPgUrl(pgUrl);
      const t0 = Date.now();
      let connected = false;
      let latencyMs = -1;
      let errDetail = "";
      try {
        const { Client } = require("pg");
        const client = new Client({ connectionString: pgUrl, connectionTimeoutMillis: 4000 });
        await client.connect();
        latencyMs = Date.now() - t0;
        connected = true;
        await client.end();
      } catch (e: any) {
        errDetail = String(e?.message || e);
      }
      checks.push({ name: "pg_connectivity", status: connected ? "pass" : "fail", detail: connected ? "connected (" + latencyMs + "ms) → " + redacted : "cannot connect: " + errDetail + " (" + redacted + ")" });
      checks.push({ name: "dialect", status: "pass", detail: "pg (B7 PG-direct mode)" });
      for (const n of ["schema_version", "index_freshness", "fts_sync", "orphans", "relation_orphans", "config", "stale_lock", "eval_envelopes", "plugin_profile", "write_integrity", "update_hint"]) {
        checks.push({ name: n, status: "warn" as const, detail: "N/A in PG mode — SQLite workspace check (run without YGL_DB_URL)" });
      }
      const failed = checks.filter((c) => c.status === "fail").length;
      if (ctx.json) {
        console.log(JSON.stringify(checks, null, 2));
      } else {
        head(ctx, "doctor — PG direct mode");
        for (const c of checks) out(ctx, (c.status === "pass" ? "  ✓ " : c.status === "warn" ? "  · " : "  ✗ ") + c.name + ": " + c.detail);
        out(ctx, paint(C.dim, "  PG 直连面：db stats | db path | doctor | webui；写/维护面需 SQLite 工作区（去掉 YGL_DB_URL）", ctx.color));
      }
      return failed ? 1 : 0;
    })();
  }

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

  // ── 2b. Selection hygiene (R16.2) ──
  // The global current_project pointer is a migration fallback now; a
  // multi-project workspace that ONLY has it (no session selection recorded)
  // gets a heads-up, since project-scoped commands fail-closed there.
  {
    const sel = resolveProject(db);
    const globalSet = !!db.metaGet("current_project");
    const sessionSet = !!db.metaGet(projectSessionKey());
    if (globalSet && !sessionSet && projectCount(db) > 1) {
      checks.push({
        name: "selection_hygiene",
        status: "warn",
        detail:
          `only the global 'current_project' pointer is set (migration fallback, source: ${sel.source}) — ` +
          `project-scoped commands fail-closed; run 'ygl-trees project use <name>' per session or pass --project`,
      });
    } else if (sel.source !== "none") {
      checks.push({ name: "selection_hygiene", status: "pass", detail: `selection resolves via ${sel.source}` });
    }
    // K3 0.106.0: the "default" bucket is the isolation hole that let 8 verifier
    // nodes land in the wrong tree — every bare process shares it. Warn when a
    // multi-project workspace is running without any session identity.
    const sid = sessionId();
    if (sid === "default" && projectCount(db) > 1) {
      checks.push({
        name: "session_identity",
        status: "warn",
        detail:
          "YGL_SESSION/DSH_SESSION_ID unset — every process shares the 'default' selection bucket; " +
          "parallel agents can flip each other's project/tree. Set YGL_SESSION per worker or pin with -p/-t",
      });
    }
    // Tree side: a lone global 'current_tree' pointer in a multi-tree workspace
    // is the same class of hazard (tree-scoped writes follow it silently).
    const treeCount = Number(db.get("SELECT COUNT(*) AS n FROM trees")?.n ?? 0);
    const treeSessionSet = !!db.metaGet(`current_tree@${sid}`);
    const treeGlobalSet = !!db.metaGet("current_tree");
    if (treeCount > 1 && treeGlobalSet && !treeSessionSet) {
      checks.push({
        name: "tree_selection_hygiene",
        status: "warn",
        detail:
          "only the global 'current_tree' pointer is set — parallel sessions flipping it move your writes; " +
          "run 'ygl-trees tree use <name>' per session or pass -t/--tree",
      });
    }
    // 0.114.22 (K3 #K3-3): doctor must also flag the tree-side default bucket —
    // the same isolation hole the project check names, on the other dimension.
    if (treeCount > 1 && sid === "default") {
      checks.push({
        name: "selection_hygiene_trees",
        status: "warn",
        detail:
          "YGL_SESSION/DSH_SESSION_ID unset — every process shares the 'default' tree selection bucket; " +
          "parallel agents can flip each other's current tree. Set YGL_SESSION per worker or pin with -t/--tree",
      });
    }
  }

  // ── 2c. Patrol queue (v12, 0.93-T2) — the zero-undispositioned iron rule
  // surfaced as workspace health: S1 open findings fail, S2/S3 open warn.
  {
    const hasPatrol = db.get("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='patrol_findings'");
    if (hasPatrol) {
      const openS1 = db.get("SELECT count(*) n FROM patrol_findings WHERE status IN ('open','ack') AND severity='S1'")?.n ?? 0;
      const openRest = db.get("SELECT count(*) n FROM patrol_findings WHERE status IN ('open','ack') AND severity!='S1'")?.n ?? 0;
      const checkCount = db.get("SELECT count(*) n FROM patrol_checks WHERE enabled=1")?.n ?? 0;
      if (openS1 > 0) {
        checks.push({ name: "patrol_queue", status: "fail", detail: `${openS1} open S1 finding(s) — run 'ygl-trees patrol findings --status open' and disposition (ack|fp|fix)` });
      } else if (openRest > 0) {
        checks.push({ name: "patrol_queue", status: "warn", detail: `${openRest} open finding(s) across ${checkCount} check(s) — patrol findings` });
      } else {
        checks.push({ name: "patrol_queue", status: "pass", detail: checkCount ? `all clear across ${checkCount} check(s)` : "no patrol checks registered" });
      }
    }
  }

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

  // ── 3b. ORM SQLite driver resolution (#54) ──
  // npm upgrades used to split better-sqlite3 (ours ^13, typeorm peer ^12) and
  // leave typeorm without a driver ("SQLite package has not been found").
  // Pin ^12 + this check: name the fix instead of a dead ORM write path.
  try {
    // #57: judge from TYPORM's resolution (not ours) and compare both copies.
    // A split tree can resolve two different better-sqlite3 packages while a
    // bare require from ygl-trees still reports one — that false pass is what
    // this check must not repeat.
    const typeormDir = require("node:path").dirname(require.resolve("typeorm"));
    const theirsPkg = require.resolve("better-sqlite3/package.json", { paths: [typeormDir] });
    const oursPkg = require.resolve("better-sqlite3/package.json");
    const theirVersion = require(theirsPkg).version;
    const ourVersion = require(oursPkg).version;
    const sameCopy = require("node:fs").realpathSync(theirsPkg) === require("node:fs").realpathSync(oursPkg);
    if (!sameCopy) {
      checks.push({
        name: "sqlite_driver",
        status: "warn",
        detail: `split better-sqlite3 tree: ygl-trees ${ourVersion} vs typeorm ${theirVersion} — run npm dedupe (or reinstall); see CHANGELOG 0.114.14 upgrade note`,
      });
    } else {
      checks.push({ name: "sqlite_driver", status: "pass", detail: `better-sqlite3 ${theirVersion} resolves for typeorm (single copy)` });
    }
  } catch {
    checks.push({
      name: "sqlite_driver",
      status: "fail",
      detail: "typeorm cannot resolve better-sqlite3 — run: npm dedupe (or reinstall) so the driver resolves; see CHANGELOG 0.114.14 upgrade note",
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

  // ── 5b. Orphaned relations (K3 0.106.0) ──
  // `relations` is type-agnostic and has no FK to its endpoints, so deleting a
  // node/evidence/claim leaves rows that point at nothing. Read paths tolerate
  // them (raw-id fallback), which is exactly why they must be visible here.
  {
    const dangling = orphanRelations(env);
    checks.push({
      name: "relation_orphans",
      status: dangling.length ? "warn" : "pass",
      detail: dangling.length
        ? `${dangling.length} relation(s) point at deleted rows — ygl-trees rel prune --dry-run lists them, rel prune removes them`
        : "every relation endpoint still exists",
    });
  }

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
    // 0.79.1: echo the holder's self-reported command line — naming the real
    // holder beats guessing (R297 report: "serve?" guess sent users astray).
    let holderCmd = "";
    try { holderCmd = fs.readFileSync(`${lockPath}/cmd`, "utf8").trim(); } catch { /* pre-0.79.1 lock */ }
    let status: Check["status"] = "pass";
    let detail = "no stale locks";
    if (foreignLock && holderAlive) {
      status = "pass";
      detail = `lock held by live pid ${lockHolder}${holderCmd ? ` (${holderCmd.slice(0, 80)})` : " (parallel session)"} — normal in multi-session use`;
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
  // 0.82 ①: `--fix write_integrity` — doctor --fix marks phantom events
  // reconciled (payload gains {"reconciled":<iso>}); the scan skips them.
  // Marking beats deleting: the audit trail stays, the operator said "known".
  const PHANTOM_SPECS = [
    { kind: "kb.add", table: "kb_notes", label: "kb", rm: "kb.rm" },
    { kind: "source.add", table: "sources", label: "source", rm: "source.rm" },
    { kind: "evidence.add", table: "evidence", label: "evidence", rm: "evidence.rm" },
  ];
  const phantomSql = (spec: { kind: string; table: string; rm: string }) =>
    `SELECT e.entity_id id, e.ts FROM events e
      WHERE e.kind='${spec.kind}'
        AND e.ts >= datetime('now', '-2 days')
        AND e.payload NOT LIKE '%"reconciled"%'
        AND NOT EXISTS (SELECT 1 FROM ${spec.table} t WHERE t.id = e.entity_id)
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.kind='${spec.rm}' AND r.entity_id = e.entity_id)`;
  {
    const phantoms: string[] = [];
    for (const spec of PHANTOM_SPECS) {
      const rows = db.all(phantomSql(spec));
      for (const r of rows) phantoms.push(`${spec.label} ${r.id} (${String(r.ts).slice(0, 16)})`);
    }
    // 0.81 ①: downgrade to warn — a missing row can also mean a legit delete
    // made BEFORE 0.81 (rm events didn't exist then) or via raw db sql; only
    // the receipt-vs-table comparison says "lost", and that distinction is
    // not worth failing doctor (which gates scripts) over.
    checks.push({
      name: "write_integrity",
      status: phantoms.length ? "warn" : "pass",
      detail: phantoms.length
        ? `${phantoms.length} unexplained write event(s) in last 48h: ${phantoms.slice(0, 3).join(", ")}${phantoms.length > 3 ? " …" : ""} — row missing without an rm event (deleted pre-0.81 or via db sql? otherwise: rollback / different workspace — check receipts' workspace line; doctor --fix marks known ones reconciled)`
        : "recent write events all match stored rows",
    });
  }

  // ── Update hint (diagnostics surface; cached only, never a network call) ──
  // 信息性 nag：不 gate 任何东西；R5b 审计时钟仍只认能力表（#29 裁定）。
  if (env.home && env.version) {
    const hint = updateHintFromCache(env.home, env.version);
    checks.push({
      name: "update_hint",
      status: hint?.update_available ? "warn" : "pass",
      detail: hint?.update_available
        ? `CLI ${env.version} < npm latest ${hint.latest} — npm i -g ygl-trees@latest（提示不影响判定/rc）`
        : hint
          ? hint.latest === env.version
            ? `CLI ${env.version} is current (cached latest ${hint.latest})`
            : `CLI ${env.version} is newer than cached latest ${hint.latest} (cache stale — refresh is best-effort, not a gate)`
          : `no cached update check yet (best-effort, never on the critical path)`,
    });
  }

  // ── Skill docs drift (source checkout only) ──
  // #85: the 12 skill frontmatters are written when the command face changes;
  // without a mechanical readout they silently lag the CLI (0.26 … 1.0.0 vs
  // 0.114.x). Warn, never fail: stale docs do not break the workspace.
  const skillAudit = env.version ? auditSkillVersions(env.version) : null;
  if (skillAudit) {
    const lagging = skillAudit.lagging.slice(0, 6).map((s) => `${s.name}@${s.version}`).join(", ");
    const more = skillAudit.lagging.length > 6 ? ` … +${skillAudit.lagging.length - 6}` : "";
    const bad = skillAudit.malformed.slice(0, 4).join(", ");
    checks.push({
      name: "skill_versions",
      status: skillAudit.lagging.length || skillAudit.malformed.length ? "warn" : "pass",
      detail: skillAudit.lagging.length || skillAudit.malformed.length
        ? `${skillAudit.total} skill doc(s); ${skillAudit.lagging.length} lag CLI ${env.version}: ${lagging}${more}${skillAudit.malformed.length ? `; no semver: ${bad}` : ""} — sync skills/*/SKILL.md version with the CLI`
        : `${skillAudit.total} skill doc(s) at CLI ${env.version} major/minor`,
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
    // 0.82 ①: phantom write events → mark reconciled. The operator looked at
    // the warn, decided the rows are gone for a known reason (db restore /
    // import experiment / pre-0.81 delete), and wants the warn gone. We
    // stamp payload.reconciled — the event stays for audit, the scan skips it.
    for (const spec of PHANTOM_SPECS) {
      const rows = db.all(phantomSql(spec)) as any[];
      if (!rows.length) continue;
      let marked = 0;
      for (const r of rows) {
        try {
          const cur = db.get("SELECT payload FROM events WHERE kind=? AND entity_id=? LIMIT 1", [spec.kind, r.id]) as any;
          let payload = "{}";
          try {
            payload = cur?.payload && String(cur.payload).trim().startsWith("{") ? String(cur.payload) : "{}";
          } catch { /* */ }
          const obj = JSON.parse(payload);
          obj.reconciled = new Date().toISOString();
          db.run("UPDATE events SET payload=? WHERE kind=? AND entity_id=?", [JSON.stringify(obj), spec.kind, r.id]);
          marked++;
        } catch { /* best-effort per event */ }
      }
      if (marked) fixes.push(`write_integrity: ${marked} ${spec.label} phantom event(s) marked reconciled (audit trail kept)`);
    }
    if (fixes.length) {
      for (const f of fixes) ok(ctx, `  fixed: ${f}`);
    } else {
      out(ctx, paint(C.dim, "  (--fix: no auto-fixable issues found)", ctx.color));
    }
  }
  return 0;
}
