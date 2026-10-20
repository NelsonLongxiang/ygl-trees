/**
 * GitHub issue #6 ①: `jobReapStuck` compared an ISO-8601 UTC `started`
 * (nowIso(), written since 0.87.1) against a space-separated LOCAL cutoff.
 * The same-day compare was always false (' ' 0x20 < 'T' 0x54) and cross-day
 * compares were off by the timezone offset, so the README's "close stuck runs
 * after 30 min" promise silently stopped holding. These tests pin both sides.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../src/reads";

let db: DB;
let dir: string;

beforeAll(() => {
  dir = path.join(process.cwd(), "tmp", `job-reap-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "t.db"));
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO jobs(id,title,command,every_minutes,at,enabled,runs,last_run,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ["j1", "reap test", "echo hi", 60, "", 1, 0, "", "pending", now]
  );
});

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addRun(id: string, agoMinutes: number): void {
  db.run("INSERT INTO runs(id,job_id,started,finished,rc,output) VALUES(?,?,?,?,?,?)", [
    id,
    "j1",
    new Date(Date.now() - agoMinutes * 60_000).toISOString(),
    "",
    null,
    "",
  ]);
}

describe("jobReapStuck（GitHub issue #6 ①：时间格式同源）", () => {
  it("reaps a run older than the cutoff on the same day", () => {
    addRun("r_old", 40);
    const store = new Store(db);
    expect(store.jobReapStuck(30)).toBe(1);
    const row = db.get("SELECT finished, rc, output FROM runs WHERE id='r_old'") as any;
    expect(row.rc).toBe(126);
    expect(row.finished).not.toBe("");
    expect(String(row.output)).toContain("(reaped: process was killed mid-run)");
  });

  it("reaps a run started yesterday (cross-day compare)", () => {
    addRun("r_yesterday", 24 * 60);
    const store = new Store(db);
    expect(store.jobReapStuck(30)).toBe(1);
    expect((db.get("SELECT rc FROM runs WHERE id='r_yesterday'") as any).rc).toBe(126);
  });

  it("leaves a fresh run untouched", () => {
    addRun("r_now", 1);
    const store = new Store(db);
    expect(store.jobReapStuck(30)).toBe(0);
    expect((db.get("SELECT finished FROM runs WHERE id='r_now'") as any).finished).toBe("");
  });
});
