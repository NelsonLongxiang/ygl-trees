/**
 * A fixed scratch parent under tmp/ that a spec removes when it is done (removeIfEmpty / rmdirSync) belongs to that
 * spec file alone. vitest runs spec files in parallel workers: when two files share such a parent, one file can remove
 * it while the other is between creating it and creating its own directory or database inside it. The second file
 * then fails to open its database and leaves files behind (G1 on Windows, 0.128.0, heads aceda841/ea967f3a:
 * config-layer-compat and workspace-graph shared tmp/workspace-cycle-234).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");

function specFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(p); }
      else if (/\.(spec|test)\.ts$/.test(name)) out.push(p);
    }
  };
  for (const top of ["packages", "apps"]) {
    for (const group of readdirSync(join(ROOT, top))) {
      const g = join(ROOT, top, group);
      if (!statSync(g).isDirectory()) continue;
      const dirs = top === "apps" ? [join(g, "tests")] : readdirSync(g).map(pkg => join(g, pkg, "tests"));
      for (const d of dirs) { try { if (statSync(d).isDirectory()) walk(d); } catch { /* no tests dir */ } }
    }
  }
  return out;
}

/** Fixed parents a spec removes: tmp/<name> literals in files that also remove directories one level up. */
export function removedParents(source: string): string[] {
  if (!/removeIfEmpty\(|rmdirSync\(/.test(source)) return [];
  const names = new Set<string>();
  for (const m of source.matchAll(/["'`]tmp\/([A-Za-z0-9._-]+)\/?["'`]/g)) names.add(m[1]);
  for (const m of source.matchAll(/["'`]tmp["'`]\s*,\s*["'`]([A-Za-z0-9._-]+)["'`]/g)) names.add(m[1]);
  return [...names];
}

export function sharedParents(files: Array<{ file: string; source: string }>): Record<string, string[]> {
  const by = new Map<string, string[]>();
  for (const { file, source } of files) for (const name of removedParents(source)) by.set(name, [...(by.get(name) ?? []), file]);
  return Object.fromEntries([...by].filter(([, f]) => f.length > 1));
}

describe("fixed tmp/ scratch parents that a spec removes are not shared between spec files", () => {
  it("finds the shared parent that broke G1 (counter-example)", () => {
    const helper = "function removeIfEmpty(dir) { rmdirSync(dir); }\n";
    const a = helper + 'const parent = join(ROOT, "tmp/workspace-cycle-234");';
    const b = helper + 'const parent = join(ROOT, "tmp/workspace-cycle-234");';
    const c = helper + 'const parent = join(ROOT, "tmp", "only-mine");';
    expect(sharedParents([{ file: "a", source: a }, { file: "b", source: b }, { file: "c", source: c }])).toEqual({ "workspace-cycle-234": ["a", "b"] });
    // A spec that never removes its parent does not count (tmp/ itself, mkdtemp prefixes).
    expect(removedParents('mkdtempSync(join(process.cwd(), "tmp/boot-retry-"));')).toEqual([]);
  });

  it("no two spec files in the repository share one", () => {
    // This file holds the counter-example literals itself, so it is left out of the scan.
    const files = specFiles().filter(f => resolve(f) !== resolve(__filename)).map(f => ({ file: relative(ROOT, f), source: readFileSync(f, "utf8") }));
    expect(files.length).toBeGreaterThan(100);
    expect(sharedParents(files)).toEqual({});
  });
});
