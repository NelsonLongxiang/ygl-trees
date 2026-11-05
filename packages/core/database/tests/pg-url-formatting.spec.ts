import { describe, expect, it } from "vitest";
import { redactPgUrl } from "../src/asyncdb";

describe("PostgreSQL target formatting", () => {
  const secret = "fixture-private-value";
  const queryKeys = ["password", "PaSsWoRd", "user", "sslpassword", "sslkey", "sslcert", "passfile"];
  const encodeKey = (key: string) => [...key].map(c => "%" + c.charCodeAt(0).toString(16)).join("");

  it("formats user information and credential parameters through one helper", () => {
    for (const protocol of ["postgres", "postgresql"]) {
      for (const key of queryKeys.flatMap(k => [k, encodeKey(k)])) {
        const target = protocol + "://fixture-user:" + secret + "@127.0.0.1:5432/work?" + key + "=" + secret + "&application_name=reader";
        const text = redactPgUrl(target);
        expect(text).not.toContain(secret);
        expect(text).not.toContain("fixture-user");
        const parsed = new URL(text);
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect([...parsed.searchParams.entries()].filter(([k]) => k !== "application_name").every(([, v]) => v === "***")).toBe(true);
        expect(parsed.searchParams.get("application_name")).toBe("reader");
      }
    }
  });

  it("keeps connection coordinates and ordinary parameters readable", () => {
    const target = "postgresql://127.0.0.1:5432/work?application_name=worker&sslmode=require&connect_timeout=2";
    expect(redactPgUrl(target)).toBe(target);
    expect(redactPgUrl(redactPgUrl(target))).toBe(target);
    const duplicate = redactPgUrl("postgres://127.0.0.1:5432/work?password=" + secret + "&PASSWORD=" + secret + "&n=2");
    expect(duplicate).not.toContain(secret);
    expect(new URL(duplicate).searchParams.getAll("password")).toEqual(["***"]);
    expect(new URL(duplicate).searchParams.getAll("PASSWORD")).toEqual(["***"]);
    expect(new URL(duplicate).searchParams.get("n")).toBe("2");
  });

  it("uses a safe placeholder when a target cannot be parsed", () => {
    for (const target of ["", "not-a-url:" + secret, "postgres://u:" + secret + "@[invalid/work", "postgres://127.0.0.1:999999/work?password=" + secret]) {
      const text = redactPgUrl(target);
      expect(text).toBe("(invalid PG URL)");
      expect(text).not.toContain(secret);
    }
  });

  it("omits fragments from displayed connection targets", () => {
    const target = "postgres://127.0.0.1:5432/work?application_name=reader#" + secret;
    expect(redactPgUrl(target)).toBe("postgres://127.0.0.1:5432/work?application_name=reader");
  });
});
