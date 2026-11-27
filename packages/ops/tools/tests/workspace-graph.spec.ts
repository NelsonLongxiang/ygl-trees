import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// Remove a fixed scratch parent once it is empty. Another spec may still be using it (ENOTEMPTY) or have removed it
// already (ENOENT); any other error is a real cleanup failure and surfaces.
function removeIfEmpty(dir: string): void {
  try { rmdirSync(dir); } catch (e: any) { if (e?.code !== "ENOTEMPTY" && e?.code !== "ENOENT") throw e; }
}

import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "scripts/gate.js");
const LAYOUT = "packages:\n  - packages/*/*\n  - apps/*\n  - vendor/*\nneverBuiltDependencies:\n  - better-sqlite3\n";
function fixture(packages: Record<string, any>, probe: (root: string) => void) {
  // Own scratch parent, never shared with another spec file (see tests-scratch-parents.spec.ts).
  const parent = join(ROOT, `tmp/workspace-graph-234-${process.pid}`); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "graph-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), LAYOUT);
    for (const [path, manifest] of Object.entries(packages)) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
    }
    probe(root);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); removeIfEmpty(parent); }
}
function run(root = ROOT, mode = "--workspace-graph") {
  const result = spawnSync(process.execPath, [SCRIPT, mode, root], { encoding: "utf8", timeout: 10000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.signal).toBeNull();
  return { rc: result.status, text: result.stdout + result.stderr };
}

describe("#234 declared workspace dependency graph", () => {
  it("the declared workspace dependencies are acyclic after the config split", () => {
    const result = run(); expect(result.rc).toBe(0); expect(result.text).toMatch(/packages, \d+ edges, no cycles/);
  });
  it("the real source graph has no core-to-domain reference or architecture exception", () => {
    const result = run(ROOT, "--source-graph"); expect(result.rc).toBe(0);
    expect(result.text).toContain("no architecture exceptions");
    expect(result.text).not.toContain("source-graph exception:");
  });
  it("accepts an acyclic app/domain/vendor graph and ignores ordinary npm dependencies", () => fixture({
    "apps/cli": { name: "@ygl/cli", dependencies: { "@ygl/domain": "workspace:~", external: "^1.0.0" } },
    "packages/research/domain": { name: "@ygl/domain", devDependencies: { framework: "workspace:*" } },
    "vendor/framework": { name: "framework" },
  }, root => expect(run(root)).toEqual({ rc: 0, text: "workspace-graph: 3 packages, 2 edges, no cycles\n" })));
  it("names a directed cycle across dependency sections", () => fixture({
    "packages/core/a": { name: "a", dependencies: { b: "workspace:~" } },
    "apps/b": { name: "b", peerDependencies: { a: "workspace:*" } },
  }, root => expect(run(root)).toEqual({ rc: 1, text: "workspace-graph: workspace cycle: a -> b -> a\n" })));
  it("rejects duplicate package names", () => fixture({
    "packages/core/a": { name: "a" }, "apps/a": { name: "a" },
  }, root => { const r = run(root); expect(r.rc).toBe(1); expect(r.text).toContain("duplicate workspace name: a"); }));
  it("names an unknown workspace reference", () => fixture({
    "packages/core/a": { name: "a", optionalDependencies: { missing: "workspace:^" } },
  }, root => { const r = run(root); expect(r.rc).toBe(1); expect(r.text).toContain("unknown workspace: a -> missing (optionalDependencies)"); }));
  it("names a self-cycle", () => fixture({
    "packages/core/a": { name: "a", devDependencies: { a: "workspace:*" } },
  }, root => expect(run(root)).toEqual({ rc: 1, text: "workspace-graph: workspace cycle: a -> a\n" })));
  it("fails closed on unsupported alias/relative workspace references", () => fixture({
    "packages/core/a": { name: "a", dependencies: { other: "workspace:../b" } },
  }, root => { const r = run(root); expect(r.rc).toBe(1); expect(r.text).toContain("unsupported workspace reference: a -> other"); }));
  it("does not traverse installed node_modules links or manifests", () => fixture({
    "packages/core/a": { name: "a" },
    "packages/core/a/node_modules/trap": { name: "a", dependencies: { a: "workspace:*" } },
    "node_modules/trap": { name: "a", dependencies: { a: "workspace:*" } },
  }, root => {
    symlinkSync(root, join(root, "packages/core/a/node_modules/loop"), process.platform === "win32" ? "junction" : "dir");
    expect(run(root)).toEqual({ rc: 0, text: "workspace-graph: 1 packages, 0 edges, no cycles\n" });
  }));
  it("rejects linked source packages instead of silently missing their edges", () => fixture({
    "packages/core/a": { name: "a" },
  }, root => {
    symlinkSync(join(root, "packages/core/a"), join(root, "apps-linked"), process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(root, "apps"));
    symlinkSync(join(root, "apps-linked"), join(root, "apps/linked"), process.platform === "win32" ? "junction" : "dir");
    const r = run(root); expect(r.rc).toBe(1); expect(r.text).toContain("linked source directory");
  }));
  it("refuses an expanded workspace layout until the scanner is updated", () => fixture({
    "packages/core/a": { name: "a" },
  }, root => {
    writeFileSync(join(root, "pnpm-workspace.yaml"), LAYOUT.replace("  - apps/*", "  - apps/*\n  - future/*"));
    const r = run(root); expect(r.rc).toBe(1); expect(r.text).toContain("workspace layouts changed");
  }));
  it("the normal contract gate includes the graph check", () => {
    const gate = readFileSync(join(ROOT, "scripts/contract-audit.sh"), "utf8");
    expect(gate).toContain("node scripts/gate.js --workspace-graph");
    expect(gate).toContain('fail "workspace graph"');
    expect(gate).toContain("node scripts/gate.js --source-graph");
    expect(gate).toContain('fail "source graph"');
  });
});


describe("#234 literal relative package-source graph", () => {
  const packages = { "packages/core/a": { name: "a" }, "packages/domain/b": { name: "b" } };
  const source = (root: string, file: string, text: string) => {
    const full = join(root, file); mkdirSync(resolve(full, ".."), { recursive: true }); writeFileSync(full, text);
  };
  const check = (root: string) => run(root, "--source-graph");
  it("reports acyclic source references even when package declarations do not name them", () => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", "export interface A { value: string }");
    source(root, "packages/domain/b/src/index.ts", 'import type { A } from "../../../core/a/src/index"; export const value: A = { value: "ok" };');
    const result = check(root); expect(result.rc).toBe(0);
    expect(result.text).toContain("2 packages, 2 files, 1 references, no cycles");
  }));
  it.each([
    ['import', 'import { value } from "../../../domain/b/src/index"; export const a = value;'],
    ['type-only import', 'import type { B } from "../../../domain/b/src/index"; export type A = B;'],
    ['re-export', 'export { value } from "../../../domain/b/src/index";'],
    ['dynamic import', 'export const load = () => import("../../../domain/b/src/index");'],
    ['require', 'export const b = require("../../../domain/b/src/index");'],
  ])("names an undeclared cycle through %s", (_kind, text) => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", text);
    source(root, "packages/domain/b/src/index.ts", 'export { a } from "../../../core/a/src/index"; export const value = 1; export interface B {}');
    const result = check(root); expect(result.rc).toBe(1);
    expect(result.text).toMatch(/source cycle: a -> b -> a|core source must not depend on a domain:/);
    expect(result.text).toContain("packages/core/a/src/index.ts");
    expect(result.text).toContain("packages/domain/b/src/index.ts");
    // The manifest graph is deliberately empty: it must not hide this distinct source cycle.
    expect(run(root).rc).toBe(0);
  }));
  it("fails an unresolved local module instead of silently losing an edge", () => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", 'export * from "../../../domain/b/src/missing";');
    source(root, "packages/domain/b/src/index.ts", "export const value = 1;");
    const result = check(root); expect(result.rc).toBe(1); expect(result.text).toContain("unresolved package source import");
  }));
  it("does not parse imports from strings or comments as graph edges", () => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", '// import { value } from "../../../domain/b/src/index";\nexport const text = "require(../../../domain/b/src/index)";');
    source(root, "packages/domain/b/src/index.ts", 'export { text } from "../../../core/a/src/index";');
    expect(check(root).rc).toBe(0);
  }));
  it("rejects syntax errors rather than reporting an incomplete graph as acyclic", () => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", "export const broken = ;");
    source(root, "packages/domain/b/src/index.ts", "export const value = 1;");
    const result = check(root); expect(result.rc).toBe(1); expect(result.text).toContain("cannot parse package source");
  }));
  it("ignores installed node_modules while refusing source links", () => fixture(packages, root => {
    source(root, "packages/core/a/src/index.ts", "export const value = 1;");
    source(root, "packages/domain/b/src/index.ts", 'export { value } from "../../../core/a/src/index";');
    const installed = join(root, "packages/core/a/src/node_modules"); mkdirSync(installed);
    symlinkSync(root, join(installed, "loop"), process.platform === "win32" ? "junction" : "dir");
    expect(check(root).rc).toBe(0);
    symlinkSync(join(root, "packages/domain/b/src"), join(root, "packages/core/a/src/linked"), process.platform === "win32" ? "junction" : "dir");
    const result = check(root); expect(result.rc).toBe(1); expect(result.text).toContain("linked source entry");
  }));
});


describe("#234 source graph complete literal forms and retired ORM exception", () => {
  const write = (root: string, file: string, text: string) => {
    const full = join(root, file); mkdirSync(resolve(full, ".."), { recursive: true }); writeFileSync(full, text);
  };
  const check = (root: string) => run(root, "--source-graph");
  it.each([
    ["import-type", "ts", 'export type A = import("../../../domain/b/src/index").B;', 'export interface B { value: string }', false],
    ["import-type cycle", "ts", 'export type A = import("../../../domain/b/src/index").B;', 'export interface B { a: import("../../../domain/a/src/index").A }', true],
    ["import-equals", "cts", 'import b = require("../../../domain/b/src/index"); export const a = b.b;', 'export const b = 1;', false],
    ["import-equals cycle", "cts", 'import b = require("../../../domain/b/src/index"); export const a = 1; export const x = b.b;', 'import a = require("../../../domain/a/src/index"); export const b = a.a;', true],
  ])("counts dependencies from %s", (_name, ext, a, b, cycle) => fixture({
    "packages/domain/a": { name: "a" }, "packages/domain/b": { name: "b" },
  }, root => {
    write(root, "packages/domain/a/src/index." + ext, String(a));
    write(root, "packages/domain/b/src/index." + ext, String(b));
    const result = check(root); expect(result.rc).toBe(cycle ? 1 : 0);
    if (cycle) {
      expect(result.text).toMatch(/source cycle: a -> b -> a|core source must not depend on a domain:/);
      expect(result.text).toContain("packages/domain/a/src/index." + ext + ":1 -> packages/domain/b/src/index." + ext);
    } else expect(result.text).toContain("1 references");
    expect(run(root).rc).toBe(0); // Empty declarations do not erase literal source dependencies.
  }));

  const ORM_PACKAGES = {
    "packages/core/database": { name: "@ygl/core-database" },
    "packages/research/pipeline": { name: "@ygl/research-pipeline", dependencies: { "@ygl/core-database": "workspace:*" } },
  };
  const orm = (root: string, importLine = 'import { RESEARCH_ENTITIES } from "../../../research/pipeline/src/entities";', source = "orm", target = "entities") => {
    write(root, "packages/core/database/src/" + source + ".ts", importLine + "\nexport const value = 1;");
    write(root, "packages/research/pipeline/src/" + target + ".ts", "export const RESEARCH_ENTITIES = []; export interface EXTRA {}");
    write(root, "packages/research/pipeline/src/cmds.ts", 'import { value } from "../../../core/database/src/' + source + '"; export const v = value;');
  };
  it("rejects the former ORM assembly edge even when its files and symbol match the retired exception", () => fixture(ORM_PACKAGES, root => {
    orm(root); const result = check(root); expect(result.rc).toBe(1);
    expect(result.text).toContain("core source must not depend on a domain: packages/core/database/src/orm.ts -> packages/research/pipeline/src/entities.ts");
    expect(run(root).rc).toBe(0);
  }));
  it.each(["second-edge", "extra-symbol", "changed-symbol", "dynamic-import", "import-type", "changed-source", "changed-target"])("refuses ORM exception mutation %s", mutation => fixture(ORM_PACKAGES, root => {
    if (mutation === "changed-source") orm(root, undefined, "other");
    else if (mutation === "changed-target") orm(root, 'import { RESEARCH_ENTITIES } from "../../../research/pipeline/src/other";', "orm", "other");
    else if (mutation === "extra-symbol") orm(root, 'import { RESEARCH_ENTITIES, EXTRA } from "../../../research/pipeline/src/entities";');
    else if (mutation === "changed-symbol") orm(root, 'import { EXTRA } from "../../../research/pipeline/src/entities";');
    else if (mutation === "dynamic-import") orm(root, 'export const load = import("../../../research/pipeline/src/entities");');
    else if (mutation === "import-type") orm(root, 'export type More = import("../../../research/pipeline/src/entities").EXTRA;');
    else {
      orm(root);
      write(root, "packages/core/database/src/second.ts", 'import { RESEARCH_ENTITIES } from "../../../research/pipeline/src/entities"; export const more = RESEARCH_ENTITIES;');
    }
    const result = check(root); expect(result.rc).toBe(1);
    expect(result.text).toMatch(/source cycle:|core source must not depend on a domain:/);
    expect(run(root).rc).toBe(0);
  }));
});
