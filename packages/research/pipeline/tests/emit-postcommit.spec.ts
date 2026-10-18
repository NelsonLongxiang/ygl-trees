/**
 * 0.91a event-family acceptance (Cordis review direct-032bf3b4):
 *   ① rollback zero-leak — an aborted transaction emits NOTHING on the bus
 *      and leaves NO events row (ghost-event hole closed);
 *   ② writes-path emission visible under vitest/ESM — the old
 *      require()-in-catch form silently skipped emission here; the static
 *      import makes the bus live in every host;
 *   ③ emitted payload byte-shape unchanged from the pre-0.91a format
 *      (SSE consumers / calibration latest-wins see identical fields).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DataSource } from "typeorm";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { onEvent, YglEvent } from "../../../core/text/src/eventbus";
import { runTx, queryAdd } from "../src/writes";
import * as treeWrites from "../../../techtree/model/src/writes";

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
const HAS_BIN = (() => { try { accessSync(BIN); return true; } catch { return false; } })();

const home = mkdtempSync(join(tmpdir(), "emit-pc-"));
let ds: DataSource;

beforeAll(async () => {
  const r = spawnSync(process.execPath, [BIN, "db", "init"], {
    env: { ...process.env, YGL_HOME: home }, encoding: "utf8",
  });
  expect(r.status).toBe(0);
  ds = await getOrm(join(home, "ygl-trees.db"));
  const iso = new Date().toISOString();
  await ds.query(`INSERT INTO projects(id,name,created,updated) VALUES('p1','alpha',?,?)`, [iso, iso]);
  await ds.query(`INSERT INTO trees(id,name,created) VALUES('t1','probe-tree',?)`, [iso]);
}, 60_000);

afterAll(async () => {
  await closeOrm().catch(() => {});
  try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows open-handle race — temp dir is disposable */ }
});

describe.skipIf(!HAS_BIN)("0.91a post-commit event flush", () => {
  it("① rollback discards the pending bag — zero bus events, zero rows", async () => {
    const seen: YglEvent[] = [];
    const unsub = onEvent((e) => seen.push(e));
    await expect(
      runTx(ds, async (mgr) => {
        await mgr.query(
          `INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('probe-rl','t','cli','probe.rollback','node','probe-rl','{}','info')`
        );
        (mgr as any).__yglPendingEvents.push({
          kind: "probe.rollback", entity: "node", entityId: "probe-rl", payload: "{}", ts: new Date().toISOString(),
        });
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");
    expect(seen.filter((e) => e.kind === "probe.rollback")).toHaveLength(0);
    const rows = await ds.query(`SELECT COUNT(*) AS n FROM events WHERE id='probe-rl'`) as any[];
    expect(Number(rows[0].n)).toBe(0);
    unsub();
  });

  it("② research writes path emits on the bus under vitest (ESM host)", async () => {
    const seen: YglEvent[] = [];
    const unsub = onEvent((e) => seen.push(e));
    const r = await queryAdd(ds, "p1", "probe query for post-commit flush");
    expect(r.dup).toBe(false);
    const hit = seen.find((e) => e.kind === "query.add");
    expect(hit).toBeDefined();
    // ③ byte-shape frozen: payload is String(original arg), same fields as 0.76-0.90
    expect(hit!.entity).toBe("query");
    expect(hit!.entityId).toBe(r.row.id);
    expect(hit!.payload).toBe("probe query for post-commit flush");
    expect(hit!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const rows = await ds.query(`SELECT COUNT(*) AS n FROM queries WHERE id=?`, [r.row.id]) as any[];
    expect(Number(rows[0].n)).toBe(1);
    unsub();
  });

  it("② techtree writes path emits on the bus under vitest (ESM host)", async () => {
    const seen: YglEvent[] = [];
    const unsub = onEvent((e) => seen.push(e));
    const r = await treeWrites.nodeAdd(ds, "t1", { key: "probe-node", name: "Probe Node", kind: "tech", tier: 1 });
    expect(r.created).toBe(true);
    const hit = seen.find((e) => e.kind === "node.add");
    expect(hit).toBeDefined();
    // ③ byte-shape frozen vs pre-0.91a: entity hardcoded "node", payload is
    // String(body) where body was the JSON string built in logEvent — i.e.
    // the legacy String(object) shape is preserved verbatim.
    expect(hit!.entity).toBe("node");
    expect(hit!.entityId).toBe(r.row.id);
    expect(hit!.payload).toBe(String(JSON.stringify({ tree: "t1", key: "probe-node", name: "Probe Node", kind: "tech", tier: 1 })));
    unsub();
  });

  it("① duplicate writes never reach the bus (pre-dup early return kept)", async () => {
    const seen: YglEvent[] = [];
    const unsub = onEvent((e) => seen.push(e));
    const r = await queryAdd(ds, "p1", "probe query for post-commit flush");
    expect(r.dup).toBe(true);
    expect(seen.filter((e) => e.kind === "query.add")).toHaveLength(0);
    unsub();
  });
});
