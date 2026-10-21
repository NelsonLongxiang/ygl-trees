/**
 * F1 (0.110.x): write receipts name their target project and the selection
 * layer that authorized it; a bare write riding session/global selection in a
 * multi-project workspace prints a cwd hint on stderr (JSON stays one object).
 * `project_source` domain is the frozen SelectionSource: flag|env|session|global|only|none.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe.skipIf(!HAS_BIN)("F1 write-target amplification (0.110.x)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-bind-"));
    run(["db", "init"]);
    run(["project", "new", "alpha"]);
    run(["project", "new", "beta"]); // session selection -> beta
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("JSON receipt carries project + project_source (session selection)", () => {
    const r = run(["research", "claim", "add", "bind-session", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j).toMatchObject({ project: "beta", project_source: "session" });
    expect(r.stderr).not.toContain("pass -p"); // JSON mode: no stderr hint
  });

  it("explicit -p reports the flag layer", () => {
    const r = run(["research", "claim", "add", "bind-flag", "-p", "alpha", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j).toMatchObject({ project: "alpha", project_source: "flag" });
  });

  it("human-mode bare write warns once on stderr, stdout stays the receipt", () => {
    const r = run(["research", "claim", "add", "bind-warn"]);
    expect(r.rc).toBe(0);
    expect(r.stderr).toContain("writing to project 'beta' via session selection");
    expect(r.stderr).toContain("pass -p <name>");
    expect(r.stdout).toContain("claim added");
  });
});
