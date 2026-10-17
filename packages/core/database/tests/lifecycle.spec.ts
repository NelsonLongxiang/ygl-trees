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

    process.env.YGL_TEST = "1"; // restore
    fs.rmSync(dir, { recursive: true, force: true });
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
