/** R3 tooling hashes must survive Git checkout conversion with autocrlf=true. */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, existsSync, readFileSync } from "node:fs";
// Remove a fixed scratch parent once it is empty. Another spec may still be using it (ENOTEMPTY) or have removed it
// already (ENOENT); any other error is a real cleanup failure and surfaces.
function removeIfEmpty(dir: string): void {
  try { rmdirSync(dir); } catch (e: any) { if (e?.code !== "ENOTEMPTY" && e?.code !== "ENOENT") throw e; }
}

import { join, resolve } from "node:path";

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: resolve(__dirname, "../../../.."), encoding: "utf8",
}).trim();
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const scratch: string[] = [];

describe.skipIf(!HAS_BIN)("R3 platform-stability regression (autocrlf=true)", () => {
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    removeIfEmpty(join(REPO, "tmp/r3-checkout-fixture"));
  });

  it("checkout export with core.autocrlf=true keeps R3 PASS without cloning the repository", () => {
    const task = join(REPO, "tmp/r3-checkout-fixture"); mkdirSync(task, { recursive: true });
    const parent = mkdtempSync(join(task, "export-")); scratch.push(parent);
    const exported = join(parent, "source"); mkdirSync(exported);
    const realIndexPath = execFileSync("git", ["rev-parse", "--git-path", "index"], { cwd: REPO, encoding: "utf8" }).trim();
    const realIndex = resolve(REPO, realIndexPath), before = readFileSync(realIndex);
    const checkoutEnv = { ...process.env, GIT_INDEX_FILE: join(parent, "index") };
    const git = (args: string[]) => execFileSync("git", ["-c", "core.autocrlf=true", ...args], {
      cwd: REPO, env: checkoutEnv, timeout: 120_000,
    });
    try {
      git(["read-tree", "HEAD"]);
      git(["checkout-index", "--all", "--prefix=" + exported.replaceAll("\\", "/") + "/"]);
    } finally {
      delete (checkoutEnv as NodeJS.ProcessEnv).GIT_INDEX_FILE;
      expect(readFileSync(realIndex).equals(before)).toBe(true);
    }
    expect(checkoutEnv.GIT_INDEX_FILE).toBeUndefined();
    expect(existsSync(join(exported, ".git"))).toBe(false);
    expect(existsSync(join(exported, ".gitattributes"))).toBe(true);
    expect(existsSync(join(exported, "verify", "meta.json"))).toBe(true);
    // checkout-index applies the real attributes and conversion, unlike a raw archive.
    const check = spawnSync(process.execPath, [join(exported, "scripts/meta-tooling.mjs"), "--check"], {
      cwd: exported, encoding: "utf8", timeout: 120_000,
    });
    expect(check.error).toBeUndefined(); expect(check.signal).toBeNull();
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toMatch(/0 drift/);

    const home = join(parent, "home");
    const env = { ...process.env, YGL_HOME: home, YGL_SESSION: "r3-eol-spec" };
    const init = spawnSync(process.execPath, [BIN, "db", "init", "--json"], {
      encoding: "utf8", timeout: 120_000, env,
    });
    expect(init.status, init.stdout).toBe(0);
    const meta = spawnSync(process.execPath, [BIN, "verify", "meta", exported, "--json"], {
      encoding: "utf8", timeout: 120_000, env,
    });
    expect(meta.error).toBeUndefined(); expect(meta.signal).toBeNull();
    expect(meta.status, meta.stdout + meta.stderr).toBe(0);
    const report = JSON.parse(meta.stdout);
    expect(report.rules.find((r: any) => r.id === "R3").verdict).toBe("PASS");
  }, 300_000);
});
