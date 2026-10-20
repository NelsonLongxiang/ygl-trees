/**
 * Batch-nine P2-1, CLI surface: `research claim unlink` / `research evidence rm`
 * must keep the exit-code and JSON contracts (rc=2 usage, rc=1 refusal with a
 * named repair path, rc=0 success, single machine-readable object on --json).
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
let srcId = "";
let claimId = "";
let evidenceId = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function json(args: string[]) {
  const r = run([...args, "--json"]);
  expect(r.rc, `${args.join(" ")} → ${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

describe.skipIf(!HAS_BIN)("claim unlink / evidence rm (batch nine P2-1)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-unlink-"));
    run(["db", "init"]);
    run(["project", "new", "unlink-cli"]);
    srcId = json(["research", "source", "add", "--title", "billing spec", "--url", "session://u/1"]).id;
    evidenceId = json(["research", "evidence", "add", srcId, "--quote", "amount must be non-negative"]).id;
    claimId = json(["research", "claim", "add", "amounts are never negative"]).id;
    json(["research", "claim", "link", claimId, evidenceId]);
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it("usage: missing ids → rc=2", () => {
    const r = run(["research", "claim", "unlink"]);
    expect(r.rc).toBe(2);
    expect(r.stdout + r.stderr).toContain("research claim unlink <claimId> <evidenceId>");
  });

  it("claim unlink: rc=0, status recomputed, JSON is one object", () => {
    const out = json(["research", "claim", "unlink", claimId, evidenceId]);
    expect(out.claim).toBe(claimId);
    expect(out.evidence).toBe(evidenceId);
    expect(out.stance).toBe("supports");
    expect(out.status).toBe("unverified");
    expect(out.recalculated).toBe(true);
  });

  it("evidence rm refuses while linked and names the repair path (rc=1)", () => {
    json(["research", "claim", "link", claimId, evidenceId]);
    const r = run(["research", "evidence", "rm", evidenceId]);
    expect(r.rc).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain(`evidence ${evidenceId} is linked to 1 claim(s)`);
    expect(out).toContain("research claim unlink <claim>");
  });

  it("evidence rm --force cascades and reports recomputed statuses", () => {
    const out = json(["research", "evidence", "rm", evidenceId, "--force"]);
    expect(out.id).toBe(evidenceId);
    expect(out.unlinked).toEqual([claimId]);
    expect(out.forced).toBe(true);
    expect(out.statuses[claimId]).toBe("unverified");
  });
});
