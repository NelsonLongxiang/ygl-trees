/** #239: table() with an empty keys array rendered every data row as a blank line. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { table, type Ctx } from "../src/fmt";

const human: Ctx = { json: false, color: false, quiet: false };
const captured = () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s?: unknown) => { lines.push(String(s ?? "")); });
  return lines;
};
afterEach(() => vi.restoreAllMocks());

describe("table() keys (#239)", () => {
  it("prints each row's values under the given keys, even when a header differs from its key", () => {
    const lines = captured();
    table(human, [{ id: "c1", name: "alpha", enabled: 1 }, { id: "c2", name: "beta", enabled: 0 }], ["id", "name", "on"], ["id", "name", "enabled"]);
    expect(lines).toHaveLength(4); // header, dashes, two rows
    expect(lines[2]).toMatch(/c1\s+alpha\s+1/);
    expect(lines[3]).toMatch(/c2\s+beta\s+0/);
  });

  it("refuses an empty keys array instead of printing blank rows", () => {
    captured();
    expect(() => table(human, [{ id: "c1" }], ["id"], [])).toThrow(/keys is empty/);
  });

  it("omitted keys still fall back to the row's own keys", () => {
    const lines = captured();
    table(human, [{ id: "c1", _hidden: "x", name: "alpha" }]);
    expect(lines[0]).toMatch(/id\s+name/);
    expect(lines[2]).toMatch(/c1\s+alpha/);
    expect(lines.join("\n")).not.toContain("_hidden");
  });

  it("--json output is unchanged by keys", () => {
    const lines = captured();
    const rows = [{ id: "c1", enabled: 1 }];
    table({ ...human, json: true }, rows, ["id", "on"], ["id", "enabled"]);
    expect(lines.join("\n")).toBe(JSON.stringify(rows, null, 2));
  });
});
