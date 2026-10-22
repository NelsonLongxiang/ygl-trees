/** 0.114.4 F1/F3 (fdc757f6 2026-10-22): a schedule-shaped token left inside the
 *  command string (e.g. `--every 1440 --json` — the suffix token defeats the
 *  end-of-string tail pull) must not register a silent manual job. Warn, do not
 *  reject: the command face is generic and may legitimately own a same-named
 *  flag. The usage line also puts the flags BEFORE the `--` separator. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_EVAL_OFFLINE: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const json = (r: { out: string }) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

describe.skipIf(!HAS_BIN)("job add schedule-shaped token tripwire (0.114.4)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-jobtok-"));
    expect(run(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("suffix token defeats the tail pull → manual registration + JSON diagnostics (warn, rc=0)", () => {
    const r = run(["job", "add", "suffix-token", "--json", "--", "echo hi --every 5 --json"]);
    expect(r.rc).toBe(0);
    const j = json(r);
    expect(j).not.toBeNull();
    expect(j.every_minutes ?? 0).toBe(0);
    expect(j.at).toBe("");
    expect(j.command).toContain("--every");
    expect(Array.isArray(j.diagnostics)).toBe(true);
    expect(String(j.diagnostics[0])).toMatch(/manual\(every=0\)/);
    expect(String(j.diagnostics[0])).toMatch(/--every/);
  });

  it("human face: the tripwire is a stderr warning line, job still registered", () => {
    const r = run(["job", "add", "suffix-token-human", "--", "echo hi --at 2026-12-01 --json"]);
    expect(r.rc).toBe(0);
    expect(r.err).toMatch(/schedule 形 token 残留命令串内/);
    expect(r.err).toMatch(/manual\(every=0\)/);
    expect(r.out).toMatch(/job registered/);
  });

  it("flags before `--` take the flag path: real schedule, no warning", () => {
    const r = run(["job", "add", "leading-flags", "--json", "--every", "5", "--", "echo hi"]);
    expect(r.rc).toBe(0);
    const j = json(r);
    expect(j.every_minutes).toBe(5);
    expect(j.diagnostics).toBeUndefined();
  });

  it("legacy tail pull is still a compatibility face (clean command, real schedule)", () => {
    const r = run(["job", "add", "tail-pull", "--json", "--", "echo hi --every 7"]);
    expect(r.rc).toBe(0);
    const j = json(r);
    expect(j.every_minutes).toBe(7);
    expect(j.command).toBe("echo hi");
    expect(j.diagnostics).toBeUndefined();
  });

  it("usage line teaches the flag-before-`--` form", () => {
    const r = run(["job", "add", "only-title"]);
    expect(r.rc).toBe(2);
    expect(r.out + r.err).toMatch(/job add <title> \[--every/);
  });
});
