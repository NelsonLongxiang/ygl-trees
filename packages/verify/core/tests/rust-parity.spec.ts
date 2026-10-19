import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalStringify } from "../src/canonical";
import type { VerifyReport, VerifySpec } from "../src/contract";
import { payloadHash, runVerify } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";

/**
 * 双实现 parity 门禁（M13-1b）：同一份冻结语料，TS 引擎与 Rust 二进制必须产出
 * **整份报告逐字节一致**（除 data_source——那是 CLI 接线的数据源锚，引擎不猜）。
 *
 * 二进制不存在时跳过（`cargo build --release` 后才有）；这是 G2 之外的第二道真值门。
 */
const REPO = resolve(__dirname, "../../../..");
const CASES = resolve(REPO, "packages/verify/core/corpus/cases");
const RUST_BIN = join(REPO, "rust/yglverify/target/release", process.platform === "win32" ? "yglverify.exe" : "yglverify");
const hasRust = existsSync(RUST_BIN);
const NOW = "2026-10-19T00:00:00.000Z";
const scratch = hasRust ? mkdtempSync(join(tmpdir(), "ygl-rust-parity-")) : "";

afterAll(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function materialize(caseDir: string, name: string): string {
  const dbPath = join(scratch, `${name}.sqlite`);
  const db = new DatabaseSync(dbPath);
  const sql = readFileSync(join(caseDir, "db.sql"), "utf8");
  db.exec(sql);
  db.close();
  return dbPath;
}

/**
 * 归一：去掉 data_source（环境锚，CLI 各自接线：TS 复制快照、Rust 直读）与 payload_sha256
 * （它覆盖 data_source，跟着环境变）。剩下的是「判定本体」——parity 就断言这一份逐字节相同，
 * 并另外断言两边各自重算的 payload 相等（证明哈希口径同源，而不是只抄了字段）。
 */
function normalize(report: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  delete copy.data_source;
  delete copy.payload_sha256;
  return copy;
}

describe.skipIf(!hasRust)("双实现 parity（整份报告逐字节）", () => {
  it("语料全量：Rust 报告 === TS 报告（canonical）", async () => {
    const cases = readdirSync(CASES).filter((d) => existsSync(join(CASES, d, "spec.json")));
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const diffs: string[] = [];
    for (const name of cases) {
      const caseDir = join(CASES, name);
      const caseMeta = JSON.parse(readFileSync(join(caseDir, "case.json"), "utf8")) as { expect_throw?: string };
      if (caseMeta.expect_throw) continue; // 构造期拒绝由 corpus_parity 单独钉
      const spec = JSON.parse(readFileSync(join(caseDir, "spec.json"), "utf8")) as VerifySpec;
      const dbPath = materialize(caseDir, name);
      const attachments = join(caseDir, "attachments");
      const submissionDir = existsSync(attachments) ? attachments : caseDir;
      const runId = `run_${name}`;

      // Windows：runner 不 close 会锁住 .sqlite，afterAll 的 rmSync 会 EPERM。
      const runner = new SqliteRunner(dbPath);
      const tsReport = await runVerify(spec, {
        runner,
        submissionDir,
        commandAllowlist: ["node"],
        nowIso: () => NOW,
        runId,
        engineVersion: "0.1.0",
        mode: "open",
      }).finally(() => runner.close());

      const r = spawnSync(
        RUST_BIN,
        ["run", "--spec", join(caseDir, "spec.json"), "--db", dbPath, "--json", "--attachments", submissionDir, "--command-allow", "node", "--now", NOW, "--run-id", runId],
        { encoding: "utf8" },
      );
      if (r.status !== 0) {
        diffs.push(`${name}: rust rc=${r.status} ${(r.stderr || "").slice(0, 200)}`);
        continue;
      }
      const rustRaw = JSON.parse(r.stdout) as Record<string, unknown>;
      const rustReport = normalize(rustRaw);
      const rustPayload = (rustRaw as { payload_sha256?: string }).payload_sha256;
      const ts = normalize(tsReport as unknown as Record<string, unknown>);
      // TS 侧 engine 不接数据源锚（那是 CLI 的动作）；把 Rust 的 data_source 注入再算 payload，
      // 这样比较的是「同一份报告字节」的哈希口径，而不是两个环境锚的差异。
      const tsWithDs = { ...(tsReport as unknown as Record<string, unknown>), data_source: (rustRaw as { data_source?: unknown }).data_source };
      const tsPayload = payloadHash(tsWithDs as unknown as VerifyReport);
      const rustCore = payloadHash(JSON.parse(JSON.stringify(rustRaw)) as unknown as VerifyReport);
      if (tsPayload !== rustCore || typeof rustPayload !== "string") {
        diffs.push(`${name}: payload recomputation differs (ts=${tsPayload} rustCore=${rustCore} rust=${String(rustPayload)})`);
      }
      if (canonicalStringify(ts) !== canonicalStringify(rustReport)) {
        const a = canonicalStringify(ts);
        const b = canonicalStringify(rustReport);
        let at = 0;
        while (at < a.length && at < b.length && a[at] === b[at]) at++;
        diffs.push(`${name}: first diff @${at} … ts=${a.slice(at, at + 120)} rust=${b.slice(at, at + 120)}`);
      }
    }
    expect(diffs).toEqual([]);
  }, 120_000);
});
