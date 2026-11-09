import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, SCHEMA_VERSION } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { Store } from "../../../research/pipeline/src/reads";

let db: DB;
let dir: string;
let file: string;
let pid: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `r12-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "unit.db");
  db = new DB(file);
  const ds = await getOrm(file);
  const writes = await import("../../pipeline/src/writes");
  const proj = await writes.projectCreate(ds, "r12", "工程产出");
  pid = proj.id;
});

afterAll(async () => {
  await closeOrm();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true }); // scratch cleanup
});

const BIN = path.join(process.cwd(), "dist", "bundle", "bin.cjs");
const hasBundle = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

// #240: same-title sections — the report shows the highest version once, in the
// position where the title first appeared; produce list still shows every version.
describe.skipIf(!hasBundle)("produce report 同名节只取最高版本（#240）", () => {
  let home: string;
  const runCli = (args: string[]) => spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" },
  });
  beforeAll(() => {
    home = path.join(process.cwd(), "tmp", `r12-240-${Date.now()}`);
    fs.mkdirSync(home, { recursive: true });
    if (runCli(["db", "init"]).status !== 0) throw new Error("db init failed");
    if (runCli(["project", "new", "p240"]).status !== 0) throw new Error("project new failed");
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("saves the same title twice → report has the heading once with only the v2 body; list keeps both", () => {
    expect(runCli(["produce", "section", "背景", "--body", "v1 body"]).status).toBe(0);
    expect(runCli(["produce", "section", "结论", "--body", "唯一节"]).status).toBe(0);
    expect(runCli(["produce", "section", "背景", "--body", "v2 body revised"]).status).toBe(0);
    const report = JSON.parse(runCli(["produce", "report"]).stdout as string) as { content: string };
    const text = report.content;
    expect((text.match(/^## 背景$/gm) ?? []).length, text).toBe(1); // once, not twice
    expect(text).toContain("v2 body revised");
    expect(text).not.toContain("v1 body"); // old version out of the report
    expect((text.match(/^## 结论$/gm) ?? []).length).toBe(1); // untouched section intact
    // #240 tail: a revision must NOT move the section — the title keeps its
    // first-appearance position (背景 was saved before 结论).
    expect(text.indexOf("## 背景")).toBeLessThan(text.indexOf("## 结论"));
    const list = JSON.parse(runCli(["produce", "list"]).stdout as string) as Array<{ kind: string }>;
    expect(list.filter((x) => x.kind === "section").length).toBe(3); // both versions + the other title stay queryable
  });
});

describe("schema 版本（artifacts.meta 信封 + 时间字段）", () => {
  it("fresh DB → 当前 SCHEMA_VERSION（v10 起），meta 列存在，时间字段齐备", () => {
    // 0.89/PG-A: v10 = events.seq + schema_migrations ledger；本组断言的
    // meta/时间字段属 v8/v9 面料，随版本上移不失效
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    expect(db.get("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
    expect(db.get("SELECT 1 AS hit FROM pragma_table_info('artifacts') WHERE name='meta'")).toBeTruthy();
  });
});

describe("task 状态机 + spec/design（R12）", () => {
  it("taskAdd → todo；taskSetStatus 走完 todo→doing→done；留痕 task.status", async () => {
    const ds = await getOrm(file);
    const writes = await import("../../pipeline/src/writes");
    const t = await writes.taskAdd(ds, pid, "发布", "等 registry");
    // #220: the envelope also stamps status_at (ISO) when the task enters a status
    expect(JSON.parse(db.get("SELECT meta FROM artifacts WHERE id=?", [t.id])!.meta)).toEqual({ status: "todo", status_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    const r1 = await writes.taskSetStatus(ds, t.id, "doing");
    expect(r1).toMatchObject({ from: "todo", to: "doing" });
    const r2 = await writes.taskSetStatus(ds, t.id, "done");
    expect(r2).toMatchObject({ from: "doing", to: "done" });
    const ev = db.all("SELECT payload FROM events WHERE kind='task.status' AND entity_id=?", [t.id]);
    expect(ev.length).toBe(2);
  });
  it("非法状态 → 报错；不存在任务 → 报错", async () => {
    const ds = await getOrm(file);
    const writes = await import("../../pipeline/src/writes");
    await expect(writes.taskSetStatus(ds, "nope", "done")).rejects.toThrow(/task not found/);
    const t = await writes.taskAdd(ds, pid, "x");
    await expect(writes.taskSetStatus(ds, t.id, "blocked")).rejects.toThrow(/todo\|doing\|done/);
  });
  it("artifactAdd 带 meta（design_type 信封）", async () => {
    const ds = await getOrm(file);
    const writes = await import("../../pipeline/src/writes");
    const r = await writes.artifactAdd(ds, pid, "design", "视觉系统", "body", "markdown", JSON.stringify({ design_type: "ui-ux" }));
    expect(JSON.parse(r.row.meta)).toEqual({ design_type: "ui-ux" });
  });
});
