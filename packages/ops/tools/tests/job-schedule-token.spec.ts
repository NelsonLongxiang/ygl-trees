/** 0.114.4 F1/F3 (fdc757f6 2026-10-22): a schedule-shaped token left inside the
 *  command string (e.g. `--every 1440 --json` — the suffix token defeats the
 *  end-of-string tail pull) must not register a silent manual job. The usage
 *  line also puts the flags BEFORE the `--` separator.
 *
 *  #220 (2026-11-05) closes the shape for good: a job with no schedule is refused
 *  (rc2, nothing written) unless `--manual` declares it — the audited bad row
 *  0b88263172 (every=0) was exactly this shape. With `--manual` the leftover
 *  token still only warns: the command may own a same-named flag. Cadences below
 *  job.min_every_minutes (60) need `--allow-frequent`. */
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

  it("suffix token defeats the tail pull → refused unless --manual (#220); with --manual: registration + JSON diagnostics", () => {
    const refused = run(["job", "add", "suffix-token", "--json", "--", "echo hi --every 5 --json"]);
    expect(refused.rc).toBe(2);
    expect(json(refused).error).toMatch(/needs a schedule[\s\S]*schedule-shaped token is still inside the command/);
    expect(json(run(["job", "list", "--json"])).some((x: any) => x.title === "suffix-token")).toBe(false);
    const r = run(["job", "add", "suffix-token", "--json", "--manual", "--", "echo hi --every 5 --json"]);
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

  it("human face: refused without --manual; with it the tripwire is a stderr warning line and the job registers", () => {
    expect(run(["job", "add", "suffix-token-human", "--", "echo hi --at 2026-12-01 --json"]).rc).toBe(2);
    const r = run(["job", "add", "suffix-token-human", "--manual", "--", "echo hi --at 2026-12-01 --json"]);
    expect(r.rc).toBe(0);
    expect(r.err).toMatch(/schedule 形 token 残留命令串内/);
    expect(r.err).toMatch(/manual\(every=0\)/);
    expect(r.out).toMatch(/job registered/);
  });

  it("flags before `--` take the flag path: real schedule, no warning (every 5 needs --allow-frequent, #220)", () => {
    const slow = run(["job", "add", "leading-flags", "--json", "--every", "5", "--", "echo hi"]);
    expect(slow.rc).toBe(2);
    expect(json(slow).error).toMatch(/below job\.min_every_minutes \(60\)/);
    const r = run(["job", "add", "leading-flags", "--json", "--every", "5", "--allow-frequent", "--", "echo hi"]);
    expect(r.rc).toBe(0);
    const j = json(r);
    expect(j.every_minutes).toBe(5);
    expect(j.diagnostics).toBeUndefined();
  });

  it("legacy tail pull is still a compatibility face (clean command, real schedule)", () => {
    expect(run(["job", "add", "tail-pull", "--json", "--", "echo hi --every 7"]).rc).toBe(2);
    const r = run(["job", "add", "tail-pull", "--json", "--allow-frequent", "--", "echo hi --every 7"]);
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
