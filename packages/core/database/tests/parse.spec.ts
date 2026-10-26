import { describe, it, expect } from "vitest";
import { parse, num } from "../src/types";

describe("parse() flag/value boundaries", () => {
  it("consumes a dash-prefixed value after a value-taking flag", () => {
    const a = parse(["evidence", "add", "sid", "--quote", "- 双平台（Twitter + Reddit）并行模拟"]);
    expect(a.flags.quote).toBe("- 双平台（Twitter + Reddit）并行模拟");
    expect(a._).toEqual(["evidence", "add", "sid"]);
  });

  it("still treats a following long flag as a boundary (missing value stays true)", () => {
    const a = parse(["x", "--note", "--json"]);
    expect(a.flags.note).toBe(true);
    expect(a.flags.json).toBe(true);
  });

  it("still treats a following single-letter flag as a boundary", () => {
    const a = parse(["x", "--note", "-q"]);
    expect(a.flags.note).toBe(true);
    expect(a.flags.q).toBe(true);
  });

  it("still treats `--` as a boundary, not a value", () => {
    const a = parse(["x", "--note", "--", "-y"]);
    expect(a.flags.note).toBe(true);
    expect(a._).toEqual(["x", "-y"]);
  });

  it("#83-①: repeated --db collects into an array (tree run per-leaf binding)", () => {
    const a = parse(["verify", "tree", "run", "ts_x", "--db", "a.db", "--db", "b=n2.db"]);
    expect(a.flags.db).toEqual(["a.db", "b=n2.db"]);
    const single = parse(["verify", "run", "s", "--db", "only.db"]);
    expect(single.flags.db).toEqual(["only.db"]); // 单值也是数组形——消费方 lastDbFlag 取末位
  });

  it("accepts negative numbers as values", () => {
    const a = parse(["x", "--cost", "-1"]);
    expect(a.flags.cost).toBe("-1");
    expect(num(a, "cost", 5)).toBe(-1);
  });

  it("inline --flag=value keeps dash text", () => {
    const a = parse(["x", "--quote=- text"]);
    expect(a.flags.quote).toBe("- text");
  });

  it("multi-letter dash text is a value, not a bundled short flag", () => {
    const a = parse(["x", "--title", "-abc"]);
    expect(a.flags.title).toBe("-abc");
    expect(a._).toEqual(["x"]);
  });
});
