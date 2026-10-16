import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, SCHEMA_VERSION } from "../../../core/database/src/db";
import { getOrm } from "../../../core/database/src/orm";

let db: DB;
let file: string;

beforeAll(async () => {
  const dir = path.join(process.cwd(), "tmp", `telemetry-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "unit.db");
  db = new DB(file);
});

describe("schema v7+（events.level）", () => {
  it("fresh DB → 最新 user_version，level 列存在，默认 info", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    expect(db.get("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
    const col = db.get("SELECT 1 AS hit FROM pragma_table_info('events') WHERE name='level'");
    expect(col).toBeTruthy();
    db.run("INSERT INTO events(id,ts,kind) VALUES('t1','2026-01-01','probe')");
    expect(db.get("SELECT level FROM events WHERE id='t1'")?.level).toBe("info");
  });
  it("显式 level 写入与读回", () => {
    db.run("INSERT INTO events(id,ts,kind,level) VALUES('t2','2026-01-01','probe','error')");
    expect(db.get("SELECT level FROM events WHERE id='t2'")?.level).toBe("error");
  });
});

describe("树域留痕 + run 关联（R10.1/R10.3）", () => {
  it("node.add/link/cond/unlock 全留痕，payload 带 run id", async () => {
    process.env.YGL_RUN_ID = "test-run-42";
    try {
      const ds = await getOrm(file);
      const treeWrites = await import("../src/writes");
      const tree = await treeWrites.treeCreate(ds, "tt", "", "");
      const n1 = await treeWrites.nodeAdd(ds, tree.id, { key: "a" });
      const n2 = await treeWrites.nodeAdd(ds, tree.id, { key: "b" });
      await treeWrites.link(ds, tree.id, "a", "b");
      await treeWrites.condAdd(ds, tree.id, "b", { name: "lv", kind: "level", op: ">=", value: "3" });
      await treeWrites.stateSet(ds, tree.id, "b", "unlocked");
      const kinds = db.all("SELECT kind, payload FROM events WHERE payload LIKE ?", ['%"run":"test-run-42"%']).map((r: any) => r.kind);
      for (const k of ["node.add", "node.link", "node.cond", "node.unlock"]) {
        expect(kinds).toContain(k);
      }
    } finally {
      delete process.env.YGL_RUN_ID;
    }
  });
});
