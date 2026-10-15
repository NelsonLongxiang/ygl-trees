import { describe, it, expect } from "vitest";

describe("@ygl package", () => {
  it("exists and exports", async () => {
    const mod = await import("../src/index");
    expect(mod).toBeTruthy();
  });
});
