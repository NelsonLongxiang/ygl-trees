/**
 * 0.80: eval context package joins the rel fabric — attachments (node ↔
 * evidence/claim/kb/..., both directions) must be summarized into
 * evalContext so a decided-by chain is visible to the eval model without
 * manually re-carrying facts via --state (user finding: P 0.30 → 0.92).
 */
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
let nodeId: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `evalctx-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  trees = new TreeStore(db);
  const ds = await getOrm(f);
  const tree = await treeWrites.treeCreate(ds, "t", "", "");
  tid = tree.id;
  await treeWrites.nodeAdd(ds, tid, { key: "probe" });
  nodeId = String(db.get("SELECT id FROM nodes WHERE tree_id=? AND key='probe'", [tid]).id);
  await closeOrm();
  // research-side fixtures (claims/evidence 挂接目标)：直插基表，绕开研究域写服务
  const ts = "2026-10-17T00:00:00Z";
  db.run("INSERT INTO projects(id,name,created,updated) VALUES('p1','fixture','" + ts + "','" + ts + "')");
  db.run("INSERT INTO sources(id,project_id,url,title,url_hash,retrieved_at,created) VALUES('s1','p1','session://adjudication/x','会话内裁决','h1','" + ts + "','" + ts + "')");
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("evalContext rel attachments (0.80)", () => {
  it("no relations → no attachments key (byte-compat with old shape)", () => {
    const pkg = trees.evalContext(tid, "probe", {});
    expect(pkg.node).toEqual({ key: "probe", name: "probe", kind: "tech", tier: 0, cost: 0 });
    expect((pkg as any).attachments).toBeUndefined();
  });

  it("claim attached decided-by (node as src) → text/status/confidence summary", () => {
    db.run(
      "INSERT INTO claims(id, project_id, text, status, confidence, content_hash, created, updated) VALUES(?,?,?,?,?,?,?,?)",
      ["cl1", "p1", "探针节点三条件已逐条核对通过", "supported", "0.92", "h", "2026-10-17T00:00:00Z", "2026-10-17T00:00:00Z"]
    );
    db.run(
      "INSERT INTO relations(id, src_type, src_id, dst_type, dst_id, rel, created) VALUES(?,?,?,?,?,?,?)",
      ["r1", "node", nodeId, "claim", "cl1", "decided-by", "2026-10-17T00:00:00Z"]
    );
    const pkg: any = trees.evalContext(tid, "probe", {});
    expect(pkg.attachments).toHaveLength(1);
    expect(pkg.attachments[0]).toMatchObject({
      rel: "decided-by", type: "claim", id: "cl1",
      text: "探针节点三条件已逐条核对通过", status: "supported", confidence: "0.92",
    });
  });

  it("evidence attached evidenced-by (node as dst, reversed direction) → quote summary", () => {
    db.run("INSERT INTO evidence(id, project_id, source_id, quote, content_hash, created) VALUES(?,?,?,?,?,?)", ["ev1", "p1", "s1", "实测三条全部命中：0.30 → 0.92", "h", "2026-10-17T00:00:00Z"]);
    db.run(
      "INSERT INTO relations(id, src_type, src_id, dst_type, dst_id, rel, created) VALUES(?,?,?,?,?,?,?)",
      ["r2", "evidence", "ev1", "node", nodeId, "evidenced-by", "2026-10-17T00:00:00Z"]
    );
    const pkg: any = trees.evalContext(tid, "probe", {});
    const ev = pkg.attachments.find((a: any) => a.id === "ev1");
    expect(ev).toMatchObject({ rel: "evidenced-by", type: "evidence", quote: "实测三条全部命中：0.30 → 0.92" });
    expect(pkg.attachments).toHaveLength(2); // r1 + r2
  });

  it("text clipped to 120 chars; dangling/unknown types degrade to id-only", () => {
    db.run(
      "INSERT INTO claims(id, project_id, text, status, content_hash, created, updated) VALUES(?,?,?,?,?,?,?)",
      ["cl2", "p1", "长".repeat(300), "supported", "h2", "2026-10-17T00:00:00Z", "2026-10-17T00:00:00Z"]
    );
    db.run(
      "INSERT INTO relations(id, src_type, src_id, dst_type, dst_id, rel, created) VALUES(?,?,?,?,?,?,?)",
      ["r3", "node", nodeId, "claim", "cl2", "decided-by", "2026-10-17T00:00:00Z"]
    );
    db.run(
      "INSERT INTO relations(id, src_type, src_id, dst_type, dst_id, rel, created) VALUES(?,?,?,?,?,?,?)",
      ["r4", "node", nodeId, "query", "ghost", "related", "2026-10-17T00:00:00Z"]
    );
    const pkg: any = trees.evalContext(tid, "probe", {});
    expect(pkg.attachments.find((a: any) => a.id === "cl2").text).toHaveLength(120);
    expect(pkg.attachments.find((a: any) => a.id === "ghost")).toEqual({ rel: "related", type: "query", id: "ghost" });
  });

  it("bounded: ≤12 attachments (13th row dropped)", () => {
    for (let i = 0; i < 15; i++) {
      db.run(
        "INSERT INTO relations(id, src_type, src_id, dst_type, dst_id, rel, created) VALUES(?,?,?,?,?,?,?)",
        [`rb${i}`, "node", nodeId, "skill", `sk${i}`, "related", "2026-10-17T00:00:00Z"]
      );
    }
    const pkg: any = trees.evalContext(tid, "probe", {});
    expect(pkg.attachments.length).toBeLessThanOrEqual(12);
  });
});
