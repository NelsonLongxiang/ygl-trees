/**
 * `verify probe --matrix` (charter §4.3, 0.112.0): the 16-probe union as CLI
 * evidence. Offline, RFC8032 deterministic seeds, rc mirrors verdict.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

const EXPECTED = [
  "envelope", "signature", "digest", "timestamp", "escalation", "injection", "cross-machine", "replay",
  "tamper-spec", "tamper-engine", "tamper-footer", "noncanon", "sig-byte", "unknown-key", "retired-key", "resign-fv",
];

function jrun(args: string[]) {
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
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("verify probe --matrix (0.112.0)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-probe-home-"));
    jrun(["db", "init"]);
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("runs the 16-probe union and passes all entries", () => {
    const r = jrun(["verify", "probe", "--matrix", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("PASS");
    expect(r.j.probe_version).toBe("1.0");
    expect(r.j.probes.map((p: any) => p.probe)).toEqual(EXPECTED);
    for (const p of r.j.probes) {
      expect(p.verdict).toBe("PASS");
      expect(p.evidence_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(String(r.j.seeds)).toMatch(/RFC8032/);
  });

  it("--only runs one probe", () => {
    const r = jrun(["verify", "probe", "--matrix", "--only", "injection", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.probes).toHaveLength(1);
    expect(r.j.probes[0].probe).toBe("injection");
  });

  it("unknown probe name is a usage error listing the matrix", () => {
    const r = jrun(["verify", "probe", "--matrix", "--only", "nope", "--json"]);
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/unknown probe 'nope'/);
    expect(String(r.j.error)).toMatch(/tamper-spec/);
  });

  it("requires --matrix or --only", () => {
    const r = jrun(["verify", "probe", "--json"]);
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/usage: verify probe --matrix/);
  });

  it("missing --target file is a runtime error", () => {
    const r = jrun(["verify", "probe", "--matrix", "--target", join(HOME, "absent.bin"), "--json"]);
    expect(r.rc).toBe(1);
    expect(String(r.j.error)).toMatch(/target not found/);
  });
});
