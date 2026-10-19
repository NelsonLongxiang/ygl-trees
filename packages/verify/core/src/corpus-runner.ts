/**
 * 语料运行器（随包发布版）：把 corpus/cases/** 逐例物化成临时 SQLite 库，
 * 跑 runVerify 再与 expected-report.json 的投影比对。
 *
 * 为什么放在 src 而不是 corpus/：`verify self-check` 是交付面命令，必须能用发布产物
 * （dist/bundle/bin.cjs）跑语料；corpus/run.ts 只做 re-export，测试与 CI 从任一入口都同源。
 *
 * @module @ygl/verify-core/corpus-runner
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VerifyReport, VerifySpec } from "./contract";
import { runVerify } from "./engine";
import { openDatabaseSync } from "./sqlite-bindings";
import { SqliteRunner } from "./sqlite-runner";

export interface CorpusCase {
  name: string;
  dir: string;
  meta: Record<string, unknown> & { expect_throw?: string };
  spec: VerifySpec;
  expected?: ExpectedProjection;
}

export interface ExpectedProjection {
  overall: string;
  summary: { pass: number; fail: number; needs_material: number; error: number };
  vu: Array<{ id: string; verdict: string; witness?: { rows_scanned?: number; rows_matched?: number; compared?: number } }>;
}

export function loadCases(root: string): CorpusCase[] {
  const entries = readdirSync(root, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>;
  const cases: CorpusCase[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    const meta = read("case.json") as CorpusCase["meta"];
    const hasExpected = existsSync(join(dir, "expected-report.json"));
    cases.push({
      name: e.name,
      dir,
      meta,
      spec: read("spec.json") as VerifySpec,
      expected: hasExpected ? (read("expected-report.json") as ExpectedProjection) : undefined,
    });
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CaseRun {
  name: string;
  report: VerifyReport;
  /** 与 expected 的偏差（空数组 = 通过） */
  diffs: string[];
}

export async function runCase(c: CorpusCase): Promise<CaseRun> {
  const work = mkdtempSync(join(tmpdir(), `yglverify-${c.name}-`));
  let runner: SqliteRunner | null = null;
  try {
    const dbPath = join(work, "case.sqlite");
    const db = openDatabaseSync(dbPath);
    db.exec(readFileSync(join(c.dir, "db.sql"), "utf8"));
    db.close();
    runner = new SqliteRunner(dbPath);
    const attachments = join(c.dir, "attachments");
    try {
      const report = await runVerify(c.spec, {
        runner,
        submissionDir: existsSync(attachments) ? attachments : c.dir,
        commandAllowlist: ["node"],
        nowIso: () => "2026-10-19T00:00:00.000Z",
        engineVersion: "0.1.0",
        mode: "open",
      });
      return { name: c.name, report, diffs: diff(c.expected, report) };
    } finally {
      runner.close();
      runner = null;
    }
  } finally {
    if (runner) runner.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** 红队案例：期望在构造/运行期抛错（G3 门禁的「必须拒绝」面）。 */
export async function runThrowCase(c: CorpusCase, pattern: string): Promise<CaseRun> {
  try {
    const run = await runCase(c);
    return { name: c.name, report: run.report, diffs: [`expected throw /${pattern}/, but run completed with ${run.report.overall}`] };
  } catch (e) {
    const msg = (e as Error).message;
    const ok = new RegExp(pattern, "i").test(msg);
    return {
      name: c.name,
      report: { overall: "ERROR" } as unknown as VerifyReport,
      diffs: ok ? [] : [`throw message did not match /${pattern}/: ${msg}`],
    };
  }
}

export function diff(expected: ExpectedProjection | undefined, report: VerifyReport): string[] {
  const out: string[] = [];
  if (!expected) return out;
  if (report.overall !== expected.overall) out.push(`overall: expected ${expected.overall}, got ${report.overall}`);
  for (const k of ["pass", "fail", "needs_material", "error"] as const) {
    if (report.summary[k] !== expected.summary[k]) {
      out.push(`summary.${k}: expected ${expected.summary[k]}, got ${report.summary[k]}`);
    }
  }
  for (const ev of expected.vu) {
    const got = report.vu.find((v) => v.id === ev.id);
    if (!got) {
      out.push(`vu ${ev.id}: missing from report`);
      continue;
    }
    if (got.verdict !== ev.verdict) out.push(`vu ${ev.id}: expected ${ev.verdict}, got ${got.verdict}`);
    if (ev.witness) {
      const w = (got.witness ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(ev.witness)) {
        if (w[k] !== v) out.push(`vu ${ev.id}.witness.${k}: expected ${String(v)}, got ${String(w[k])}`);
      }
    }
  }
  return out;
}

export async function runCorpus(root: string): Promise<CaseRun[]> {
  const runs: CaseRun[] = [];
  for (const c of loadCases(root)) {
    runs.push(c.meta.expect_throw ? await runThrowCase(c, c.meta.expect_throw) : await runCase(c));
  }
  return runs;
}
