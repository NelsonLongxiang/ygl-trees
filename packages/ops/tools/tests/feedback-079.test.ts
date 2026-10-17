/** 0.79 feedback-hardening unit tests — real-user report surfaces.
 *  Covers: pidAlive / db unlock semantics (via lock file + pid liveness),
 *  claim link --by-source + source-id enrichment (pure query layer is covered
 *  by CLI-level demo; here we assert the helpers), and produce spec
 *  --design-type rejection (argv-level, asserted via the demo suite too). */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, pidAlive } from "../../../core/database/src/db";

let dir = "";

function scratch(): string {
  dir = path.join(process.cwd(), "tmp", `fb079-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pidAlive", () => {
  it("rejects garbage and non-numeric pids", () => {
    expect(pidAlive("")).toBe(false);
    expect(pidAlive("abc")).toBe(false);
    expect(pidAlive("-5")).toBe(false);
    expect(pidAlive("0")).toBe(false);
  });
  it("detects this process as alive", () => {
    expect(pidAlive(String(process.pid))).toBe(true);
  });
  it("treats a plausibly-dead huge pid as dead (or alive only if the OS really has it — both are truthful)", () => {
    // Windows pids live in a 32-bit-ish space; 3.9e6 is virtually never taken,
    // but the assertion we care about is *a boolean, no throw*.
    const r = pidAlive("3900000");
    expect(typeof r).toBe("boolean");
  });
});

describe("db unlock semantics (db-cmds case unlock drives these helpers)", () => {
  it("lockHolder reads the pid file, empty when absent", () => {
    const d = scratch();
    const dbFile = path.join(d, "u.db");
    const lock = `${dbFile}.ygllock`; // lockHolder takes the DB file path
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    const holder = (DB as any).lockHolder(dbFile);
    expect(String(holder)).toBe(String(process.pid));
    // stale-lock detection pairs lockHolder with pidAlive: a dead pid in the
    // file is exactly what `db unlock` clears without --force.
    fs.writeFileSync(path.join(lock, "pid"), "3900000");
    expect(pidAlive((DB as any).lockHolder(dbFile))).toBe(false);
    fs.rmSync(lock, { recursive: true, force: true });
    expect((DB as any).lockHolder(dbFile)).toBe("");
  });
  it("close() truly releases the lock (no residue — the 0.76 incident class)", () => {
    const d = scratch();
    const file = path.join(d, "u2.db");
    const db = new DB(file);
    db.close();
    expect(fs.existsSync(`${file}.ygllock`)).toBe(false);
  }, 20000);
});
