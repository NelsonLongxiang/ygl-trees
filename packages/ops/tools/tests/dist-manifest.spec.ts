/**
 * #236: `dist/` is gitignored, so the clean-tree guard cannot see stale build
 * output, and `pnpm pack` ships all of `dist/`. The build empties `dist/` and
 * records what it produced; `pack:repro` refuses anything else and names it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cleanDist, distDrift, distFiles, writeManifest } from "../../../../scripts/lib/dist-manifest.mjs";

const REPO = resolve(__dirname, "../../../..");
const PACK = resolve(REPO, "scripts/pack-repro.mjs");
const CLI = resolve(REPO, "scripts/dist-manifest.mjs");

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, encoding: "utf8" });
const put = (root: string, rel: string, body = "x\n") => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};
const node = (cwd: string, args: string[]) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

let dir = "";

describe("dist manifest guard (#236)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ygl-dist-manifest-"));
    // a clean git checkout whose dist/ and node_modules/ are ignored, like the repo
    put(dir, ".gitignore", "dist/\nnode_modules/\n");
    expect(git(dir, ["init", "-q"]).status).toBe(0);
    expect(git(dir, ["add", ".gitignore"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "-m", "seed"]).status).toBe(0);
    put(dir, "dist/bundle/bin.cjs");
    put(dir, "dist/packages/a/src/x.js");
    writeManifest(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("accepts dist/ exactly as the clean build left it", () => {
    expect(distFiles(dir)).toEqual(["dist/bundle/bin.cjs", "dist/packages/a/src/x.js"]);
    expect(distDrift(dir)).toEqual({ ok: true, manifest: true, extra: [], missing: [] });
    const r = node(dir, [PACK, "--check-dist"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it("refuses a planted stale file and names it, before any packing", () => {
    put(dir, "dist/packages/techtree/model/src/plugin.js");
    const d = distDrift(dir);
    expect(d.ok).toBe(false);
    expect(d.extra).toEqual(["dist/packages/techtree/model/src/plugin.js"]);

    const check = node(dir, [PACK, "--check-dist"]);
    expect(check.status).toBe(1);
    expect(JSON.parse(check.stdout).extra).toEqual(["dist/packages/techtree/model/src/plugin.js"]);

    // the real packing path: clean worktree, stale dist/ → rc 1 naming the file, no tarball
    expect(git(dir, ["status", "--porcelain"]).stdout).toBe("");
    const pack = node(dir, [PACK, "--json"]);
    expect(pack.status).toBe(1);
    expect(pack.stderr).toMatch(/refuses to seal bytes from a stale dist\//);
    expect(pack.stderr).toContain("dist/packages/techtree/model/src/plugin.js");
    expect(pack.stdout).toBe("");
  });

  it("refuses a file the build produced that has since gone", () => {
    unlinkSync(join(dir, "dist/packages/a/src/x.js"));
    const r = node(dir, [PACK, "--check-dist"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).missing).toEqual(["dist/packages/a/src/x.js"]);
  });

  it("refuses when no clean build is on record", () => {
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    const d = distDrift(dir);
    expect(d).toMatchObject({ ok: false, manifest: false });
    expect(d.reason).toMatch(/pnpm build/);
    expect(node(dir, [PACK, "--check-dist"]).status).toBe(1);
  });

  it("clean empties dist/; write records the new set; the manifest stays out of dist/", () => {
    put(dir, "dist/leftover.js");
    expect(node(dir, [CLI, "clean"]).status).toBe(0);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    put(dir, "dist/bundle/bin.cjs");
    const w = node(dir, [CLI, "write"]);
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(/1 files recorded/);
    expect(distFiles(dir)).toEqual(["dist/bundle/bin.cjs"]);
    expect(node(dir, [CLI, "check"]).status).toBe(0);
    cleanDist(dir);
    expect(node(dir, [CLI, "check"]).status).toBe(1);
    expect(node(dir, [CLI, "bogus"]).status).toBe(2);
  });
});
