/** job group — batch + schedule. `job tick` is what cron/systemctl drives.
 *  Writes (add) run on the TypeORM write service (src/writes.ts). */
import { execSync } from "node:child_process";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, table, paint, C, writeResult } from "../../../core/text/src/fmt";
import { nowIso } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";
import { configGetNumber } from "./config";
import { sessionId } from "../../../core/database/src/selection";
import { jobHealth, JobRunRow } from "../../../research/pipeline/src/lifecycle";

const JOB_USAGE = 'usage: job add <title> [--every <min> [--allow-frequent]|--at "YYYY-MM-DD HH:MM"|--manual] [--force] -- <command> | ' +
  "list | show <id|title> | run <id|title> | tick | enable|disable <id> | retire <id|title> --reason <why> | prune-runs [--keep N] [--apply] | logs";

/** Each job's newest runs (newest first), for health. One query, grouped in memory. */
function runsByJob(env: Env, perJob = 20): Map<string, JobRunRow[]> {
  const by = new Map<string, JobRunRow[]>();
  for (const r of env.db.all("SELECT job_id, started, finished, rc, output FROM runs ORDER BY started DESC, id DESC") as any[]) {
    const list = by.get(r.job_id) ?? [];
    if (list.length < perJob) list.push(r);
    by.set(r.job_id, list);
  }
  return by;
}

/** Job rows as `job list --json` / `job show` expose them (#220): the stored row, its command, and derived health. */
export function jobViews(env: Env): Array<Record<string, any>> {
  const failing = configGetNumber(env.db, "job.failing_runs");
  const runs = runsByJob(env);
  const now = Date.now();
  return (env.db.all("SELECT * FROM jobs ORDER BY created") as any[]).map((j) => ({
    id: j.id, title: j.title, command: j.command, every: j.every_minutes, at: j.at, enabled: j.enabled, runs: j.runs,
    last_run: j.last_run, status: j.status, created: j.created,
    ...jobHealth(j, runs.get(j.id) ?? [], now, failing),
  }));
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;

  switch (action) {
    case "add": {
      const title = rest[0];
      let command = rest.slice(1).join(" ");
      // Flags placed after the `--` separator land inside the command string
      // (e.g. `job add t -- "cmd" --every 60`). Pull them back out so both
      // `job add t --every 60 -- "cmd"` and the trailing form work.
      let every = Number(args.flags.every || 0);
      let at = String(args.flags.at || "");
      const tailEvery = /\s--every(?:=|\s+)?(\d+)\s*$/.exec(command);
      if (tailEvery) {
        every = Number(tailEvery[1]);
        command = command.slice(0, tailEvery.index).trim();
      }
      // Shim-proof: on Windows the npm .cmd shim re-splits space-bearing flag
      // values, so the quoted pre-`--` form reaches us as loose words inside
      // the command. Accept a bare `YYYY-MM-DD HH:MM[:SS]` (also `T`-joined)
      // at the tail so both platforms parse.
      const tailAt =
        /\s--at(?:=|\s+)?("[^"]*"|'[^']*'|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?|\S+)\s*$/.exec(command);
      if (tailAt) {
        at = tailAt[1].replace(/^["']|["']$/g, "");
        command = command.slice(0, tailAt.index).trim();
      }
      if (!title || !command) {
        bad(ctx, 'usage: job add <title> [--every <min>|--at "YYYY-MM-DD HH:MM"|--manual] -- <command>');
        return 2;
      }
      const manual = args.flags.manual === true || args.flags.manual === "true";
      const allowFrequent = args.flags["allow-frequent"] === true || args.flags["allow-frequent"] === "true";
      // #220 J4: a job with no schedule never runs on tick. It used to land silently as "manual" (every=0) — the
      // 0.114.4 misregistration shape — so it now has to be declared.
      if (manual && (every || at)) {
        bad(ctx, `--manual means no schedule; drop --every/--at, or drop --manual — ${JOB_USAGE}`);
        return 2;
      }
      if (!every && !at && !manual) {
        const leftover = /--every\b|--at\b/.test(command) ? " (a schedule-shaped token is still inside the command: move --every/--at before --)" : "";
        bad(ctx, `job add needs a schedule: --every <min> or --at "YYYY-MM-DD HH:MM", or --manual for a job run only by \`job run\`${leftover}`);
        return 2;
      }
      const floor = configGetNumber(env.db, "job.min_every_minutes");
      if (every > 0 && floor > 0 && every < floor && !allowFrequent) {
        bad(ctx, `--every ${every} is below job.min_every_minutes (${floor}); pass --allow-frequent if this cadence is intended`);
        return 2;
      }
      // F1/F3 (0.114.4, fdc757f6 09:25): the tail pull is a compatibility
      // heuristic — when the command string still carries a schedule-shaped
      // token (e.g. `--every 1440 --json`; the suffix token breaks the
      // end-of-string pull), the row must not land as a silent manual job.
      // Warn, do not reject: any command may legitimately own a same-named flag.
      const scheduleDiagnostics: string[] = [];
      if (/--every\b|--at\b/.test(command)) {
        const schedule = every ? `every ${every} min` : at ? `at ${at}` : "manual(every=0)";
        const warning = `schedule 形 token 残留命令串内，本 job 已按 ${schedule} 注册；若意图是调度，请把 --every 移到 -- 之前`;
        scheduleDiagnostics.push(warning);
        if (!ctx.json) console.error(paint(C.yellow, `  ! ${warning}`, ctx.color));
      }
      const force = args.flags.force === true || args.flags.force === "true";
      return getOrm(env.db.path)
        .then((ds) => writes.jobAdd(ds, { title, command, every, at, force }))
        .then((r): number => {
          if (ctx.json) {
            console.log(
              JSON.stringify({
                ...r.row,
                ...(r.dup ? { duplicate: true } : {}),
                ...(scheduleDiagnostics.length ? { diagnostics: scheduleDiagnostics } : {}),
              }, null, 2),
            );
            return 0;
          }
          writeResult(ctx, r as any, (row) => `job registered: ${row.id}  ${row.title}`);
          if (!ctx.json) {
            out(ctx, paint(C.dim, `  command:  ${r.row.command}`, ctx.color));
            out(ctx, paint(C.dim, `  schedule: ${r.row.every_minutes ? `every ${r.row.every_minutes} min` : r.row.at || "manual"}`, ctx.color));
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "list": {
      const rows = jobViews(env);
      if (ctx.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      table(ctx, rows, ["id", "title", "every", "at", "on", "runs", "last_run", "health"], [
        "id",
        "title",
        "every",
        "at",
        "enabled",
        "runs",
        "last_run",
        "health",
      ]);
      return 0;
    }
    case "show": {
      if (!rest[0]) { bad(ctx, `job show needs <id|title> — ${JOB_USAGE}`); return 2; }
      const j = jobViews(env).find((r) => r.id === rest[0] || r.title === rest[0]);
      if (!j) { bad(ctx, `job not found: ${rest[0]}`); return 1; }
      const recent = store.db.all("SELECT id, started, finished, rc, substr(output,1,200) AS output FROM runs WHERE job_id=? ORDER BY started DESC, id DESC LIMIT 10", [j.id]);
      if (ctx.json) { console.log(JSON.stringify({ ...j, recent_runs: recent }, null, 2)); return 0; }
      for (const k of ["id", "title", "command", "every", "at", "enabled", "status", "health", "consecutive_failures", "last_ok", "last_error", "next_due", "runs", "last_run"])
        out(ctx, `  ${k.padEnd(21)} ${j[k] === "" || j[k] === undefined ? "—" : String(j[k])}`);
      out(ctx, `  recent runs`);
      for (const r of recent as any[]) out(ctx, `    ${r.started}  rc=${r.rc ?? "…"}  ${String(r.output || "").replace(/\s+/g, " ").slice(0, 100)}`);
      return 0;
    }
    case "retire": {
      if (!rest[0] || typeof args.flags.reason !== "string" || !args.flags.reason.trim()) {
        bad(ctx, `job retire needs <id|title> and --reason "<why>" — ${JOB_USAGE}`);
        return 2;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.jobRetire(ds, rest[0], String(args.flags.reason)))
        .then((r): number => {
          if (ctx.json) { console.log(JSON.stringify({ ...r.row, ...(r.dup ? { duplicate: true } : {}) }, null, 2)); return 0; }
          writeResult(ctx, r as any, (row) => `job retired: ${row.id}  ${row.title}  (disabled; history kept)`);
          return 0;
        })
        .catch((e: any): number => { bad(ctx, e?.message || String(e)); return 1; });
    }
    case "prune-runs": {
      const keepRaw = args.flags.keep;
      const keep = keepRaw === undefined ? configGetNumber(env.db, "job.keep_runs") : Number(keepRaw);
      if (!Number.isInteger(keep) || keep < 1) { bad(ctx, `--keep must be a whole number ≥ 1 — ${JOB_USAGE}`); return 2; }
      const apply = args.flags.apply === true || args.flags.apply === "true";
      return getOrm(env.db.path)
        .then((ds) => writes.jobPruneRuns(ds, keep, apply))
        .then((r): number => {
          if (ctx.json) { console.log(JSON.stringify({ keep, apply, ...r }, null, 2)); return 0; }
          const total = r.jobs.reduce((n, j) => n + j.prune, 0);
          table(ctx, r.jobs, ["id", "title", "total", "prune"], ["id", "title", "total", "prune"]);
          if (apply) ok(ctx, `deleted ${r.deleted} run row(s) beyond the newest ${keep} per job`);
          else out(ctx, paint(C.dim, `  dry run: ${total} run row(s) beyond the newest ${keep} per job would be deleted — add --apply to delete`, ctx.color));
          return 0;
        })
        .catch((e: any): number => { bad(ctx, e?.message || String(e)); return 1; });
    }
    case "run": {
      if (!rest[0]) {
        bad(ctx, "usage: job run <jobId|title>");
        return 2;
      }
      const j = store.db.get("SELECT * FROM jobs WHERE id=? OR title=?", [rest[0], rest[0]]);
      if (!j) {
        bad(ctx, `job not found: ${rest[0]}`);
        return 1;
      }
      execute(env, j);
      return 0;
    }
    case "tick": {
      return withTickLock(env, () => {
        const staleMin = configGetNumber(env.db, "job.stale_minutes");
        const reaped = store.jobReapStuck(staleMin);
        if (reaped) out(ctx, paint(C.yellow, `  ! reaped ${reaped} stuck run(s) (killed mid-run, >${staleMin}min)`, ctx.color));
        const due = store.jobDue();
        if (!due.length) {
          out(ctx, paint(C.dim, "  nothing due", ctx.color));
          return 0;
        }
        for (const j of due) execute(env, j);
        return 0;
      });
    }
    case "disable": {
      if (!rest[0]) {
        bad(ctx, "usage: job disable <jobId|title>");
        return 2;
      }
      const r = store.db.run("UPDATE jobs SET enabled=0 WHERE id=? OR title=?", [rest[0], rest[0]]);
      if (!r.changes) {
        bad(ctx, `job not found: ${rest[0]}`);
        return 1;
      }
      ok(ctx, `job disabled: ${rest[0]}`);
      return 0;
    }
    case "enable": {
      if (!rest[0]) {
        bad(ctx, "usage: job enable <jobId|title>");
        return 2;
      }
      const r = store.db.run("UPDATE jobs SET enabled=1 WHERE id=? OR title=?", [rest[0], rest[0]]);
      if (!r.changes) {
        bad(ctx, `job not found: ${rest[0]}`);
        return 1;
      }
      ok(ctx, `job enabled: ${rest[0]}`);
      return 0;
    }
    case "logs":
      table(ctx, store.runsList(Number(args.flags.limit || 10)), ["id", "job", "started", "rc", "output"], [
        "id",
        "title",
        "started",
        "rc",
        "output",
      ]);
      return 0;
    case "":
      out(ctx, paint(C.dim, `  ${JOB_USAGE}`, ctx.color));
      return 0;
    default:
      bad(ctx, `unknown job action: ${action}`);
      return 2;
  }
}

/** Worker-level session id for a job run (K3 0.106.0). The job runner is a
 *  process boundary: each JOB gets its own session namespace, so two different
 *  jobs under one DSH session cannot flip each other's session-scoped
 *  selection. Concurrent runs of the SAME job share the id (same job ⇒ same
 *  namespace); that is intentional — the guarantee is per-job isolation, not
 *  per-run. Nested workers keep appending (`<parent>/<job>/<run>`), so the
 *  chain stays traceable.
 *
 *  GitHub #7 余项: the parent MUST come from the selection bucket (`sessionId()`,
 *  default "default"), not the event-actor fallback ("cli"). A plain shell has
 *  no YGL_SESSION; `project use` then writes `current_project@default`, so a
 *  worker parented "cli" climbs a bucket nobody wrote and the job still dies
 *  "ambiguous project". Selection and audit identity are different namespaces. */
export function workerSessionId(jobId: string, parent = sessionId()): string {
  return `${parent}/${jobId}`;
}

function execute(env: Env, job: any): void {
  const { ctx, store } = env;
  const runId = store.jobStart(job.id);
  let rc = 0;
  let output = "";
  const started = Date.now();
  try {
    // 0.83: the runner process itself holds the app-level write lock; a job
    // command that invokes ygl-trees again would collide with its own parent
    // (self-deadlock — every `ygl-trees …` job failed rc=1 "locked"). Children
    // boot lock-free like webui serve: WAL already permits concurrent readers
    // and serializes writers at the SQLite layer.
    output = execSync(job.command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
      env: { ...process.env, YGL_SERVE: "1", YGL_SESSION: workerSessionId(job.id), YGL_JOB_ID: job.id },
    });
    rc = 0;
  } catch (e: any) {
    rc = typeof e?.status === "number" ? e.status : 1;
    output = `${e?.stdout || ""}${e?.stderr || ""}${e?.message || ""}`;
  }
  const ms = Date.now() - started;
  store.jobFinish(runId, rc, output);
  // #220: a one-shot (`at`, no every) job is finished once it has run — disable it so it stops lingering enabled.
  if (job.at && !(Number(job.every_minutes) > 0)) {
    const status = rc === 0 ? "done" : "failed";
    store.db.run("UPDATE jobs SET enabled=0, status=? WHERE id=?", [status, job.id]);
    store.log("job.settle", "job", job.id, `one-shot ran (${job.at}) → ${status}, disabled`);
  }
  if (rc === 0) ok(ctx, `${job.title}  ok  ${ms}ms`);
  else bad(ctx, `${job.title}  rc=${rc}  ${output.slice(0, 160)}`);
  store.log("job.run", "job", job.id, `rc=${rc} ${nowIso()}`);
}

/**
 * Concurrency guard for `job tick`: mkdir-based lock (same primitive the
 * WASM sqlite VFS uses). A lock older than 15 minutes is considered stale
 * (crashed holder) and stolen. Never blocks: a live lock means another tick
 * is running, so we skip — cron will call again.
 */
function withTickLock(env: Env, fn: () => number): number {
  const { ctx } = env;
  const fs = require("node:fs");
  const path = require("node:path");
  const lockDir = path.join(env.home, "tick.lock");

  const tryAcquire = (): boolean => {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "info"), `${process.pid} ${new Date().toISOString()}`);
      return true;
    } catch (e: any) {
      if (e?.code === "EEXIST") return false;
      return true; // unrelated fs error: proceed unlocked rather than block cron
    }
  };

  let locked = tryAcquire();
  if (!locked) {
    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockDir).mtimeMs > 15 * 60_000;
    } catch {
      stale = false;
    }
    if (stale) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      locked = tryAcquire();
      if (locked) out(ctx, paint(C.yellow, "  ! stole stale tick.lock (holder crashed >15min ago)", ctx.color));
    }
  }
  if (!locked) {
    out(ctx, paint(C.yellow, "  another job tick is running; skipping (cron will retry)", ctx.color));
    return 0;
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
