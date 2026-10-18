/**
 * 0.88 工单单1+单2（P1×2，监督席 direct-e487e737）：
 * 1. condAdd (node_id,name) 自然键幂等——同内容重跑返回已存在行 duplicate:true，
 *    同键异内容点名拒绝（旧行为：N 次重跑=N 行异 id 全 rc=0，多行 required=1
 *    会让 node can 永锁）。
 * 2. unlink rel 不匹配不再静默 no-op——0 行删除点名实际 rel（旧行为：rc=0
 *    回执 unlinked 但什么都没删）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import * as treeWrites from "../src/writes";

let db: DB;
let dir: string;
let tid: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `condidem-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  const ds = await getOrm(f);
  const tree = await treeWrites.treeCreate(ds, "ct", "", "");
  tid = tree.id;
  await treeWrites.nodeAdd(ds, tid, { key: "a" });
  await treeWrites.nodeAdd(ds, tid, { key: "b" });
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("condAdd 幂等（工单单1·P1）", () => {
  it("同内容重跑 → 同一行 + duplicate:true，不新增行", async () => {
    const ds = await getOrm(db.path!);
    const o = { name: "x_ready", kind: "flag", op: "eval", value: "Y" };
    const r1 = await treeWrites.condAdd(ds, tid, "a", o);
    const r2 = await treeWrites.condAdd(ds, tid, "a", o);
    const r3 = await treeWrites.condAdd(ds, tid, "a", o);
    expect((r1 as any).duplicate).toBeUndefined();
    expect((r2 as any).duplicate).toBe(true);
    expect((r3 as any).duplicate).toBe(true);
    expect(r2.id).toBe(r1.id);
    expect(db.get("SELECT COUNT(*) c FROM node_conditions WHERE node_id=(SELECT id FROM nodes WHERE tree_id=? AND key='a') AND name='x_ready'", tid).c).toBe(1);
    await closeOrm();
  });

  it("同键异内容 → 点名拒绝 + 指路 cond rm（不再静默新建第二行）", async () => {
    const ds = await getOrm(db.path!);
    await expect(
      treeWrites.condAdd(ds, tid, "a", { name: "x_ready", kind: "flag", op: "eval", value: "DIFFERENT" })
    ).rejects.toThrow(/already exists on a with different content[\s\S]*node cond rm a --name x_ready/);
    expect(db.get("SELECT COUNT(*) c FROM node_conditions WHERE name='x_ready'").c).toBe(1);
    await closeOrm();
  });

  it("可选标志不同也算异内容（required 变化影响门禁语义）", async () => {
    const ds = await getOrm(db.path!);
    await expect(
      treeWrites.condAdd(ds, tid, "a", { name: "x_ready", kind: "flag", op: "eval", value: "Y", required: false })
    ).rejects.toThrow(/different content/);
    await closeOrm();
  });
});

describe("unlink 语义（工单单2·P1）", () => {
  it("rel 不匹配 → 点名实际 rel 并指路 --rel，0 删除即报错", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.link(ds, tid, "a", "b", { rel: "enables" });
    await expect(treeWrites.unlink(ds, tid, "a", "b")).rejects.toThrow(
      /no prereq edge from a to b — actual rel\(s\): enables\. Pass --rel <rel> to match/
    );
    expect(db.get("SELECT COUNT(*) c FROM node_edges").c).toBe(1);
    await closeOrm();
  });

  it("--rel 匹配后正常删除 + 落 node.unlink 事件", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.unlink(ds, tid, "a", "b", "enables");
    expect(db.get("SELECT COUNT(*) c FROM node_edges").c).toBe(0);
    expect(db.get("SELECT kind FROM events WHERE kind='node.unlink' ORDER BY rowid DESC LIMIT 1").kind).toBe("node.unlink");
    await closeOrm();
  });

  it("两节点间无边 → 点名 none（无假成功）", async () => {
    const ds = await getOrm(db.path!);
    await expect(treeWrites.unlink(ds, tid, "a", "b")).rejects.toThrow(
      /no prereq edge from a to b — actual rel\(s\): none/
    );
    await closeOrm();
  });
});
