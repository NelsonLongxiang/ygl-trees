import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, parse, resolve } from "node:path";

// Filesystem topology, not filesystem effects: no outside-project directories or fake .git files.
const topology = vi.hoisted(() => ({ files: new Set<string>(), directories: new Set<string>() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  return {
    ...actual,
    existsSync: (file: string) => topology.files.has(path.resolve(file)) || topology.directories.has(path.resolve(file)),
    realpathSync: (file: string) => path.resolve(file),
    statSync: (file: string) => {
      const key = path.resolve(file);
      if (!topology.files.has(key) && !topology.directories.has(key)) throw new Error("ENOENT");
      return { isDirectory: () => topology.directories.has(key) };
    },
  };
});
vi.mock("../../../verify/core/src/meta", () => ({ runMeta: vi.fn(() => { throw new Error("outside-Git discovery must not run meta"); }) }));
import { gitRootOf, metaGate, metaRepoRootOf } from "../src/meta-gate";
import { runMeta } from "../../../verify/core/src/meta";

const BASE = join(parse(process.cwd()).root, "virtual-fixture");
beforeEach(() => { topology.files.clear(); topology.directories.clear(); vi.clearAllMocks(); });
const file = (name: string) => topology.files.add(resolve(name));
const directory = (name: string) => topology.directories.add(resolve(name));

describe("verifier root discovery on isolated filesystem topology", () => {
  it("outside git, the nearest AGENTS.md still marks a standalone verifier dir", () => {
    const root = join(BASE, "standalone"); file(join(root, "AGENTS.md"));
    expect(gitRootOf(join(root, "sub"))).toBeNull();
    expect(metaRepoRootOf(join(root, "sub"))).toBe(root);
  });
  it("uses the nearest standalone AGENTS ancestor rather than a more distant one", () => {
    file(join(BASE, "AGENTS.md")); file(join(BASE, "inner/AGENTS.md"));
    expect(metaRepoRootOf(join(BASE, "inner/sub"))).toBe(join(BASE, "inner"));
  });
  it("a bare nested AGENTS.md does not replace the containing Git repository", () => {
    directory(join(BASE, ".git")); file(join(BASE, "packages/AGENTS.md"));
    expect(metaRepoRootOf(join(BASE, "packages/domain"))).toBe(BASE);
    expect(gitRootOf(join(BASE, "packages/domain"))).toBe(BASE);
  });
  it("an inner verifier index takes precedence over the outer Git repository", () => {
    directory(join(BASE, ".git")); file(join(BASE, "inner/verify/meta.json"));
    expect(metaRepoRootOf(join(BASE, "inner/work"))).toBe(join(BASE, "inner"));
  });
  it("no markers means no inferred repository", () => {
    expect(metaRepoRootOf(join(BASE, "plain/sub"))).toBeNull();
    expect(gitRootOf(join(BASE, "plain/sub"))).toBeNull();
  });
  it("ladder 4 silently skips meta without a Git repository, without bypass or ledger writes", () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(BASE, "business"));
    const write = vi.fn();
    try {
      const report = metaGate({ db: { run: write } } as any, { flags: {} }, "submit");
      expect(report).toEqual({ pass: true, skipped: true });
      expect(runMeta).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    } finally { cwd.mockRestore(); }
  });
});
