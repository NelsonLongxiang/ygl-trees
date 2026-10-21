/**
 * 0.110.0 release incident: `pack:repro` sealed bytes from a dirty worktree
 * (another session's uncommitted docs + an old CRLF checkout), so the published
 * artifact no longer matched the audited commit. The guard refuses that input;
 * `--check-dirty` exposes the same judge for tests and CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirtyPaths, assertCleanTree } from "../../../../scripts/lib/pack-guard.mjs";

const REPO = resolve(__dirname, "../../../..");
const SCRIPT = resolve(REPO, "scripts/pack-repro.mjs");
const SEED = "one\n";

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, encoding: "utf8" });

let dir = "";

describe("pack-repro clean-tree guard", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ygl-pack-guard-"));
    expect(git(dir, ["init", "-q"]).status).toBe(0);
    writeFileSync(join(dir, "a.txt"), SEED, "utf8");
    expect(git(dir, ["add", "a.txt"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "-m", "seed"]).status).toBe(0);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("accepts a clean worktree", () => {
    expect(dirtyPaths(dir)).toEqual([]);
    expect(() => assertCleanTree(dir)).not.toThrow();
  });

  it("refuses a dirty worktree and names the offending path", () => {
    writeFileSync(join(dir, "a.txt"), "two\n", "utf8");
    try {
      expect(dirtyPaths(dir)).toContain("a.txt");
      expect(() => assertCleanTree(dir)).toThrow(/refuses to seal bytes from a dirty worktree/);
      expect(() => assertCleanTree(dir)).toThrow(/a\.txt/);
      // explicitly opted-in dirt is reported, not hidden
      expect(assertCleanTree(dir, { allowDirty: true })).toContain("a.txt");
    } finally {
      writeFileSync(join(dir, "a.txt"), SEED, "utf8");
    }
  });

  it("--check-dirty exits 1 on dirt and 0 when clean (same judge as the packer)", () => {
    writeFileSync(join(dir, "a.txt"), "three\n", "utf8");
    const dirty = spawnSync(process.execPath, [SCRIPT, "--check-dirty"], { cwd: dir, encoding: "utf8" });
    expect(dirty.status).toBe(1);
    const dj = JSON.parse(dirty.stdout);
    expect(dj.dirty).toBe(true);
    expect(dj.files).toContain("a.txt");

    writeFileSync(join(dir, "a.txt"), SEED, "utf8");
    const clean = spawnSync(process.execPath, [SCRIPT, "--check-dirty"], { cwd: dir, encoding: "utf8" });
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ dirty: false, files: [] });
  });
});
