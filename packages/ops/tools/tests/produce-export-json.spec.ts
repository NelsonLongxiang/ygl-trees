/**
 * GitHub #46: `produce export --json` success path must be ONE JSON object
 * (frozen contract: writes print a single object); it used to print the human
 * `written: …` ack, while its error path was already JSON.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let artifactId = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe.skipIf(!HAS_BIN)("produce export --json (#46)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-prod-export-"));
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
    expect(run(["research", "claim", "add", "断言一", "-p", "p"]).rc).toBe(0);
    const outline = run(["produce", "outline", "--json"]);
    expect(outline.rc).toBe(0);
    artifactId = outline.j.id as string;
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("success: single JSON object {artifact_id, path, chars, bytes}, file written, no human ack", () => {
    const dest = join(HOME, "exported.md");
    const r = run(["produce", "export", artifactId, dest, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j).toBeTruthy();
    expect(r.j.artifact_id).toBe(artifactId);
    expect(r.j.path).toBe(dest);
    expect(typeof r.j.chars).toBe("number");
    expect(typeof r.j.bytes).toBe("number");
    expect(r.out).not.toMatch(/written:/);
    expect(r.out.startsWith("{")).toBe(true);
    expect(readFileSync(dest, "utf8").length).toBe(r.j.chars);
    expect(Buffer.byteLength(readFileSync(dest, "utf8"), "utf8")).toBe(r.j.bytes);
  });

  it("error path stays a single JSON error object", () => {
    const r = run(["produce", "export", "no-such-artifact", join(HOME, "x.md"), "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j).toBeTruthy();
    expect(Object.keys(r.j)).toEqual(["error"]);
  });

  it("human mode keeps the ack (JSON discipline only changes the machine channel)", () => {
    const r = run(["produce", "export", artifactId, join(HOME, "human.md")]);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/written:/);
    expect(r.out).not.toMatch(/artifact_id/);
  });
});
