/**
 * 0.81: `node cond rm <key> --name <n>` + action-word `cond add <key>`.
 * User report ④: cond had no add verb ("node not found: add") and no rm at
 * all — cleanup required raw db sql. condRemove must be transactional,
 * event-logged (node.cond-rm) and name its misses (frozen contract ④).
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
  dir = path.join(process.cwd(), "tmp", `condrm-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  const ds = await getOrm(f);
  const tree = await treeWrites.treeCreate(ds, "ct", "", "");
  tid = tree.id;
  await treeWrites.nodeAdd(ds, tid, { key: "probe" });
  await treeWrites.condAdd(ds, tid, "probe", { name: "y_ready", op: ">=", value: "40" });
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("condRemove", () => {
  it("按自然键删除 + 落 node.cond-rm 事件", async () => {
    const ds = await getOrm(db.path!);
    const r = await treeWrites.condRemove(ds, tid, "probe", "y_ready");
    expect(r.removed).toBe(true);
    expect(r.name).toBe("y_ready");
    expect(db.get("SELECT COUNT(*) c FROM node_conditions WHERE name='y_ready'").c).toBe(0);
    const ev = db.get("SELECT kind FROM events WHERE kind='node.cond-rm' ORDER BY ts DESC LIMIT 1");
    expect(ev.kind).toBe("node.cond-rm");
    await closeOrm();
  });

  it("条件不存在 → 点名 + 列出该节点剩余条件", async () => {
    await treeWrites.condAdd(await getOrm(db.path!), tid, "probe", { name: "trend", op: ">=", value: "100" });
    const ds = await getOrm(db.path!);
    await expect(treeWrites.condRemove(ds, tid, "probe", "nope")).rejects.toThrow(
      /condition not found: nope \(node probe has: trend\)/
    );
    await closeOrm();
  });

  it("节点不存在 → node not found（命名错误，契约④）", async () => {
    const ds = await getOrm(db.path!);
    await expect(treeWrites.condRemove(ds, tid, "ghost", "trend")).rejects.toThrow(/node not found: ghost/);
    await closeOrm();
  });
});
