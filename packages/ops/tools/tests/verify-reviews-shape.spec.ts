/** #reviews shape validation (release-seat report direct-bcbd5146):
 *  a review entry missing `findings` used to reach `hit.findings.map` and crash
 *  with TypeError inside prepare. CLI now rejects with rc=2 + schema hint; the
 *  runner keeps a defensive fallback for library callers. */
import { describe, expect, it } from "vitest";
import { fileReviewer, reviewsShapeProblem } from "../src/verify-cmds";

describe("verify prepare --reviews shape", () => {
  it("accepts a well-formed reviews array", () => {
    expect(reviewsShapeProblem([
      { source_clause: "S1", findings: [{ question: "faithful", verdict: "ok", reason: "逐字" }] },
    ])).toBeNull();
  });

  it("rejects missing findings with a schema hint (rc=2 surface)", () => {
    const p = reviewsShapeProblem([{ source_clause: "S1", verdict: "ok" }]);
    expect(p).toMatch(/findings must be an array/);
    expect(p).toMatch(/faithful\|decidable\|not-vacuous/);
  });

  it("rejects missing source_clause and unknown question/verdict", () => {
    expect(reviewsShapeProblem([{ findings: [] }])).toMatch(/source_clause/);
    expect(reviewsShapeProblem([{ source_clause: "S1", findings: [{ question: "x", verdict: "ok", reason: "r" }] }])).toMatch(/question/);
    expect(reviewsShapeProblem([{ source_clause: "S1", findings: [{ question: "faithful", verdict: "maybe", reason: "r" }] }])).toMatch(/verdict/);
  });

  it("fileReviewer never crashes on a malformed entry (defensive fallback)", async () => {
    const runner = fileReviewer([{ source_clause: "S1" } as any]);
    const out = await runner.review({ vu: { source_clause: "S1", id: "V1" } } as any);
    expect(out).toEqual([]);
  });
});
