import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { FileChecker, VerifySpec, VerifyUnit } from "../src/contract";
import { foldOverall, runVerify, type QueryRunner } from "../src/engine";
import { prepareSpec } from "../src/prepare";

/**
 * ④ walk ignore globs（验证席裁定）：排除面只减扫描域，不改变 require/sha256 的字面校验。
 * 语义：scanned = 排除后的可见文件数；matched = 可见文件里命中 glob 的数；全被排除 → NEEDS-MATERIAL。
 */
const root = mkdtempSync(join(tmpdir(), "ygl-file-ignore-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const runner: QueryRunner = {
  query: () => [],
  tableRows: () => 0,
  schemaFingerprint: () => "sha256:ignored",
};

function fileUnit(checker: FileChecker): VerifyUnit {
  return {
    id: "V1",
    role: "assert",
    title: "attachments",
    severity: "S1",
    source_clause: "clause",
    expected_from: { quote: "q", locator: "l" },
    checker,
  } as VerifyUnit;
}

function specWith(checker: FileChecker): VerifySpec {
  return {
    contract_version: "1.1",
    spec_id: "spec_file_ignore",
    spec_version: 1,
    verifier: { engine_version: "0.1.0", corpus_version: "1.0" },
    as_of: { kind: "snapshot", value: "2026-07-31T00:00:00.000Z" },
    attachments: [],
    sealed: { review: false },
    vu: [fileUnit(checker)],
  } as unknown as VerifySpec;
}

describe("file checker: ignore globs", () => {
  it("被排除的文件不进扫描面，但仍可被 require 命中", async () => {
    const dir = join(root, "case-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "invoice.pdf"), "pdf");
    writeFileSync(join(dir, "receipt.pdf"), "pdf");
    writeFileSync(join(dir, "notes.tmp"), "tmp");
    const report = await runVerify(specWith({ type: "file", glob: "*.pdf", ignore: ["*.tmp"], require: ["notes.tmp"] }), {
      runner,
      submissionDir: dir,
      nowIso: () => "2026-10-19T00:00:00.000Z",
      runId: "run_ignore",
    });
    const v = report.vu[0];
    expect(v.verdict).toBe("PASS");
    expect(v.witness).toMatchObject({ rows_scanned: 2, rows_matched: 2 });
    expect(v.evidence).toMatchObject({ files: 2, matched: 2, ignored: 1 });
    expect(foldOverall(report.vu).overall).toBe("PASS");
  });

  it("全部被排除 → NEEDS-MATERIAL（不假装通过，也不当成 FAIL）", async () => {
    const dir = join(root, "case-b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.tmp"), "x");
    const report = await runVerify(specWith({ type: "file", glob: "*.pdf", ignore: ["*.tmp"] }), {
      runner,
      submissionDir: dir,
      nowIso: () => "2026-10-19T00:00:00.000Z",
      runId: "run_ignore_all",
    });
    expect(report.vu[0].verdict).toBe("NEEDS-MATERIAL");
    expect(report.vu[0].witness).toMatchObject({ rows_scanned: 0, rows_matched: 0 });
  });

  it("prepare P2 拒绝越界/通吃的 ignore", async () => {
    const material = "附件数量不少于两个。";
    const base = {
      source_clause: "附件数量不少于两个。",
      anchor: { quote: "附件数量不少于两个。", locator: "material.md#1" },
      checker: { type: "file" as const, glob: "*.pdf" },
    };
    const review = (clause: string) => ({
      source_clause: clause,
      findings: [
        { question: "faithful" as const, verdict: "ok" as const, reason: "逐字", anchor: { quote: clause, locator: "material.md#1" } },
        { question: "decidable" as const, verdict: "ok" as const, reason: "可判", anchor: { quote: clause, locator: "material.md#1" } },
        { question: "not-vacuous" as const, verdict: "ok" as const, reason: "非空转", anchor: { quote: clause, locator: "material.md#1" } },
      ],
    });
    for (const bad of [["../escape/*.tmp"], ["/abs/*.tmp"], ["**"]]) {
      const res = await prepareSpec(material, {
        runner: { prepare: async () => [{ ...base, checker: { type: "file", glob: "*.pdf", ignore: bad } }] },
        reviewer: { review: async () => review(base.source_clause).findings.map((f) => ({ ...f, vu_id: "V1" })) },
        redteam: true,
        materialIndex: { text: material, files: [] },
        asOf: { kind: "snapshot", value: "2026-07-31T00:00:00.000Z" },
        nowIso: "2026-10-19T00:00:00.000Z",
      });
      expect(res.verdict).toBe("needs-material");
      expect(res.rejected[0].stage).toBe("P2");
      expect(res.rejected[0].reason).toMatch(/ignore/);
    }
  });

  it("悬空 symlink 被跳过并留痕，不让整目录 file checker 变 ERROR", async () => {
    const dir = join(root, "case-dangling");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "invoice.pdf"), "pdf");
    try {
      symlinkSync(join(dir, "does-not-exist.pdf"), join(dir, "broken.pdf"));
    } catch {
      return; // Windows without symlink privilege: skip (CI variants)
    }
    const report = await runVerify(specWith({ type: "file", glob: "*.pdf" }), {
      runner,
      submissionDir: dir,
      nowIso: () => "2026-10-19T00:00:00.000Z",
      runId: "run_dangling",
    });
    const v = report.vu[0];
    expect(v.verdict).toBe("PASS");
    expect((v.evidence as any).files).toBe(1);
    expect((v.evidence as any).skipped_symlinks).toContain("broken.pdf");
  });
});
