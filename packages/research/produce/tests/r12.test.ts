import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, SCHEMA_VERSION } from "../../../core/database/src/db";
import { getOrm } from "../../../core/database/src/orm";
import { Store } from "../../../research/pipeline/src/reads";

let db: DB;
let file: string;
let pid: string;

beforeAll(async () => {
  const dir = path.join(process.cwd(), "tmp", `r12-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "unit.db");
  db = new DB(file);
  const ds = await getOrm(file);
  const writes = await import("../../pipeline/src/writes");
  const proj = await writes.projectCreate(ds, "r12", "工程产出");
  pid = proj.id;
});

describe("schema v8（artifacts.meta 信封）", () => {
  it("fresh DB → v8，meta 列存在默认空", () => {
    expect(SCHEMA_VERSION).toBe(8);
    expect(db.get("PRAGMA user_version")?.user_version).toBe(8);
    expect(db.get("SELECT 1 AS hit FROM pragma_table_info('artifacts') WHERE name='meta'")).toBeTruthy();
  });
});

describe("task 状态机 + spec/design（R12）", () => {
  it("taskAdd → todo；taskSetStatus 走完 todo→doing→done；留痕 task.status", async () => {
    const ds = await getOrm(file);
    const writes = await import("../../pipeline/src/writes");
    const t = await writes.taskAdd(ds, pid, "发布", "等 registry");
    expect(JSON.parse(db.get("SELECT meta FROM artifacts WHERE id=?", [t.id])!.meta)).toEqual({ status: "todo" });
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
