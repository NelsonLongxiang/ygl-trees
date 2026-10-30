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

      expect(git(dir, ["push", "gate", "HEAD:refs/heads/master", "v1.2.3"]).status).toBe(0);
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
  it("#131 rejects a remote tag until its commit is on freshly fetched remote master", () => {
    const fixture=mkdtempSync(join(tmpdir(),"ygl-release-order-"));
    try {
      const work=join(fixture,"work"),bare=join(fixture,"remote.git");
      expect(git(fixture,["init","-q","--initial-branch=master",work]).status).toBe(0);
      expect(git(fixture,["init","--bare","-q",bare]).status).toBe(0);
      writeFileSync(join(work,"package.json"),JSON.stringify({version:"9.1.0"}));
      expect(git(work,["add","package.json"]).status).toBe(0);expect(git(work,["commit","-qm","base"]).status).toBe(0);
      const master=git(work,["rev-parse","HEAD"]).stdout.trim();
      expect(git(work,["remote","add","gate",bare]).status).toBe(0);expect(git(work,["push","gate","HEAD:refs/heads/master"]).status).toBe(0);
      expect(git(work,["switch","-qc","release"]).status).toBe(0);writeFileSync(join(work,"release.txt"),"release");
      expect(git(work,["add","release.txt"]).status).toBe(0);expect(git(work,["commit","-qm","release"]).status).toBe(0);
      const release=git(work,["rev-parse","HEAD"]).stdout.trim();expect(git(work,["tag","-a","v9.1.0","-m","v9.1.0"]).status).toBe(0);expect(git(work,["push","gate","v9.1.0"]).status).toBe(0);
      // A forged/stale tracking ref must not turn a remote tag-only release green.
      expect(git(work,["update-ref","refs/remotes/gate/master",release]).status).toBe(0);
      const premature=guard(work,["--remote","gate"]);expect(premature.status,premature.stdout+premature.stderr).toBe(1);
      expect(JSON.parse(premature.stdout).error).toContain(release);expect(JSON.parse(premature.stdout).error).toContain(master);
      expect(git(fixture,["--git-dir="+bare,"config","receive.denyDeleteCurrent","ignore"]).status).toBe(0);
      expect(git(work,["push","gate",":refs/heads/master"]).status).toBe(0);
      const absent=guard(work,["--remote","gate"]);expect(absent.status).toBe(1);expect(JSON.parse(absent.stdout).error).toContain("cannot freshly fetch");
      expect(git(work,["push","gate","HEAD:refs/heads/master"]).status).toBe(0);
      const allowed=guard(work,["--remote","gate"]);expect(allowed.status,allowed.stdout+allowed.stderr).toBe(0);
      expect(JSON.parse(allowed.stdout)).toMatchObject({ok:true,remote:"gate",remote_master:release,remote_verified:true});
    } finally { rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
  });
  it("#131 rejects a different remote tag target even if local release is on master",()=>{
    const fixture=mkdtempSync(join(tmpdir(),"ygl-release-tag-target-"));
    try{
      const work=join(fixture,"work"),bare=join(fixture,"remote.git");git(fixture,["init","-q","--initial-branch=master",work]);git(fixture,["init","--bare","-q",bare]);
      writeFileSync(join(work,"package.json"),JSON.stringify({version:"9.2.0"}));git(work,["add","package.json"]);git(work,["commit","-qm","base"]);git(work,["tag","v9.2.0"]);git(work,["remote","add","gate",bare]);git(work,["push","gate","v9.2.0"]);
      writeFileSync(join(work,"note"),"release");git(work,["add","note"]);git(work,["commit","-qm","release"]);git(work,["tag","-f","v9.2.0"]);git(work,["push","gate","HEAD:refs/heads/master"]);
      const r=guard(work,["--remote","gate"]);expect(r.status).toBe(1);expect(JSON.parse(r.stdout).error).toMatch(/remote tag.*target|remote.*different/);
    }finally{rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  });
  it("#131 no-network output is explicitly local-only, not remote release verification",()=>{
    const r=guard(dir,["--remote","gate","--no-network"]);expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({remote_verified:false});
  });
});
