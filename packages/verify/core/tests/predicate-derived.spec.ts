/**
 * Contract 1.3 part 2b (#80, owner 2026-11-11): derived tables and spec views, run in memory only.
 *
 * fixtures/predicate-derived.json is shared with rust/yglverify/tests/predicate_derived.rs: both engines must render
 * the same SQL, return the same rows (views created as TEMP VIEWs) and refuse the same shapes. The runVerify cases
 * check the isolation contract: views live in memory, the snapshot's sha256 is unchanged, views stored in the
 * snapshot are never executed, and a spec without derived tables or views never takes the isolated path.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import type { VerifySpec } from "../src/contract";
import { isolationRefusal, namesReadBy, renderPredicate, renderViews, runVerify, uses13Shapes, usesIsolation, type QueryRunner } from "../src/engine";
import { lintCandidates, prepareViews, snapshotPathRefusal, type SchemaProbe } from "../src/prepare";
import { SqliteRunner } from "../src/sqlite-runner";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/predicate-derived.json"), "utf8"));

describe("derived table and view vectors (shared with Rust)", () => {
  const db = new DatabaseSync(":memory:");
  for (const d of fixture.ddl) db.exec(d);
  const measure = (c: { predicate: unknown; findSql: string; scopeSql: string; rows: number; scanned: number }) => {
    const r = renderPredicate(c.predicate as never);
    expect(r.findSql).toBe(c.findSql);
    expect(r.scopeSql).toBe(c.scopeSql);
    expect(db.prepare(r.findSql).all().length).toBe(c.rows);
    expect(Number((db.prepare(r.scopeSql).get() as { n: number }).n)).toBe(c.scanned);
  };
  for (const c of fixture.cases) it(`${c.name}: ${c.rows} row(s) of ${c.scanned}`, () => measure(c));
  it("views render to the frozen SELECTs, in declaration order", () => {
    const views = renderViews(fixture.views);
    expect(views).toEqual(fixture.view_sql);
    for (const v of views) db.exec(`CREATE TEMP VIEW ${v.name} AS ${v.sql}`);
  });
  for (const c of fixture.view_cases) it(`${c.name}: ${c.rows} row(s) of ${c.scanned}`, () => measure(c));
  for (const r of fixture.rejects) {
    it(`refuses: ${r.name}`, () => expect(() => renderPredicate({ from: r.from, select: ["id"] } as never)).toThrow(r.error));
  }
  for (const r of fixture.view_rejects) {
    it(`refuses views: ${r.name}`, () => expect(() => renderViews(r.views)).toThrow(r.error));
  }
});

describe("isolated runs: views in memory, the snapshot untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "ygl-derived13-"));
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dbPath = join(home, "snap.sqlite");
  const db = new DatabaseSync(dbPath);
  for (const d of fixture.ddl) db.exec(d);
  db.exec("CREATE VIEW stored_view AS SELECT id FROM orders");
  db.close();
  const sha = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");

  const and = (...conditions: unknown[]) => ({ op: "and", conditions });
  const vuOf = (id: string, predicate: unknown, extra: Record<string, unknown> = {}) => ({
    id, role: "assert", severity: "S1", source_clause: `clause ${id}`,
    checker: { type: "sql", expect: "empty", fail_when: "rows>0", predicate, ...extra },
  });
  const spec = (contract: string, vu: unknown[], views?: unknown): VerifySpec => ({
    contract_version: contract, spec_id: "spec_derived13", spec_version: 1, title: "derived", domain: "test",
    created: "2026-11-11T00:00:00.000Z", runtime_min: "1",
    verifier: { engine_version: "test", corpus_version: "1.2" },
    as_of: { kind: "snapshot", value: "2026-11-11T00:00:00.000Z" },
    vu, attachments: [], sealed: { review: false }, ...(views === undefined ? {} : { views }),
  } as never);
  const run = async (s: VerifySpec, runner: QueryRunner = new SqliteRunner(dbPath)) => {
    try { return await runVerify(s, { runner, mode: "open", nowIso: () => "2026-11-11T00:00:00.000Z", runId: "run_derived13" }); }
    finally { (runner as SqliteRunner).close?.(); }
  };
  // "no big order without an item": big_orders minus orders that have items → order 3 has an item, so empty → PASS
  const views = [
    { name: "big_orders", predicate: { from: "orders", select: ["id", "amount", "batch"], where: and({ col: "amount", op: ">", value: 10 }) } },
  ];

  it("a view and a derived table run, PASS and FAIL are real, and the snapshot bytes are unchanged", async () => {
    const before = sha();
    const pass = await run(spec("1.3", [vuOf("V1", { from: "big_orders", select: ["id"], where: and({ col: "amount", op: ">", value: 1000 }) })], views));
    expect(pass.overall).toBe("PASS");
    expect((pass.vu[0] as { witness: { rows_scanned: number } }).witness.rows_scanned).toBe(2);
    const fail = await run(spec("1.3", [vuOf("V1", { from: { derived: views[0].predicate }, select: ["id"], where: and({ col: "batch", op: "=", value: "b2" }) })]));
    expect(fail.overall).toBe("FAIL");
    expect(sha()).toBe(before);
  });

  it("a stored snapshot view is never executed by a 1.3 spec (from, derived, view or raw sql)", async () => {
    const msg = "snapshot_view: stored_view is a view stored in the snapshot";
    await expect(run(spec("1.3", [vuOf("V1", { from: "stored_view", select: ["id"] })]))).rejects.toThrow(msg);
    await expect(run(spec("1.3", [vuOf("V1", { from: { derived: { from: "stored_view", select: ["id"] } }, select: ["id"] })]))).rejects.toThrow(msg);
    await expect(run(spec("1.3", [vuOf("V1", { from: "orders", select: ["id"], where: and({ col: "id", op: "<", value: 0 }) })], [{ name: "v", predicate: { from: "stored_view", select: ["id"] } }]))).rejects.toThrow(msg);
    const raw = { id: "V1", role: "assert", severity: "S1", source_clause: "c", checker: { type: "sql", expect: "empty", fail_when: "rows>0", sql: "SELECT id FROM stored_view WHERE id < 0" } };
    await expect(run(spec("1.3", [raw]))).rejects.toThrow(msg);
    // 1.2 behaviour is unchanged: the same raw sql still runs in a 1.2 spec.
    expect((await run(spec("1.2", [raw]))).vu[0].verdict).not.toBe("ERROR");
  });

  it("a view may not shadow a snapshot object", async () => {
    await expect(run(spec("1.3", [vuOf("V1", { from: "orders", select: ["id"], where: and({ col: "id", op: "<", value: 0 }) })], [{ name: "items", predicate: views[0].predicate }]))).rejects.toThrow("view_name: items is already an object in the snapshot");
  });

  it("derived tables and views are 1.3-only shapes (version_shape)", async () => {
    await expect(run(spec("1.2", [vuOf("V1", { from: "orders", select: ["id"] })], views))).rejects.toThrow("version_shape");
    await expect(run(spec("1.2", [vuOf("V1", { from: { derived: views[0].predicate }, select: ["id"] })]))).rejects.toThrow("version_shape");
    expect(uses13Shapes(spec("1.3", [vuOf("V1", { from: "orders", select: ["id"] })], []))).toBe(true);
  });

  it("a runner without isolation refuses the spec; a spec without derived tables or views never isolates", async () => {
    const plain = { query: () => [], tableRows: () => 0, schemaFingerprint: () => "x" };
    await expect(run(spec("1.3", [vuOf("V1", { from: "big_orders", select: ["id"] })], views), plain as QueryRunner)).rejects.toThrow("isolation_unavailable");
    let isolated = 0;
    const spy = new SqliteRunner(dbPath);
    const orig = spy.isolate.bind(spy);
    spy.isolate = (v) => { isolated++; orig(v); };
    await run(spec("1.3", [vuOf("V1", { from: { pragma: "table_info", arg: "orders" }, select: ["name"], where: and({ col: "name", op: "=", value: "nope" }) })]), spy);
    expect(isolated).toBe(0);
    expect(usesIsolation(spec("1.2", [vuOf("V1", { from: "orders", select: ["id"] })]))).toBe(false);
  });

  it("temp storage is memory and views are temp; isolate runs once", () => {
    const runner = new SqliteRunner(dbPath);
    try {
      runner.isolate(renderViews(views));
      expect(runner.query("SELECT name, type FROM sqlite_temp_master")).toEqual([{ name: "big_orders", type: "view" }]);
      expect(runner.query("SELECT count(*) AS n FROM big_orders")).toEqual([{ n: 2 }]);
      expect(() => runner.isolate([])).toThrow("already isolated");
      expect(runner.untouched()).toBeNull();
    } finally { runner.close(); }
  });

  it("red team: ATTACH / DETACH / file: in supplied SQL is refused in a 1.3 spec, not inside literals or comments", async () => {
    expect(isolationRefusal("SELECT 1 FROM t; ATTACH 'x' AS y")).toContain("ATTACH");
    expect(isolationRefusal("SELECT * FROM t WHERE p = 'file:snap.sqlite' -- detach")).toBeNull();
    expect(isolationRefusal("SELECT 'attach' FROM t /* ATTACH */")).toBeNull();
    expect(isolationRefusal("SELECT * FROM file:x")).toContain("FILE:");
    const raw = { id: "V1", role: "assert", severity: "S1", source_clause: "c", checker: { type: "sql", expect: "empty", fail_when: "rows>0", sql: "SELECT id FROM orders WHERE id < 0", scope_sql: "SELECT count(*) AS n FROM orders -- \nWHERE 1 AND 'x' <> 'DETACH'" } };
    expect((await run(spec("1.3", [raw]))).overall).not.toBe("ERROR");
    const bad = { ...raw, checker: { ...raw.checker, sql: "SELECT id FROM orders WHERE id IN (SELECT 1) AND detach" } };
    await expect(run(spec("1.3", [bad]))).rejects.toThrow("snapshot_reference");
  });

  it("namesReadBy covers every source a spec reads", () => {
    const s = spec("1.3", [
      vuOf("V1", { from: { derived: { from: "orders", select: ["id"] } }, select: ["id"] }),
      { id: "V2", role: "assert", severity: "S1", source_clause: "c", checker: { type: "sql", expect: "empty", fail_when: "rows>0", sql: "SELECT a FROM items JOIN orders ON 1" } },
    ], [{ name: "v", predicate: { from: "big", select: ["id"] } }]);
    expect(namesReadBy(s).sort()).toEqual(["big", "items", "orders"]);
  });
});

describe("prepare: view registration and the snapshot-path red team", () => {
  const schema: SchemaProbe = { tables: { orders: ["id", "sku", "amount", "batch"], items: ["id", "order_id", "qty"] }, views: ["stored_view"] };
  const big = { from: "orders", select: ["id", "amount"], where: { op: "and", conditions: [{ col: "amount", op: ">", value: 10 }] } };

  it("registers views with their output columns; candidates may read them", () => {
    const r = prepareViews([{ name: "big_orders", predicate: big }], schema);
    expect(r.error).toBeUndefined();
    expect(r.schema?.specViews).toEqual({ big_orders: ["id", "amount"] });
    const cand = (predicate: unknown) => ({ source_clause: "S1 x", anchor: { quote: "S1 x", locator: "m#S1" }, checker: { type: "sql", expect: "empty", fail_when: "rows>0", predicate } });
    const lint = (predicate: unknown, views?: unknown) => lintCandidates([cand(predicate)] as never, { schema, views: views as never }).issues.map((i) => i.reason);
    expect(lint({ from: "big_orders", select: ["id"] }, [{ name: "big_orders", predicate: big }])).toEqual([]);
    expect(lint({ from: "big_orders", select: ["sku"] }, [{ name: "big_orders", predicate: big }])[0]).toContain('column "sku" is not in big_orders');
    expect(lint({ from: "big_orders", select: ["id"] })[0]).toContain("is not in the probed schema");
    expect(lint({ from: "stored_view", select: ["id"] })[0]).toContain("is a view stored in the snapshot");
    expect(lint({ from: { derived: big }, select: ["amount"], where: { op: "and", conditions: [{ col: "amount", op: "<", value: 99 }] } })).toEqual([]);
    expect(lint({ from: { derived: big }, select: ["sku"] })[0]).toContain('column "sku" is not in derived');
    expect(lint({ from: { derived: { from: "nope", select: ["id"] } }, select: ["id"] })[0]).toContain('from.derived.from "nope" is not in the probed schema');
  });

  it("refuses a view that shadows a snapshot object, reads an unknown table or a later view", () => {
    expect(prepareViews([{ name: "orders", predicate: { from: "items", select: ["id"] } }], schema).error).toContain("is already an object in the snapshot");
    expect(prepareViews([{ name: "stored_view", predicate: big }], schema).error).toContain("is already an object in the snapshot");
    expect(prepareViews([{ name: "v", predicate: { from: "nope", select: ["id"] } }], schema).error).toContain("is not in the probed schema");
    expect(prepareViews([{ name: "a", predicate: { from: "b", select: ["id"] } }, { name: "b", predicate: big }], schema).error).toContain("not declared before it");
    expect(prepareViews([{ name: "a", predicate: big }, { name: "b", predicate: { from: "a", select: ["amount"] } }], schema).error).toBeUndefined();
    expect(prepareViews(undefined, schema)).toEqual({ schema });
  });

  it("refuses any string naming the snapshot path, anywhere in a candidate or view", () => {
    const p = "/data/snaps/snap-2026.sqlite";
    expect(snapshotPathRefusal({ where: { conditions: [{ value: `file:${p}?mode=ro` }] } }, [p])).toContain("snapshot_reference");
    expect(snapshotPathRefusal({ where: { conditions: [{ value: "snap-2026" }] } }, [p])).toBeNull();
    expect(snapshotPathRefusal({ any: p }, [])).toBeNull();
    expect(prepareViews([{ name: "v", predicate: { ...big, where: { op: "and", conditions: [{ col: "sku", op: "=", value: p }] } } }], schema, [p]).error).toContain("snapshot_reference");
  });
});
