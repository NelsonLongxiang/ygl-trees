import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 语料冻结守卫（契约 §4.6）：corpus/cases 与 canonical 向量只增不改。
 * 改了已冻结案例必须升 corpus_version + CHANGELOG 记差异，然后重跑
 * `node corpus/freeze.mjs --write`。
 */
describe("corpus 冻结快照（裁定 C：跟版本不跟日历）", () => {
  it("当前语料与 manifest.json 逐文件哈希一致", async () => {
    const mod = (await import("../corpus/freeze.mjs")) as { corpusDigest: () => { entries: Array<{ path: string; sha256: string }>; digest: string } };
    const { entries, digest } = mod.corpusDigest();
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "corpus", "manifest.json"), "utf8")) as {
      corpus_version: string;
      digest: string;
      entries: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.corpus_version).toMatch(/^\d+\.\d+$/);
    expect(manifest.digest).toBe(digest);
    expect(manifest.entries).toEqual(entries);
    expect(entries.length).toBeGreaterThan(100);
  });
});
