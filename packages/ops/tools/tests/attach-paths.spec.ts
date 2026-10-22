/**
 * GitHub #55: `verify submit --attach` edge cases — same basename in different
 * dirs must stay distinct, identical content must not be listed twice, and a
 * directory argument is a usage error (rc=2), not a runtime failure.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";
let WORK = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "attach-paths" },
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim() };
}

describe.skipIf(!HAS_BIN)("verify submit --attach paths (#55)", () => {
  let text = "";
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-attach-"));
    WORK = mkdtempSync(join(tmpdir(), "ygl-attach-files-"));
    mkdirSync(join(WORK, "x"));
    mkdirSync(join(WORK, "y"));
    writeFileSync(join(WORK, "x", "c.txt"), "A");
    writeFileSync(join(WORK, "y", "c.txt"), "B");
    text = join(WORK, "material.txt");
    writeFileSync(text, "材料");
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
  });
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("same basename in different dirs: both listed with directory-qualified paths", () => {
    const r = run([
      "verify", "submit", "--title", "同名", "--text", text,
      "--attach", join(WORK, "x", "c.txt"), "--attach", join(WORK, "y", "c.txt"),
    ]);
    expect(r.rc).toBe(0);
    expect(r.j.files.map((f: any) => f.path).sort()).toEqual(["x/c.txt", "y/c.txt"]);
  });

  it("identical file passed twice is one material file (blob already deduped)", () => {
    const r = run([
      "verify", "submit", "--title", "重复", "--text", text,
      "--attach", join(WORK, "x", "c.txt"), "--attach", join(WORK, "x", "c.txt"),
    ]);
    expect(r.rc).toBe(0);
    expect(r.j.files).toHaveLength(1);
  });

  it("directory attachment is a usage error (rc=2) with the fix", () => {
    const r = run([
      "verify", "submit", "--title", "目录", "--text", text, "--attach", join(WORK, "x"),
    ]);
    expect(r.rc).toBe(2);
    expect(String(r.j?.error)).toMatch(/^usage: verify submit --attach <file>/);
    expect(String(r.j?.error)).toMatch(/directories are not accepted/);
  });
});
