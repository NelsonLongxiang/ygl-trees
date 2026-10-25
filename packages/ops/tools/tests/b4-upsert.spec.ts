/**
 * B4 upsert 原语 + 并发幂等验收。
 *
 * 验收（契约 v1.2 B4）：N 进程同内容并发写 → 一行 + 其余 duplicate:true rc0。
 * 本 spec 用**真多进程**（spawn 子进程）对同一 SQLite 工作区同内容并发 insert，
 * 断言最终只有一行、且每个进程都拿到 rc0（duplicate 不算失败）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { upsertSql, insertOrFetch, contentKey } from "../../../core/database/src/upsert";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

describe("B4 upsert primitive — dialect-neutral ON CONFLICT RETURNING", () => {
  it("generates identical SQL shape for both dialects (only placeholders differ)", () => {
    const spec = {
      table: "queries", cols: ["id", "project_id", "text", "content_hash"],
      values: ["q1", "p1", "hello", "h"], conflictCols: ["project_id", "content_hash"],
    };
    const sqlite = upsertSql(spec, { ph: () => "?" });
    const pg = upsertSql(spec, { ph: (i) => `$${i + 1}` });
    for (const s of [sqlite, pg]) {
      expect(s.insertSql).toContain("ON CONFLICT(project_id,content_hash) DO NOTHING RETURNING *");
      expect(s.selectSql).toContain("WHERE project_id = ");
    }
    expect(sqlite.insertSql).toContain("VALUES (?,?,?,?)");
    expect(pg.insertSql).toContain("VALUES ($1,$2,$3,$4)");
  });

  it("SQLite: first insert creates, second reports duplicate with the existing row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ygl-b4u-"));
    const db = new DatabaseSync(join(dir, "u.db"));
    try {
      db.exec("CREATE TABLE queries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(project_id, content_hash))");
      const exec = {
        dialect: "sqlite" as const,
        all: async (sql: string, params: unknown[]) => db.prepare(sql).all(...(params as any[])) as any[],
      };
      const spec = {
        table: "queries", cols: ["id", "project_id", "text", "content_hash"],
        values: ["q1", "p1", "账单核对", contentKey(["p1", "账单核对"])], conflictCols: ["project_id", "content_hash"],
      };
      const a = await insertOrFetch(spec, exec);
      expect(a.duplicate).toBe(false);
      expect(a.row?.id).toBe("q1");
      // 同内容再写（另一进程的视角）→ duplicate:true，且返回同一行
      const b = await insertOrFetch(
        { ...spec, values: ["q2", "p1", "账单核对", contentKey(["p1", "账单核对"])] },
        exec,
      );
      expect(b.duplicate).toBe(true);
      expect(b.row?.id).toBe("q1");
      const count = db.prepare("SELECT COUNT(*) AS n FROM queries").get() as any;
      expect(count.n).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it("contentKey is stable across calls (same content → same hash)", () => {
    expect(contentKey(["p1", "账单核对"])).toBe(contentKey(["p1", "账单核对"]));
    expect(contentKey(["p1", "账单核对"])).not.toBe(contentKey(["p2", "账单核对"]));
  });
});

describe.skipIf(!HAS_BIN)("B4 concurrent idempotency — N processes, same content, one row", () => {
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-b4-conc-"));
    const r = spawnSync(process.execPath, [BIN, "db", "init", "--json"], { env: { ...process.env, YGL_HOME: home }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const p = spawnSync(process.execPath, [BIN, "project", "new", "p1", "--json"], { env: { ...process.env, YGL_HOME: home }, encoding: "utf8" });
    expect(p.status).toBe(0);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("8 concurrent same-content query-add → all rc0, exactly one row", async () => {
    const N = 8;
    const TEXT = "B4 并发同内容写入";
    const runs = Array.from({ length: N }, () =>
      new Promise<{ rc: number; out: string }>((res) => {
        const child = spawn(process.execPath, [BIN, "research", "query", "add", TEXT, "-p", "p1", "--json"], {
          env: { ...process.env, YGL_HOME: home, YGL_SESSION: "b4-conc" },
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d));
        child.on("close", (code) => res({ rc: code ?? -1, out }));
      }),
    );
    const results = await Promise.all(runs);
    // 每个进程都必须是 rc0（幂等：重复不是失败）
    for (const r of results) expect(r.rc, r.out).toBe(0);
    // 恰好一行
    const st = spawnSync(process.execPath, [BIN, "db", "sql", `SELECT COUNT(*) AS n FROM queries WHERE text='${TEXT}'`, "--json"], {
      env: { ...process.env, YGL_HOME: home }, encoding: "utf8",
    });
    const n = JSON.parse(st.stdout)[0].n;
    expect(n).toBe(1);
  }, 300_000);
});
