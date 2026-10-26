/**
 * B7（总工 direct-f7d3b5da 裁：CLI boot PG 分支——最后一公里）。
 * 语义钉：PG 模式（YGL_DB_URL=postgres://）不要求/不创建 SQLite 工作区；
 * 直连面 = db stats | db path | doctor（连通性+N/A 明细）；其余命令组点名 rc2
 * 拒绝——绝不静默回落 SQLite（评审席信息差补报钉死的缺口）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const PG = "postgres://u:secret@127.0.0.1:1/none"; // 端口 1 = 不可达（连接超时/拒绝即命名错误）

let HOME = "";

function run(args: string[], envExtra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, ...envExtra },
  });
  return { rc: r.status ?? -1, out: r.stdout || "", err: r.stderr || "", raw: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("B7 CLI boot PG branch", () => {
  beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ygl-b7-")); });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("write command in PG mode → rc2 named refusal, no SQLite file created", () => {
    const r = run(["kb", "add", "--name", "x", "--description", "x", "--json"], { YGL_DB_URL: PG });
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/PG mode/);
    expect(r.raw).toMatch(/PG-direct faces: db stats/);
    expect(existsSync(join(HOME, "ygl-trees.db"))).toBe(false); // 不静默建库
  });

  it("db stats in PG mode → pg connection error (not sqlite no-database)", () => {
    const r = run(["db", "stats", "--json"], { YGL_DB_URL: PG });
    expect(r.rc).toBe(1);
    expect(r.raw).not.toMatch(/no database at/);
  });

  it("db path in PG mode → dialect pg + redacted url, rc0", () => {
    const r = run(["db", "path", "--json"], { YGL_DB_URL: PG });
    expect(r.rc).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ dialect: "pg" });
    expect(String(j.url)).not.toContain("secret");
  });

  it("doctor in PG mode → pg_connectivity fail + named N/A rows, rc1", () => {
    const r = run(["doctor", "--json"], { YGL_DB_URL: PG });
    expect(r.rc).toBe(1);
    const checks = JSON.parse(r.out);
    const conn = checks.find((c: any) => c.name === "pg_connectivity");
    expect(conn.status).toBe("fail");
    expect(String(conn.detail)).not.toContain("secret");
    expect(checks.filter((c: any) => /N\/A in PG mode/.test(c.detail)).length).toBeGreaterThanOrEqual(8);
  });

  it("webui in PG mode → named refusal (sync dashboard face), rc1", () => {
    const r = run(["webui", "export", "--json"], { YGL_DB_URL: PG });
    expect(r.rc).toBe(1);
    expect(r.raw).toMatch(/requires the SQLite workspace face/);
  });

  it("db init still works without PG env (no regression)", () => {
    const r = run(["db", "init"]);
    expect(r.rc).toBe(0);
    expect(existsSync(join(HOME, "ygl-trees.db"))).toBe(true);
  });
});
