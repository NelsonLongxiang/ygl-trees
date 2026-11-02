import { describe, it, expect } from "vitest";
import { evidenceAdd, evidenceAddBatch, QuoteMismatchError } from "../src/writes";
import { PgCapabilityError } from "../../../core/database/src/pg-workspace";

const manager = () => ({
  connection: { options: { type: "sqlite" } },
  findOne: async (entity: any) => entity.name === "Source" ? { content: "stored original" } : null,
});
const source = () => ({ transaction: async (fn: any) => fn(manager()) }) as any;

describe("quote mismatch error ownership", () => {
  it("uses a domain error rather than a PG capability error for SQLite", async () => {
    const error = await evidenceAdd(source(), "p", "s", "absent quote").catch(e => e);
    expect(error).toBeInstanceOf(QuoteMismatchError);
    expect(error).not.toBeInstanceOf(PgCapabilityError);
    expect(error.message).toContain("s");
  });
  it("preserves the domain error while adding a physical batch line", async () => {
    const error = await evidenceAddBatch(source(), "p", [{ source_id: "s", quote: "absent quote", __line: 7 }]).catch(e => e);
    expect(error).toBeInstanceOf(QuoteMismatchError);
    expect(error).not.toBeInstanceOf(PgCapabilityError);
    expect(error.message).toContain("line 7:");
  });
});
