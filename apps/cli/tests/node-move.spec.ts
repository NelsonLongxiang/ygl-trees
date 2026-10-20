/**
 * Batch-nine supplement P2-2/P2-3, CLI surface: `node move <key> --to <tree>`
 * and the previously undocumented `node rm`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, YGL_HOME: HOME } });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}
function json(args: string[]) {
  const r = run([...args, "--json"]);
  expect(r.rc, `${args.join(" ")} → ${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!HAS_BIN)("node move / node rm help", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-nodemove-"));
    run(["db", "init"]);
    json(["tree", "new", "alpha"]);
    json(["tree", "new", "beta"]);
    json(["tree", "use", "alpha"]);
    json(["node", "add", "n1", "-t", "alpha"]);
    json(["node", "add", "p", "-t", "alpha"]);
    json(["node", "add", "c", "-t", "alpha"]);
    json(["node", "link", "p", "c", "-t", "alpha"]);
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true }));

  it("moves a lone node and reports both trees", () => {
    const out = json(["node", "move", "n1", "--to", "beta", "-t", "alpha"]);
    expect(out.moved).toBe(true);
    expect(out.from_tree).toBe("alpha");
    expect(out.to_tree).toBe("beta");
    const listed = json(["node", "list", "-t", "beta"]);
    expect(JSON.stringify(listed)).toContain("n1");
  });

  it("refuses a node whose edges live in the old tree (rc=1)", () => {
    const r = run(["node", "move", "c", "--to", "beta", "-t", "alpha"]);
    expect(r.rc).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/edge\(s\) inside tree 'alpha'[\s\S]*node unlink/);
  });

  it("usage: missing --to → rc=2", () => {
    const r = run(["node", "move", "n1", "-t", "alpha"]);
    expect(r.rc).toBe(2);
    expect(r.stdout + r.stderr).toContain("node move <key> --to <tree>");
  });

  it("help lists node move and node rm", () => {
    const r = run(["--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("node move <key> --to <tree>");
    expect(r.stdout).toContain("rm <key>");
  });
});
