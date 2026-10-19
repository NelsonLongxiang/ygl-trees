/** 0.93-T2 patrol 命令族契约（spawn 发布产物；schema v12）。
 * 依据 direct-e487e737 单3→M8→.157 ops-handbook 零未处置铁律产品化。 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const BIN = resolve(__dirname, "../../../..", "dist/bundle/bin.cjs");
const hasBin = (() => { try { require("node:fs").accessSync(BIN); return true; } catch { return false; } })();

let HOME = "";
function run(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "spec-patrol", ...extra },
  });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe.skipIf(!hasBin)("patrol command family (0.93-T2)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-patrol-"));
    run(["db", "init"]);
  });
  afterAll(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* EPERM on win */ } });

  test("SQL gates: non-SELECT and semicolon both rc=2", () => {
    const a = run(["patrol", "add", "evil", "--sql", "DELETE FROM artifacts"]);
    expect(a.rc).toBe(2);
    const b = run(["patrol", "add", "evil2", "--sql", "SELECT 1; DROP TABLE events"]);
    expect(b.rc).toBe(2);
    expect(run(["patrol", "list", "--json"]).out.includes("evil")).toBe(false);
  });

  test("add is idempotent by name (duplicate:true, single row)", () => {
    const sql = "SELECT id FROM projects WHERE status = 'never'";
    const first = run(["patrol", "add", "idem", "--sql", sql, "--severity", "S3"]);
    expect(first.rc).toBe(0);
    const again = run(["patrol", "add", "idem", "--sql", sql, "--severity", "S3", "--json"]);
    expect(again.rc).toBe(0);
    expect(JSON.parse(again.out).duplicate).toBe(true);
    const list = JSON.parse(run(["patrol", "list", "--json"]).out);
    expect(list.filter((c: any) => c.name === "idem").length).toBe(1);
  });

  test("lifecycle: violation → finding → ack → disappear → auto-fixed", () => {
    // seed a violating row directly (projects has no FK parents)
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
    db.prepare(`INSERT INTO projects(id,name,question,status,created,updated)
      VALUES('pp1','ghost-proj','','zombie','2019-01-01','2019-01-01')`).run();
    run(["patrol", "add", "zombie-projects",
      "--sql", "SELECT id FROM projects WHERE status = 'zombie'", "--severity", "S1"]);
    db.close();

    const run1 = JSON.parse(run(["patrol", "run", "--json"]).out);
    expect(run1.open_total).toBe(1);
    const zc1 = run1.checks.find((c: any) => c.name === "zombie-projects");
    expect(zc1.violations).toBe(1);
    expect(zc1.fresh).toBe(1);

    // doctor surfaces S1 as fail (doctor --json is a bare array of checks)
    const doc = JSON.parse(run(["doctor", "--json"]).out);
    const pq = doc.find((c: any) => c.name === "patrol_queue");
    expect(pq.status).toBe("fail");

    // disposition: ack, then the row disappears → auto-fixed
    const open = JSON.parse(run(["patrol", "findings", "--status", "open", "--json"]).out);
    const fid = open[0].id;
    expect(run(["patrol", "ack", fid, "--note", "investigating"]).rc).toBe(0);

    const db2 = new DatabaseSync(join(HOME, "ygl-trees.db"));
    db2.prepare(`DELETE FROM projects WHERE id='pp1'`).run();
    db2.close();
    const run2 = JSON.parse(run(["patrol", "run", "--json"]).out);
    expect(run2.open_total).toBe(0);
    const zc2 = run2.checks.find((c: any) => c.name === "zombie-projects");
    expect(zc2.auto_fixed).toBe(1);
    const fixed = JSON.parse(run(["patrol", "findings", "--status", "fixed", "--json"]).out);
    expect(fixed.length).toBe(1);
  });

  test("recurrence: fixed-then-violating reopens; ack survives rerun (P1 direct-6ca52c84)", () => {
    // seed a violating project row; check fires on status='zombie2'
    const { DatabaseSync } = require("node:sqlite");
    const open = (file = "ygl-trees.db") => new DatabaseSync(join(HOME, file));
    let db = open();
    db.prepare(`INSERT INTO projects(id,name,question,status,created,updated)
      VALUES('pp2','recurrence-proj','','zombie2','2019-01-01','2019-01-01')`).run();
    db.close();
    run(["patrol", "add", "recurrence",
      "--sql", "SELECT id FROM projects WHERE status = 'zombie2'", "--severity", "S2"]);

    const r1 = JSON.parse(run(["patrol", "run", "--json"]).out);
    const rc1 = r1.checks.find((c: any) => c.name === "recurrence");
    expect(rc1.fresh).toBe(1);

    // fix the finding by hand (as if dispositioned), then let the row KEEP
    // violating and rerun → must reopen: status=open, resolved NULL, reopened=1
    const f1 = JSON.parse(run(["patrol", "findings", "--status", "open", "--json"]).out)
      .find((f: any) => f.check_name === "recurrence" || f.row_key === "pp2");
    run(["patrol", "fix", f1.id, "--note", "handled"]);
    const r2 = JSON.parse(run(["patrol", "run", "--json"]).out);
    const rc2 = r2.checks.find((c: any) => c.name === "recurrence");
    expect(rc2.reopened).toBe(1);
    const after = JSON.parse(run(["patrol", "findings", "--status", "open", "--json"]).out)
      .find((f: any) => f.row_key === "pp2");
    expect(after.status).toBe("open");
    expect(after.resolved ?? null).toBe(null);

    // ack the reopened finding; row still violates → rerun keeps ack alive
    run(["patrol", "ack", after.id, "--note", "investigating"]);
    const r3 = JSON.parse(run(["patrol", "run", "--json"]).out);
    const rc3 = r3.checks.find((c: any) => c.name === "recurrence");
    expect(rc3.reopened).toBe(0);
    const acked = JSON.parse(run(["patrol", "findings", "--status", "ack", "--json"]).out)
      .find((f: any) => f.row_key === "pp2");
    expect(acked.status).toBe("ack");

    // cleanup: row disappears → auto-fixed closes the ack lane too
    db = open();
    db.prepare(`DELETE FROM projects WHERE id='pp2'`).run();
    db.close();
    const r4 = JSON.parse(run(["patrol", "run", "--json"]).out);
    const rc4 = r4.checks.find((c: any) => c.name === "recurrence");
    expect(rc4.auto_fixed).toBe(1);
  });

  test("run JSON stays pure (single object) and rm names unknown checks", () => {
    const j = run(["patrol", "run", "--json"]);
    expect(j.rc).toBe(0);
    expect(() => JSON.parse(j.out)).not.toThrow();
    const rm = run(["patrol", "rm", "no-such-check"]);
    expect(rm.rc).toBe(1);
    expect(rm.out + rm.err).toContain("patrol check not found: no-such-check");
  });
});
