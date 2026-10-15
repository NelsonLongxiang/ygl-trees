/** job group — batch + schedule. `job tick` is what cron/systemctl drives. */
import { execSync } from "node:child_process";
import { Env } from "../cli";
import { ok, bad, out, table, paint, C } from "../fmt";
import { nowIso } from "../text";

export function run(env: Env, action: string, rest: string[], args: any): number {
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
      const tailAt = /\s--at(?:=|\s+)?("[^"]*"|'[^']*'|\S+)\s*$/.exec(command);
      if (tailAt) {
        at = tailAt[1].replace(/^["']|["']$/g, "");
        command = command.slice(0, tailAt.index).trim();
      }
      if (!title || !command) {
        bad(ctx, 'usage: job add <title> -- <command> [--every <min>] [--at "YYYY-MM-DD HH:MM"]');
        return 2;
      }
      const force = args.flags.force === true || args.flags.force === "true";
      const j = store.jobAdd({ title, command, every, at, force });
      if (j.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${j.row.id}  ${title}`, ctx.color));
      else ok(ctx, `job registered: ${j.row.id}  ${j.row.title}`);
      out(ctx, paint(C.dim, `  command:  ${j.row.command}`, ctx.color));
      out(ctx, paint(C.dim, `  schedule: ${j.row.every_minutes ? `every ${j.row.every_minutes} min` : j.row.at || "manual"}`, ctx.color));
      return 0;
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
      const due = store.jobDue();
      if (!due.length) {
        out(ctx, paint(C.dim, "  nothing due", ctx.color));
        return 0;
      }
      for (const j of due) execute(env, j);
      return 0;
    }
    case "disable":
      store.db.run("UPDATE jobs SET enabled=0 WHERE id=? OR title=?", [rest[0], rest[0]]);
      ok(ctx, `job disabled: ${rest[0]}`);
      return 0;
    case "enable":
      store.db.run("UPDATE jobs SET enabled=1 WHERE id=? OR title=?", [rest[0], rest[0]]);
      ok(ctx, `job enabled: ${rest[0]}`);
      return 0;
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

function execute(env: Env, job: any): void {
  const { ctx, store } = env;
  const runId = store.jobStart(job.id);
  let rc = 0;
  let output = "";
  const started = Date.now();
  try {
    output = execSync(job.command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
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
