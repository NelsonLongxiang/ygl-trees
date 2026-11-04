/**
 * #176 W1-T3 offline: on PG the gate judgement (canUnlock / ready / pathTo / ancestors / descendants) runs on an
 * in-memory copy of one tree (materializeTree). The copy must give exactly the answers the source workspace gives.
 * Seeded through the real CLI so the rows are the ones production writes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DB } from "../../../core/database/src/db";
import { SqliteAsyncDb } from "../../../core/database/src/asyncdb";
import { TreeStore } from "../src/reads";
import { materializeTree } from "../src/async-store";

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");

describe.skipIf(!existsSync(BIN))("#176 W1-T3 materializeTree gives the same judgement as the source workspace", () => {
  let home = "", db: DB, mem: DB, treeId = "";
  const y = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 30000, env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_SESSION: "mat", YGL_NO_UPDATE_CHECK: "1" } });
    expect(r.status, args.join(" ") + "\n" + r.stdout + r.stderr).toBe(0);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "t3-mat-"));
    y("db", "init");
    treeId = y("tree", "new", "gates").id;
    y("tree", "new", "other");
    y("tree", "use", "gates");
    for (const k of ["root", "a", "b", "c", "x", "y", "z", "goal", "opt", "tel"]) y("node", "add", k, "--cost", "2");
    y("node", "link", "root", "a");
    y("node", "link", "root", "b");
    y("node", "link", "a", "goal");
    y("node", "link", "b", "goal", "--mode", "OR");
    y("node", "link", "c", "goal", "--mode", "OR");
    y("node", "link", "x", "z", "--mode", "XOR");
    y("node", "link", "y", "z", "--mode", "XOR");
    y("node", "link", "opt", "goal", "--optional");
    y("node", "link", "root", "x", "--rel", "excludes");
    y("node", "cond", "add", "goal", "--name", "level", "--op", ">=", "--value", "3");
    y("node", "cond", "add", "goal", "--name", "promo", "--op", ">=", "--value", "1", "--optional", "--effect", "cost_mul", "--weight", "0.5");
    y("node", "cond", "add", "tel", "--name", "runs", "--op", "telemetry", "--value", "node.add>=3");
    y("node", "index");
    y("node", "unlock", "root");
    y("node", "unlock", "a");
    y("node", "unlock", "x");
    db = new DB(join(home, "ygl-trees.db"));
    mem = await materializeTree(new SqliteAsyncDb(db), treeId);
  }, 180_000);
  afterAll(() => {
    mem?.close(); db?.close();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("copies only the selected tree, without PG-only columns", () => {
    expect((mem.get("SELECT COUNT(*) AS n FROM trees") as any).n).toBe(1);
    expect((mem.get("SELECT COUNT(*) AS n FROM nodes") as any).n).toBe(10);
  });

  const keys = ["root", "a", "b", "c", "x", "y", "z", "goal", "opt", "tel"];
  for (const state of [{}, { level: 3 }, { level: 3, promo: 1 }]) {
    it(`canUnlock matches for every node with state ${JSON.stringify(state)}`, () => {
      const src = new TreeStore(db), copy = new TreeStore(mem);
      for (const k of keys) expect(copy.canUnlock(treeId, k, "default", state), k).toEqual(src.canUnlock(treeId, k, "default", state));
    });
    it(`ready matches with state ${JSON.stringify(state)}`, () => {
      expect(new TreeStore(mem).ready(treeId, "default", state)).toEqual(new TreeStore(db).ready(treeId, "default", state));
    });
  }

  it("pathTo, ancestors and descendants match", () => {
    const src = new TreeStore(db), copy = new TreeStore(mem);
    for (const k of ["goal", "z", "a"]) {
      expect(copy.pathTo(treeId, k)).toEqual(src.pathTo(treeId, k));
      expect(copy.ancestors(treeId, k)).toEqual(src.ancestors(treeId, k));
    }
    expect(copy.descendants(treeId, "root")).toEqual(src.descendants(treeId, "root"));
  });

  it("telemetry conditions count the copied events the same way", () => {
    const src = new TreeStore(db).canUnlock(treeId, "tel");
    expect(src.ok).toBe(true); // ten node.add events exist
    expect(new TreeStore(mem).canUnlock(treeId, "tel")).toEqual(src);
  });
});
