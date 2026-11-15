import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(ROOT, "scripts/gate.js");
const LAYOUT = "packages:\n  - packages/*/*\n  - apps/*\n  - vendor/*\nneverBuiltDependencies:\n  - better-sqlite3\n";
function fixture(packages: Record<string, any>, probe: (root: string) => void) {
  const parent = join(ROOT, "tmp/workspace-cycle-234"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "graph-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), LAYOUT);
    for (const [path, manifest] of Object.entries(packages)) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
    }
    probe(root);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
function run(root = ROOT) {
  const result = spawnSync(process.execPath, [SCRIPT, "--workspace-graph", root], { encoding: "utf8", timeout: 10000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.signal).toBeNull();
  return { rc: result.status, text: result.stdout + result.stderr };
}

describe("#234 workspace source graph", () => {
  it("the actual repository is acyclic after the config split", () => {
    const result = run(); expect(result.rc).toBe(0); expect(result.text).toMatch(/packages, \d+ edges, no cycles/);
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
  });
});
