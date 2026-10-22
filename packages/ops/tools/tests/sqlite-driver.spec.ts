/**
 * GitHub #54: the npm upgrade path used to split better-sqlite3 between our
 * dependency (^13) and typeorm's optional peer (^12), leaving the ORM without a
 * driver. We now pin ^12 and doctor surfaces resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const req = createRequire(import.meta.url);
let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "driver-spec" },
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j };
}

describe.skipIf(!HAS_BIN)("better-sqlite3 / typeorm peer alignment (#54)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-driver-"));
    expect(run(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("installed driver satisfies typeorm's ^12 peer and is a single copy", () => {
    const driver = req("better-sqlite3/package.json").version as string;
    expect(Number(driver.split(".")[0])).toBe(12);
    const typeormDir = resolve(REPO, "node_modules/typeorm");
    // both resolutions point at the same physical package
    const ours = req.resolve("better-sqlite3");
    const theirs = req.resolve("better-sqlite3", { paths: [typeormDir] });
    expect(theirs).toBe(ours);
  });

  it("doctor reports sqlite_driver pass", () => {
    const r = run(["doctor"]);
    expect(r.rc).toBe(0);
    const checks = Array.isArray(r.j) ? r.j : r.j?.checks ?? [];
    const driver = checks.find((c: any) => c.name === "sqlite_driver");
    expect(driver, JSON.stringify(checks.map((c: any) => c.name))).toBeTruthy();
    expect(driver.status).toBe("pass");
  });
});
