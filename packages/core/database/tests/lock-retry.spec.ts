import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// 0.94 lock-family hardening (task 68d051ae71): the app-level .ygllock is
// checked BEFORE the SQLite handle exists, so busy_timeout could not cover
// open-stage contention. The constructor now bounded-waits (default 8s,
// YGL_LOCK_RETRY_MS) instead of failing instantly.

const REPO = resolve(__dirname, "../../../..");
const DB_DIST = join(REPO, "dist/packages/core/database/src/db.js");
const HOME = mkdtempSync(join(tmpdir(), "lock-retry-"));

// Holder child: constructs DB (takes the lock), holds `ms`, closes (releases).
function holderScript(file: string, ms: number): string {
  return `
    const { DB } = require(${JSON.stringify(DB_DIST)});
    const db = new DB(${JSON.stringify(file)}, { lock: true });
    setTimeout(() => { db.close(); process.exit(0); }, ${ms});
  `;
}

async function waitForLockDir(lockDir: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(lockDir) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(lockDir)) throw new Error("holder child never took the lock");
}

describe("db open lock retry (0.94, 68d051ae71)", () => {
  const file = join(HOME, "ygl-trees.db");
  const lockDir = `${file}.ygllock`;

  beforeAll(() => {
    const { DB } = require(DB_DIST) as typeof import("../../src/db");
    const db = new DB(file, { lock: true });
    db.close();
  });

  afterAll(() => {
    try { rmSync(HOME, { recursive: true, force: true }); } catch { /* EPERM on Windows */ }
  });

  it("transient holder (1.2s): open waits and proceeds", async () => {
    const child = spawn(process.execPath, ["-e", holderScript(file, 1200)], { stdio: "ignore" });
    await waitForLockDir(lockDir);
    const { DB } = require(DB_DIST) as typeof import("../../src/db");
    const t0 = Date.now();
    let db: any = null;
    try {
      expect(() => { db = new DB(file, { lock: true }); }).not.toThrow();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(800); // actually waited for the holder
      expect(db.get<{ user_version: number }>("PRAGMA user_version").user_version).toBeGreaterThan(0);
    } finally {
      if (db) db.close();
      child.kill();
      if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
    }
  }, 20_000);

  it("stubborn holder + short window (YGL_LOCK_RETRY_MS=400): informative throw", async () => {
    const child = spawn(process.execPath, ["-e", holderScript(file, 8000)], { stdio: "ignore" });
    await waitForLockDir(lockDir);
    const { DB } = require(DB_DIST) as typeof import("../../src/db");
    const prev = process.env.YGL_LOCK_RETRY_MS;
    process.env.YGL_LOCK_RETRY_MS = "400";
    const t0 = Date.now();
    try {
      expect(() => new DB(file, { lock: true })).toThrow(/database is locked by another process.*waited 400ms/s);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      if (prev === undefined) delete process.env.YGL_LOCK_RETRY_MS; else process.env.YGL_LOCK_RETRY_MS = prev;
      child.kill();
      if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }, 20_000);

  it("dead holder (stale pid): stolen immediately, no wait", () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "999999999"); // no such process
    const { DB } = require(DB_DIST) as typeof import("../../src/db");
    const t0 = Date.now();
    let db: any = null;
    expect(() => { db = new DB(file, { lock: true }); }).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    db.close();
  }, 15_000);

  it("YGL_LOCK_RETRY_MS=0 disables the wait (back-compat escape hatch)", () => {
    mkdirSync(lockDir, { recursive: true });
    // a live foreign pid: this worker's parent is alive for the test duration
    writeFileSync(join(lockDir, "pid"), String(process.ppid));
    const { DB } = require(DB_DIST) as typeof import("../../src/db");
    const prev = process.env.YGL_LOCK_RETRY_MS;
    process.env.YGL_LOCK_RETRY_MS = "0";
    const t0 = Date.now();
    try {
      expect(() => new DB(file, { lock: true })).toThrow(/database is locked/);
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      if (prev === undefined) delete process.env.YGL_LOCK_RETRY_MS; else process.env.YGL_LOCK_RETRY_MS = prev;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }, 15_000);
});
