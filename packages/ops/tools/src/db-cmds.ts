import * as path from "node:path";
import * as fs from "node:fs";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C, show } from "../../../core/text/src/fmt";
import { dbPath } from "../../../core/database/src/db";
import { syncToPg, migrateToPg } from "./pgsync";


/**
 * Cold-start: import the built-in skills that ship with this package, so a
 * fresh workspace immediately has capability discovery (agent match) working.
 * Resolves skills/ relative to the CLI installation (repo root or npm package).
 */
async function autoImportBuiltinSkills(env: any, dbFile: string): Promise<number> {
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  // probe upward from this module to find skills/ (same approach as repoRoot)
  let skillsDir: string | null = null;
  let dir: string = __dirname;
  for (let i = 0; i < 6; i++, dir = path2.dirname(dir)) {
    const candidate = path2.join(dir, "skills");
    if (fs2.existsSync(candidate)) {
      const entries = fs2.readdirSync(candidate).filter((e: string) =>
        fs2.existsSync(path2.join(candidate, e, "SKILL.md"))
      );
      if (entries.length > 0) {
        skillsDir = candidate;
        break;
      }
    }
  }
  if (!skillsDir) return 0;
  const { getOrm } = require("../../../core/database/src/orm");
  const writes = require("../../../research/pipeline/src/writes");
  const { parseFrontmatter } = require("../../../core/text/src/text");
  const ds = await getOrm(dbFile);
  let count = 0;
  // Note: getOrm caches the DataSource; the lock is released when the outer
  // DB.close() runs. For db init's short-lived process this is fine.
  for (const entry of fs2.readdirSync(skillsDir)) {
    const skillFile = path2.join(skillsDir, entry, "SKILL.md");
    if (!fs2.existsSync(skillFile)) continue;
    try {
      const raw = fs2.readFileSync(skillFile, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      await writes.skillUpsert(ds, {
        name: meta.name || entry,
        description: meta.description || "",
        body,
        tags: (meta.tags || "").toString(),
        version: meta.version || "0.1.0",
        origin: `builtin:${entry}`,
      });
      count++;
    } catch { /* per-skill isolation: one bad skill must not block the rest */ }
  }
  return count;
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, db, home } = env;
  const file = args.flags.db ? String(args.flags.db) : dbPath(home);

  switch (action) {
    case "init": {
      fs.mkdirSync(home, { recursive: true });
      const d = new (require("../../../core/database/src/db").DB)(file);
      d.metaSet("created", new Date().toISOString());
      d.metaSet("schema_version", String(require("../../../core/database/src/db").SCHEMA_VERSION));
      d.close();
      ok(ctx, `workspace ready: ${home}`);
      ok(ctx, `database:        ${file}`);
      // Cold-start fix (0.48): a fresh workspace has ZERO skills, so agent match
      // returns nothing and a cold user thinks the tool has no capabilities.
      // Auto-import the built-in skills that ship with this package.
      autoImportBuiltinSkills(env, file).then(async (n) => {
        if (n > 0) ok(ctx, `built-in skills:  ${n} imported (agent match ready)`);
        // Release the ORM connection so the lock doesn't linger
        try { const { closeOrm } = require("../../../core/database/src/orm"); await closeOrm(); } catch { /* */ }
      });
      return 0;
    }
    case "path":
      if (ctx.json) console.log(JSON.stringify({ path: file }, null, 2));
      else out(ctx, file);
      return 0;
    case "stats": {
      const s = env.store.stats();
      if (ctx.json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      head(ctx, "Database");
      show(ctx, { file, size_kb: (fs.statSync(file).size / 1024).toFixed(1), ...s });
      return 0;
    }
    case "time-travel": {
      // v2: query workspace state at a past moment using entity created_at
      const when = rest[0];
      if (!when) {
        bad(ctx, 'usage: db time-travel "YYYY-MM-DD HH:MM" (or "YYYY-MM-DD")');
        return 2;
      }
      const ts = when.includes(" ") ? when : when + " 23:59:59";
      const tables = ["projects", "sources", "evidence", "claims", "kb_notes", "skills", "trees", "nodes", "artifacts", "events"];
      const counts: Record<string, number> = {};
      for (const t of tables) {
        try {
          const r = db.get(`SELECT COUNT(*) as n FROM ${t} WHERE created <= ?`, [ts]) as any;
          counts[t] = r?.n || 0;
        } catch { counts[t] = 0; }
      }
      // node unlock state at that time (via events)
      let unlockedAt = 0;
      try {
        const r = db.get(
          `SELECT COUNT(DISTINCT entity_id) as n FROM events WHERE kind='node.unlock' AND ts <= ?`, [ts]
        ) as any;
        unlockedAt = r?.n || 0;
      } catch { /* */ }
      if (ctx.json) { console.log(JSON.stringify({ timestamp: ts, counts, unlocked_nodes: unlockedAt }, null, 2)); return 0; }
      head(ctx, `Workspace at ${ts}`);
      const labels: Record<string, string> = {
        projects: "项目", sources: "来源", evidence: "证据", claims: "断言",
        kb_notes: "知识", skills: "技能", trees: "树", nodes: "节点",
        artifacts: "产出", events: "事件",
      };
      for (const [k, v] of Object.entries(counts)) {
        out(ctx, `  ${String(labels[k] || k).padEnd(6)} ${String(v).padStart(5)}`);
      }
      out(ctx, `  已解锁  ${String(unlockedAt).padStart(5)}`);
      return 0;
    }
    case "timeline": {
      // v2: workspace growth timeline — events per day with entity milestones
      const days = db.all(`
        SELECT date(ts) as day, COUNT(*) as events,
          SUM(CASE WHEN kind LIKE 'project%' THEN 1 ELSE 0 END) as projects,
          SUM(CASE WHEN kind LIKE 'source%' THEN 1 ELSE 0 END) as sources,
          SUM(CASE WHEN kind LIKE 'claim%' THEN 1 ELSE 0 END) as claims,
          SUM(CASE WHEN kind LIKE 'kb%' THEN 1 ELSE 0 END) as kb,
          SUM(CASE WHEN kind LIKE 'node%' THEN 1 ELSE 0 END) as nodes
        FROM events GROUP BY date(ts) ORDER BY day
      `) as any[];
      if (!days.length) { ok(ctx, "no events yet"); return 0; }
      // F2 fix: --json outputs pure JSON (frozen contract ④)
      if (ctx.json) {
        console.log(JSON.stringify({ timeline: days, total: days.reduce((s2: number, d: any) => s2 + d.events, 0) }, null, 2));
        return 0;
      }
      const maxEvents = Math.max(...days.map(d => d.events));
      head(ctx, "Workspace Timeline");
      let totalP = 0, totalS = 0, totalC = 0, totalK = 0, totalN = 0;
      for (const d of days) {
        totalP += d.projects; totalS += d.sources; totalC += d.claims;
        totalK += d.kb; totalN += d.nodes;
        const barLen = Math.round(d.events / maxEvents * 30);
        const bar = "█".repeat(barLen);
        const milestones: string[] = [];
        if (d.projects > 0) milestones.push(`+${d.projects}项目`);
        if (d.sources > 0) milestones.push(`+${d.sources}来源`);
        if (d.claims > 0) milestones.push(`+${d.claims}断言`);
        if (d.kb > 0) milestones.push(`+${d.kb}知识`);
        if (d.nodes > 0) milestones.push(`+${d.nodes}节点`);
        out(ctx, `  ${d.day} ${bar.padEnd(32)} ${String(d.events).padStart(5)} events  ${milestones.join(" ")}`);
      }
      out(ctx, "");
      out(ctx, paint(C.dim, `  累计: ${totalP}项目 · ${totalS}来源 · ${totalC}断言 · ${totalK}知识 · ${totalN}节点变更`, ctx.color));
      return 0;
    }
    case "workspace": {
      // v2: multi-workspace management — each workspace is a YGL_HOME directory
      const sub = rest[0] || "list";
      const wsRoot = path.join(env.home, ".."); // parent of current workspace
      if (sub === "list") {
        const dirs = fs.existsSync(wsRoot) ? fs.readdirSync(wsRoot).filter((d: string) =>
          fs.existsSync(path.join(wsRoot, d, "ygl-trees.db"))
        ) : [];
        const cur = path.basename(env.home);
        head(ctx, "Workspaces (parent: " + wsRoot + ")");
        for (const d of dirs) {
          out(ctx, (d === cur ? "  * " : "    ") + d);
        }
        out(ctx, "");
        out(ctx, paint(C.dim, "  * = current | switch: YGL_HOME=<path> ygl-trees <cmd>", ctx.color));
        return 0;
      }
      if (sub === "create") {
        const name = rest[1];
        if (!name) { bad(ctx, "usage: db workspace create <name>"); return 2; }
        const dir = path.join(wsRoot, name);
        if (fs.existsSync(path.join(dir, "ygl-trees.db"))) {
          ok(ctx, `workspace already exists: ${name}`);
          return 0;
        }
        fs.mkdirSync(dir, { recursive: true });
        ok(ctx, `workspace created: ${dir}`);
        out(ctx, paint(C.dim, `  init: YGL_HOME=${dir} ygl-trees db init`, ctx.color));
        return 0;
      }
      bad(ctx, "usage: db workspace list | create <name>");
      return 2;
    }
    case "obsidian": {
      // v2 feature: export workspace as Obsidian-compatible markdown vault
      const outDir = rest[0] || path.join(env.home, "obsidian-export");
      fs.mkdirSync(path.join(outDir, "projects"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "knowledge"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "skills"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "trees"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "claims"), { recursive: true });
      let count = 0;
      const safe = (t: string) => String(t).replace(/[\/:*?"<>|]/g, "_").slice(0, 50);
      for (const p of db.all("SELECT * FROM projects") as any[]) {
        fs.writeFileSync(path.join(outDir, "projects", safe(p.name) + ".md"),
          `---
type: project
id: ${p.id}
---

# ${p.name}

${p.question || ""}
`);
        count++;
      }
      for (const n of db.all("SELECT * FROM kb_notes") as any[]) {
        fs.writeFileSync(path.join(outDir, "knowledge", safe(n.title) + ".md"),
          `---
type: knowledge
tags: ${n.tags || ""}
confidence: ${n.confidence}
---

# ${n.title}

${n.body}
`);
        count++;
      }
      for (const sk of db.all("SELECT * FROM skills WHERE enabled=1") as any[]) {
        fs.writeFileSync(path.join(outDir, "skills", safe(sk.name) + ".md"),
          `---
type: skill
version: ${sk.version}
---

# ${sk.name}

${String(sk.body).slice(0, 500)}
`);
        count++;
      }
      for (const t of db.all("SELECT * FROM trees") as any[]) {
        const nodes = db.all("SELECT * FROM nodes WHERE tree_id=?", [t.id]) as any[];
        let c = `---
type: tree
---

# ${t.name} (${nodes.length} nodes)

`;
        for (const n of nodes) c += `- **${n.key}** (${n.kind}, tier ${n.tier})
`;
        fs.writeFileSync(path.join(outDir, "trees", safe(t.name) + ".md"), c);
        count++;
      }
      for (const cl of db.all("SELECT * FROM claims") as any[]) {
        const links = db.all("SELECT e.quote FROM claim_evidence ce JOIN evidence e ON ce.evidence_id=e.id WHERE ce.claim_id=?", [cl.id]) as any[];
        let c2 = `---
type: claim
status: ${cl.status}
confidence: ${cl.confidence}
---

# ${cl.id}

${cl.text}

## Evidence
`;
        for (const l of links) c2 += `- > ${String(l.quote).slice(0, 100)}
`;
        fs.writeFileSync(path.join(outDir, "claims", cl.id + ".md"), c2);
        count++;
      }
      ok(ctx, `obsidian vault exported: ${count} files → ${outDir}`);
      return 0;
    }
    case "export": {
      const dest = rest[0] || `ygl-trees-dump-${Date.now()}.sql`;
      // --lean: skip derived-table data (node_closure / node_index are
      // rebuilt by `node index`; their DDL still ships).
      const lean = args.flags.lean === true || args.flags.lean === "true";
      const skip = lean ? new Set(["node_closure", "node_index"]) : new Set<string>();
      // Order respects FK dependencies so the dump replays into a fresh db.
      const dataTables = [
        "meta", "config", "skills", "skill_refs", "projects", "queries", "sources", "query_sources", "evidence",
        "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links",
        "trees", "nodes", "node_edges", "node_closure", "node_conditions", "node_state", "node_index",
        "relations", "jobs", "runs", "events",
      ];
      const lines: string[] = [
        "-- ygl-trees full dump",
        "-- replay: sqlite3 new.db < dump.sql   (foreign_keys toggled below)",
        "PRAGMA foreign_keys=OFF;",
      ];
      // FTS5 shadow tables (skills_fts_data, …_idx, …) don't carry the
      // sqlite_ prefix; replaying their CREATE after CREATE VIRTUAL TABLE
      // would collide with the ones the virtual table creates itself.
      const FTS_TABLES = ["skills_fts", "sources_fts", "evidence_fts", "kb_fts", "nodes_fts"];
      const isFtsOrShadow = (n: string) => FTS_TABLES.some((f) => n === f || n.startsWith(f + "_"));
      for (const r of db.all(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
      ))
        if (!isFtsOrShadow(r.name)) lines.push(r.sql + ";");
      const counts: string[] = [];
      for (const t of dataTables) {
        if (skip.has(t)) {
          counts.push(`${t}:skipped`);
          continue;
        }
        const rows = db.all(`SELECT * FROM ${t}`);
        for (const r of rows) {
          const cols = Object.keys(r);
          const vals = cols.map((c) => sqlLit(r[c])).join(",");
          lines.push(`INSERT OR REPLACE INTO ${t}(${cols.join(",")}) VALUES(${vals});`);
        }
        counts.push(`${t}:${rows.length}`);
      }
      lines.push("PRAGMA foreign_keys=ON;");
      // atomic: a truncated SQL dump restores as data loss — never half-write
      const { writeFileAtomic } = require("@deepseek-ai/dsh-atomic-write");
      return writeFileAtomic(dest, lines.join("\n") + "\n", {} as any).then((): number => {
        ok(ctx, `dumped to ${dest}`);
        out(ctx, paint(C.dim, `  ${counts.join("  ")}`, ctx.color));
        return 0;
      });
    }
    case "reset": {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
      }
      ok(ctx, `removed ${file}`);
      return 0;
    }
    case "sql": {
      const sql = rest.join(" ");
      if (!sql) return 0;
      const rows = db.all(sql);
      table(ctx, rows);
      return 0;
    }
    case "dups": {
      // Rows sharing identical base content (incl. pre-v3 duplicates kept
      // alive by salted hashes during migration).
      const checks: Array<[string, string]> = [
        ["claims", "project_id || '|' || text"],
        ["queries", "project_id || '|' || text"],
        ["evidence", "source_id || '|' || quote"],
        ["kb_notes", "title || '|' || body"],
        ["jobs", "title"],
      ];
      const found: any[] = [];
      for (const [t, grp] of checks) {
        const rows = db.all(
          `SELECT ${grp} AS g, COUNT(*) AS c FROM ${t} GROUP BY g HAVING c>1 ORDER BY c DESC LIMIT 20`
        );
        for (const r of rows) found.push({ table: t, count: r.c, content: String(r.g).replace(/\s+/g, " ").slice(0, 70) });
      }
      if (ctx.json) {
        console.log(JSON.stringify(found, null, 2));
        return 0;
      }
      if (!found.length) {
        ok(ctx, "no duplicate content rows");
        return 0;
      }
      head(ctx, `Duplicate content (${found.length})`);
      table(ctx, found, ["table", "count", "content"], ["table", "count", "content"]);
      return 1;
    }
    case "sync": {
      if (rest[0] !== "pg") {
        bad(ctx, 'usage: db sync pg <url> [--tables a,b]   (url or env YGL_PG_URL)');
        return 2;
      }
      const url = rest[1] || process.env.YGL_PG_URL || "";
      if (!url) {
        bad(ctx, "missing postgres url — pass it or set YGL_PG_URL (keeps credentials out of shell history)");
        return 2;
      }
      const only = args.flags.tables ? String(args.flags.tables).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
      return syncToPg(db, url, only)
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify(r, null, 2));
            return 0;
          }
          ok(ctx, `mirrored ${r.tables.length} table(s) to PostgreSQL (${r.fulltext})`);
          out(ctx, paint(C.dim, `  ${r.server_version.split(" (")[0]}`, ctx.color));
          out(ctx, paint(C.dim, `  ${r.tables.map((t) => `${t.table}:${t.rows}`).join("  ")}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `sync failed: ${e?.message || e}`);
          return 1;
        });
    }
    case "migrate": {
      if (rest[0] !== "pg") {
        bad(ctx, "usage: db migrate pg <url> [--fresh]   (url or env YGL_PG_URL)");
        return 2;
      }
      const url = rest[1] || process.env.YGL_PG_URL || "";
      if (!url) {
        bad(ctx, "missing postgres url — pass it or set YGL_PG_URL");
        return 2;
      }
      const fresh = args.flags.fresh === true || args.flags.fresh === "true";
      return migrateToPg(db, url, fresh)
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify(r, null, 2));
            return 0;
          }
          ok(ctx, `migrated ${r.tables.length} table(s) into PostgreSQL — one-time, full fidelity`);
          out(ctx, paint(C.dim, `  ${r.server_version.split(" (")[0]} · FK ${r.constraints.fk} · UNIQUE ${r.constraints.unique} · ${r.fulltext}`, ctx.color));
          out(ctx, paint(C.dim, `  ${r.tables.map((t) => `${t.table}:${t.rows}`).join("  ")}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `migrate failed: ${e?.message || e}`);
          return 1;
        });
    }
    case "":
      out(ctx, paint(C.dim, "  db: init | stats | path | export [--lean] | sync pg <url> | migrate pg <url> [--fresh] | dups | reset | sql \"<sql>\"", ctx.color));
      return 0;
    default:
      out(ctx, paint(C.red, `  unknown db action: ${action}`, ctx.color));
      return 2;
  }
}

function sqlLit(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
