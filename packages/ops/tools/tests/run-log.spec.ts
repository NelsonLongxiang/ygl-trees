/**
 * #178: G8 ran the tag-clone `pnpm test` with stdout/stderr on a log fd opened
 * with "a". On Windows that O_APPEND handle rejects MSYS-bash builtin writes
 * silently (rc 1), so demo.sh's first `echo` under `set -e` ended an all-green
 * chain with rc 1. The handle G8 uses must accept a bash builtin write.
 * (On POSIX "a" works too; the red case only exists on the Windows release box.)
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openLog } from "../../../../scripts/lib/run-log.mjs";

const REPO = resolve(__dirname, "../../../..");
const bash = process.platform === "win32" ? process.env.GIT_BASH || "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const dir = mkdtempSync(join(tmpdir(), "ygl-run-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("G8 log handle (#178)", () => {
  it("a bash builtin echo under set -e lands in the log, rc 0", () => {
    const file = join(dir, "builtin.log");
    const fd = openLog(file);
    let r;
    try {
      r = spawnSync(bash, ["-c", "set -euo pipefail; echo builtin-hi; node -e \"console.log('node-hi')\"; echo rc=$?"], { stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(readFileSync(file, "utf8").replace(/\r/g, "")).toBe("builtin-hi\nnode-hi\nrc=0\n");
  });

  it("starts each log fresh (every G8 log name is used once per WORK)", () => {
    const file = join(dir, "fresh.log");
    writeFileSync(file, "stale\n");
    closeSync(openLog(file));
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("post-release-check opens its logs through openLog, never an append handle", () => {
    const src = readFileSync(join(REPO, "scripts/post-release-check.mjs"), "utf8");
    expect(src).toMatch(/const fd = openLog\(logFile\)/);
    expect(src).not.toMatch(/openSync\([^)]*,\s*["']a\+?["']\)/);
  });
});
