import { describe, it, expect, vi } from "vitest";
import { evidenceAdd, evidenceAddBatch, QuoteMismatchError } from "../src/writes";
import { PgCapabilityError } from "../../../core/database/src/pg-workspace";

const manager = () => ({
  connection: { options: { type: "sqlite" } },
  query: vi.fn(async (sql: string) => {
    expect(sql).toBe("UPDATE meta SET value=value WHERE 0");
    return [];
  }),
  findOne: async (entity: any) => entity.name === "Source" ? { content: "stored original" } : null,
});
const source = () => {
  const mgr = manager();
  return { manager: mgr, transaction: async (fn: any) => fn(mgr) } as any;
};

describe("quote mismatch error ownership", () => {
  it("uses a domain error rather than a PG capability error for SQLite", async () => {
    const db = source();
    const error = await evidenceAdd(db, "p", "s", "absent quote").catch(e => e);
    expect(db.manager.query.mock.calls).toEqual([["UPDATE meta SET value=value WHERE 0"]]);
    expect(error).toBeInstanceOf(QuoteMismatchError);
    expect(error).not.toBeInstanceOf(PgCapabilityError);
    expect(error.message).toContain("s");
  });
  it("preserves the domain error while adding a physical batch line", async () => {
    const db = source();
    const error = await evidenceAddBatch(db, "p", [{ source_id: "s", quote: "absent quote", __line: 7 }]).catch(e => e);
    expect(db.manager.query.mock.calls).toEqual([["UPDATE meta SET value=value WHERE 0"]]);
    expect(error).toBeInstanceOf(QuoteMismatchError);
    expect(error).not.toBeInstanceOf(PgCapabilityError);
    expect(error.message).toContain("line 7:");
  });
});
