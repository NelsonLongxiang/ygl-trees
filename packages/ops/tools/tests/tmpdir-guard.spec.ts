import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import setup from "../../../../tests/support/tmpdir-guard";

const ROOT = resolve(__dirname, "../../../..");
const KEYS = ["TMPDIR", "TEMP", "TMP", "YGL_EVAL_OFFLINE"] as const;
const saved = () => KEYS.map(key => [key, process.env[key]] as const);
const restore = (before: ReturnType<typeof saved>) => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
};
function owned(probe: (root: string, finish: () => void, before: ReturnType<typeof saved>) => void) {
  const before = saved(); let root = "", finish: (() => void) | undefined;
  try {
    finish = setup(); root = process.env.TMP!;
    probe(root, () => { const cleanup = finish!; finish = undefined; cleanup(); }, before);
  } finally {
    try { finish?.(); } finally {
      restore(before);
      if (root && existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

describe("project-owned Vitest temporary root (#227)", () => {
  it("uses a fresh project-local root inherited by every temp variable", () => owned((root, finish, before) => {
    expect(resolve(root, "..")).toBe(join(ROOT, "tmp/test-runs"));
    expect(root).toMatch(/ygl-vitest-/);
    for (const key of ["TMPDIR", "TEMP", "TMP"]) expect(process.env[key]).toBe(root);
    if (process.env.YGL_TEST_LIVE_EVAL !== "1") expect(process.env.YGL_EVAL_OFFLINE).toBe("1");
    finish(); expect(existsSync(root)).toBe(false); expect(saved()).toEqual(before);
  }));
  it("rejects a leaked file, names it and still restores environment before throwing", () => owned((root, finish, before) => {
    writeFileSync(join(root, "unclosed-fixture.txt"), "negative control");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(finish).toThrow(/tests left 1 entry.*unclosed-fixture.txt/);
      expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("tmpdir-guard leftover: unclosed-fixture.txt");
    } finally { stderr.mockRestore(); }
    expect(existsSync(root)).toBe(false); expect(saved()).toEqual(before);
  }));
  it("allows an empty engine snapshot directory but not a retained snapshot file", () => {
    owned((root, finish, before) => {
      mkdirSync(join(root, "ygl-verify-snapshots")); finish(); expect(saved()).toEqual(before);
    });
    owned((root, finish, before) => {
      mkdirSync(join(root, "ygl-verify-snapshots")); writeFileSync(join(root, "ygl-verify-snapshots/left.sqlite"), "unclosed");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try { expect(finish).toThrow(/ygl-verify-snapshots/); } finally { stderr.mockRestore(); }
      expect(existsSync(root)).toBe(false); expect(saved()).toEqual(before);
    });
  });
  it("never cleans another invocation's sibling directory", () => {
    const parent = join(ROOT, "tmp/test-runs"); mkdirSync(parent, { recursive: true });
    const sibling = mkdtempSync(join(parent, "other-owner-")), marker = join(sibling, "keep.txt");
    writeFileSync(marker, "belongs to the sibling fixture");
    try {
      owned((_root, finish) => finish()); expect(existsSync(marker)).toBe(true);
    } finally { rmSync(sibling, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
  it("restores absent variables as absent rather than keeping inherited fixture values", () => {
    const before = saved();
    try {
      delete process.env.TMPDIR; delete process.env.YGL_EVAL_OFFLINE;
      owned((root, finish) => {
        expect(process.env.TMPDIR).toBe(root); finish();
        expect(Object.hasOwn(process.env, "TMPDIR")).toBe(false);
        expect(Object.hasOwn(process.env, "YGL_EVAL_OFFLINE")).toBe(false);
      });
    } finally { restore(before); }
  });
});
