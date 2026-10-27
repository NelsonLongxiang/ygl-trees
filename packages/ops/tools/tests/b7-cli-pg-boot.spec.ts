/**
 * B7（总工 direct-f7d3b5da 裁：CLI boot PG 分支——最后一公里）。
 * 语义钉：PG 模式（YGL_DB_URL=postgres://）不要求/不创建 SQLite 工作区；
 * 直连面 = db stats | db path | doctor（连通性+N/A 明细）；其余命令组点名 rc2
 * 拒绝——绝不静默回落 SQLite（评审席信息差补报钉死的缺口）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

describe.skipIf(!HAS_BIN)("#93 B7 PG boot hardening", () => {
  beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ygl-b93-")); });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("#93-② query-string credentials redacted in db path --json", () => {
    const r = run(["db", "path", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl?user=alice&password=s3cretPW" });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain("s3cretPW");
    expect(r.out).toContain("password=***");
  });

  it("#93-② redacted in refusal message (write cmd under PG env)", () => {
    const r = run(["research", "source", "list", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl?password=s3cretPW&user=alice" });
    expect(r.rc).toBe(2);
    expect(r.raw).not.toContain("s3cretPW");
  });

  it("#93-② redacted in doctor --json connectivity detail", () => {
    const r = run(["doctor", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl?user=alice&password=s3cretPW" });
    expect(r.rc).toBe(1);
    expect(r.out).not.toContain("s3cretPW");
  });

  it("#93-② userinfo + query creds both stripped (redactPgUrl unit)", async () => {
    const { redactPgUrl } = await import("../../../core/database/src/asyncdb");
    const out = redactPgUrl("postgres://bob:hunter2@h:5/db?sslpassword=zz&sslkey=k1&SSLCERT=c2&passfile=pf&x=1");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("bob@");
    for (const v of ["zz", "k1", "c2", "pf"]) expect(out).not.toContain(v + "&");
    expect(out).toContain("x=1");
  });

  it("#93-③(a) --db postgres:// refused rc2 pointing to env", () => {
    const r = run(["db", "path", "--db", "postgres://alice:s3cretPW@127.0.0.1:1/y"], {});
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/YGL_DB_URL/);
    expect(r.raw).not.toContain("s3cretPW");
  });

  it("#93-③(b) env PG + explicit --db sqlite → fail-closed naming both", () => {
    const r = run(["db", "stats", "--db", "x.db", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl" });
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/conflicting targets/);
    expect(r.raw).toContain("x.db");
  });

  it("#93-① db init under PG env binds SQLite workspace (rc0, file created)", () => {
    const r = run(["db", "init", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl" });
    expect(r.rc).toBe(0);
    expect(existsSync(join(HOME, "ygl-trees.db"))).toBe(true);
  });

  it("#93-① verify self-check under PG env not refused by allowlist", () => {
    const r = run(["verify", "self-check", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl" });
    expect(r.rc, r.raw).not.toBe(2);
    expect(r.raw).not.toMatch(/PG mode/);
  });

  it("#93-① matrix PG-leg consistency: no step refused rc2 by boot allowlist", () => {
    // init + self-check 是 PG 腿带 YGL_DB_URL 的两步；contract 步已 env-scrub（矩阵侧）。
    const steps = [
      ["db", "init", "--json"],
      ["verify", "self-check", "--json"],
    ];
    for (const args of steps) {
      const r = run(args, { YGL_DB_URL: "postgres://127.0.0.1:1/ygl" });
      const refused = r.rc === 2 && /PG mode/.test(r.raw);
      expect(refused, args.join(" ") + " must not be allowlist-refused").toBe(false);
    }
  });
});

describe.skipIf(!HAS_BIN)("#93 复核补钉（direct-929d02dd/7b99c88e）", () => {
  beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ygl-b93b-")); });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("#93-③ every --db value checked: postgres:// + later sqlite path → rc2", () => {
    const r = run(["db", "stats", "--db", "postgres://alice:pw@127.0.0.1:1/ygl", "--db", "./ygl-trees.db", "--json"], {});
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/YGL_DB_URL/);
    expect(r.raw).not.toContain(":pw@");
  });

  it("#93-①(a) matrix pg-stats step fails on dead PG (rc≠0, connect error)", () => {
    // 矩阵 PG 腿新增的 pg-stats 步——对着无监听端口，db stats 必须 rc1 连接错误（名存实亡断根）
    const r = run(["db", "stats", "--json"], { YGL_DB_URL: "postgres://127.0.0.1:1/ygl" });
    expect(r.rc).toBe(1);
    expect(r.raw).not.toMatch(/no database at/);
    expect(r.raw.length).toBeGreaterThan(0);
  });
});

describe("#93-1(b) 矩阵 PG 腿步骤清单钉（删 pg-stats 行 → 本测试红）", () => {
  it("matrix PG leg steps include pg-stats (reads the actual script)", () => {
    const src = readFileSync(resolve(REPO, "scripts/dual-backend-matrix.mjs"), "utf8");
    // PG 腿块：从 pgUrl 分支起截到 legs.push(backend pg)
    const i = src.indexOf("pgHome");
    const j = src.indexOf('backend: "pg"', i);
    const leg = src.slice(i, j);
    expect(leg).toContain('["pg-stats"');
    expect(leg).toContain('"db", "stats", "--json"');
    expect(leg).toContain('YGL_DB_URL: pgUrl'); // 该步必须带 PG env（真连 PG）
  });
});
