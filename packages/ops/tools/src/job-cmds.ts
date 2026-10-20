/** job group — batch + schedule. `job tick` is what cron/systemctl drives.
 *  Writes (add) run on the TypeORM write service (src/writes.ts). */
import { execSync } from "node:child_process";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, table, paint, C, writeResult } from "../../../core/text/src/fmt";
import { nowIso } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";
import { configGetNumber } from "./config";

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
        bad(ctx, 'usage: job add <title> -- <command> [--every <min>] [--at "YYYY-MM-DD HH:MM"]');
        return 2;
      }
      const force = args.flags.force === true || args.flags.force === "true";
      return getOrm(env.db.path)
        .then((ds) => writes.jobAdd(ds, { title, command, every, at, force }))
        .then((r): number => {
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
    case "list":
      table(ctx, store.jobList(), ["id", "title", "every", "at", "on", "runs", "last_run", "status"], [
        "id",
        "title",
        "every",
        "at",
        "enabled",
        "runs",
        "last_run",
        "status",
      ]);
      return 0;
    case "run": {
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
      const r = store.db.run("UPDATE jobs SET enabled=0 WHERE id=? OR title=?", [rest[0], rest[0]]);
      if (!r.changes) {
        bad(ctx, `job not found: ${rest[0]}`);
        return 1;
      }
      ok(ctx, `job disabled: ${rest[0]}`);
      return 0;
    }
    case "enable": {
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
      out(ctx, paint(C.dim, "  job: add <title> -- <cmd> | list | run <id> | tick | enable|disable <id> | logs", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown job action: ${action}`);
      return 2;
  }
}

/** Worker-level session id for a job run (K3 0.106.0). The job runner is a
 *  process boundary: two concurrent runs of one job (or two jobs under one DSH
 *  session) must not share the parent's session-scoped selection, or their
 *  writes land wherever the operator last pointed the parent. Nested workers
 *  keep appending (`<parent>/<job>/<run>`), so the chain stays traceable. */
export function workerSessionId(jobId: string, parent = process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "cli"): string {
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
