/**
 * #176 W1-T3 (G7 on #194): `node can` read the decision-model config (token, endpoint, thresholds) from the
 * synchronous SQLite face on every call, even with no eval condition. On PG that face is not there, so a plain
 * `node can` failed with the masked "operation failed". The config is now read only when a judged node has eval
 * conditions. Offline stand-in for "no SQLite config face": drop the config table and judge through the real CLI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DB } from "../../../core/database/src/db";

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");

describe.skipIf(!existsSync(BIN))("#176 W1-T3 node can without eval conditions never reads the config face", () => {
  let home = "";
  const y = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 30000, env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_SESSION: "nocfg", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "" } });
    return { rc: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "t3-nocfg-"));
    for (const a of [["db", "init"], ["tree", "new", "g"], ["tree", "use", "g"], ["node", "add", "a"], ["node", "add", "B"], ["node", "add", "E"], ["node", "link", "a", "B"]]) expect(y(...a).rc, a.join(" ")).toBe(0);
    expect(y("node", "cond", "add", "E", "--name", "judged", "--op", "eval", "--value", "is it done?").rc).toBe(0);
    const db = new DB(join(home, "ygl-trees.db"));
    try { db.run("DROP TABLE config"); } finally { db.close(); }
  }, 120_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("judges a node without eval conditions (single and batch)", () => {
    const one = y("node", "can", "B");
    expect(one.rc).toBe(0);
    expect(one.json).toMatchObject({ key: "B", ok: false, missing_required: ["a (AND)"] });
    const batch = y("node", "can", "a", "B");
    expect(batch.rc).toBe(0);
    expect(batch.json.map((r: any) => r.key)).toEqual(["a", "B"]);
  });

  it("still reads the config when a judged node has eval conditions and --eval is set", () => {
    const r = y("node", "can", "E", "--eval");
    expect(r.rc).not.toBe(0);
    expect(JSON.stringify(r.json)).toMatch(/no such table: config/);
  });
});
