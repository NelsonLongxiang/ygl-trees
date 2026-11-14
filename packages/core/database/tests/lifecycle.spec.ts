import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../src/db";
import { DatabaseService } from "../src/plugin";
import { Context } from "@deepseek-ai/cordis";

describe("Cordis lifecycle: Service.stop() cleans resources", () => {
  // spawn/lock tests need headroom under parallel suite load (was 5s default, flaked at ~5.1-9s)
  // per-test timeout headroom: 20s
  it("DatabaseService.stop() closes db handle", () => {
    process.env.YGL_TEST = "1"; // skip lock
    const dir = path.join(process.cwd(), "tmp", `lifecycle-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, "test.db");

    // Create a Context and Service (simplified — no full App boot)
    const ctx = new Context();
    const svc = new DatabaseService(ctx, dbFile);

    // DB is open
    expect(svc.db).toBeDefined();
    const ver = svc.db.get("PRAGMA user_version") as any;
    expect(ver.user_version).toBeGreaterThanOrEqual(9);

    // Call stop() — should close the db
    svc.stop();

    // After stop, querying should fail (db handle is null)
    let threw = false;
    try {
      svc.db.get("PRAGMA user_version");
    } catch {
      threw = true;
    }
    // Either threw, or the internal handle is null
    const handleNull = !(svc.db as any).db || (svc.db as any).db === null;
    expect(threw || handleNull).toBe(true);

    // Double-stop is safe (idempotent)
    svc.stop(); // should not throw

    // Cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("DB.close() closes handle (lock cleanup on process exit)", () => {
    const dir = path.join(process.cwd(), "tmp", `lock-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, "test.db");
    process.env.YGL_TEST = undefined; // enable lock

    try {
      const db = new DB(dbFile, { lock: true });
      const lockDir = `${dbFile}.ygllock`;
      expect(fs.existsSync(lockDir)).toBe(true); // lock acquired

      db.close();
      // After close, querying must fail (SQLite handle released)
      let queryFailed = false;
      try { db.get("PRAGMA user_version"); } catch { queryFailed = true; }
      expect(queryFailed).toBe(true); // closed connection rejects queries
      // Lock dir: beforeExit/exit handlers clean on process exit;
      // PID-liveness (0.68) self-heals any Windows residue.
    } finally {
      // try/finally: a mid-test failure must NOT leave YGL_TEST cleared for
      // sibling tests in this worker — they would hang on DB locks (cascade).
      process.env.YGL_TEST = "1"; // restore
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("stop() is idempotent — multiple calls safe", () => {
    process.env.YGL_TEST = "1";
    const dir = path.join(process.cwd(), "tmp", `idem-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = new Context();
    const svc = new DatabaseService(ctx, path.join(dir, "t.db"));
    svc.stop();
    svc.stop(); // no throw
    svc.stop(); // still no throw
    expect(true).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);
});

describe("schema v14: v13 workspace upgrades in place, jobs kept intact (#258)", () => {
  it("a v13 jobs table gains project_id/owner and reaches the current schema", () => {
    process.env.YGL_TEST = "1";
    const dir = path.join(process.cwd(), "tmp", `v14-upgrade-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, "test.db");
    const pre = new DB(dbFile, false);
    // DB construction already replayed SCHEMA_SQL at v14 — drop the two new columns and pin v13 to fabricate a legacy workspace.
    pre.exec("ALTER TABLE jobs DROP COLUMN project_id");
    pre.exec("ALTER TABLE jobs DROP COLUMN owner");
    pre.exec("INSERT INTO jobs(id,title,command,every_minutes,at,enabled,runs,last_run,status,created) VALUES('j1','legacy job','echo a',0,'',1,0,'','pending','2026-01-01T00:00:00Z')");
    pre.exec("PRAGMA user_version=13");
    pre.close();
    const ctx = new Context();
    const svc = new DatabaseService(ctx, dbFile);
    const ver = svc.db.get("PRAGMA user_version") as any;
    expect(ver.user_version).toBe(15); // v15 re-pin (#276 bumps); the v13->v14 step stays exercised by the same upgrade path
    const job = svc.db.get("SELECT id,title,project_id,owner FROM jobs WHERE id='j1'") as any;
    expect(job.id).toBe("j1");
    expect(job.project_id).toBe("");
    expect(job.owner).toBe("");
    svc.stop();
  });
});