/**
 * #176 W5b offline: the PG upgrade track and the open-time version guard, against a scripted client.
 * Real-PG replay (baseline v12 database → db upgrade → same structure as a fresh migration) lives in
 * b8-pg-upgrade.spec.ts and runs in G7.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SCHEMA_VERSION } from "../../../core/database/src/db";
import { requirePgSchemaVersion, PgCapabilityError } from "../../../core/database/src/pg-workspace";
import { PG_BASELINE_VERSION, PG_UPGRADES, PgUpgradeError, migrateIndexNames, upgradePgSchema, type PgUpgradeStep } from "../src/pgsync";

/** Scripted pg client: answers the handful of queries the upgrade track issues and records every statement. */
function fakeClient(opts: { ledger?: boolean; version?: number | null; indexes?: string[] }) {
  const log: string[] = [];
  const indexes = new Set(opts.indexes ?? migrateIndexNames());
  let version = opts.version ?? null;
  return {
    log,
    async query(sql: string, params: any[] = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
      if (/information_schema\.tables/.test(sql)) return { rows: opts.ledger === false ? [] : [{ hit: 1 }] };
      if (/MAX\(version\)/.test(sql)) return { rows: [{ version }] };
      if (/FROM pg_indexes/.test(sql)) return { rows: [...indexes].map((indexname) => ({ indexname })) };
      if (/^\s*INSERT INTO schema_migrations/.test(sql)) { version = Math.max(version ?? 0, Number(params[0])); return { rows: [] }; }
      if (/CREATE INDEX IF NOT EXISTS/.test(sql)) { for (const n of migrateIndexNames()) indexes.add(n); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

describe("#176 W5b PG upgrade track", () => {
  it("every SCHEMA_VERSION above the PG baseline has exactly one PG upgrade step", () => {
    expect(PG_BASELINE_VERSION).toBeLessThanOrEqual(SCHEMA_VERSION);
    const versions = PG_UPGRADES.map((s) => s.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let v = PG_BASELINE_VERSION + 1; v <= SCHEMA_VERSION; v++) expect(versions, `missing PG step for v${v}`).toContain(v);
    expect(versions.every((v) => v > PG_BASELINE_VERSION && v <= SCHEMA_VERSION)).toBe(true);
  });

  it("v14 to v15 applies only the two additive grant columns and records version 15", async () => {
    const c = fakeClient({ version: 14 });
    const r = await upgradePgSchema(c, 15);
    expect(r.steps).toEqual([15]);
    const step = PG_UPGRADES.find(s => s.version === 15)!;
    expect(step.sql).toContain("ALTER TABLE kb_notes ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT ''");
    expect(step.sql).toContain("ALTER TABLE skills ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT ''");
    expect(c.log.at(-1)).toBe("COMMIT");
  });

  it("MIGRATE_INDEXES names are unique and include the W5a events index", () => {
    const names = migrateIndexNames();
    expect(names.length).toBeGreaterThan(15);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("idx_events_kind_entity");
  });

  it("converges a missing index on a current-version database, under the lock, in one transaction", async () => {
    const c = fakeClient({ version: SCHEMA_VERSION, indexes: migrateIndexNames().filter((n) => n !== "idx_events_kind_entity") });
    const r = await upgradePgSchema(c, SCHEMA_VERSION);
    expect(r).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, steps: [], indexes_created: ["idx_events_kind_entity"], duplicate: false });
    expect(c.log[0]).toBe("BEGIN");
    expect(c.log[1]).toMatch(/pg_advisory_xact_lock/);
    expect(c.log.at(-1)).toBe("COMMIT");
  });

  it("is idempotent: a second run changes nothing and reports duplicate", async () => {
    const r = await upgradePgSchema(fakeClient({ version: SCHEMA_VERSION }), SCHEMA_VERSION);
    expect(r).toMatchObject({ steps: [], indexes_created: [], duplicate: true });
  });

  it("applies version steps in order and records each one in the ledger", async () => {
    const steps: PgUpgradeStep[] = [
      { version: PG_BASELINE_VERSION + 2, note: "second", sql: "ALTER TABLE b ADD COLUMN y text" },
      { version: PG_BASELINE_VERSION + 1, note: "first", sql: "ALTER TABLE a ADD COLUMN x text" },
    ];
    const c = fakeClient({ version: PG_BASELINE_VERSION });
    const r = await upgradePgSchema(c, PG_BASELINE_VERSION + 2, steps);
    expect(r.steps).toEqual([PG_BASELINE_VERSION + 1, PG_BASELINE_VERSION + 2]);
    const order = c.log.filter((l) => /^ALTER TABLE|^INSERT INTO schema_migrations/.test(l)).map((l) => l.startsWith("INSERT") ? "ledger" : l);
    expect(order).toEqual(["ALTER TABLE a ADD", "ledger", "ALTER TABLE b ADD", "ledger"]);
  });

  const refusals: Array<[string, Parameters<typeof fakeClient>[0], number, PgUpgradeStep[], RegExp]> = [
    ["no ledger", { ledger: false }, SCHEMA_VERSION, PG_UPGRADES, /no ygl-trees schema_migrations ledger/],
    ["newer than the engine", { version: SCHEMA_VERSION + 1 }, SCHEMA_VERSION, PG_UPGRADES, /newer than this engine/],
    ["older than the baseline", { version: PG_BASELINE_VERSION - 1 }, SCHEMA_VERSION, PG_UPGRADES, /predates the PG upgrade baseline/],
    ["gap in the steps", { version: PG_BASELINE_VERSION }, PG_BASELINE_VERSION + 2, [{ version: PG_BASELINE_VERSION + 2, note: "x", sql: "SELECT 1" }], /no PG upgrade step for v13/],
  ];
  it.each(refusals)("refuses (%s), rolls back and never commits", async (_k, state, target, steps, msg) => {
    const c = fakeClient(state);
    await expect(upgradePgSchema(c, target, steps)).rejects.toThrow(PgUpgradeError);
    await expect(upgradePgSchema(fakeClient(state), target, steps)).rejects.toThrow(msg);
    expect(c.log).toContain("ROLLBACK");
    expect(c.log).not.toContain("COMMIT");
    expect(c.log.some((l) => /^ALTER|^CREATE/.test(l))).toBe(false);
  });
});

describe("#176 W5b open-time version guard", () => {
  const ds = (ledger: boolean, version: number | null) => ({
    async query(sql: string) {
      if (/information_schema\.tables/.test(sql)) return ledger ? [{ hit: 1 }] : [];
      return [{ version }];
    },
  });
  it("passes at exactly SCHEMA_VERSION", async () => {
    await expect(requirePgSchemaVersion(ds(true, SCHEMA_VERSION), SCHEMA_VERSION)).resolves.toBeUndefined();
  });
  it.each([
    ["older", ds(true, SCHEMA_VERSION - 1), /expects v\d+.*Run: ygl-trees db upgrade/],
    ["newer", ds(true, SCHEMA_VERSION + 1), /newer than this engine.*Upgrade ygl-trees/],
    ["no ledger", ds(false, null), /no ygl-trees schema_migrations ledger/],
  ])("refuses a %s schema with an actionable, credential-free message", async (_k, db, msg) => {
    const p = requirePgSchemaVersion(db, SCHEMA_VERSION);
    await expect(p).rejects.toThrow(PgCapabilityError);
    await expect(requirePgSchemaVersion(db, SCHEMA_VERSION)).rejects.toThrow(msg);
  });
});

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
describe.skipIf(!existsSync(BIN))("#176 W5b db upgrade CLI surface (no PG)", () => {
  it("is a usage error on a SQLite workspace, in both human and JSON modes", () => {
    const home = mkdtempSync(join(tmpdir(), "pg-upgrade-cli-"));
    try {
      const env = { ...process.env, YGL_HOME: home, YGL_NO_UPDATE_CHECK: "1", YGL_DB_URL: "" };
      expect(spawnSync(process.execPath, [BIN, "db", "init", "--json"], { env, encoding: "utf8" }).status).toBe(0);
      const human = spawnSync(process.execPath, [BIN, "db", "upgrade"], { env, encoding: "utf8" });
      expect(human.status).toBe(2);
      expect(human.stderr + human.stdout).toMatch(/PG upgrade track/);
      const json = spawnSync(process.execPath, [BIN, "db", "upgrade", "--json"], { env, encoding: "utf8" });
      expect(json.status).toBe(2);
      expect(JSON.parse(json.stdout).error).toMatch(/YGL_DB_URL/);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
