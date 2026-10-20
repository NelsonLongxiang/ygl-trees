/**
 * Batch-nine supplement P2-2: `node move <key> --to <tree>`.
 *
 * The user's incident: eight nodes landed in the wrong tree, and the only
 * repair path was `db sql`. This spec pins the narrow v1 contract — one node
 * at a time, per-node rows travel with it, and a node that still has edges
 * inside its tree is refused (moving it would split the graph).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { nowIso } from "../../../core/text/src/text";
import * as treeWrites from "../src/writes";

let db: DB;
let dir: string;
let left = "";
let right = "";

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `nodemove-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "t.db");
  db = new DB(f);
  const ds = await getOrm(f);
  left = (await treeWrites.treeCreate(ds, "left", "", "")).id;
  right = (await treeWrites.treeCreate(ds, "right", "", "")).id;
  await treeWrites.nodeAdd(ds, left, { key: "lonely", name: "Lonely" });
  await treeWrites.nodeAdd(ds, right, { key: "taken" });
  await closeOrm();
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nodeMove", () => {
  it("moves a lone node and marks BOTH trees dirty", async () => {
    const ds = await getOrm(db.path!);
    const lonelyId = (db.get("SELECT id FROM nodes WHERE key='lonely'") as any).id;
    // Only the depth-0 self row follows the node (K3 0.106.0); transitive
    // closure rows are rebuilt by `node index` and must stay where they were.
    db.run("INSERT INTO node_closure(tree_id,ancestor,descendant,depth) VALUES(?,?,?,0)", [left, lonelyId, lonelyId]);
    const shadowId = (await treeWrites.nodeAdd(ds, left, { key: "shadow" })).row.id;
    db.run("INSERT INTO node_closure(tree_id,ancestor,descendant,depth) VALUES(?,?,?,1)", [left, lonelyId, shadowId]);
    const r = await treeWrites.nodeMove(ds, left, "lonely", "right");
    expect(r.moved).toBe(true);
    expect(r.from_tree).toBe("left");
    expect(r.to_tree).toBe("right");
    expect(r.row.tree_id).toBe(right);
    expect(db.get("SELECT tree_id FROM nodes WHERE key='lonely'").tree_id).toBe(right);
    // FTS row travels by node id (it has no tree column) — search still finds it.
    expect(db.get("SELECT COUNT(*) c FROM nodes_fts WHERE key='lonely'").c).toBe(1);
    for (const t of [left, right]) {
      expect(db.get("SELECT dirty FROM node_index WHERE tree_id=?", t)?.dirty).toBe(1);
    }
    const selfRow = db.get("SELECT tree_id FROM node_closure WHERE ancestor=? AND descendant=? AND depth=0", [r.row.id, r.row.id]);
    expect(selfRow.tree_id).toBe(right);
    const stale = db.get("SELECT tree_id FROM node_closure WHERE ancestor=? AND descendant=?", [r.row.id, shadowId]);
    expect(stale.tree_id).toBe(left);
    await closeOrm();
  });

  it("carries node_state rows to the new tree (status preserved)", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.nodeAdd(ds, left, { key: "stateful" });
    const id = db.get("SELECT id FROM nodes WHERE key='stateful'").id;
    db.run("INSERT INTO node_state(tree_id,context,node_id,status,level,progress,updated) VALUES(?,?,?,?,?,?,?)", [
      left, "default", id, "unlocked", 3, 0.5, nowIso(),
    ]);
    const r = await treeWrites.nodeMove(ds, left, "stateful", "right");
    expect(r.state_rows).toBe(1);
    const st = db.get("SELECT tree_id,status,level FROM node_state WHERE node_id=?", id);
    expect(st.tree_id).toBe(right);
    expect(st.status).toBe("unlocked");
    expect(st.level).toBe(3);
    expect(db.get("SELECT COUNT(*) c FROM node_state WHERE tree_id=?", left).c).toBe(0);
    await closeOrm();
  });

  it("refuses a node with edges and names the unlink repair path", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.nodeAdd(ds, left, { key: "parent" });
    await treeWrites.nodeAdd(ds, left, { key: "child" });
    await treeWrites.link(ds, left, "parent", "child", {});
    await expect(treeWrites.nodeMove(ds, left, "child", "right")).rejects.toThrow(
      /node 'child' has 1 edge\(s\) inside tree 'left'[\s\S]*node unlink <parent> child/
    );
    expect(db.get("SELECT tree_id FROM nodes WHERE key='child'").tree_id).toBe(left);
    await closeOrm();
  });

  it("refuses a key that already exists in the target tree", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.nodeAdd(ds, left, { key: "taken" });
    await expect(treeWrites.nodeMove(ds, left, "taken", "right")).rejects.toThrow(
      /node 'taken' already exists in tree 'right'[\s\S]*node rm taken -t right/
    );
    // Both rows still exist (one per tree), so the bare key is ambiguous: an
    // unfiltered `WHERE key='taken'` returns whichever row SQLite hits first —
    // that made this assertion pass or fail depending on row order.
    expect(db.get("SELECT COUNT(*) c FROM nodes WHERE key='taken'").c).toBe(2);
    expect(db.get("SELECT COUNT(*) c FROM nodes WHERE key='taken' AND tree_id=?", left).c).toBe(1);
    await closeOrm();
  });

  it("is idempotent when the node is already in the target tree", async () => {
    const ds = await getOrm(db.path!);
    const r = await treeWrites.nodeMove(ds, right, "taken", "right");
    expect(r.moved).toBe(false);
    expect(r.to_tree).toBe("right");
    await closeOrm();
  });

  // External review #1 (issue #2): the first call moved the node, so a retry
  // looks up an empty source tree. It must stay idempotent (rc=0, moved:false,
  // duplicate:true) instead of surfacing as `node not found`.
  it("is idempotent when the same move is retried after success", async () => {
    const ds = await getOrm(db.path!);
    await treeWrites.nodeAdd(ds, left, { key: "retried" });
    const first = await treeWrites.nodeMove(ds, left, "retried", "right");
    expect(first.moved).toBe(true);
    const again = await treeWrites.nodeMove(ds, left, "retried", "right");
    expect(again.moved).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.row.tree_id).toBe(right);
    expect(db.get("SELECT COUNT(*) c FROM nodes WHERE key='retried'").c).toBe(1);
    // One `node.move` + one `node.move.noop`, never a second move claim.
    expect(db.get("SELECT COUNT(*) c FROM events WHERE kind='node.move' AND entity_id=?", first.row.id).c).toBe(1);
    expect(db.get("SELECT payload FROM events WHERE kind='node.move.noop' AND entity_id=? ORDER BY rowid DESC LIMIT 1", first.row.id).payload).toContain('"retried"');
    await closeOrm();
  });

  it("names unknown nodes and unknown trees", async () => {
    const ds = await getOrm(db.path!);
    await expect(treeWrites.nodeMove(ds, left, "ghost", "right")).rejects.toThrow(/node not found: ghost/);
    await expect(treeWrites.nodeMove(ds, left, "parent", "no-such-tree")).rejects.toThrow(/tree not found: no-such-tree/);
    await closeOrm();
  });
});
