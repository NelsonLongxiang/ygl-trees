/**
 * GitHub issue #14 ② (zhujun, 0.109.1): `agent brief --json --db <file>` did
 * not say WHICH database the brief resolved against — with an explicit --db
 * the path was invisible in the payload. The field is additive (`db`), and
 * without --db it reports the workspace default.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function jrun(args: string[]) {
  const r = run(args);
  let j: any = null;
  try {
    j = JSON.parse(r.out);
  } catch {
    j = null;
  }
  return { rc: r.rc, j, raw: r.out };
}

describe.skipIf(!HAS_BIN)("agent brief --json db field (#14 ②)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-brief-db-"));
    run(["db", "init"]);
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reports the workspace default database", () => {
    const r = jrun(["agent", "brief", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.db).toBe(join(HOME, "ygl-trees.db"));
  });

  it("reports the explicit --db path (was ABSENT in 0.109.1)", () => {
    const alt = join(HOME, "snapshot.sqlite");
    copyFileSync(join(HOME, "ygl-trees.db"), alt);
    const r = jrun(["agent", "brief", "--json", "--db", alt]);
    expect(r.rc).toBe(0);
    expect(r.j.db).toBe(alt);
  });
});
