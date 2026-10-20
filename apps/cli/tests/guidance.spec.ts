import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// 0.104.0 (batch nine P1): the research verbs (claim/source/evidence/query/
// predict) are actions, not groups. `ygl-trees claim list` used to answer only
// "unknown group" plus fuzzy guesses; the hint now names the owning group.
// Human channel only — --json stays a single machine-readable object.

const REPO = resolve(__dirname, "../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe.skipIf(!HAS_BIN)("0.104 unknown-group guidance", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-guidance-"));
    run(["db", "init"]);
  });

  it("names the owning group for a research action used as a group", () => {
    const r = run(["claim", "list"]);
    expect(r.rc).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toContain("unknown group: claim");
    expect(out).toContain("try: ygl-trees research claim");
    expect(out).toContain("(claim is an action of the research group)");
  });

  it("still offers fuzzy guesses for plain typos", () => {
    const r = run(["databse", "list"]);
    expect(r.rc).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toContain("did you mean");
    expect(out).not.toContain("is an action of the research group");
  });

  it("keeps --json a single object with no human hint", () => {
    const r = run(["claim", "list", "--json"]);
    expect(r.rc).toBe(2);
    const parsed = JSON.parse(r.stdout.trim()) as { error?: string };
    expect(String(parsed.error)).toContain("unknown group");
    expect(r.stdout).not.toContain("try: ygl-trees research claim");
  });

  afterAll(() => {
    if (HOME) rmSync(HOME, { recursive: true, force: true });
  });
});
