/**
 * Contract 1.3 (owner 2026-11-11, #80/#232): glob / not-glob in the predicate op closed set.
 *
 * The vectors in fixtures/predicate-glob.json are shared with rust/yglverify/tests/predicate_glob.rs: both engines
 * must render the same findSql, match the same rows on real SQLite, and refuse the same conditions. The version gate
 * keeps glob out of 1.1/1.2 specs, and a 1.2 spec without it runs exactly as before.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import { BASELINE_CONTRACT_VERSION, CONTRACT_VERSION, KNOWN_CONTRACT_VERSIONS, type VerifySpec } from "../src/contract";
import { renderPredicate, runVerify, uses13Shapes } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/predicate-glob.json"), "utf8"));
const pred = (cond: unknown) => ({ from: "entries", select: ["path"], where: { op: "and" as const, conditions: [cond as any] } });

describe("glob / not-glob vectors (shared with Rust)", () => {
  for (const c of fixture.cases) {
    it(`${c.op} ${JSON.stringify(c.pattern)} on ${JSON.stringify(c.value)} → ${c.match ? "match" : "no match"} (${c.name})`, () => {
      const { findSql } = renderPredicate(pred({ col: "path", op: c.op, value: c.pattern }));
      expect(findSql).toBe(c.findSql);
      const db = new DatabaseSync(":memory:");
      db.exec(fixture.table);
      db.prepare("INSERT INTO entries(path) VALUES (?)").run(c.value);
      expect(db.prepare(findSql).all().length === 1).toBe(c.match);
      db.close();
    });
  }
  for (const r of fixture.rejects) {
    it(`refuses: ${r.name}`, () => {
      expect(() => renderPredicate(pred(r.condition))).toThrow(r.error);
    });
  }
  it("covers the #232 path-grammar set", () => {
    const names = fixture.cases.map((c: { name: string }) => c.name).join("\n");
    for (const want of ["absolute path", "parent segment", "backslash", "control character", "empty segment", "single package prefix"]) expect(names).toContain(want);
  });
});

describe("contract 1.3 version gate", () => {
  const home = mkdtempSync(join(tmpdir(), "ygl-glob13-"));
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dbPath = join(home, "snap.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE entries(path TEXT); INSERT INTO entries(path) VALUES ('package/a.js'), ('package/lib/b.js')");
  db.close();

  const spec = (contract: string, op: string, value: string): VerifySpec => ({
    contract_version: contract, spec_id: "spec_glob13", spec_version: 1, title: "glob", domain: "test",
    created: "2026-11-11T00:00:00.000Z", runtime_min: "1",
    verifier: { engine_version: "test", corpus_version: "1.2" },
    as_of: { kind: "snapshot", value: "2026-11-11T00:00:00.000Z" },
    vu: [{ id: "V1", role: "assert", severity: "S1", source_clause: "every entry lives under package/",
      checker: { type: "sql", predicate: pred({ col: "path", op, value }), fail_when: "rows>0" } } as any],
    attachments: [], sealed: { review: false },
  } as any);
  const run = async (s: VerifySpec) => {
    const runner = new SqliteRunner(dbPath);
    try { return await runVerify(s, { runner, mode: "open", nowIso: () => "2026-11-11T00:00:00.000Z", runId: "run_glob13" }); }
    finally { runner.close(); }
  };

  it("the engine runs 1.1, 1.2 and 1.3; prepare's baseline stamp stays 1.2", () => {
    expect(CONTRACT_VERSION).toBe("1.3");
    expect(BASELINE_CONTRACT_VERSION).toBe("1.2");
    expect([...KNOWN_CONTRACT_VERSIONS]).toEqual(["1.1", "1.2", "1.3"]);
  });

  it("a 1.3 spec with not-glob runs: no entry outside package/ → PASS, with the rendered SQL in the witness", async () => {
    const report = await run(spec("1.3", "not-glob", "package/*"));
    expect(report.contract_version).toBe("1.3");
    expect(report.overall).toBe("PASS");
    expect(JSON.stringify(report.vu[0])).toContain("NOT GLOB 'package/*'");
  });

  it("a 1.2 or 1.1 spec that uses glob is refused by name (version_shape)", async () => {
    for (const v of ["1.2", "1.1"]) {
      await expect(run(spec(v, "glob", "package/*"))).rejects.toThrow(`version_shape: this spec declares contract_version ${v} but uses 1.3-only shapes`);
    }
  });

  it("a 1.2 spec without glob runs as before; an unknown version is refused", async () => {
    const r = await run(spec("1.2", "!=", "x"));
    expect(r.contract_version).toBe("1.2");
    await expect(run(spec("1.4", "=", "x"))).rejects.toThrow("unsupported contract_version 1.4");
  });

  it("uses13Shapes sees glob in where, scan and both sql-pair sides", () => {
    const g = { col: "p", op: "glob", value: "a*" };
    const mk = (checker: unknown) => ({ vu: [{ checker }] }) as unknown as VerifySpec;
    expect(uses13Shapes(mk({ type: "sql", predicate: { from: "t", select: ["p"], scan: { op: "and", conditions: [g] } } }))).toBe(true);
    expect(uses13Shapes(mk({ type: "sql-pair", left: { predicate: { from: "t", select: ["p"] } }, right: { predicate: pred(g) } }))).toBe(true);
    expect(uses13Shapes(mk({ type: "count", predicate: { from: "t", select: [], where: { op: "not", conditions: [{ op: "or", conditions: [g] }] } } }))).toBe(true);
    expect(uses13Shapes(mk({ type: "sql", predicate: pred({ col: "p", op: "=", value: "glob" }) }))).toBe(false);
  });
});
