/** patrol group — boundary assertions + disposition queue (0.93-T2).
 *
 * Productizes .157's ops-handbook sop-patrol-daily: a patrol check is a
 * declarative SELECT that returns VIOLATING rows (empty = pass); `patrol run`
 * re-evaluates every enabled check and upserts a findings queue. The iron
 * rule: no finding stays undispositioned — open findings age visibly, ack/fp/
 * fixed are the three exits (fixed also happens automatically when a
 * violation disappears).
 *
 * SQL safety: check bodies must be a single SELECT (prefix gate, no
 * semicolons — multi-statement is impossible without one) and are executed
 * through this SAME connection whose write path is only ever exercised via
 * the transactional write service; a hand-crafted write smuggled past the
 * gates would still need a ';' to run. */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, table, paint, C } from "../../../core/text/src/fmt";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";

const SEVERITIES = ["S1", "S2", "S3"] as const;

/** Gate a check body: single SELECT, no statement separator, sane length. */
function assertSelectGate(ctx: any, sql: string): boolean {
  const body = sql.trim();
  if (!/^SELECT\s/i.test(body)) {
    bad(ctx, `patrol check sql must start with SELECT (returns violating rows; empty = pass) — got: ${body.slice(0, 60)}`);
    return false;
  }
  if (body.includes(";")) {
    bad(ctx, "patrol check sql must be a single statement — semicolons are rejected");
    return false;
  }
  if (body.length > 4000) {
    bad(ctx, "patrol check sql too long (>4000 chars)");
    return false;
  }
  return true;
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;
  const sev = String(args.flags.severity || "S2");

  switch (action) {
    case "add": {
      const name = rest[0];
      const sql = String(args.flags.sql || "");
      if (!name || !sql) {
        bad(ctx, 'usage: patrol add <name> --sql "SELECT ... " [--severity S1|S2|S3] [--desc "..."]');
        return 2;
      }
      if (!SEVERITIES.includes(sev as any)) {
        bad(ctx, `--severity must be one of ${SEVERITIES.join("|")} — got: ${sev}`);
        return 2;
      }
      if (!assertSelectGate(ctx, sql)) return 2;
      return getOrm(env.db.path)
        .then((ds) => writes.patrolAdd(ds, { name, sql, severity: sev, description: String(args.flags.desc || "") }))
        .then((r: any): number => {
          const row = r.row ?? r;
          if (r.dup) {
            if (ctx.json) console.log(JSON.stringify({ ...row, duplicate: true }));
            else out(ctx, paint(C.yellow, `  ⚠ duplicate: patrol check '${row.name}' exists — sql unchanged (remove first: patrol rm ${row.name})`, ctx.color));
            return 0;
          }
          if (ctx.json) console.log(JSON.stringify(row));
          else out(ctx, `  ✓ patrol check added: ${row.name}  [${row.severity}]`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    case "rm": {
      const name = rest[0];
      if (!name) { bad(ctx, "usage: patrol rm <name>"); return 2; }
      return getOrm(env.db.path)
        .then((ds) => writes.patrolRm(ds, name))
        .then((r: any): number => {
          if (ctx.json) console.log(JSON.stringify(r));
          else out(ctx, `  ✓ patrol check removed: ${r.name}  (findings cleared: ${r.findings})`);
          return 0;
        })
        .catch((e: any): number => { bad(ctx, e?.message || String(e)); return 1; });
    }

    case "list": {
      const checks = store.db.all(
        `SELECT c.id, c.name, c.severity, c.enabled, c.description,
                (SELECT count(*) FROM patrol_findings f WHERE f.check_id=c.id AND f.status IN ('open','ack')) AS open
           FROM patrol_checks c ORDER BY c.name`
      ) as any[];
      if (ctx.json) { console.log(JSON.stringify(checks, null, 2)); return 0; }
      table(ctx, checks, ["id", "name", "severity", "on", "open", "description"], []);
      return 0;
    }

    case "run": {
      const only = String(args.flags.name || "");
      const checks = store.db.all(
        `SELECT * FROM patrol_checks WHERE enabled=1 ${only ? "AND name=?" : ""}`,
        only ? [only] : []
      ) as any[];
      if (only && !checks.length) {
        bad(ctx, `patrol check not found (or disabled): ${only}`);
        return 1;
      }
      return (async (): Promise<number> => {
        const results: any[] = [];
        let failedCheck = "";
        const ds = await getOrm(env.db.path);
        for (const c of checks) {
          let rows: any[] = [];
          try {
            rows = store.db.all(c.sql) as any[];
          } catch (e: any) {
            // a broken check must not take the run down — it becomes its own S1 finding
            rows = [{ check_error: String(e?.message || e).slice(0, 500) }];
            failedCheck = c.name;
          }
          const r = await writes.patrolRecord(ds, c.id, c.severity, rows);
          results.push({ name: c.name, severity: c.severity, ...r });
        }
        const openTotal = (store.db.get(
          `SELECT count(*) AS n FROM patrol_findings WHERE status IN ('open','ack')`
        ) as any)?.n ?? 0;
        if (ctx.json) {
          console.log(JSON.stringify({ checks: results, open_total: openTotal, ...(failedCheck ? { failed_check: failedCheck } : {}) }, null, 2));
        } else {
          for (const r of results) {
            const flag = r.violations ? paint(C.red, String(r.violations), ctx.color) : paint(C.green, "0", ctx.color);
            out(ctx, `  ${r.name}  [${r.severity}]  violations: ${flag}  (new ${r.fresh} · reopened ${r.reopened} · auto-fixed ${r.auto_fixed})`);
          }
          out(ctx, openTotal
            ? paint(C.yellow, `  ⚠ open findings: ${openTotal} — patrol findings (disposition: patrol ack|fp|fix <id>)`, ctx.color)
            : paint(C.green, `  ✓ all clear — open findings: 0`, ctx.color));
          if (failedCheck) out(ctx, paint(C.red, `  ✗ check errored: ${failedCheck} (recorded as a finding)`, ctx.color));
        }
        return 0;
      })().catch((e: any): number => { bad(ctx, e?.message || String(e)); return 1; });
    }

    case "findings": {
      const status = String(args.flags.status || "");
      const findings = store.db.all(
        `SELECT f.id, c.name AS check_name, f.severity, f.status, f.row_key, f.first_seen, f.last_seen, f.note
           FROM patrol_findings f JOIN patrol_checks c ON c.id=f.check_id
          ${status ? "WHERE f.status=?" : ""} ORDER BY f.last_seen DESC LIMIT 200`,
        status ? [status] : []
      ) as any[];
      if (ctx.json) { console.log(JSON.stringify(findings, null, 2)); return 0; }
      table(ctx, findings, ["id", "check_name", "severity", "status", "row_key", "last_seen", "note"], []);
      return 0;
    }

    case "ack":
    case "fp":
    case "fix": {
      const id = rest[0];
      const note = String(args.flags.note || "");
      if (!id) { bad(ctx, `usage: patrol ${action} <finding-id> [--note "..."]`); return 2; }
      return getOrm(env.db.path)
        .then((ds) => writes.patrolDisposition(ds, id, action as "ack" | "fp" | "fix", note))
        .then((f: any): number => {
          if (ctx.json) console.log(JSON.stringify(f));
          else out(ctx, `  ✓ ${id} → ${f.status}${note ? `  · ${note}` : ""}`);
          return 0;
        })
        .catch((e: any): number => { bad(ctx, e?.message || String(e)); return 1; });
    }

    default: {
      bad(ctx, 'usage: patrol add <name> --sql "SELECT ..." [--severity S1|S2|S3] | run [--name X] | list | findings [--status open|ack|fixed|fp] | ack|fp|fix <id> --note .. | rm <name>');
      return 2;
    }
  }
}
