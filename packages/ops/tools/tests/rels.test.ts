import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { resolveRef, relAdd, relRm, REL_TYPES, RelError, orphanRelations, projectNameOf } from "../src/rels";

let db: DB;
let dir: string;
let env: any;
const now = new Date().toISOString();

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `rels-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "unit.db");
  db = new DB(file);
  env = { ctx: { json: true, color: false, quiet: true }, db, store: new Store(db), home: dir };
  const ds = await getOrm(file);
  const writes = await import("../../../research/pipeline/src/writes");
  const treeWrites = await import("../../../techtree/model/src/writes");
  const proj = await writes.projectCreate(ds, "rels-unit", "关联织物单测");
  const src = await writes.sourceAdd(ds, proj.id, { title: "来源", url: "https://ex.com/r" });
  const ev = await writes.evidenceAdd(ds, proj.id, src.row.id, "证据原文");
  const cl = await writes.claimAdd(ds, proj.id, "单测断言：关联可用");
  await writes.kbAdd(ds, { title: "知识笔记甲", body: "内容" });
  const tree = await treeWrites.treeCreate(ds, "rt", proj.id, "");
  await treeWrites.nodeAdd(ds, tree.id, { key: "alpha" });
  db.metaSet("current_tree", "rt");
  (globalThis as any).__ids = { ev: ev.row.id, cl: cl.row.id, pid: proj.id };
});

afterAll(async () => {
  await closeOrm();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true }); // scratch cleanup
});

describe("F4 跨项目判定（projectNameOf）", () => {
  it("uses the stored project field; project-less types are null", async () => {
    const writes = await import("../../../research/pipeline/src/writes");
    const ds = await getOrm(db.path!);
    const beta = await writes.projectCreate(ds, "rels-beta", "另一个项目");
    const clB = await writes.claimAdd(ds, beta.id, "beta 断言");
    const clA = (globalThis as any).__ids.cl as string;
    const nodeRow = db.get("SELECT id FROM nodes LIMIT 1") as any;
    const kbRow = db.get("SELECT id FROM kb_notes LIMIT 1") as any;
    expect(projectNameOf(db, "claim", clA)).toBe("rels-unit");
    expect(projectNameOf(db, "claim", clB.row.id)).toBe("rels-beta");
    expect(projectNameOf(db, "node", nodeRow.id)).toBe("rels-unit");
    expect(projectNameOf(db, "kb", kbRow.id)).toBeNull();
    expect(projectNameOf(db, "claim", "cls_nope")).toBeNull();
  });
});

describe("引用解析", () => {
  it("九类类型注册齐全", () => expect(REL_TYPES.length).toBe(9));
  it("task:<id> 解析为 artifacts kind='task' 行", async () => {
    const writes = await import("../../../research/pipeline/src/writes");
    const ds = await getOrm(db.path!);
    const t = await writes.taskAdd(ds, (globalThis as any).__ids.pid as string, "关联单测任务");
    const r = resolveRef(env, `task:${t.id}`);
    expect(r.type).toBe("task");
    expect(r.display).toBe("关联单测任务");
    expect(() => resolveRef(env, "task:nope")).toThrowError(/task not found/);
  });
  it("node:<key> 在当前树解析为 node.id", () => {
    const r = resolveRef(env, "node:alpha");
    expect(r.type).toBe("node");
    expect(r.display).toBe("alpha");
    expect(r.id).toBeTruthy();
    // resolves to the same id twice (stable)
    expect(resolveRef(env, "node:alpha").id).toBe(r.id);
  });
  it("kb 可按 id 或 title 解析", () => {
    expect(resolveRef(env, "kb:知识笔记甲").display).toBe("知识笔记甲");
  });
  it("404 → RelError code 1；坏类型 → code 2；无冒号 → code 2", () => {
    expect(() => resolveRef(env, "node:zzz")).toThrowError(RelError);
    try { resolveRef(env, "node:zzz"); } catch (e: any) { expect(e.code).toBe(1); }
    try { resolveRef(env, "foo:bar"); } catch (e: any) { expect(e.code).toBe(2); }
    try { resolveRef(env, "nocolon"); } catch (e: any) { expect(e.code).toBe(2); }
  });
});

describe("relAdd / relRm", () => {
  it("add 幂等（同四元组 duplicate）", async () => {
    const a = await relAdd(env, "node:alpha", "kb:知识笔记甲", "evidenced-by");
    expect(a.duplicate).toBe(false);
    const b = await relAdd(env, "node:alpha", "kb:知识笔记甲", "evidenced-by");
    expect(b.duplicate).toBe(true);
    expect(b.row.id).toBe(a.row.id);
    // events 留痕（rel.add）
    expect(db.get("SELECT 1 AS h FROM events WHERE kind='rel.add' AND entity_id=?", [a.row.id])).toBeTruthy();
  });
  it("跨域任意两端（node↔claim）", async () => {
    const r = await relAdd(env, "node:alpha", `claim:${(globalThis as any).__ids.cl}`, "decided-by");
    expect(r.row.dst_type).toBe("claim");
  });
  it("rm 后行消失；rm 不存在 → RelError 1", async () => {
    await relAdd(env, "node:alpha", `evidence:${(globalThis as any).__ids.ev}`);
    await relRm(env, "node:alpha", `evidence:${(globalThis as any).__ids.ev}`);
    expect(db.get("SELECT 1 AS h FROM relations WHERE dst_type='evidence'")).toBeFalsy();
    await expect(relRm(env, "node:alpha", `evidence:${(globalThis as any).__ids.ev}`)).rejects.toThrowError(RelError);
  });
  it("rel.add 事件可查（agent log 面可见）", () => {
    const n = db.all("SELECT COUNT(*) AS c FROM events WHERE kind='rel.add'");
    expect(Number(n[0].c)).toBeGreaterThanOrEqual(2);
  });
});

describe("orphan relations (K3 0.106.0)", () => {
  it("detects a dangling endpoint and prunes it explicitly (dry-run first)", async () => {
    const treeWrites = await import("../../../techtree/model/src/writes");
    const rels = await import("../src/rels");
    const ds = await getOrm(db.path!);
    const tree = await treeWrites.treeCreate(ds, "rt2", (globalThis as any).__ids.pid as string, "");
    await treeWrites.nodeAdd(ds, tree.id, { key: "doomed" });
    db.metaSet("current_tree", "rt2");
    await relAdd(env, "node:doomed", `claim:${(globalThis as any).__ids.cl as string}`, "related");
    expect(orphanRelations(env).length).toBe(0);

    // deleting the node through raw SQL is exactly the "no FK cascade" hole
    db.run("DELETE FROM nodes WHERE key='doomed'");
    const dangling = orphanRelations(env);
    expect(dangling.length).toBe(1);
    expect(dangling[0].src_type).toBe("node");

    await rels.run(env, "prune", [], { flags: { "dry-run": true } });
    expect(orphanRelations(env).length).toBe(1);
    await rels.run(env, "prune", [], { flags: {} });
    expect(orphanRelations(env).length).toBe(0);
    const ev = db.get("SELECT payload FROM events WHERE kind='rel.prune' ORDER BY rowid DESC LIMIT 1") as any;
    expect(String(ev.payload)).toContain('"pruned":1');
  });
});
