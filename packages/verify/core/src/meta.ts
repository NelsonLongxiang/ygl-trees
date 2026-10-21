/**
 * `verify meta` v1 (charter §4.1, 0.111.0): verifier-repo admission rules.
 *
 * The charter is the governance layer; this module is its first mechanical
 * gate. Rules are frozen by this file's META_VERSION and checked against a
 * repository tree (no DB, no spec execution):
 *   R1 AGENTS.md at repo root (owner order).
 *   R2 verify/meta.json ↔ verifier/spec files are bidirectionally consistent.
 *   R3 no stray executable verification artifacts: docs&#47;** has no
 *      *.mjs/*.js/*.sh, and the repo root has no loose scripts (tmp/ excluded;
 *      tmp must be gitignored per repo convention).
 *
 * R4 (clean-checkout reproducibility) is deliberately deferred to 0.113+ — it
 * needs a command allowlist and privacy-filtered output, see charter §4.4.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const META_VERSION = "1.0";
/** On-disk index schema version (verify/meta.json). A future format must bump
 *  this and be rejected by name when unknown — never silently mis-read. */
export const META_INDEX_VERSION = 1;

export type MetaVerdict = "PASS" | "FAIL" | "NEEDS-MATERIAL";

export interface MetaRule {
  id: "R1" | "R2" | "R3";
  severity: "S1" | "S2";
  title: string;
  verdict: MetaVerdict;
  evidence: Record<string, unknown>;
}

export interface MetaReport {
  meta_version: string;
  repo: string;
  rules: MetaRule[];
  verdict: MetaVerdict;
  checked_at: string;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const posix = (p: string) => p.split(sep).join("/");

function r1(repo: string): MetaRule {
  const file = join(repo, "AGENTS.md");
  const ok = existsSync(file) && statSync(file).isFile();
  return {
    id: "R1",
    severity: "S1",
    title: "AGENTS.md exists at repo root",
    verdict: ok ? "PASS" : "FAIL",
    evidence: ok ? { path: "AGENTS.md" } : { path: "AGENTS.md", reason: "missing at repo root" },
  };
}

function r2(repo: string): MetaRule {
  const indexFile = join(repo, "verify", "meta.json");
  const specsDir = join(repo, "verify", "specs");
  if (!existsSync(indexFile)) {
    // Nothing to reconcile: a repo without verifier artifacts has no index to
    // desync. (A present verify/specs dir without an index fails below.)
    if (!existsSync(specsDir)) {
      // #22: zero-scan is NOT a pass (SKIP ≠ OK). A repo with no verifier
      // artifacts has unproven admission — NEEDS-MATERIAL, not PASS. The gate
      // maps it to meta_unverified (mirrors the charter's "must pass meta").
      return { id: "R2", severity: "S1", title: "verify/meta.json ↔ spec files consistent", verdict: "NEEDS-MATERIAL", evidence: { skipped: true, reason: "no verify/meta.json or verify/specs — nothing was scanned, so admission is unproven" } };
    }
    return {
      id: "R2",
      severity: "S1",
      title: "verify/meta.json ↔ spec files consistent",
      verdict: "FAIL",
      evidence: { reason: "verify/specs exists but verify/meta.json is missing" },
    };
  }
  let index: { meta_index_version?: number; specs?: Array<{ file?: string; sha256?: string }> };
  try {
    index = JSON.parse(readFileSync(indexFile, "utf8"));
  } catch (e: any) {
    return { id: "R2", severity: "S1", title: "verify/meta.json ↔ spec files consistent", verdict: "FAIL", evidence: { reason: `cannot parse verify/meta.json: ${e?.message || e}` } };
  }
  if (index.meta_index_version !== META_INDEX_VERSION) {
    return {
      id: "R2",
      severity: "S1",
      title: "verify/meta.json ↔ spec files consistent",
      verdict: "FAIL",
      evidence: {
        reason: `unknown meta_index_version ${JSON.stringify(index.meta_index_version)} (supported: ${META_INDEX_VERSION}) — a newer index format is never silently mis-read`,
      },
    };
  }
  const listed = new Map<string, string>();
  for (const s of index.specs ?? []) {
    if (!s.file || typeof s.file !== "string") {
      return { id: "R2", severity: "S1", title: "verify/meta.json ↔ spec files consistent", verdict: "FAIL", evidence: { reason: "meta.json entry without file" } };
    }
    listed.set(posix(s.file), String(s.sha256 ?? ""));
  }
  const problems: string[] = [];
  for (const [rel, want] of listed) {
    const full = join(repo, rel);
    if (!existsSync(full)) {
      problems.push(`listed spec missing: ${rel}`);
      continue;
    }
    if (want && sha256(readFileSync(full)) !== want) problems.push(`listed spec sha256 mismatch: ${rel}`);
  }
  if (existsSync(specsDir)) {
    for (const name of readdirSync(specsDir)) {
      if (!name.endsWith(".json")) continue;
      const rel = posix(relative(repo, join(specsDir, name)));
      if (!listed.has(rel)) problems.push(`unlisted spec file: ${rel}`);
    }
  }
  return {
    id: "R2",
    severity: "S1",
    title: "verify/meta.json ↔ spec files consistent",
    verdict: problems.length ? "FAIL" : "PASS",
    evidence: problems.length ? { problems: problems.slice(0, 10), listed: listed.size } : { listed: listed.size },
  };
}

const EXEC_EXTS = [".sh", ".mjs", ".js", ".cjs", ".ps1"];

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    // Tooling/build dirs are pruned during traversal (scanning node_modules
    // would take minutes and is never a verifier artifact).
    if (REPO_TOOLING.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Directories that intentionally host repo tooling or build output — their
 *  scripts are not "stray verification artifacts". `docs/` is deliberately NOT
 *  allowlisted (docs must stay prose). */
const REPO_TOOLING = new Set(["scripts", "benchmarks", "examples", "rust", "vendor", "node_modules", "dist", "tmp", ".git", "coverage", ".claude"]);
/** Named repo-tooling files outside the tooling dirs (pure utils, never a
 *  verification artifact). Each entry needs a reason: freeze.mjs freezes the
 *  golden corpus; it produces no spec/report. */
const REPO_TOOLING_FILES = new Set(["packages/verify/core/corpus/freeze.mjs"]);

function r3(repo: string): MetaRule {
  const problems: string[] = [];
  // #22: scan the WHOLE tree (root-only + docs/ let lib/probe.mjs through).
  // `tmp/` is excluded from the scan but must be gitignored (checked below);
  // tooling homes are allowlisted as a directory, never as a filename pattern.
  for (const full of walkFiles(repo)) {
    const rel = posix(relative(repo, full));
    const top = rel.split("/")[0];
    if (REPO_TOOLING.has(top)) continue;
    if (REPO_TOOLING_FILES.has(rel)) continue;
    if (!EXEC_EXTS.some((ext) => rel.endsWith(ext))) continue;
    if (top === "docs") problems.push(`executable artifact under docs/: ${rel}`);
    else if (!rel.includes("/")) problems.push(`loose script at repo root: ${rel}`);
    else problems.push(`stray executable outside tooling dirs: ${rel}`);
  }
  const tmpDir = join(repo, "tmp");
  if (existsSync(tmpDir)) {
    const gitignore = join(repo, ".gitignore");
    const ignored = existsSync(gitignore) && /(^|\n)\s*tmp\/?\s*(\n|$)/.test(readFileSync(gitignore, "utf8"));
    if (!ignored) problems.push("tmp/ exists but is not gitignored");
  }
  return {
    id: "R3",
    severity: "S1",
    title: "no stray executable verification artifacts",
    verdict: problems.length ? "FAIL" : "PASS",
    evidence: problems.length ? { problems: problems.slice(0, 10) } : { root: "clean", docs: "clean" },
  };
}

/** Run the frozen v1 meta rules against a repository tree. */
export function runMeta(repo: string, now = new Date().toISOString()): MetaReport {
  const rules = [r1(repo), r2(repo), r3(repo)];
  // Four-value skeleton applied to admission: FAIL beats NEEDS-MATERIAL beats
  // PASS; a zero-scan rule (R2 skipped) makes the whole report NEEDS-MATERIAL.
  const verdict: MetaVerdict = rules.some((r) => r.verdict === "FAIL")
    ? "FAIL"
    : rules.some((r) => r.verdict === "NEEDS-MATERIAL")
      ? "NEEDS-MATERIAL"
      : "PASS";
  return { meta_version: META_VERSION, repo, rules, verdict, checked_at: now };
}
