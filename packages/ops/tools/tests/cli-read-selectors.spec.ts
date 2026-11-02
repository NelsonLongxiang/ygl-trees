import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
let home: string;
let other: string;

function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "read-selectors",
      YGL_DB_URL: "", YGL_PROJECT: "", YGL_TREE: "", YGL_TEST: "1",
      YGL_EVAL_OFFLINE: "1", NO_COLOR: "1", ...extra },
  });
  if (r.error) throw r.error;
  return { rc: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}
function json(args: string[], extra: Record<string, string | undefined> = {}) {
  const r = run([...args, "--json"], extra);
  expect(r.rc, r.stdout + r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
function selections() {
  return json(["db", "sql", "SELECT key,value FROM meta WHERE key LIKE 'current_project%' OR key LIKE 'current_tree%' ORDER BY key"]);
}

beforeAll(() => {
  const tmp = join(ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  home = mkdtempSync(join(tmp, "read-selectors-"));
  other = mkdtempSync(join(tmp, "read-selectors-other-"));
  for (const target of [home, other]) json(["db", "init"], { YGL_HOME: target });
  for (const name of ["alpha", "beta", "gamma"]) json(["project", "new", name]);
  json(["research", "claim", "add", "beta-only claim", "-p", "beta"]);
  json(["project", "use", "alpha"]);
  json(["tree", "new", "target"]);
  json(["node", "add", "target-node", "--tree", "target"]);
  json(["tree", "new", "target"], { YGL_HOME: other });
  json(["node", "add", "other-node", "--tree", "target"], { YGL_HOME: other });
});
afterAll(() => {
  for (const dir of [home, other]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("#166 brief project selection", () => {
  for (const flag of ["-p", "--project"]) {
    it(`${flag} pins both payload and source over env/session without changing pointers`, () => {
      const before = selections();
      const brief = json(["agent", "brief", flag, "beta"], { YGL_PROJECT: "alpha" });
      expect(brief).toMatchObject({ current_project: "beta", selection_source: "flag", project: { name: "beta", claims: 1 } });
      expect(brief.unverified_claims).toEqual([expect.objectContaining({ text: "beta-only claim" })]);
      expect(selections()).toEqual(before);
    });
  }
  it("flag, environment and session can name three different projects", () => {
    const before = selections();
    const brief = json(["agent", "brief", "-p", "gamma"], { YGL_PROJECT: "beta" });
    expect(brief).toMatchObject({ current_project: "gamma", selection_source: "flag", project: { name: "gamma", claims: 0 } });
    expect(selections()).toEqual(before);
    expect(json(["agent", "brief"], { YGL_PROJECT: "beta" })).toMatchObject({ current_project: "beta", selection_source: "env" });
  });
  it("human brief uses the explicit project too", () => {
    const r = run(["agent", "brief", "-p", "beta"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toMatch(/project\s+beta/);
    expect(r.stdout).toMatch(/claims 0\/1/);
  });
  it("missing explicit project is a named runtime error, not fallback", () => {
    const r = run(["agent", "brief", "-p", "missing-project", "--json"]);
    expect(r.rc).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: "project not found: missing-project" });
  });
  it("without a flag preserves session selection and the multi-project strict gate", () => {
    expect(json(["agent", "brief"])).toMatchObject({ current_project: "alpha", selection_source: "session" });
    const r = run(["agent", "brief", "--json"], { YGL_SESSION: "unselected-read-selectors" });
    expect(r.rc).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/ambiguous project/);
  });
});

describe("#166 node list global workspace selectors", () => {
  for (const flag of ["--home", "--db"]) {
    for (const leading of [true, false]) {
      it(`${flag} ${leading ? "before" : "after"} command selects the requested workspace`, () => {
        const selector = [flag, flag === "--home" ? home : join(home, "ygl-trees.db")];
        const command = ["node", "list", "--tree", "target"];
        const rows = json(leading ? [...selector, ...command] : [...command, ...selector], { YGL_HOME: other });
        expect(rows.map((r: any) => r.key)).toEqual(["target-node"]);
      });
    }
  }
  it("a typo still returns exactly one JSON usage error", () => {
    const r = run(["node", "list", "--tree", "target", "--home", home, "--bogus", "x", "--json"]);
    expect(r.rc).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/unknown flag --bogus/);
  });
});
