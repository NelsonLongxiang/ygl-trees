/**
 * B6 PG 直连面：PgAsyncDb 原语 + 工厂方言分派。
 * 用注入的假 pg 客户端验证（真库执行归 fdc docker 终验）。
 */
import { describe, it, expect, vi } from "vitest";

describe("B6 PgAsyncDb (PG direct surface primitive)", () => {
  it("factory dispatches to PG when YGL_DB_URL is postgres://", async () => {
    const { getAsyncDb } = await import("../../../core/database/src/asyncdb");
    const old = process.env.YGL_DB_URL;
    try {
      process.env.YGL_DB_URL = "postgresql://u:p@127.0.0.1:15432/ygl";
      const adb = getAsyncDb(null);
      expect(adb.dialect).toBe("pg");
      process.env.YGL_DB_URL = "";
      expect(() => getAsyncDb(null)).toThrow(/sqlite backend requires a DB/);
    } finally {
      if (old === undefined) delete process.env.YGL_DB_URL;
      else process.env.YGL_DB_URL = old;
    }
  });

  it("converts ? placeholders to $n and delegates get/all", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const fakeFactory = () => ({
      async connect() {},
      async query(sql: string, params: unknown[]) {
        seen.push({ sql, params });
        return { rows: sql.includes("AS n") ? [{ n: 3 }] : [{ id: "r1" }, { id: "r2" }] };
      },
      async end() {},
    });
    const { PgAsyncDb } = await import("../../../core/database/src/asyncdb");
    const adb = new PgAsyncDb("postgresql://u:p@127.0.0.1:15432/ygl", fakeFactory);
    const one = await adb.get("SELECT COUNT(*) AS n FROM t WHERE a=? AND b=?", [1, 2]);
    expect(one).toEqual({ n: 3 });
    const many = await adb.all("SELECT * FROM t WHERE k=?", ["v"]);
    expect(many.length).toBe(2);
    // 占位符转换正确（? → $1..$n，顺序保留）
    expect(seen[0].sql).toBe("SELECT COUNT(*) AS n FROM t WHERE a=$1 AND b=$2");
    expect(seen[0].params).toEqual([1, 2]);
    expect(seen[1].sql).toBe("SELECT * FROM t WHERE k=$1");
  });
});
