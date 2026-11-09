import { describe, expect, it } from "vitest";

/** #250: the suite-level offline pin — without YGL_TEST_LIVE_EVAL=1 the whole
 * unit run must see YGL_EVAL_OFFLINE=1 (set by tests/support/tmpdir-guard.ts).
 * Mutation-checked: removing the setup line turns this red. */
describe("evaluator offline pin (#250)", () => {
  it("without the live opt-in, the suite runs with YGL_EVAL_OFFLINE=1", () => {
    if (process.env.YGL_TEST_LIVE_EVAL === "1") {
      // the opt-in host keeps this spec honest by not asserting the pin
      expect(process.env.YGL_TEST_LIVE_EVAL).toBe("1");
      return;
    }
    expect(process.env.YGL_EVAL_OFFLINE).toBe("1");
  });
});
