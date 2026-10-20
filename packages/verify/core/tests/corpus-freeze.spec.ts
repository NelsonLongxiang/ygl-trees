import { createHash } from "node:crypto";
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

  // 0.108.0（fdc757f6 0.103 裁定的「双检」另一半）：manifest 现在是 blob 内容哈希
  // （身份锚，免疫检出配置）；这里断言工作树字节与 manifest 逐个相等（运行时锚）。
  // `.gitattributes` 回归把语料写成 CRLF 时，这两道哈希会分叉、本测试大声失败。
  it("工作树字节 == manifest 的 blob 内容哈希（运行时锚）", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "corpus", "manifest.json"), "utf8")) as {
      entries: Array<{ path: string; sha256: string }>;
    };
    const corpus = join(__dirname, "..", "corpus");
    const drift = manifest.entries.filter((e) => {
      const disk = createHash("sha256").update(readFileSync(join(corpus, e.path))).digest("hex");
      return disk !== e.sha256;
    });
    expect(drift.map((e) => e.path)).toEqual([]);
  });

  it(".gitattributes 本身进保护集（属性回归 = 大声失败）", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "corpus", "manifest.json"), "utf8")) as {
      attributes_sha256?: string;
    };
    expect(manifest.attributes_sha256).toMatch(/^[0-9a-f]{64}$/);
    const disk = createHash("sha256").update(readFileSync(join(__dirname, "..", "..", "..", "..", ".gitattributes"))).digest("hex");
    expect(manifest.attributes_sha256).toBe(disk);
  });
});
