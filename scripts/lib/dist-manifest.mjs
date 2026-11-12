/**
 * Release-input guard for `dist/` (#236).
 *
 * `dist/` is gitignored, so the clean-tree guard in pack-guard.mjs cannot see
 * it, and `pnpm pack` ships every file under it. In the 0.121.0 gates a
 * long-lived Windows checkout carried two `dist/` files that the release
 * commit does not produce: one from a source removed in 0.86.0, one built
 * from work that was never committed. Only the cross-machine byte check
 * caught it.
 *
 * Contract:
 *   - `pnpm build` starts with `cleanDist` (an empty `dist/`), and ends with
 *     `writeManifest`, which records the exact file set that build produced.
 *   - `pack:repro` calls `distDrift` and refuses to pack when `dist/` holds a
 *     file the manifest does not list (stale or planted), when a listed file
 *     is gone, or when there is no manifest at all (no clean build on record).
 *
 * The manifest lives under node_modules/.cache, outside `dist/`, so it never
 * enters the tarball and cannot change the release bytes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const MANIFEST_REL = join("node_modules", ".cache", "ygl-trees", "dist-manifest.json");

/** Every regular file under `dist/`, as sorted forward-slash paths relative to the repo root. */
export function distFiles(root) {
  const base = join(root, "dist");
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  if (existsSync(base)) walk(base);
  return out.sort();
}

/** Remove `dist/` entirely, so the build that follows cannot inherit leftovers. */
export function cleanDist(root) {
  rmSync(join(root, "dist"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Record the file set the build just produced. */
export function writeManifest(root) {
  const files = distFiles(root);
  const path = join(root, MANIFEST_REL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, files }, null, 2) + "\n", "utf8");
  return { path, files };
}

/**
 * Compare `dist/` with the manifest of the last clean build.
 * Returns { ok, manifest, extra, missing, reason? }.
 */
export function distDrift(root) {
  const path = join(root, MANIFEST_REL);
  if (!existsSync(path)) {
    return { ok: false, manifest: false, extra: [], missing: [], reason: "no dist manifest: run `pnpm build` (it empties dist/ and records what it built)" };
  }
  let listed;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (doc?.version !== 1 || !Array.isArray(doc.files)) throw new Error("unknown shape");
    listed = new Set(doc.files);
  } catch (e) {
    return { ok: false, manifest: false, extra: [], missing: [], reason: `unreadable dist manifest (${e?.message || e}): run \`pnpm build\`` };
  }
  const present = distFiles(root);
  const have = new Set(present);
  const extra = present.filter((f) => !listed.has(f));
  const missing = [...listed].filter((f) => !have.has(f)).sort();
  return { ok: extra.length === 0 && missing.length === 0, manifest: true, extra, missing };
}

/** Throw unless `dist/` is exactly what the last clean build produced. */
export function assertDistClean(root) {
  const d = distDrift(root);
  if (d.ok) return d;
  const lines = [];
  if (d.reason) lines.push(d.reason);
  const show = (label, list) => {
    if (!list.length) return;
    lines.push(`${label} (${list.length}):`, ...list.slice(0, 10).map((f) => `  ${f}`));
    if (list.length > 10) lines.push(`  … ${list.length - 10} more`);
  };
  show("dist/ files the last clean build did not produce", d.extra);
  show("dist/ files the last clean build produced that are gone", d.missing);
  throw new Error(
    `pack:repro refuses to seal bytes from a stale dist/ (#236):\n${lines.join("\n")}` +
      `\nOfficial release bytes require a clean build: run \`pnpm build\` (it empties dist/ first), then pack.`,
  );
}
