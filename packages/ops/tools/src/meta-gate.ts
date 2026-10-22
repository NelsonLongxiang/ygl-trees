/**
 * 0.113.0 (charter §4.2): meta gate default policy.
 *
 * Detection ladder (fdc757f6 ruling, 2026-10-21):
 *   1. explicit --meta-repo       → hard (the caller named a verifier repo)
 *   2. cwd inside a git repo AND the repo it belongs to carries a verifier
 *      marker (AGENTS.md / verify/ / verify/meta.json) → hard by default
 *
 * "The repo" is resolved exactly as `verify meta` resolves it (#25 ③): walk UP
 * from the real path of cwd (or of --meta-repo) to the nearest marker dir or
 * git root — so a subdirectory is judged as its repo, never as itself.
 *   3. cwd inside a git repo, no marker → warn, point at R1, skip the gate
 *      (a verifier repo missing AGENTS.md feels R1 pressure, the gate does not
 *      silently disappear)
 *   4. cwd outside git → silent skip (ordinary business directory)
 *
 * `--no-meta` is the emergency escape and MUST be recorded: every bypass writes
 * a `meta.bypass` event (payload: command/cwd/repo) before the command
 * proceeds. A bypass that cannot be recorded is refused.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalStringify } from "../../../verify/core/src/canonical";

import type { Env } from "../../../core/database/src/types";
import { runMeta } from "../../../verify/core/src/meta";

/** Machine-readable default policy (contract-audit keys its version assertion on it). */
export const META_DEFAULT_POLICY = "hard-for-verifier-repos";

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${createHash("sha256").update(`${nowIso()}:${Math.random()}`).digest("hex").slice(0, 24)}`;

export interface MetaGateResult {
  pass: boolean;
  report?: ReturnType<typeof runMeta>;
  meta_error?: string;
  message?: string;
  /** gate was skipped by policy (non-verifier dir/no markers) — not a bypass. */
  skipped?: boolean;
  /** --no-meta: gate skipped explicitly and recorded in the events ledger. */
  bypassed?: boolean;
  /** provenance sidecar (canonical JSON + payload_sha256) to persist with the
   *  material/spec so bypass survives into the report/archive evidence chain. */
  bypass?: MetaBypassProvenance;
  warning?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** nearest ancestor carrying .git (file or dir), starting at dir. */
/** #26: macOS /var → /private/var etc. Store and compare real paths. */
export function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** #25c: the meta repo root is found by walking UP from the starting dir.
 *  The walk stops at a dir carrying a verifier meta index (`verify/meta.json`
 *  or `verify/specs/`) or at the git root (ladder step 3). A bare AGENTS.md
 *  does NOT stop it inside git (#25 ③ follow-up): monorepos keep nested
 *  AGENTS.md files (`packages/AGENTS.md`) that are guidance, not verifier
 *  repos — `packages/x` must be judged as the repo, not as `packages`.
 *  Outside git, the nearest AGENTS.md still marks a standalone verifier dir. */
export function metaRepoRootOf(start: string): string | null {
  let cur = realPathOf(start);
  let nearestAgents: string | null = null;
  for (;;) {
    if (hasMetaIndex(cur)) return cur;
    if (existsSync(join(cur, ".git"))) return cur;
    if (nearestAgents === null && existsSync(join(cur, "AGENTS.md"))) nearestAgents = cur;
    const parent = dirname(cur);
    if (parent === cur) return nearestAgents;
    cur = parent;
  }
}

function hasMetaIndex(dir: string): boolean {
  return existsSync(join(dir, "verify", "meta.json")) || isDir(join(dir, "verify", "specs"));
}

/** #25 ③: the repo the gate judges — the same walk-up/realpath `verify meta`
 *  uses, so `verify meta` and submit/prepare never disagree about the repo. */
export function judgedRepoOf(start: string): string {
  return metaRepoRootOf(start) ?? realPathOf(start);
}

export function gitRootOf(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function hasVerifierMarker(repo: string): boolean {
  // `verify/` alone is ambiguous: a ygl workspace home keeps its data there.
  // A verifier repo is marked by AGENTS.md or a verifier meta index/specs dir.
  return existsSync(join(repo, "AGENTS.md")) || hasMetaIndex(repo);
}

/** Persist a meta.bypass event synchronously (node:sqlite, WAL-friendly). */
export interface MetaBypassProvenance {
  command: string;
  cwd: string;
  repo: string;
  bypassed_at: string;
  payload_sha256: string;
}

export function recordMetaBypass(
  env: Env,
  command: string,
  repo: string,
): { ok: true; provenance: MetaBypassProvenance } | { ok: false; problem: string } {
  try {
    const base = {
      command,
      cwd: realPathOf(process.cwd()),
      repo: realPathOf(repo),
      bypassed_at: nowIso(),
    };
    const payload_sha256 = createHash("sha256").update(canonicalStringify(base)).digest("hex");
    const provenance: MetaBypassProvenance = { ...base, payload_sha256 };
    env.db.run("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES(?,?,?,?,?,?,?)", [
      newId("evt"),
      base.bypassed_at,
      "cli",
      "meta.bypass",
      "meta",
      base.repo,
      JSON.stringify(provenance),
    ]);
    return { ok: true, provenance };
  } catch (e: any) {
    return { ok: false, problem: String(e?.message || e) };
  }
}

export function metaGate(env: Env, args: any, command: "submit" | "prepare"): MetaGateResult {
  const bypass = args.flags["no-meta"] === true;
  const explicitRepo = args.flags["meta-repo"] ? resolve(String(args.flags["meta-repo"])) : null;
  const requireMeta = explicitRepo !== null || args.flags["require-meta"] === true;

  // Explicit --meta-repo wins over cwd; either way the start dir walks up.
  const repo = judgedRepoOf(explicitRepo ?? process.cwd());

  if (bypass) {
    const rec = recordMetaBypass(env, command, repo);
    if (!rec.ok) {
      return { pass: false, meta_error: "meta_bypass_unrecorded", message: `--no-meta refused: cannot record the bypass in the events ledger (${rec.problem})` };
    }
    return {
      pass: true,
      bypassed: true,
      bypass: rec.provenance,
      message: `meta gate bypassed via --no-meta (recorded as meta.bypass in the events ledger; command=${command}, repo=${repo})`,
    };
  }

  // Ladder steps 2/3/4 when no explicit signal.
  let hard = requireMeta;
  if (!hard) {
    // Ladder 2/3/4 are scoped to git repos (fdc ruling): outside git is an
    // ordinary business directory, silently out of scope.
    const root = gitRootOf(realPathOf(process.cwd()));
    if (!root) return { pass: true, skipped: true };
    if (hasVerifierMarker(repo)) hard = true;
    else {
      const warning = `no verifier markers under ${repo} (AGENTS.md / verify/ / verify/meta.json); meta gate skipped — if this IS a verifier repo, add AGENTS.md first (R1), then re-run (or pass --meta-repo <dir> / --require-meta)`;
      return { pass: true, skipped: true, warning };
    }
  }

  if (!existsSync(join(repo, "AGENTS.md"))) {
    return { pass: false, meta_error: "meta_unverified", message: `meta gate: no AGENTS.md under ${repo} (meta_unverified; pass --meta-repo <verifier repo> or --no-meta to record a bypass)` };
  }
  const report = runMeta(repo);
  if (report.verdict === "PASS") return { pass: true, report };
  const r2 = report.rules.find((r) => r.id === "R2");
  const reason = String((r2?.evidence as any)?.reason ?? "");
  const meta_error = /unknown meta_index_version/.test(reason)
    ? "meta_index_unknown"
    : report.verdict === "NEEDS-MATERIAL"
      ? "meta_unverified"
      : "meta_failed";
  const failed = report.rules.filter((r) => r.verdict === "FAIL").map((r) => r.id).join(",");
  const message = `meta gate failed (${failed || report.verdict}): ${report.rules.filter((r) => r.verdict !== "PASS").map((r) => `${r.id} ${JSON.stringify(r.evidence)}`).join("; ")}`;
  return { pass: false, report, meta_error, message };
}

export function refuseMeta(env: Env, gate: MetaGateResult): number {
  const { ctx } = env;
  if (ctx.json) {
    console.log(JSON.stringify({ error: gate.message, meta_error: gate.meta_error, ...(gate.report ? { meta: gate.report } : {}) }, null, 2));
  } else {
    console.error(`error: ${gate.message || "meta gate failed"}`);
  }
  return 1;
}
