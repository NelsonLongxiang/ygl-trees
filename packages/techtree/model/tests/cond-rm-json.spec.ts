/**
 * `node cond rm --json` printed the human line ("✓ condition removed: …") instead of a JSON object — a breach of
 * the frozen --json write contract, caught by the #176 W1-T3 SQLite/PG golden on #194. The receipt is now the
 * removed row plus the node key; the human line is unchanged (examples/demo.sh matches it).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");

describe.skipIf(!existsSync(BIN))("node cond rm --json writes a single JSON receipt", () => {
  let home = "";
  const y = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 30000, env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_SESSION: "condrm", YGL_NO_UPDATE_CHECK: "1" } });
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "cond-rm-json-"));
    for (const a of [["db", "init"], ["tree", "new", "g"], ["tree", "use", "g"], ["node", "add", "B"]]) expect(y([...a, "--json"]).status, a.join(" ")).toBe(0);
    expect(y(["node", "cond", "add", "B", "--name", "promo", "--op", ">=", "--value", "1", "--optional", "--effect", "cost_mul", "--weight", "0.5", "--json"]).status).toBe(0);
  }, 120_000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("--json: the removed row as one object, snake_case, rc 0", () => {
    const r = y(["node", "cond", "rm", "B", "--name", "promo", "--json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ node: "B", name: "promo", op: ">=", value: "1", required: 0, effect: "cost_mul", weight: 0.5, removed: true });
    for (const k of Object.keys(j)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("human mode keeps the line demo.sh matches; a second rm names the miss with rc 1", () => {
    expect(y(["node", "cond", "add", "B", "--name", "lvl", "--op", ">=", "--value", "2", "--json"]).status).toBe(0);
    const h = y(["node", "cond", "rm", "B", "--name", "lvl"]);
    expect(h.status).toBe(0);
    expect(h.stdout + h.stderr).toContain("condition removed: B · lvl");
    const again = y(["node", "cond", "rm", "B", "--name", "lvl", "--json"]);
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stdout).error).toMatch(/condition not found: lvl/);
  });
});
