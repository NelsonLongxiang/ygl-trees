/**
 * Contract 1.3 part 2a (#80, owner 2026-11-11): read-only pragma table functions as a predicate source.
 *
 * fixtures/predicate-pragma.json is shared with rust/yglverify/tests/predicate_pragma.rs: both engines must render
 * the same findSql / scopeSql, return the same rows on the fixture schema, and refuse the same sources. The runVerify
 * cases check the witness: a pragma source counts its own rows, so a structural check is never a zero-scan.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import { PRAGMA_SOURCES, QUOTED_IDENTS, type VerifySpec } from "../src/contract";
import { extractTables, parsePragmaSource, renderPredicate, runVerify, uses13Shapes } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/predicate-pragma.json"), "utf8"));

describe("pragma source vectors (shared with Rust)", () => {
  const db = new DatabaseSync(":memory:");
  for (const d of fixture.ddl) db.exec(d);
  for (const c of fixture.cases) {
    it(`${c.name}: ${c.rows} row(s)`, () => {
      const r = renderPredicate(c.predicate);
      expect(r.findSql).toBe(c.findSql);
      expect(r.scopeSql).toBe(c.scopeSql);
      expect(db.prepare(r.findSql).all().length).toBe(c.rows);
      expect(Number((db.prepare(r.scopeSql).get() as { n: number }).n)).toBe(c.scanned);
    });
  }
  for (const r of fixture.rejects) {
    it(`refuses: ${r.name}`, () => {
      expect(() => renderPredicate({ from: r.from, select: ["name"] } as never)).toThrow(r.error);
    });
  }
  it("covers every whitelisted pragma and every quoted identifier", () => {
    const used = new Set(fixture.cases.map((c: { predicate: { from: unknown } }) => (typeof c.predicate.from === "object" ? (c.predicate.from as { pragma: string }).pragma : "")));
    for (const p of Object.keys(PRAGMA_SOURCES)) if (p !== "index_xinfo") expect(used.has(p), p).toBe(true);
    const sql = fixture.cases.map((c: { findSql: string }) => c.findSql).join(" ");
    for (const q of QUOTED_IDENTS) expect(sql).toContain(`"${q}"`);
  });
});

describe("pragma sources in the witness and the version gate", () => {
  const home = mkdtempSync(join(tmpdir(), "ygl-pragma13-"));
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dbPath = join(home, "snap.sqlite");
  const db = new DatabaseSync(dbPath);
  for (const d of fixture.ddl) db.exec(d);
  db.close();

  const spec = (contract: string, from: unknown, where: unknown): VerifySpec => ({
    contract_version: contract, spec_id: "spec_pragma13", spec_version: 1, title: "pragma", domain: "test",
    created: "2026-11-11T00:00:00.000Z", runtime_min: "1",
    verifier: { engine_version: "test", corpus_version: "1.2" },
    as_of: { kind: "snapshot", value: "2026-11-11T00:00:00.000Z" },
    vu: [{ id: "V1", role: "assert", severity: "S1", source_clause: "orders.amount must be NOT NULL",
      checker: { type: "sql", expect: "nonempty", fail_when: "rows==0", predicate: { from, select: ["name"], where } } } as never],
    attachments: [], sealed: { review: false },
  } as never);
  const run = async (s: VerifySpec) => {
    const runner = new SqliteRunner(dbPath);
    try { return await runVerify(s, { runner, mode: "open", nowIso: () => "2026-11-11T00:00:00.000Z", runId: "run_pragma13" }); }
    finally { runner.close(); }
  };
  const notNullAmount = { op: "and", conditions: [{ col: "name", op: "=", value: "amount" }, { col: "notnull", op: "=", value: 1 }] };

  it("a 1.3 structural check passes with a real scan: rows_scanned counts the pragma's rows", async () => {
    const report = await run(spec("1.3", { pragma: "table_info", arg: "orders" }, notNullAmount));
    expect(report.overall).toBe("PASS");
    const w = (report.vu[0] as { witness: { rows_scanned: number; sources: Array<{ table: string; rows: number }> } }).witness;
    expect(w.rows_scanned).toBe(3);
    expect(w.sources).toEqual([{ table: "pragma_table_info('orders')", rows: 3 }]);
  });

  it("the same check on a nullable column FAILs (it is a real check, not a vacuous one)", async () => {
    const where = { op: "and", conditions: [{ col: "name", op: "=", value: "sku" }, { col: "notnull", op: "=", value: 1 }] };
    expect((await run(spec("1.3", { pragma: "table_info", arg: "orders" }, where))).overall).toBe("FAIL");
  });

  it("a pragma source in a 1.2 spec is refused by name (version_shape)", async () => {
    await expect(run(spec("1.2", { pragma: "table_info", arg: "orders" }, notNullAmount))).rejects.toThrow("version_shape");
    expect(uses13Shapes(spec("1.3", { pragma: "user_version" }, undefined))).toBe(true);
    expect(uses13Shapes(spec("1.3", "orders", undefined))).toBe(false);
  });

  it("source extraction and the runner's row count accept only the closed pragma form", () => {
    expect(extractTables("SELECT name FROM pragma_table_info('orders') WHERE x")).toEqual(["pragma_table_info('orders')"]);
    expect(parsePragmaSource("pragma_user_version")).toBe("pragma_user_version");
    expect(parsePragmaSource("pragma_writable_schema")).toBeNull();
    expect(parsePragmaSource("pragma_table_info('orders'); DROP TABLE orders")).toBeNull();
    const runner = new SqliteRunner(dbPath);
    try {
      expect(runner.tableRows("pragma_index_list('orders')")).toBe(1);
      expect(() => runner.tableRows("pragma_foreign_keys")).toThrow("invalid table name");
    } finally { runner.close(); }
  });
});
