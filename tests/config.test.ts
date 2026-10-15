import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DB } from "../src/db";
import { CONFIG_REGISTRY, configAll, configGet, configReset, configSet } from "../src/config";

let db: DB;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-unit-"));
  db = new DB(path.join(dir, "unit.db"));
});

describe("config registry 不变量", () => {
  it("默认值与声明类型自洽", () => {
    for (const c of CONFIG_REGISTRY) {
      if (c.def !== "" && c.type === "number") expect(Number.isFinite(Number(c.def))).toBe(true);
      if (c.type === "boolean") expect(["true", "false"]).toContain(c.def);
    }
  });
  it("阈值键默认构成合法灰带（fail < pass）", () => {
    const pass = Number(CONFIG_REGISTRY.find((c) => c.key === "eval.pass_threshold")!.def);
    const fail = Number(CONFIG_REGISTRY.find((c) => c.key === "eval.fail_threshold")!.def);
    expect(fail).toBeLessThan(pass);
  });
});

describe("config get/set/reset", () => {
  it("未知键报错", () => {
    expect(() => configGet(db, "nope.key")).toThrow(/unknown config key/);
    expect(() => configSet(db, "nope.key", "1")).toThrow(/unknown config key/);
  });
  it("数值键拒非数值", () => {
    expect(() => configSet(db, "search.limit", "abc")).toThrow(/数值/);
  });
  it("布尔键拒非法字面量", () => {
    expect(() => configSet(db, "eval.offline", "maybe")).toThrow(/布尔/);
  });
  it("阈值范围 [0,1] 校验", () => {
    expect(() => configSet(db, "eval.pass_threshold", "1.5")).toThrow(/\[0,1\]/);
  });
  it("default_confidence 枚举校验", () => {
    expect(() => configSet(db, "default_confidence", "D")).toThrow(/A\|B\|C/);
  });
  it("覆盖→读取→重置回默认", () => {
    expect(configGet(db, "eval.pass_threshold")).toBe("0.7");
    configSet(db, "eval.pass_threshold", "0.8");
    expect(configGet(db, "eval.pass_threshold")).toBe("0.8");
    configReset(db, "eval.pass_threshold");
    expect(configGet(db, "eval.pass_threshold")).toBe("0.7");
  });
  it("configAll 反映覆盖与默认标记", () => {
    configSet(db, "search.limit", "7");
    const rows = configAll(db);
    const changed = rows.find((r) => r.key === "search.limit")!;
    expect(changed.value).toBe("7");
    expect(changed.is_default).toBe(false);
    const untouched = rows.find((r) => r.key === "eval.offline")!;
    expect(untouched.is_default).toBe(true);
    configReset(db, "search.limit");
  });
  it("set 留痕 events（config.set）", () => {
    configSet(db, "eval.offline", "true");
    const hit = db.get("SELECT 1 AS h FROM events WHERE kind='config.set' AND entity_id='eval.offline'");
    expect(hit).toBeTruthy();
    configReset(db, "eval.offline");
  });
});
