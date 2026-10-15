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
      const lines = db
        .all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
        .map((r: any) => r.sql + ";");
      for (const t of ["meta", "skills", "skill_refs", "projects", "queries", "sources", "evidence", "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links", "relations", "jobs", "runs", "events"]) {
        const rows = db.all(`SELECT * FROM ${t}`);
        for (const r of rows) {
          const cols = Object.keys(r);
          const vals = cols.map((c) => sqlLit(r[c])).join(",");
          lines.push(`INSERT OR REPLACE INTO ${t}(${cols.join(",")}) VALUES(${vals});`);
        }
      }
      fs.writeFileSync(dest, lines.join("\n") + "\n");
      ok(ctx, `dumped to ${dest}`);
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
    case "":
      out(ctx, paint(C.dim, "  db: init | stats | path | export <file> | reset | sql \"<sql>\"", ctx.color));
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
