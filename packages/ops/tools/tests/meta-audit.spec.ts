/**
 * #37 enforcement half: meta-tooling --audit chain validation.
 * The reregistrations[] audit trail must be an unbroken chain per path —
 * each old_sha256 matches the previous new_sha256, and the last new_sha256
 * matches the current tooling[] sha. A hand-edited meta.json breaks the chain.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO, "scripts", "meta-tooling.mjs");

function runAudit(root: string) {
  const r = spawnSync(process.execNode || process.execPath, [SCRIPT, "--audit"], {
    encoding: "utf8",
    env: { ...process.env, YGL_META_ROOT: root },
    timeout: 30_000,
  });
  return { rc: r.status ?? -1, out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!readFileSync(SCRIPT, "utf8").includes("--audit"))("#37 meta-tooling --audit chain validation", () => {
  let root = "";
  let real = "";

  it("real repo: chain OK (0 breaks)", () => {
    const r = runAudit(REPO);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/chain OK \(\d+ entries, 0 breaks\)/);
  }, 30_000);

  it("hand-edited reregistrations → broken chain → rc=1", () => {
    // Copy verify/meta.json to a scratch root, tamper with a sha, verify detection
    root = mkdtempSync(join(tmpdir(), "ygl-audit-tamper-"));
    const verifyDir = join(root, "verify");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(verifyDir, { recursive: true });
    copyFileSync(join(REPO, "verify", "meta.json"), join(verifyDir, "meta.json"));
    const idx = JSON.parse(readFileSync(join(verifyDir, "meta.json"), "utf8"));
    // Tamper: change the LAST reregistration's new_sha256 to break the
    // "last new == current tooling sha" invariant (this IS checked)
    const last = idx.reregistrations[idx.reregistrations.length - 1];
    last.new_sha256 = "0".repeat(64);
    writeFileSync(join(verifyDir, "meta.json"), JSON.stringify(idx, null, 2));
    const r = runAudit(root);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/chain break|≠ current tooling|gap/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 30_000);
});
