/**
 * GitHub #17: release-order guard. 0.110.0 published npm ~3.5 min before the
 * annotated tag existed; "latest on npm" briefly had no tag to point at.
 *
 * `npm publish <tgz>` does NOT run lifecycle hooks, so the exact-bytes release
 * flow must call `scripts/prepublish-guard.mjs` explicitly (package.json's
 * prepublishOnly only backs up directory publishes).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const SCRIPT = resolve(REPO, "scripts/prepublish-guard.mjs");

const git = (cwd: string, args: string[]) =>
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, encoding: "utf8" });

const guard = (cwd: string, args: string[] = []) =>
  spawnSync(process.execPath, [SCRIPT, ...args, "--json"], { cwd, encoding: "utf8" });

let dir = "";

describe("prepublish-guard (#17)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ygl-prepublish-"));
    expect(git(dir, ["init", "-q"]).status).toBe(0);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }, null, 2) + "\n", "utf8");
    expect(git(dir, ["add", "package.json"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "-m", "release"]).status).toBe(0);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("rejects an untagged HEAD and names the fix", () => {
    const r = guard(dir);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(String(j.error)).toMatch(/v1\.2\.3 does not point at HEAD/);
    expect(String(j.error)).toMatch(/git tag -a v1\.2\.3/);
  });

  it("accepts HEAD when the annotated tag is present", () => {
    expect(git(dir, ["tag", "-a", "v1.2.3", "-m", "v1.2.3"]).status).toBe(0);
    const r = guard(dir);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, tag: "v1.2.3" });
  });

  it("rejects a tag that points at an older commit (HEAD moved on)", () => {
    expect(git(dir, ["tag", "-d", "v1.2.3"]).status).toBe(0);
    // tag the current commit, then advance HEAD
    expect(git(dir, ["tag", "-a", "v1.2.3", "-m", "v1.2.3"]).status).toBe(0);
    writeFileSync(join(dir, "note.txt"), "later\n", "utf8");
    expect(git(dir, ["add", "note.txt"]).status).toBe(0);
    expect(git(dir, ["commit", "-q", "-m", "post-release docs"]).status).toBe(0);
    const r = guard(dir);
    expect(r.status).toBe(1);
    expect(String(JSON.parse(r.stdout).error)).toMatch(/does not point at HEAD/);
  });

  it("--remote refuses when the tag is missing remotely, accepts after push", () => {
    const bare = join(dir, "..", `ygl-prepublish-remote-${Date.now()}.git`);
    expect(spawnSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" }).status).toBe(0);
    try {
      expect(git(dir, ["remote", "add", "gate", bare]).status).toBe(0);
      // HEAD is one commit past the tag here — re-tag HEAD for this case
      expect(git(dir, ["tag", "-d", "v1.2.3"]).status).toBe(0);
      expect(git(dir, ["tag", "-a", "v1.2.3", "-m", "v1.2.3"]).status).toBe(0);

      const missing = guard(dir, ["--remote", "gate"]);
      expect(missing.status).toBe(1);
      expect(String(JSON.parse(missing.stdout).error)).toMatch(/is not on remote 'gate'/);

      expect(git(dir, ["push", "gate", "v1.2.3"]).status).toBe(0);
      const present = guard(dir, ["--remote", "gate"]);
      expect(present.status).toBe(0);
      expect(JSON.parse(present.stdout)).toMatchObject({ ok: true, tag: "v1.2.3" });

      // --no-network must skip the remote read entirely
      expect(git(dir, ["push", "gate", ":refs/tags/v1.2.3"]).status).toBe(0);
      const skipped = guard(dir, ["--remote", "gate", "--no-network"]);
      expect(skipped.status).toBe(0);
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
