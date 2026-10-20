import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// 0.90 ③ (direct-ce7e561b): qualified node refs — `node:<tree>/<key>` and
// `<tree>/<key>` retarget the tree; `node:<key>` sheds its prefix;
// cross-tree link refs are refused with rc=2.

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = (() => {
  try {
    spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
})();

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe.skipIf(!HAS_BIN)("0.90 qualified node refs", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-nodequal-"));
    run(["db", "init"]);
    run(["tree", "new", "t-a"]);
    run(["tree", "new", "t-b"]);
    run(["node", "add", "na", "-t", "t-a"]);
    run(["node", "add", "nb", "-t", "t-b"]);
    run(["tree", "use", "t-b"]); // current tree is t-b
  });

  it("node:<tree>/<key> resolves from a different current tree", () => {
    const r = run(["node", "show", "node:t-a/na"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("na");
  });

  it("<tree>/<key> and node:<key> forms resolve too", () => {
    expect(run(["node", "show", "t-a/na"]).rc).toBe(0);
    const r = run(["node", "show", "node:nb"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("nb");
  });

  it("cross-tree link refused with rc=2 naming both trees", () => {
    const r = run(["node", "link", "t-b/nb", "t-a/na"]);
    expect(r.rc).toBe(2);
    expect((r.stdout + r.stderr)).toContain("cross-tree link refused");
    expect((r.stdout + r.stderr)).toContain("t-a");
  });

  it("qualified ref overrides -t (writes target the named tree)", () => {
    const r = run(["node", "unlock", "node:t-a/na", "-t", "t-b"]);
    expect(r.rc).toBe(0);
    const show = run(["node", "show", "na", "-t", "t-a"]);
    expect(show.stdout).toContain("已解锁");
  });

  // 0.104.0 (batch nine P1): a link naming an endpoint that lives in another
  // tree used to answer only "parent not found" — the cross-tree lookup that
  // plain node commands get was not applied. Both endpoints get the hint, and
  // it must not suggest pinning the other tree (edges stay single-tree).
  it("missing link parent names the tree that owns the key", () => {
    const r = run(["node", "link", "na", "nb"]); // current tree is t-b
    expect(r.rc).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain("parent not found: na");
    expect(out).toContain("key exists in other tree(s): 't-a'");
    expect(out).toContain("edges cannot cross trees");
    expect(out).toContain("add 'na' to 't-b'");
  });

  it("missing link child gets the same hint", () => {
    const r = run(["node", "link", "nb", "na"]);
    expect(r.rc).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain("child not found: na");
    expect(out).toContain("key exists in other tree(s): 't-a'");
    expect(out).toContain("edges cannot cross trees");
  });

  it("a genuinely absent key keeps the current-tree hint", () => {
    const r = run(["node", "link", "nb", "nope"]);
    expect(r.rc).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain("child not found: nope");
    expect(out).not.toContain("key exists in other tree(s)");
    expect(out).toContain("current tree: 't-b'");
  });

  afterAll(() => {
    if (HOME) rmSync(HOME, { recursive: true, force: true });
  });
});
