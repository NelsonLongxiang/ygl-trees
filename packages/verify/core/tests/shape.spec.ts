/**
 * 契约形状守卫（M13-1 冻结配套）：VerifySpec / VerifyReport 的**字段形状**快照。
 *
 * 为什么不是逐字快照：报文字段带 volatile 值（run_id/时间/哈希），逐字快照每跑一次都变。
 * 这里取「字段路径 + 类型」的规范化清单——它恰好是 contract 1.0「冻结后不得静默改内文」
 * 那条纪律的机械对应物：字段增删改名/类型变更都会让清单变化，必须显式走 1.0→1.1。
 *
 * 更新方式：YGL_UPDATE_SHAPES=1 npx vitest run packages/verify/core/tests/shape.spec.ts
 * （作者席动作；CI 与评审席只读校验，同 freeze.mjs --write 纪律）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION, type VerifySpec } from "../src/contract";
import { runVerify } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";

const UPDATE = process.env.YGL_UPDATE_SHAPES === "1";
const SHAPES = join(__dirname, "..", "corpus", "shapes");

/** 字段形状：路径 + 类型；数组记 `[]` 并递归元素 0（空数组只记 `[]`）。 */
function shapeOf(value: unknown, prefix = "", out: string[] = []): string[] {
  const t = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (prefix) out.push(`${prefix}:${t}`);
  if (t === "array") {
    const arr = value as unknown[];
    if (arr.length) shapeOf(arr[0], `${prefix}[]`, out);
  } else if (t === "object") {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // 值为 undefined 的键在 JSON 里本就不存在（序列化时省略），不记为形状——否则
      // 快照会声明一个实际不可见字段（如 open 模式下的 verifier.binary_sha256）。
      if ((value as Record<string, unknown>)[key] === undefined) continue;
      shapeOf((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

function assertShape(file: string, sample: unknown) {
  const lines = shapeOf(sample).join("\n") + "\n";
  const path = join(SHAPES, file);
  if (UPDATE) {
    writeFileSync(path, lines, "utf8");
    return;
  }
  expect(existsSync(path), `形状快照缺失：${path}（作者席用 YGL_UPDATE_SHAPES=1 生成）`).toBe(true);
  expect(lines).toBe(readFileSync(path, "utf8"));
}

describe("契约形状守卫：spec/report 字段集合冻结（contract 1.1）", () => {
  it("VerifySpec 形状与冻结快照一致", () => {
    const spec: VerifySpec = {
      contract_version: "1.1",
      spec_id: "spec_shape0001",
      spec_version: 1,
      title: "shape sample",
      domain: "logistics",
      created: "2026-10-19T00:00:00.000Z",
      runtime_min: "0.95.0",
      verifier: { engine_version: "0.95.0", corpus_version: "1.0" },
      as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
      materials_sha256: "0".repeat(64),
      attachments: [{ path: "a.xlsx", sha256: "1".repeat(64), mime: "application/vnd.ms-excel", role: "baseline", size: 1 }],
      sealed: { review: false },
      vu: [
        {
          id: "U1",
          role: "source",
          title: "source unit",
          severity: "S2",
          source_clause: "clause",
          checker: { type: "sql", predicate: { from: "t", select: [], where: { op: "and", conditions: [{ col: "id", op: "is not null" }] } } },
          expected_from: { kind: "material-extract", source_id: "materials", anchor: "p1", quote: "clause" },
        },
      ],
    };
    assertShape("spec.shape.txt", spec);
  });

  it("VerifyReport 形状与冻结快照一致（含 witness/verifier/data_source）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ygl-shape-"));
    const dbPath = join(dir, "s.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE bills(id TEXT, amount_cents INTEGER); INSERT INTO bills VALUES ('A',100);");
    db.close();
    const spec: VerifySpec = {
      contract_version: "1.1",
      spec_id: "spec_shape0002",
      spec_version: 1,
      title: "shape sample report",
      domain: "logistics",
      created: "2026-10-19T00:00:00.000Z",
      runtime_min: "0.95.0",
      verifier: { engine_version: "0.95.0", corpus_version: "1.0" },
      as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
      materials_sha256: "0".repeat(64),
      attachments: [],
      sealed: { review: false },
      vu: [
        {
          id: "V1",
          role: "assert",
          title: "no negative",
          severity: "S2",
          source_clause: "no negative amounts",
          checker: {
            type: "sql",
            expect: "no_rows",
            predicate: { from: "bills", select: [], where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] } },
          },
          expected_from: { kind: "material-extract", source_id: "materials", anchor: "p1", quote: "no negative amounts" },
        },
      ],
    };
    const runner = new SqliteRunner(dbPath);
    try {
      const report = await runVerify(spec, { runner, nowIso: () => "2026-10-19T00:00:00.000Z", engineVersion: "shape" });
      assertShape("report.shape.txt", report);
    } finally {
      runner.close?.();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
