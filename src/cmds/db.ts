import * as fs from "node:fs";
import { Env } from "../cli";
import { ok, out, head, table, paint, C, show } from "../fmt";
import { dbPath } from "../db";

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, db, home } = env;
  const file = args.flags.db ? String(args.flags.db) : dbPath(home);

  switch (action) {
    case "init": {
      fs.mkdirSync(home, { recursive: true });
      const d = new (require("../db").DB)(file);
      d.metaSet("created", new Date().toISOString());
      d.metaSet("schema_version", String(require("../db").SCHEMA_VERSION));
      d.close();
      ok(ctx, `workspace ready: ${home}`);
      ok(ctx, `database:        ${file}`);
      return 0;
    }
    case "path":
      out(ctx, file);
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
    case "export": {
      const dest = rest[0] || `ygl-trees-dump-${Date.now()}.sql`;
      // --lean: skip derived-table data (node_closure / node_index are
      // rebuilt by `node index`; their DDL still ships).
      const lean = args.flags.lean === true || args.flags.lean === "true";
      const skip = lean ? new Set(["node_closure", "node_index"]) : new Set<string>();
      // Order respects FK dependencies so the dump replays into a fresh db.
      const dataTables = [
        "meta", "skills", "skill_refs", "projects", "queries", "sources", "evidence",
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
      fs.writeFileSync(dest, lines.join("\n") + "\n", "utf8");
      ok(ctx, `dumped to ${dest}`);
      out(ctx, paint(C.dim, `  ${counts.join("  ")}`, ctx.color));
      return 0;
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
    case "":
      out(ctx, paint(C.dim, "  db: init | stats | path | export <file> [--lean] | dups | reset | sql \"<sql>\"", ctx.color));
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
