/**
 * `verify meta` (charter §4.1 / §4.4): verifier-repo admission rules.
 *
 * The charter is the governance layer; this module is its first mechanical
 * gate. Rules are frozen by this file's META_VERSION and checked against a
 * repository tree (no DB, no spec execution):
 *   R1  AGENTS.md at repo root (owner order).
 *   R2  verify/meta.json ↔ verifier/spec files are bidirectionally consistent
 *       (v2: registration arrays are well-formed).
 *   R3  no stray executable verification artifacts: docs&#47;** has no
 *       *.mjs/*.js/*.sh, and the repo root has no loose scripts (tmp/ excluded;
 *       tmp must be gitignored per repo convention). v2: a tracked executable
 *       is also admissible when registered in `orchestration[]` (validity is
 *       R5a's job) or in `tooling[]` (sha256 must match; in a repo that lists
 *       specs, tooling must not drive `verify run|prepare|submit|archive`).
 *   R5a (v2 only) declared orchestration is statically compliant: path under
 *       verify/orchestration/, sha256 matches, `replaced_by` from the §4.7
 *       closed set, `sunset` a full MAJOR.MINOR.PATCH. No clock comparison —
 *       time enforcement (R5b) is audit-side and explicit (charter v1.2), not
 *       part of the default `verify meta`.
 *
 * Index versions: `meta_index_version: 1` (specs only) is read by the v1 rules
 * exactly as before — registrations are not read from a v1 index. Version 2
 * adds `orchestration[]` / `tooling[]`. Any other value is rejected by name
 * (never silently mis-read).
 *
 * R4 (clean-checkout reproducibility) is deliberately deferred — it needs a
 * command allowlist and privacy-filtered output, see charter §4.4.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Rule-set version: 1.0 = R1–R3 over a v1 index (0.111.0); 1.1 = v2 index
 *  registrations (R3 exemption by registration, R5a) — v1 repos judge the same. */
export const META_VERSION = "1.1";
/** On-disk index schema versions this rule set reads. A future format must be
 *  added here and be rejected by name when unknown — never silently mis-read. */
export const META_INDEX_VERSIONS: readonly number[] = [1, 2];
/** Latest index schema version (what a new verifier repo should declare). */
export const META_INDEX_VERSION = 2;

/** charter §4.7 table note: `replaced_by` closed set = the union of command
 *  tokens in the first column (backticks stripped, parentheticals ignored). */
export const R5_REPLACED_BY: readonly string[] = [
  "verify collect",
  "verify snapshot build",
  "verify tree run",
  "verify self-check",
  "verify package",
  "verify notify",
  "verify import-report",
];
export const ORCHESTRATION_ROLES: readonly string[] = ["collect", "invoke", "aggregate-input"];
export const TOOLING_ROLES: readonly string[] = ["build", "test", "release", "gate"];
const ORCHESTRATION_DIR = "verify/orchestration/";
const SEMVER_FULL = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** charter §4.4 R3: in a repo that lists specs, tooling must not drive verification. */
const DRIVES_VERIFY = /\bverify\s+(run|prepare|submit|archive)\b/;

export type MetaVerdict = "PASS" | "FAIL" | "NEEDS-MATERIAL";
export type MetaRuleId = "R1" | "R2" | "R3" | "R5a";

export interface MetaRule {
  id: MetaRuleId;
  severity: "S1" | "S2";
  title: string;
  verdict: MetaVerdict;
  evidence: Record<string, unknown>;
}

export interface MetaReport {
  meta_version: string;
  repo: string;
  /** index schema version read from verify/meta.json; null when there is no index */
  meta_index_version: number | null;
  rules: MetaRule[];
  verdict: MetaVerdict;
  checked_at: string;
}

export interface OrchestrationEntry {
  path: string;
  sha256: string;
  role: string;
  replaced_by: string;
  sunset: string;
}
export interface ToolingEntry {
  path: string;
  sha256: string;
  role: string;
}

/** What the rules know about the index after R2 parsed it. */
interface IndexState {
  /** null = no verify/meta.json */
  version: number | null;
  /** true only when the index parsed and its version is supported */
  readable: boolean;
  specsListed: number;
  orchestration: OrchestrationEntry[];
  tooling: ToolingEntry[];
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const posix = (p: string) => p.split(sep).join("/");
const R2_TITLE = "verify/meta.json ↔ spec files consistent";

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

function r2fail(evidence: Record<string, unknown>): MetaRule {
  return { id: "R2", severity: "S1", title: R2_TITLE, verdict: "FAIL", evidence };
}

/** Registration shape (v2): every entry must carry the declared keys with the
 *  closed-set roles; content checks (file exists, sha matches, …) are R3/R5a. */
function registrationShapeProblems(index: { orchestration?: unknown; tooling?: unknown }): string[] {
  const problems: string[] = [];
  const seenPaths = new Set<string>();
  const checkPath = (kind: string, i: number, p: unknown): string | null => {
    if (typeof p !== "string" || !p) return `${kind}[${i}] without path`;
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || p.split("/").includes("..")) return `${kind}[${i}] path must be repo-relative POSIX (no ".."): ${p}`;
    if (seenPaths.has(p)) return `${kind}[${i}] path registered twice: ${p}`;
    seenPaths.add(p);
    return null;
  };
  for (const [kind, list, roles] of [
    ["orchestration", index.orchestration, ORCHESTRATION_ROLES],
    ["tooling", index.tooling, TOOLING_ROLES],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.push(`${kind} must be an array`);
      continue;
    }
    list.forEach((raw, i) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      const pathProblem = checkPath(kind, i, e.path);
      if (pathProblem) problems.push(pathProblem);
      if (typeof e.sha256 !== "string" || !SHA256_HEX.test(e.sha256)) problems.push(`${kind}[${i}] sha256 must be 64 lowercase hex: ${String(e.path ?? "?")}`);
      if (typeof e.role !== "string" || !roles.includes(e.role)) problems.push(`${kind}[${i}] role ${JSON.stringify(e.role)} not in ${roles.join("|")}: ${String(e.path ?? "?")}`);
      if (kind === "orchestration") {
        if (typeof e.replaced_by !== "string" || !e.replaced_by) problems.push(`orchestration[${i}] without replaced_by: ${String(e.path ?? "?")}`);
        if (typeof e.sunset !== "string" || !e.sunset) problems.push(`orchestration[${i}] without sunset: ${String(e.path ?? "?")}`);
      }
    });
  }
  return problems;
}

function r2(repo: string): { rule: MetaRule; index: IndexState } {
  const indexFile = join(repo, "verify", "meta.json");
  const specsDir = join(repo, "verify", "specs");
  const unreadable = (version: number | null): IndexState => ({ version, readable: false, specsListed: 0, orchestration: [], tooling: [] });
  if (!existsSync(indexFile)) {
    // Nothing to reconcile: a repo without verifier artifacts has no index to
    // desync. (A present verify/specs dir without an index fails below.)
    if (!existsSync(specsDir)) {
      // #22: zero-scan is NOT a pass (SKIP ≠ OK). A repo with no verifier
      // artifacts has unproven admission — NEEDS-MATERIAL, not PASS. The gate
      // maps it to meta_unverified (mirrors the charter's "must pass meta").
      return {
        rule: { id: "R2", severity: "S1", title: R2_TITLE, verdict: "NEEDS-MATERIAL", evidence: { skipped: true, reason: "no verify/meta.json or verify/specs — nothing was scanned, so admission is unproven" } },
        index: unreadable(null),
      };
    }
    return { rule: r2fail({ reason: "verify/specs exists but verify/meta.json is missing" }), index: unreadable(null) };
  }
  let index: { meta_index_version?: unknown; specs?: Array<{ file?: string; sha256?: string }>; orchestration?: unknown; tooling?: unknown };
  try {
    index = JSON.parse(readFileSync(indexFile, "utf8"));
  } catch (e: any) {
    return { rule: r2fail({ reason: `cannot parse verify/meta.json: ${e?.message || e}` }), index: unreadable(null) };
  }
  const version = typeof index.meta_index_version === "number" ? index.meta_index_version : null;
  if (version === null || !META_INDEX_VERSIONS.includes(version)) {
    return {
      rule: r2fail({
        reason: `unknown meta_index_version ${JSON.stringify(index.meta_index_version)} (supported: ${META_INDEX_VERSIONS.join(", ")}) — never silently mis-read`,
      }),
      index: unreadable(version),
    };
  }
  const listed = new Map<string, string>();
  for (const s of index.specs ?? []) {
    if (!s.file || typeof s.file !== "string") {
      return { rule: r2fail({ reason: "meta.json entry without file" }), index: unreadable(version) };
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
  // v1 index: registrations are not part of the format — not read (charter:
  // "v1 索引按 v1 规则只读兼容、不读登记"). v2: the arrays must be well-formed.
  const state: IndexState = { version, readable: true, specsListed: listed.size, orchestration: [], tooling: [] };
  if (version === 2) {
    const shape = registrationShapeProblems(index);
    problems.push(...shape);
    if (shape.length === 0) {
      state.orchestration = ((index.orchestration as OrchestrationEntry[] | undefined) ?? []).map((e) => ({ ...e, path: posix(e.path) }));
      state.tooling = ((index.tooling as ToolingEntry[] | undefined) ?? []).map((e) => ({ ...e, path: posix(e.path) }));
    }
  }
  const evidence: Record<string, unknown> = problems.length ? { problems: problems.slice(0, 10), listed: listed.size } : { listed: listed.size };
  if (version === 2) Object.assign(evidence, { orchestration: state.orchestration.length, tooling: state.tooling.length });
  return {
    rule: { id: "R2", severity: "S1", title: R2_TITLE, verdict: problems.length ? "FAIL" : "PASS", evidence },
    index: state,
  };
}

/** v1 scan set (0.111.0). v2 adds `.py` (charter §4.4 R3 lists it); the v1 rule
 *  set stays byte-for-byte what v1 repos were admitted under. */
const EXEC_EXTS_V1 = [".sh", ".mjs", ".js", ".cjs", ".ps1"];
const EXEC_EXTS_V2 = [...EXEC_EXTS_V1, ".py"];

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
 *  allowlisted (docs must stay prose). charter v1.1: these stay name-allowlisted
 *  without registration. */
const REPO_TOOLING = new Set(["scripts", "benchmarks", "examples", "rust", "vendor", "node_modules", "dist", "tmp", ".git", "coverage", ".claude"]);
/** v1 only: named repo-tooling files outside the tooling dirs. Under a v2 index
 *  this hardcode is retired — the file is registered in `tooling[]` instead
 *  (this repo's own verify/meta.json does exactly that). */
const REPO_TOOLING_FILES_V1 = new Set(["packages/verify/core/corpus/freeze.mjs"]);

function fileSha(repo: string, rel: string): string | null {
  const full = join(repo, rel);
  try {
    if (!statSync(full).isFile()) return null;
    return sha256(readFileSync(full));
  } catch {
    return null;
  }
}

function r3(repo: string, index: IndexState): MetaRule {
  const problems: string[] = [];
  const v2 = index.version === 2 && index.readable;
  const exts = v2 ? EXEC_EXTS_V2 : EXEC_EXTS_V1;
  // v2 exemptions by registration. Orchestration entries exempt by path alone —
  // their validity (location/sha/replaced_by/sunset) is judged once, in R5a.
  // Tooling entries exempt only when the registered sha256 matches the file.
  const orchestrationPaths = new Set(v2 ? index.orchestration.map((e) => e.path) : []);
  const toolingOk = new Set<string>();
  if (v2) {
    for (const t of index.tooling) {
      const got = fileSha(repo, t.path);
      if (got === null) problems.push(`tooling file missing: ${t.path}`);
      else if (got !== t.sha256) problems.push(`registered tooling sha256 mismatch: ${t.path}`);
      else if (index.specsListed > 0 && DRIVES_VERIFY.test(readFileSync(join(repo, t.path), "utf8"))) {
        problems.push(`tooling must not drive verification (verify run|prepare|submit|archive) when specs are listed: ${t.path} — register it in orchestration[]`);
      } else toolingOk.add(t.path);
    }
  }
  // #22: scan the WHOLE tree (root-only + docs/ let lib/probe.mjs through).
  // `tmp/` is excluded from the scan but must be gitignored (checked below);
  // tooling homes are allowlisted as a directory, never as a filename pattern.
  for (const full of walkFiles(repo)) {
    const rel = posix(relative(repo, full));
    const top = rel.split("/")[0];
    if (REPO_TOOLING.has(top)) continue;
    if (!v2 && REPO_TOOLING_FILES_V1.has(rel)) continue;
    if (!exts.some((ext) => rel.endsWith(ext))) continue;
    if (orchestrationPaths.has(rel) || toolingOk.has(rel)) continue;
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
  const evidence: Record<string, unknown> = problems.length ? { problems: problems.slice(0, 10) } : { root: "clean", docs: "clean" };
  if (v2) Object.assign(evidence, { registered: { orchestration: orchestrationPaths.size, tooling: toolingOk.size } });
  return {
    id: "R3",
    severity: "S1",
    title: "no stray executable verification artifacts",
    verdict: problems.length ? "FAIL" : "PASS",
    evidence,
  };
}

/** R5a (charter v1.2, v2 index only): static compliance of declared orchestration.
 *  Offline, no clock. An explicit empty `orchestration: []` is a declaration and
 *  judges PASS (same reading as `specs: []`, charter v1.1 R2). */
function r5a(repo: string, index: IndexState): MetaRule {
  const problems: string[] = [];
  for (const e of index.orchestration) {
    if (!e.path.startsWith(ORCHESTRATION_DIR)) problems.push(`orchestration path must be under ${ORCHESTRATION_DIR}: ${e.path}`);
    const got = fileSha(repo, e.path);
    if (got === null) problems.push(`orchestration file missing: ${e.path}`);
    else if (got !== e.sha256) problems.push(`orchestration sha256 mismatch: ${e.path}`);
    if (!R5_REPLACED_BY.includes(e.replaced_by)) problems.push(`replaced_by ${JSON.stringify(e.replaced_by)} is not a §4.7 primitive (${R5_REPLACED_BY.join(" | ")}): ${e.path}`);
    if (!SEMVER_FULL.test(e.sunset)) problems.push(`sunset must be a full MAJOR.MINOR.PATCH (got ${JSON.stringify(e.sunset)}): ${e.path}`);
  }
  return {
    id: "R5a",
    severity: "S1",
    title: "orchestration statically compliant",
    verdict: problems.length ? "FAIL" : "PASS",
    evidence: problems.length ? { problems: problems.slice(0, 10), entries: index.orchestration.length } : { entries: index.orchestration.length, clock: "not compared (R5b)" },
  };
}

/** Run the frozen meta rules against a repository tree. */
export function runMeta(repo: string, now = new Date().toISOString()): MetaReport {
  const { rule: ruleR2, index } = r2(repo);
  const rules: MetaRule[] = [r1(repo), ruleR2, r3(repo, index)];
  // R5a exists only for a readable v2 index: a v1 repo keeps its R1–R3 report
  // shape, and an unreadable/unknown index already failed R2 by name.
  if (index.version === 2 && index.readable) rules.push(r5a(repo, index));
  // Four-value skeleton applied to admission: FAIL beats NEEDS-MATERIAL beats
  // PASS; a zero-scan rule (R2 skipped) makes the whole report NEEDS-MATERIAL.
  const verdict: MetaVerdict = rules.some((r) => r.verdict === "FAIL")
    ? "FAIL"
    : rules.some((r) => r.verdict === "NEEDS-MATERIAL")
      ? "NEEDS-MATERIAL"
      : "PASS";
  return { meta_version: META_VERSION, repo, meta_index_version: index.version, rules, verdict, checked_at: now };
}
