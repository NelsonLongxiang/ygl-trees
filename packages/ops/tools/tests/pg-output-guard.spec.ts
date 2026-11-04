import { describe, expect, it } from "vitest";
import { assertNoPgPassword } from "./fixtures/pg-output-guard";

describe("PG output password guard", () => {
  it("accepts passwordless trust URLs without testing an empty substring", () => {
    expect(() => assertNoPgPassword('{"ok":true}', "postgres://127.0.0.1/test")).not.toThrow();
  });
  it("still rejects a nonempty password and never includes it or the output in the error", () => {
    const fake = "fixture-only-secret";
    let message = "";
    try { assertNoPgPassword("unsafe=" + fake, "postgres://tester:" + fake + "@127.0.0.1/test"); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe("PG output contains a configured password (redacted)");
    expect(message.includes(fake)).toBe(false);
    expect(() => assertNoPgPassword('{"ok":true}', "postgres://tester:" + fake + "@127.0.0.1/test")).not.toThrow();
  });
  it("checks encoded and decoded password forms", () => {
    const url = "postgres://tester:fixture%3Asecret@127.0.0.1/test";
    for (const value of ["fixture%3Asecret", "fixture:secret"]) {
      expect(() => assertNoPgPassword(value, url)).toThrow("configured password (redacted)");
    }
  });
  it("still checks literal passwords with malformed percent escapes", () => {
    expect(() => assertNoPgPassword("fixture%ZZ", "postgres://tester:fixture%ZZ@127.0.0.1/test")).toThrow("configured password (redacted)");
  });
});
