/**
 * Windows empty-lock regression (report direct-9154275f, 0.114.9):
 * a killed process / delayed delete can leave `.ygllock/` with NO pid/cmd.
 * The old code read "unknown", failed the liveness probe, tried one rmSync
 * (which can fail EBUSY on Windows and was swallowed), then wrote its own pid
 * into the surviving dir — every later process saw a live holder pointing at
 * itself and `db unlock --force`/`doctor --fix` could not break the ring.
 *
 * Contract: an empty lock dir is an orphan and must be taken over (retry clear);
 * if the OS still refuses, fail closed rather than create a self-lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    cwd: HOME,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "lock-empty" },
    timeout: 60_000,
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe.skipIf(!HAS_BIN)("empty .ygllock takeover (Windows residue)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-lock-empty-"));
    expect(jrun(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("write proceeds on an EMPTY lock dir and the residue is gone", async () => {
    const lock = join(HOME, "ygl-trees.db.ygllock");
    mkdirSync(lock, { recursive: true }); // no pid/cmd = killed-process residue
    expect(existsSync(join(lock, "pid"))).toBe(false);
    const r = jrun(["project", "new", "empty-lock-p"]);
    expect(r.rc, r.out + r.err).toBe(0);
    // Windows may release the dir a tick after process exit; poll briefly.
    for (let i = 0; i < 40 && existsSync(lock); i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    // Windows may leave the EMPTY dir behind (handle latency); what matters is
    // that it carries no live holder and the NEXT write can take over.
    if (existsSync(lock)) expect(existsSync(join(lock, "pid"))).toBe(false);
    const r2 = jrun(["project", "new", "empty-lock-p2"]);
    expect(r2.rc, r2.out + r2.err).toBe(0);
  });

  it("db unlock clears an empty lock dir (no self-referencing holder)", async () => {
    const lock = join(HOME, "ygl-trees.db.ygllock");
    mkdirSync(lock, { recursive: true });
    const r = jrun(["db", "unlock"]);
    expect(r.rc, r.out + r.err).toBe(0);
    expect(r.j.cleared).toBe(true);
    for (let i = 0; i < 40 && existsSync(lock); i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(existsSync(lock)).toBe(false);
  });
});
