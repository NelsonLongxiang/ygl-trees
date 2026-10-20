import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { corpusDigest, selfCheck } from "../src/selfcheck";

const CORPUS = join(__dirname, "..", "corpus");
const scratch: string[] = [];

function copyCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "ygl-selfcheck-"));
  scratch.push(dir);
  cpSync(CORPUS, dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("verify self-check（递归验证 L0–L6 单入口）", () => {
  it("真实语料：向量/摘要/形状/语料实跑全绿", async () => {
    const res = await selfCheck({ corpusDir: CORPUS });
    const ids = res.items.map((i) => `${i.id}:${i.status}`);
    expect(ids).toEqual([
      "environment:ok",
      "canonical-vectors:ok",
      "corpus-digest:ok",
      "shapes:ok",
      "corpus-cases:ok",
      "archives:skip",
    ]);
    expect(res.ok).toBe(true);
    expect(res.environment.contract_version).toBe("1.2");
    expect(res.environment.corpus_version).toBe("1.2");
  }, 120_000);

  it("改了已冻结案例 → 摘要失败并点名文件", async () => {
    const dir = copyCorpus();
    const target = join(dir, "cases", "sql-find-violation", "db.sql");
    writeFileSync(target, readFileSync(target, "utf8") + "\n-- tamper\n");
    const res = await selfCheck({ corpusDir: dir, runCases: false });
    const digest = res.items.find((i) => i.id === "corpus-digest")!;
    expect(digest.status).toBe("fail");
    expect(digest.detail).toContain("cases/sql-find-violation/db.sql");
    expect(res.ok).toBe(false);
  });

  it("canonical 向量被改 → 向量项失败（不是摘要失败掩盖）", async () => {
    const dir = copyCorpus();
    const file = join(dir, "canonical", "vectors.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.cases[0].expected = '{"wrong":true}';
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const res = await selfCheck({ corpusDir: dir, runCases: false });
    expect(res.items.find((i) => i.id === "canonical-vectors")!.status).toBe("fail");
  });

  it("没有语料 → 显式 skip，不假装 ok", async () => {
    const res = await selfCheck({});
    expect(res.ok).toBe(true);
    expect(res.items.filter((i) => i.status === "skip").map((i) => i.id)).toEqual(["corpus", "archives"]);
    expect(res.items.find((i) => i.id === "corpus")!.detail).toContain("--corpus");
  });

  it("G3 空 archives 目录 → skip（不是 ok）", async () => {
    const archives = mkdtempSync(join(tmpdir(), "ygl-empty-archives-"));
    scratch.push(archives);
    const res = await selfCheck({ corpusDir: CORPUS, runCases: false, archivesDir: archives, archiveVerifier: () => ({ ok: true, problems: [] }) });
    const item = res.items.find((i) => i.id === "archives")!;
    expect(item.status).toBe("skip");
    expect(item.detail).toMatch(/no archived runs/);
  });

  it("归档校验注入：坏包 → archives 项失败", async () => {
    const dir = copyCorpus();
    const archives = mkdtempSync(join(tmpdir(), "ygl-archives-"));
    scratch.push(archives);
    writeFileSync(join(archives, "fake.zip"), "PK-fake");
    writeFileSync(join(archives, "run_x.json"), JSON.stringify({ run_id: "run_x", archives: [{ path: join(archives, "fake.zip"), archive_id: "arc_x" }] }));
    const res = await selfCheck({ corpusDir: dir, runCases: false, archivesDir: archives, archiveVerifier: () => ({ ok: false, problems: ["item hash mismatch: report.json"] }) });
    const item = res.items.find((i) => i.id === "archives")!;
    expect(item.status).toBe("fail");
    expect(item.detail).toContain("hash mismatch");
  });

  it("corpusDigest 与 freeze.mjs 同算法（与 manifest 自洽）", () => {
    const now = corpusDigest(CORPUS);
    const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
    expect(now.digest).toBe(manifest.digest);
    expect(now.entries.length).toBe(manifest.entries.length);
  });
});
