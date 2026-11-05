/**
 * #220: task and job lifecycle. A real-workspace audit (434 tasks / 75 jobs) found doctor 16/16 PASS over stale
 * doing/todo, unlinked done tasks, failing enabled jobs, unscheduled jobs and "version families". These tests pin
 * the derivations (pure) and the CLI faces that now expose and maintain them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { jobFamilies, jobFamilyStem, jobHealth, staleTasks, taskView } from "../../../research/pipeline/src/lifecycle";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("lifecycle derivations (#220)", () => {
  it("taskView reads status_at, and falls back to created for rows written before it", () => {
    const stamped = taskView({ id: "a", title: "t", created: ago(40), meta: JSON.stringify({ status: "doing", status_at: ago(2), owner: "dev" }) });
    expect(stamped).toMatchObject({ status: "doing", owner: "dev", status_at: ago(2), status_at_source: "status_at" });
    const legacy = taskView({ id: "b", title: "t", created: ago(40), meta: JSON.stringify({ status: "todo" }) });
    expect(legacy).toMatchObject({ status: "todo", owner: "", status_at: ago(40), status_at_source: "created" });
    expect(taskView({ id: "c", title: "t", created: ago(1), meta: "not json" }).status).toBe("todo");
  });

  it("staleTasks: doing ≥ doingDays, todo ≥ todoDays, closed tasks never; oldest first", () => {
    const t = (id: string, status: string, days: number) => taskView({ id, title: id, created: ago(100), meta: JSON.stringify({ status, status_at: ago(days) }) });
    const rows = staleTasks([t("d20", "doing", 20), t("d10", "doing", 10), t("t40", "todo", 40), t("t20", "todo", 20), t("x", "done", 99), t("c", "cancelled", 99)], NOW, 14, 30);
    expect(rows.map((r) => [r.id, r.age_days, r.threshold_days])).toEqual([["t40", 40, 30], ["d20", 20, 14]]);
  });

  it("jobHealth: precedence retired → done → disabled → failing → never-ran → manual → overdue → ok", () => {
    const job = (o: any) => ({ id: "j", title: "j", enabled: 1, runs: 3, every_minutes: 60, at: "", status: "ok", last_run: ago(0), ...o });
    const fail = (n: number) => Array.from({ length: n }, (_, i) => ({ started: ago(i), finished: ago(i), rc: 1, output: `boom ${i}` }));
    const okRun = { started: ago(5), finished: ago(5), rc: 0, output: "" };
    expect(jobHealth(job({ status: "retired" }), fail(5), NOW).health).toBe("retired");
    expect(jobHealth(job({ status: "done", enabled: 0 }), [], NOW).health).toBe("done");
    expect(jobHealth(job({ enabled: 0 }), fail(5), NOW)).toMatchObject({ health: "disabled", consecutive_failures: 5, last_error: "boom 0" });
    expect(jobHealth(job({}), [...fail(3), okRun], NOW)).toMatchObject({ health: "failing", consecutive_failures: 3, last_ok: ago(5) });
    expect(jobHealth(job({}), [...fail(2), okRun], NOW).health).toBe("ok");
    expect(jobHealth(job({}), fail(2), NOW, 2).health).toBe("failing");
    expect(jobHealth(job({ runs: 0, last_run: "" }), [], NOW)).toMatchObject({ health: "never-ran", next_due: "now" });
    expect(jobHealth(job({ runs: 0, last_run: "", every_minutes: 0 }), [], NOW).health).toBe("manual");
    expect(jobHealth(job({ every_minutes: 0, runs: 4 }), [okRun], NOW).health).toBe("manual");
    expect(jobHealth(job({ last_run: ago(1) }), [okRun], NOW).health).toBe("overdue");
    expect(jobHealth(job({ last_run: new Date(NOW - 30 * 60_000).toISOString() }), [okRun], NOW)).toMatchObject({ health: "ok", next_due: new Date(NOW + 30 * 60_000).toISOString() });
  });

  it("version families: the audited series share a stem; unrelated names and glued words do not", () => {
    const stems = ["npm观测序列", "npm观测序列 v2", "npm观测序列 v3", "树健康巡检", "树健康巡检 绝对路径版", "树健康巡检 v2",
      "监督席·open-a2a-net验证器(v9 全量)", "监督席·open-a2a-net验证器 v16:24判据", "nightly", "nightly-2"].map(jobFamilyStem);
    expect(new Set(stems.slice(0, 3)).size).toBe(1);
    expect(new Set(stems.slice(3, 6)).size).toBe(1);
    expect(stems[6]).toBe(stems[7]);
    expect(stems[8]).toBe(stems[9]);
    expect(jobFamilyStem("dev2")).toBe("dev2");
    expect(jobFamilyStem("序列v3")).toBe("序列");
    const fams = jobFamilies([{ id: "1", title: "npm观测序列" }, { id: "2", title: "npm观测序列 v2" }, { id: "3", title: "npm观测序列 v3", status: "retired" }, { id: "4", title: "solo" }]);
    expect(fams).toEqual([{ stem: "npm观测序列", ids: ["1", "2"], titles: ["npm观测序列", "npm观测序列 v2"] }]);
  });
});

describe.skipIf(!existsSync(BIN))("task and job lifecycle CLI (real bundle, #220)", () => {
  let home = "";
  const cli = (args: string[], extra: Record<string, string> = {}) => {
    // --json must precede `--`: everything after the separator is the job's command
    const sep = args.indexOf("--");
    const argv = sep < 0 ? [...args, "--json"] : [...args.slice(0, sep), "--json", ...args.slice(sep)];
    const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_SESSION: "lifecycle-test", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1", ...extra } });
    expect(r.error, r.stderr).toBeUndefined();
    let json: any = null;
    try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* non-json face */ }
    return { rc: r.status, json, text: r.stdout + r.stderr };
  };
  const sql = (q: string) => cli(["db", "sql", q]);
  const node = (code: string) => `"${process.execPath}" -e "${code}"`;
  beforeAll(() => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/lifecycle-"));
    expect(cli(["db", "init"]).rc).toBe(0);
    expect(cli(["project", "new", "p1", "-q", "q1"]).rc).toBe(0);
  }, 60000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("task: owner, status times, cancel (reason required), reopen, assign, list filters", () => {
    const a = cli(["task", "add", "写报告", "--owner", "dev-seat"]).json;
    const listed = () => cli(["task", "list"]).json.find((t: any) => t.id === a.id);
    expect(listed()).toMatchObject({ status: "todo", owner: "dev-seat", status_at_source: "status_at", done_at: "" });
    expect(cli(["task", "doing", a.id]).json).toMatchObject({ from: "todo", to: "doing" });
    expect(cli(["task", "done", a.id]).rc).toBe(0);
    expect(listed().done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const noReason = cli(["task", "cancel", a.id]);
    expect(noReason.rc).toBe(2);
    expect(noReason.json.error).toMatch(/--reason/);
    expect(cli(["task", "cancel", a.id, "--reason", "superseded by #220"]).json).toMatchObject({ from: "done", to: "cancelled", cancel_reason: "superseded by #220" });
    expect(listed()).toMatchObject({ status: "cancelled", cancel_reason: "superseded by #220", done_at: "" });
    expect(cli(["task", "cancel", a.id, "--reason", "again"]).json).toMatchObject({ duplicate: true, cancel_reason: "superseded by #220" });
    const straight = cli(["task", "doing", a.id]);
    expect(straight.rc).toBe(1);
    expect(straight.json.error).toMatch(/reopen it first/);
    expect(cli(["task", "reopen", a.id]).json).toMatchObject({ from: "cancelled", to: "todo" });
    expect(listed()).toMatchObject({ status: "todo", cancel_reason: "", done_at: "" });
    expect(cli(["task", "assign", a.id, "owner-2"]).json).toMatchObject({ from: "dev-seat", owner: "owner-2" });
    expect(cli(["task", "assign", a.id, "owner-2"]).json.duplicate).toBe(true);
    expect(cli(["task", "list", "--owner", "owner-2"]).json.map((t: any) => t.id)).toEqual([a.id]);
    expect(cli(["task", "list", "--status", "bogus"]).rc).toBe(2);
    expect(cli(["task", "assign", a.id]).rc).toBe(2);
  });

  it("task stale: thresholds from config or flags, legacy rows age from created, --all spans projects", () => {
    const doing = cli(["task", "add", "旧的进行中"]).json;
    cli(["task", "doing", doing.id]);
    const todo = cli(["task", "add", "旧的待办"]).json;
    const legacy = cli(["task", "add", "旧格式"]).json;
    sql(`UPDATE artifacts SET meta=json_set(meta,'$.status_at','${ago(20)}') WHERE id='${doing.id}'`);
    sql(`UPDATE artifacts SET meta=json_set(meta,'$.status_at','${ago(45)}') WHERE id='${todo.id}'`);
    sql(`UPDATE artifacts SET meta='{"status":"todo"}', created='${ago(60)}' WHERE id='${legacy.id}'`);
    const ids = (r: any) => r.json.map((t: any) => t.id);
    const stale = cli(["task", "stale"]);
    expect(stale.rc).toBe(0);
    expect(ids(stale)).toEqual(expect.arrayContaining([doing.id, todo.id, legacy.id]));
    expect(stale.json.find((t: any) => t.id === legacy.id)).toMatchObject({ status_at_source: "created", threshold_days: 30 });
    expect(ids(cli(["task", "stale", "--doing-days", "30"]))).not.toContain(doing.id);
    expect(cli(["task", "stale", "--todo-days", "x"]).rc).toBe(2);
    expect(cli(["project", "new", "p2", "-q", "q2"]).rc).toBe(0);
    expect(ids(cli(["task", "stale", "-p", "p2"]))).toEqual([]);
    expect(ids(cli(["task", "stale", "--all"]))).toEqual(expect.arrayContaining([doing.id, todo.id]));
    cli(["project", "use", "p1"]);
  });

  it("job add guards: a schedule (or --manual) is required; cadences below the floor need --allow-frequent", () => {
    expect(cli(["job", "add", "no-schedule", "--", "echo hi"]).json.error).toMatch(/needs a schedule/);
    expect(cli(["job", "add", "both", "--manual", "--every", "60", "--", "echo hi"]).rc).toBe(2);
    expect(cli(["job", "add", "fast", "--every", "5", "--", "echo hi"]).json.error).toMatch(/below job\.min_every_minutes \(60\)/);
    expect(cli(["job", "add", "fast", "--every", "5", "--allow-frequent", "--", "echo hi"]).json).toMatchObject({ every_minutes: 5 });
    expect(cli(["job", "add", "by-hand", "--manual", "--", "echo hi"]).json).toMatchObject({ every_minutes: 0, at: "" });
    expect(cli(["job", "list"]).json.map((j: any) => j.title)).not.toContain("no-schedule");
  });

  it("job health: failing enabled job fails doctor; retire clears the alarm and keeps history; show lists runs", () => {
    cli(["job", "add", "breaks", "--manual", "--", node("process.exit(3)")]);
    for (let i = 0; i < 3; i++) cli(["job", "run", "breaks"]);
    const breaks = () => cli(["job", "list"]).json.find((j: any) => j.title === "breaks");
    expect(breaks()).toMatchObject({ health: "failing", consecutive_failures: 3, command: expect.stringContaining("process.exit(3)") });
    const doc = cli(["doctor"]);
    expect(doc.rc).toBe(1);
    expect(doc.json.find((c: any) => c.name === "job_health")).toMatchObject({ status: "fail", detail: expect.stringMatching(/1 enabled job\(s\) failing: breaks/) });
    const show = cli(["job", "show", "breaks"]).json;
    expect(show.recent_runs).toHaveLength(3);
    expect(cli(["job", "retire", "breaks"]).rc).toBe(2);
    expect(cli(["job", "retire", "breaks", "--reason", "replaced"]).json).toMatchObject({ status: "retired", enabled: 0 });
    expect(cli(["job", "retire", "breaks", "--reason", "again"]).json.duplicate).toBe(true);
    expect(breaks()).toMatchObject({ health: "retired", runs: 3 });
    expect(cli(["doctor"]).json.find((c: any) => c.name === "job_health").status).not.toBe("fail");
    expect(cli(["job", "show", "nope"]).rc).toBe(1);
  });

  it("a one-shot job is done and disabled after it runs", () => {
    cli(["job", "add", "once", "--at", "2000-01-01 00:00", "--", node("0")]);
    cli(["job", "tick"]);
    expect(cli(["job", "list"]).json.find((j: any) => j.title === "once")).toMatchObject({ status: "done", enabled: 0, health: "done" });
  });

  it("prune-runs: dry run by default, --apply deletes beyond --keep, a current failing streak survives", () => {
    cli(["job", "add", "chatty", "--manual", "--", node("0")]);
    for (let i = 0; i < 5; i++) cli(["job", "run", "chatty"]);
    const count = (title: string) => sql(`SELECT count(*) AS n FROM runs WHERE job_id=(SELECT id FROM jobs WHERE title='${title}')`).json[0].n;
    const dry = cli(["job", "prune-runs", "--keep", "2"]).json;
    expect(dry).toMatchObject({ keep: 2, apply: false, deleted: 0 });
    expect(dry.jobs.find((j: any) => j.title === "chatty")).toMatchObject({ total: 5, prune: 3 });
    expect(count("chatty")).toBe(5);
    expect(dry.jobs.find((j: any) => j.title === "breaks")).toBeUndefined(); // 3 failing runs: the streak is protected
    expect(cli(["job", "prune-runs", "--keep", "2", "--apply"]).json.deleted).toBeGreaterThanOrEqual(3);
    expect(count("chatty")).toBe(2);
    expect(count("breaks")).toBe(3);
    expect(cli(["job", "prune-runs", "--keep", "0"]).rc).toBe(2);
  });

  it("doctor names task hygiene and job warnings (stale, version family, frequent, manual)", () => {
    cli(["job", "add", "npm观测序列", "--every", "1440", "--", "echo a"]);
    cli(["job", "add", "npm观测序列 v2", "--every", "1440", "--", "echo b"]);
    const checks = cli(["doctor"]).json;
    const task = checks.find((c: any) => c.name === "task_hygiene");
    expect(task.status).toBe("warn");
    expect(task.detail).toMatch(/stale doing/);
    expect(task.detail).toMatch(/stale todo/);
    const job = checks.find((c: any) => c.name === "job_health");
    expect(job.status).toBe("warn");
    expect(job.detail).toMatch(/version family: npm观测序列 ×2/);
    expect(job.detail).toMatch(/every < 60 min: fast/);
    expect(job.detail).toMatch(/no schedule \(manual\)/);
  });
});
