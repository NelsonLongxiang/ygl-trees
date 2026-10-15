import { describe, it, expect } from "vitest";
import { ngram, clip, contentHash, slug, parseFrontmatter, splitTags } from "../packages/core/text";

describe("ngram (CJK 二元组切分)", () => {
  it("中文串切二元组", () => {
    expect(ngram("科技树")).toBe("科技 技树");
  });
  it("单词中文保留原样", () => {
    expect(ngram("树")).toBe("树");
  });
  it("拉丁词保持整词并小写", () => {
    expect(ngram("TypeORM Gateway")).toBe("typeorm gateway");
  });
  it("中英混合各按各自规则", () => {
    expect(ngram("用docker跑")).toBe("用 docker 跑");
  });
  it("空串安全", () => {
    expect(ngram("")).toBe("");
  });
});

describe("clip", () => {
  it("短文本原样", () => {
    expect(clip("短", 10)).toBe("短");
  });
  it("长文本截断带省略号且不超限", () => {
    const out = clip("abcdefghij", 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });
  it("折叠空白", () => {
    expect(clip("a\n\n  b", 10)).toBe("a b");
  });
});

describe("contentHash (幂等写入)", () => {
  it("同内容同 hash（确定性）", () => {
    expect(contentHash("x", false)).toBe(contentHash("x", false));
  });
  it("force 加盐 → hash 不同", () => {
    expect(contentHash("x", false)).not.toBe(contentHash("x", true));
  });
  it("两次 force 也互不相同（随机盐）", () => {
    expect(contentHash("x", true)).not.toBe(contentHash("x", true));
  });
  it("无盐 hash = sha1 本体（与 DB 唯一索引对齐）", () => {
    expect(contentHash("abc", false)).toBe(
      require("node:crypto").createHash("sha1").update("abc").digest("hex")
    );
  });
});

describe("slug", () => {
  it("非法字符转连字符", () => {
    expect(slug("a b/c")).toBe("a-b-c");
  });
  it("空输入回落 item", () => {
    expect(slug("!!!")).toBe("item");
  });
});

describe("parseFrontmatter", () => {
  it("无 frontmatter 整体为 body", () => {
    const { meta, body } = parseFrontmatter("# t\n内容");
    expect(meta).toEqual({});
    expect(body.startsWith("# t")).toBe(true);
  });
  it("标量与引号剥离", () => {
    const { meta } = parseFrontmatter('---\nname: "x"\nv: 1\n---\nbody');
    expect(meta.name).toBe("x");
    expect(meta.v).toBe("1");
  });
  it("折叠块 >- 合并为一行", () => {
    const { meta } = parseFrontmatter("---\nd: >-\n  a\n  b\n---\nb");
    expect(meta.d).toBe("a b");
  });
});

describe("splitTags", () => {
  it("中英文分隔符通吃", () => {
    expect(splitTags("a,b，c;；d e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});
