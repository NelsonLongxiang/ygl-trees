import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { TreeStore } from "../src/reads";
import * as treeWrites from "../src/writes";

let db: DB;
let dir: string;
let trees: TreeStore;
let tid: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `costmul-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  trees = new TreeStore(db);
  const ds = await getOrm(f);
  const tree = await treeWrites.treeCreate(ds, "t", "", "");
  tid = tree.id;
  await treeWrites.nodeAdd(ds, tid, { key: "a" });
  await treeWrites.nodeAdd(ds, tid, { key: "b", cost: 100 });
  await treeWrites.link(ds, tid, "a", "b");
  await treeWrites.condAdd(ds, tid, "b", { name: "has_eng", kind: "flag", op: "has", value: "1", required: false, effect: "cost_mul", weight: 0.8 });
});

afterAll(async () => {
  await closeOrm();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cost_mul discount direction (GPT-6.1 SOL fix)", () => {
  it("condition satisfied = discount applied", () => {
    const r = trees.canUnlock(tid, "b", "default", { has_eng: 1 });
    expect(r.cost_multiplier).toBeCloseTo(0.8, 1);
  });
  it("condition unsatisfied = no discount", () => {
    const r = trees.canUnlock(tid, "b", "default", {});
    expect(r.cost_multiplier).toBeCloseTo(1, 1);
  });
});
