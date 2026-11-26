import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
// Remove a fixed scratch parent once it is empty. Another spec may still be using it (ENOTEMPTY) or have removed it
// already (ENOENT); any other error is a real cleanup failure and surfaces.
function removeIfEmpty(dir: string): void {
  try { rmdirSync(dir); } catch (e: any) { if (e?.code !== "ENOTEMPTY" && e?.code !== "ENOENT") throw e; }
}

import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import * as core from "../../../core/database/src/config";
import * as ops from "../src/config";

const ROOT = resolve(__dirname, "../../../..");
function database(probe: (db: DB) => void) {
  // Own scratch parent: a parent shared with another spec file can be removed by that file's removeIfEmpty while
  // this one sits between mkdirSync and mkdtempSync/opening the database (parallel workers; tests-scratch-parents.spec.ts).
  // Per worker process (pid) as well, so two runs of this file can never share it either; each case gets its own
  // mkdtemp directory below it, and the database is closed before anything is removed.
  const parent = join(ROOT, `tmp/config-layer-compat-234-${process.pid}`); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "config-")); let db: DB | undefined;
  try { db = new DB(join(home, "config.db")); probe(db); }
  finally { db?.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); removeIfEmpty(parent); }
}

describe("#234 configuration layer compatibility", () => {
  it("old ops imports share the exact registry and reader functions", () => {
    for (const key of ["CONFIG_REGISTRY", "specOf", "isSecretKey", "configGet", "configGetNumber", "configGetBool"] as const) expect(ops[key]).toBe(core[key]);
    expect("configSet" in core).toBe(false); expect("configReset" in core).toBe(false);
  });
  it("every default and empty override remains identical without writing on reads", () => database(db => {
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n;
    for (const spec of core.CONFIG_REGISTRY) {
      expect(core.specOf(spec.key)).toBe(spec);
      expect(core.configGet(db, spec.key)).toBe(spec.def);
      db.run("INSERT INTO config(key,value,note,updated) VALUES(?,?,?,?)", [spec.key, "", spec.note, "fixture"]);
      expect(core.configGet(db, spec.key)).toBe(spec.def);
      expect(ops.configGet(db, spec.key)).toBe(spec.def);
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n).toBe(before);
  }));
  it("override, numeric fallback, boolean resolution and reset preserve semantics", () => database(db => {
    ops.configSet(db, "search.limit", "33"); expect(core.configGetNumber(db, "search.limit")).toBe(33);
    db.run("UPDATE config SET value=? WHERE key=?", ["not-finite", "search.limit"]);
    expect(core.configGetNumber(db, "search.limit")).toBe(20);
    ops.configSet(db, "eval.offline", "YES"); expect(core.configGetBool(db, "eval.offline")).toBe(true);
    ops.configSet(db, "eval.offline", "no"); expect(core.configGetBool(db, "eval.offline")).toBe(false);
    expect(ops.configReset(db, "search.limit")).toEqual({ key: "search.limit", value: "20" });
  }));
  it("secret reads remain internal while ops receipts, events and exports remain redacted", () => database(db => {
    const key = "decision_model_llm_token", value = "test-only-config-layer-token-1234567890";
    expect(ops.configSet(db, key, value).value).toBe(ops.maskSecret(value));
    expect(core.configGet(db, key)).toBe(value); expect(core.isSecretKey(key)).toBe(true);
    expect(ops.configAll(db).find(row => row.key === key)!.value).toBe(ops.maskSecret(value));
    expect(ops.exportableRows(db, "config").some(row => row.key === key)).toBe(false);
    const events = db.all<any>("SELECT payload FROM events WHERE kind='config.set' AND entity_id=?", [key]);
    expect(events).toHaveLength(1); expect(events[0].payload).toBe(ops.REDACTED);
    expect(ops.configReset(db, key)).toEqual({ key, value: "" }); expect(core.configGet(db, key)).toBe("");
  }));
  it("unknown keys retain the original failures and cause zero writes", () => database(db => {
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n;
    expect(() => core.configGet(db, "missing")).toThrow("unknown config key: missing (config list 查看全部)");
    expect(() => ops.configSet(db, "missing", "value")).toThrow("unknown config key: missing (config list 查看全部)");
    expect(() => ops.configReset(db, "missing")).toThrow("unknown config key: missing");
    expect(core.specOf("missing")).toBeUndefined(); expect(core.isSecretKey("missing")).toBe(false);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n).toBe(before);
  }));
  it("core only imports the DB type and all four domains use the lower reader layer", () => {
    const source = readFileSync(join(ROOT, "packages/core/database/src/config.ts"), "utf8");
    expect(source.match(/^import.*$/gm)).toEqual(['import type { DB } from "./db";']);
    for (const file of ["research/pipeline/src/cmds.ts", "research/produce/src/produce-cmds.ts", "knowledge/skills/src/cmds.ts", "techtree/model/src/cmds.ts"]) {
      const text = readFileSync(join(ROOT, "packages", file), "utf8");
      expect(text).toContain('from "../../../core/database/src/config"');
      expect(text).not.toContain('from "../../../ops/tools/src/config"');
    }
  });
});
