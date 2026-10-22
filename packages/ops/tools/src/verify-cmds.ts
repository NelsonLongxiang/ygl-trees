/** verify group — spec-validator 命令面（M13-1）.
 *
 * 构造面（submit / prepare / trace）在 ygl 工作区里完成，执行面（run）只碰**库快照副本**，
 * 报告与规范都是文件工件：`$YGL_HOME/verify/{materials,specs,reports}`。
 *
 * 两条裁定决定了这里没有模型调用：
 * - 构造期的提取/翻译由 agent 做，CLI 只吃它的输出（`--candidates`）；
 * - 盲审同理（`--reviews`，每候选一组三问结论），CLI 只做机械判定（fail-closed）。
 * 真网关适配器属于 M13-1b；M13-1 的 CLI 是「注入接口的文件形态」。
 *
 * 运行契约：rc 只表达过程——0=跑完出报告（PASS/FAIL 都是有效结论），1=运行错误，2=用法错误。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { openDatabaseSync } from "../../../verify/core/src/sqlite-bindings";

import type { Env } from "../../../core/database/src/types";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";
import { bad, C, head, out, paint, table } from "../../../core/text/src/fmt";
import type { ReviewFinding, ReviewRunner, VerifyReport, VerifySpec } from "../../../verify/core/src/contract";
import { CORPUS_VERSION } from "../../../verify/core/src/contract";
import { payloadHash, runVerify } from "../../../verify/core/src/engine";
import type { MaterialIndex, PrepareCandidate, PrepareRunner } from "../../../verify/core/src/prepare";
import { compileClausePattern, lintCandidates, noClauseLinesMessage, prepareSpec } from "../../../verify/core/src/prepare";
import { metaGate, metaRepoRootOf, refuseMeta } from "./meta-gate";
import { runMeta } from "../../../verify/core/src/meta";
import { runProbeMatrix } from "../../../verify/core/src/probe";
import type { FileScanRecord } from "../../../verify/core/src/engine";
import { CHECKER_EXAMPLES, EXAMPLES_DERIVED_FROM, NULL_OPS_NOTE } from "../../../verify/core/src/examples.generated";
import { selfCheck } from "../../../verify/core/src/selfcheck";
import { SqliteRunner } from "../../../verify/core/src/sqlite-runner";
import type { ArchiveWith } from "./archive";
import { appendRegistry, ARCHIVE_WITH, buildArchive, retainSnapshot, unarchivedRuns, verifyArchiveBytes, verifyArchiveFile } from "./archive";
import { BLOB_LIMIT, blobPath, mimeFor, putBlob, putBlobFromFile } from "./blob-store";
import { binaryKey, readSealedBinary, verifySealSignature } from "./sealed-binary";
import { attachJobTarget, checkEligibility, GraduationError, graduationPath, jobCommand, patrolEligibility, shellSafePath, writeGraduation } from "./graduate";
import type { SigningKeyTable } from "../../../verify/core/src/signature";
import { fingerprintOfRawPublicKey, SIGNING_SCHEME } from "../../../verify/core/src/signature";

const KINDS = ["materials", "specs", "reports", "registrations", "binaries"] as const;

function paths(env: Env) {
  const root = join(env.home, "verify");
  for (const k of KINDS) mkdirSync(join(root, k), { recursive: true });
  return {
    root,
    materials: join(root, "materials"),
    specs: join(root, "specs"),
    reports: join(root, "reports"),
    registrations: join(root, "registrations"),
    binaries: join(root, "binaries"),
  };
}

export const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
export const short = (sha: string): string => sha.slice(0, 12);

export interface MaterialRecord {
  material_id: string;
  title: string;
  created: string;
  text_sha256: string;
  text_path: string;
  files: Array<{ path: string; sha256: string; mime: string; size: number; stored: string; blob?: boolean }>;
  /** #34: clause pattern declared at submit (`--clause-pattern`), frozen with the
   *  material; absent = the default fleet convention `^([A-Z]+[0-9]+) `. */
  clause_pattern?: string;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  // Atomic write: temp file in the same directory + rename. A killed process
  // must never leave a half-written frozen record behind — --schedule rewrites
  // graduations/*.json in place, and a truncated JSON there is unauditable
  // (issue #3). rename(2) is atomic on the same filesystem on POSIX and Windows.
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** 以文件形态注入 prepare 的候选（agent 的提取/翻译产物）。 */
export function fileRunner(candidates: PrepareCandidate[]): PrepareRunner {
  return {
    async prepare() {
      return candidates;
    },
  };
}

/** 以文件形态注入盲审结论：每候选一组三问，按 source_clause 对齐（不认 VU id —— 那由 prepare 生成）。 */
export function fileReviewer(reviews: Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }>): ReviewRunner {
  return {
    async review(req) {
      const hit = reviews.find((r) => r.source_clause === req.vu.source_clause);
      if (!hit) return []; // 没有该候选的盲审结论 → prepare 的 fail-closed 会判"自审不完整"
      return hit.findings.map((f) => ({ ...f, vu_id: req.vu.id }));
    },
  };
}

/** P4 最小红队（fdc757f6 裁定①配套）：空快照上不得 ERROR、不得空洞 PASS。 */
export function minimalRedTeam(schemaSql: string[], submissionDir?: string): (s: VerifySpec) => Promise<string[]> {
  return async (s: VerifySpec) => {
    const db = openDatabaseSync(":memory:");
    try {
      for (const ddl of schemaSql) {
        try {
          db.exec(ddl);
        } catch {
          /* 视图/触发器/索引失败不影响空表门 */
        }
      }
      const runner = {
        query: (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>,
        tableRows: (t: string) => db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>,
        schemaFingerprint: () => "empty-snapshot",
        sourceTables: () => [] as string[],
      };
      const report = await runVerify(s, { runner: runner as never, submissionDir, mode: "open", nowIso: () => "1970-01-01T00:00:00.000Z" });
      const failures: string[] = [];
      if (report.overall === "ERROR") failures.push("spec errors out on an empty snapshot (construction bug, not a data finding)");
      for (const r of report.vu) {
        if (r.verdict === "PASS" && (r.witness?.rows_scanned ?? 0) === 0) failures.push(`${r.id} passes on an empty snapshot — vacuous pass`);
        // GitHub #18.2: file checkers are constructible in P2 (glob/ignore only),
        // but this red-team gate runs without attachment staging — say what to do
        // instead of leaking the engine's bare "--attachments <dir>" wording.
        if (r.verdict === "ERROR" && String((r as any).evidence?.reason ?? "").includes("file checker requires --attachments")) {
          failures.push(
            `${r.id} is a file checker: no attachments were staged for this prepare — submit them with ` +
              "`verify submit --attach <file>` so the red-team gate can run the file checkers against the material's attachments",
          );
        }
      }
      return failures;
    } finally {
      db.close();
    }
  };
}

/** Stage a material's blob-store attachments into a throwaway dir so the P4
 *  red-team gate can evaluate file checkers (GitHub #18.2 / cf31945f report:
 *  file specs regressed to unconditional P4 rejection because prepare never
 *  provided a submission dir). Returns null when the material has no files. */
function stageMaterialAttachments(env: Env, material: MaterialRecord): { dir: string; cleanup: () => void } | null {
  if (!material.files.length) return null;
  const dir = mkdtempSync(join(tmpdir(), "ygl-prep-attach-"));
  for (const f of material.files) {
    const src = blobPath(paths(env).root, f.sha256);
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** 从快照库取建表 DDL（红队空库用；不复制数据）。 */
export function schemaOf(dbPath: string): { ddl: string[]; fingerprint: string } {
  const db = openDatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
    return { ddl: rows.map((r) => r.sql).filter(Boolean), fingerprint: sha256(rows.map((r) => `${r.name}:${r.sql}`).join("\n")) };
  } finally {
    db.close();
  }
}

/** run 只碰副本（裁定 A）：把快照复制到临时文件，报告记来源 + sha256。 */
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 清理过期快照副本（r11 R7）：只删自己目录里超过 7 天的文件。 */
function pruneSnapshots(dir: string): number {
  let removed = 0;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > SNAPSHOT_TTL_MS) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* 并发删除/占用不影响本次 run */
    }
  }
  return removed;
}

/**
 * 语义边界行（#27 Q3 / 方案 T6）：人类可读输出首屏必须透出「这份 PASS 在哪一层成立」。
 * 契约 ≤1.2 的报告没有 `semantic_scope` 字段 → 按最保守的 structural 读并标明缺省——
 * 父验证器对子归档的 PASS 只说明子归档在场、可验，不代表子结论为真。只改人类输出，JSON 面原样。
 */
/** 闭集（#27 fdc 提案；契约 1.3 草案 §2）：闭集之外的值不得原样透出——可见面失败开放会让拼错或未来的新值
 *  读起来像更强的承诺（评审 P3）。 */
const SEMANTIC_SCOPES = new Set(["structural", "factual", "semantic"]);
export function scopeLine(report: object): string {
  // 契约 1.2 的 VerifyReport 类型没有这个字段（它属 1.3 批）；按索引读
  const raw = (report as Record<string, unknown>).semantic_scope;
  if (typeof raw !== "string") return "semantic_scope structural  (缺省：报告无 semantic_scope 字段，按最保守读——父 PASS 不代表子结论为真)";
  if (SEMANTIC_SCOPES.has(raw)) return `semantic_scope ${raw}`;
  return `semantic_scope structural  (未知值 ${JSON.stringify(raw)} 不在闭集 structural|factual|semantic 内，按最保守读——父 PASS 不代表子结论为真)`;
}

export function snapshotCopy(dbPath: string): { path: string; sha256: string; source: string } {
  const stat = statSync(dbPath);
  if (!stat.isFile()) throw new Error(`--db must point to a SQLite file (snapshot copy), not a directory: ${dbPath}`);
  const dir = join(process.env.TEMP || process.env.TMPDIR || ".", "ygl-verify-snapshots");
  mkdirSync(dir, { recursive: true });
  pruneSnapshots(dir);
  const target = join(dir, `${basename(dbPath)}.${Date.now()}.sqlite`);
  copyFileSync(dbPath, target);
  return { path: target, sha256: `sha256:${sha256(readFileSync(target))}`, source: basename(dbPath) };
}

export function specDir(env: Env, specId: string): string {
  return join(paths(env).specs, specId);
}

/**
 * 构造记录落盘（0.102.2，原子占位 0.102.4）：**ready 才写 `prepare.json`**（以最后一次成功为准——
 * 同 spec 再准备成功会覆盖，这不是"不可变"，只是"失败的补跑不许冲掉成功记录"）；未 ready 的
 * 尝试写 `attempts/<ts>.json`，只追加、不覆盖。CLI 与 HTTP 共用这一个口径——此前 CLI 无论
 * ready 与否都覆盖 `prepare.json`（一次失败的补跑会冲掉上一轮已冻结的成功记录），HTTP 面则
 * 什么都不写（失败尝试无痕）；两个面各错一半，现在统一为「成功记录以最后一次成功为准、
 * 失败尝试留档」。
 *
 * 并发安全（r23 P3③）：attempts 用 `flag: "wx"` 原子占位。先 `existsSync` 再写的续号方案有
 * TOCTOU 窗口（8 路并发没撞是毫秒错开的运气），`wx` 下同毫秒的第二个写者直接拿 EEXIST，
 * 续号重试即可——路径选择与创建是同一次系统调用，不存在"选中后被抢"。
 */
export function writePrepareRecord(dir: string, ready: boolean, payload: unknown, now = new Date().toISOString()): string {
  mkdirSync(dir, { recursive: true });
  if (ready) {
    const file = join(dir, "prepare.json");
    writeJson(file, payload);
    return file;
  }
  const attempts = join(dir, "attempts");
  mkdirSync(attempts, { recursive: true });
  const base = now.replace(/[:.]/g, "-");
  const data = `${JSON.stringify(payload, null, 2)}
`;
  for (let n = 1; n < 1000; n++) {
    const file = join(attempts, n === 1 ? `${base}.json` : `${base}-${n}.json`);
    try {
      writeFileSync(file, data, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  throw new Error("cannot allocate an attempts record: 1000 same-millisecond collisions");
}

/** as_of 校验失败（r22 ②）。CLI 映射 rc=2，HTTP 映射 400——两侧共用同一个校验。 */
export class AsOfError extends Error {}

/** 严格 ISO：纯日期（按 UTC 00:00）或"带显式时区"的 datetime；其余一律拒（r23 P3①）。 */
const AS_OF_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AS_OF_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** 日历合法性按 UTC 逐字段回读——`2026-02-30` 会被 Date 静默滚成 03-02，不能信任 Date.parse。 */
function calendarOk(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * as_of 归一（r22 ②，0.102.4 收紧为严格 ISO）。R13 要求锚定冻结值：不可解析的时间锚会把
 * 报告变成不可对质，而"能解析但按本机时区解释"的锚在 CI(UTC) 与本机(+08) 会得到两个时刻。
 *
 * 接受：`2026-10-24`（纯日期，按 UTC 00:00）、`2026-10-24T10:00:00Z`、
 * `2026-10-24T10:00:00.123+08:00`、`+0800`（与引擎 `ISO_DATETIME_TZ` 的 `±hh` 口径一致）。
 * 拒绝：无时区 datetime、空格分隔、非 ISO（`Jan 1 2026`）、非法日历（`2026-02-30`）。
 * 未给（undefined/null/空串）才回落 `fallback`（调用方的本次时刻）。
 */
export function normalizeAsOf(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") throw new AsOfError(`as_of must be an ISO-8601 string, got ${typeof raw}`);
  const t = raw.trim();
  let m = AS_OF_DATE.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!calendarOk(y, mo, d)) throw new AsOfError(`as_of is not a valid calendar date: ${raw}`);
    return new Date(Date.UTC(y, mo - 1, d)).toISOString();
  }
  m = AS_OF_DATETIME.exec(t);
  if (!m) {
    throw new AsOfError(
      `as_of is not an ISO-8601 timestamp with an explicit zone (use 2026-10-24T00:00:00Z, 2026-10-24T08:00:00+08:00, +0800, or a bare date 2026-10-24) — got: ${raw}`
    );
  }
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m;
  const [y, mo, d] = [Number(ys), Number(mos), Number(ds)];
  if (!calendarOk(y, mo, d)) throw new AsOfError(`as_of is not a valid calendar date: ${raw}`);
  const [h, mi, sec] = [Number(hs), Number(mis), Number(ss ?? "0")];
  if (h > 23 || mi > 59 || sec > 59) throw new AsOfError(`as_of has an out-of-range time: ${raw}`);
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const zh = Number(digits.slice(0, 2));
    const zm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (zh > 23 || zm > 59) throw new AsOfError(`as_of has an out-of-range zone offset: ${raw}`);
    offsetMin = sign * (zh * 60 + zm);
  }
  const ms = frac ? Number(`${frac}000`.slice(0, 3)) : 0;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60000).toISOString();
}

// GitHub #34: load named clause exemptions (JSON array or { exempt: [...] }).
// Each entry names a declared clause by exactly one of `id`, `locator` (`#S3`)
// or exact `text` — never by line number — and carries a mandatory `reason`.
type ExemptEntry = { id?: string; locator?: string; text?: string; reason?: string };
function loadCoverageExempt(args: any): { ok: true; exempt: ExemptEntry[] } | { ok: false; code: number; problem: string } {
  const file = args.flags["coverage-exempt"];
  if (file === undefined) return { ok: true, exempt: [] };
  const path = String(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    return { ok: false, code: 1, problem: `cannot read --coverage-exempt ${path}: ${e?.message || e}` };
  }
  const list = Array.isArray(raw) ? raw : (raw as { exempt?: unknown })?.exempt;
  if (!Array.isArray(list)) return { ok: false, code: 2, problem: "--coverage-exempt must be a JSON array or { exempt: [{ id | locator | text, reason }] }" };
  const exempt: ExemptEntry[] = [];
  for (const [i, e] of list.entries()) {
    if (typeof e === "string") {
      return { ok: false, code: 2, problem: `--coverage-exempt entry #${i} is a bare string — write { id: ${JSON.stringify(e)}, reason: "<why no VU covers it>" } (the reason is mandatory)` };
    }
    const o = (e ?? {}) as { id?: unknown; locator?: unknown; text?: unknown; reason?: unknown };
    const keys = (["id", "locator", "text"] as const).filter((k) => typeof o[k] === "string");
    if (keys.length !== 1) return { ok: false, code: 2, problem: `--coverage-exempt entry #${i} must name its clause by exactly one of id / locator / text` };
    exempt.push({ [keys[0]]: o[keys[0]] as string, ...(typeof o.reason === "string" ? { reason: o.reason } : {}) });
  }
  return { ok: true, exempt };
}

// GitHub #34: `--clause-pattern <regex>` declares the material's clause lines
// (first capture group = id); default is the fleet convention `^([A-Z]+[0-9]+) `.
function loadClausePattern(args: any): { ok: true; pattern: RegExp; declared: boolean } | { ok: false; problem: string } {
  const raw = args.flags["clause-pattern"];
  if (raw === true) return { ok: false, problem: "--clause-pattern needs a regular expression, e.g. --clause-pattern '^([A-Z]+[0-9]+) '" };
  const p = compileClausePattern(raw === undefined ? undefined : String(raw));
  return typeof p === "string" ? { ok: false, problem: p } : { ok: true, pattern: p, declared: raw !== undefined };
}

// #34: structured clause scope for prepare.json / attempts (what coverage was judged by)
export function clauseScopeOf(p: { pattern: RegExp; declared: boolean }, cov?: { enforced: boolean; clauses: number }) {
  return { pattern: p.pattern.source, declared: p.declared, enforced: cov?.enforced ?? null, clauses: cov?.clauses ?? null };
}

// The clause pattern frozen with a material (absent = default convention).
export function materialClausePattern(material: MaterialRecord): { ok: true; pattern: RegExp; declared: boolean } | { ok: false; problem: string } {
  if (material.clause_pattern === undefined) return { ok: true, pattern: compileClausePattern(undefined) as RegExp, declared: false };
  const p = compileClausePattern(String(material.clause_pattern));
  return typeof p === "string" ? { ok: false, problem: `material ${material.material_id} has an unusable clause_pattern: ${p}` } : { ok: true, pattern: p, declared: true };
}

export function findMaterial(env: Env, id: string): MaterialRecord {
  const dir = join(paths(env).materials, id);
  const file = join(dir, "material.json");
  if (!existsSync(file)) throw new Error(`material not found: ${id} (verify submit first)`);
  return readJson<MaterialRecord>(file);
}

/** 找语料目录：显式 flag > YGL_VERIFY_CORPUS > 从 cwd 向上找 packages/verify/core/corpus。 */
function resolveCorpus(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const envDir = process.env.YGL_VERIFY_CORPUS;
  if (envDir && existsSync(envDir)) return envDir;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "packages", "verify", "core", "corpus");
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function selfCheckCase(env: Env, root: string, args: any): Promise<number> {
  const { ctx } = env;
  const res = await selfCheck({
    corpusDir: resolveCorpus(args.flags.corpus ? String(args.flags.corpus) : undefined),
    archivesDir: join(root, "archives"),
    archiveVerifier: (zip: string) => verifyArchiveBytes(readFileSync(zip)),
    runCases: args.flags.cases !== false && args.flags["no-cases"] !== true,
    caseLimit: args.flags.limit ? Number(args.flags.limit) : undefined,
  });
  if (ctx.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  for (const item of res.items) {
    const mark = item.status === "ok" ? paint(C.green, "✓", ctx.color) : item.status === "skip" ? paint(C.dim, "–", ctx.color) : paint(C.red, "✗", ctx.color);
    out(ctx, `  ${mark} ${item.id.padEnd(18)} ${item.detail}`);
  }
  out(ctx, res.ok ? paint(C.green, "  self-check: ok", ctx.color) : paint(C.red, "  self-check: FAILED", ctx.color));
  return res.ok ? 0 : 1;
}

/** 每个动作认识的旗标。--json/--no-color 等全局旗标在 GLOBAL_FLAGS 里（bin 层解析）。 */
const GLOBAL_FLAGS = new Set(["json", "color", "no-color", "quiet", "home", "db", "project", "p", "verbose", "global", "force"]);
const ACTION_FLAGS: Record<string, string[]> = {
  submit: ["title", "text", "attach", "meta-repo", "require-meta", "no-meta", "clause-pattern"],
  prepare: ["candidates", "reviews", "db", "as-of", "title", "domain", "draft", "spec-version", "meta-repo", "require-meta", "no-meta", "coverage-exempt"],
  run: ["db", "submission", "no-archive"],
  graduate: ["min-runs", "min-span-days", "every", "schedule", "patrol", "db"],
  list: ["unarchived"],
  report: ["out", "keys", "expect-key"],
  trace: [],
  export: ["out"],
  archive: ["with", "out", "snapshot"],
  "self-check": ["corpus", "cases", "no-cases", "limit"],
  "lint-candidates": ["text", "db", "reviews", "coverage-exempt", "clause-pattern"],
  example: ["checker", "null-ops"],
  meta: [],
  probe: ["matrix", "target", "only"],
  register: ["keys", "expect-key", "no-copy"],
  signature: ["keys", "expect-key"],
};

/** 密钥表：--keys > $YGL_VERIFY_KEYS > $YGL_HOME/verify/keys/signing-keys.json；都没有返回 null。 */
function loadKeyTable(env: Env, args: any): SigningKeyTable | null {
  const explicit = args.flags.keys ? String(args.flags.keys) : process.env.YGL_VERIFY_KEYS;
  const candidates = explicit ? [explicit] : [join(verifyRoot(env), "keys", "signing-keys.json")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const table = JSON.parse(readFileSync(file, "utf8")) as SigningKeyTable;
      if (!table || typeof table !== "object" || typeof table.keys !== "object") throw new Error("keys must be an object");
      // 自检（r16 P2②）：key_id 必须是 sha256(public_key)，防贴错行导致「指纹与公钥不对应」——
      // 认表不认报文的前提是表自己是自洽的。
      for (const [keyId, entry] of Object.entries(table.keys)) {
        const pub = String((entry as any)?.public_key ?? "");
        if (!/^[0-9a-f]{64}$/.test(pub)) throw new Error(`key ${keyId} has a malformed public_key (expect 64 hex)`);
        const derived = fingerprintOfRawPublicKey(Buffer.from(pub, "hex"));
        if (derived !== keyId) throw new Error(`key table inconsistency: entry ${keyId} carries a public key whose fingerprint is ${derived}`);
      }
      return table;
    } catch (e: any) {
      throw new Error(`cannot read signing key table ${file}: ${e?.message || e}`);
    }
  }
  if (explicit) throw new Error(`signing key table not found: ${explicit}`);
  return null;
}

/** --expect-key <64hex|file>：单键「钉死」通道（不做信任表，只认这一把）。 */
function expectKeyTable(args: any): SigningKeyTable | null {
  if (!args.flags["expect-key"]) return null;
  const raw = String(args.flags["expect-key"]);
  let hexText = raw;
  if (existsSync(raw)) {
    const bytes = readFileSync(raw);
    hexText = bytes.length === 32 ? bytes.toString("hex") : bytes.toString("utf8").trim();
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hexText)) throw new Error("--expect-key must be 64 hex chars (raw ed25519 public key) or a 32-byte key file");
  const key = Buffer.from(hexText, "hex");
  const fp = fingerprintOfRawPublicKey(key);
  return { scheme: SIGNING_SCHEME, keys: { [fp]: { public_key: hexText.toLowerCase(), created: "expect-key" } } };
}

function verifyRoot(env: Env): string {
  return paths(env).root;
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx } = env;
  const p = paths(env);
  // 未知旗标是用法错误（rc=2）：静默吞掉会让 `--attachment` 这种拼写落成 files:[]，
  // 提交物缺附件却一路跑到 PASS 边缘——构造期静默比报错危险得多（验证席回灌 ①）。
  const allowed = new Set([...(ACTION_FLAGS[action] ?? []), ...GLOBAL_FLAGS]);
  const unknown = Object.keys(args.flags ?? {}).filter((k) => !allowed.has(k));
  if (unknown.length) {
    bad(ctx, `unknown flag${unknown.length > 1 ? "s" : ""} for verify ${action}: ${unknown.map((k) => `--${k}`).join(" ")}`);
    return 2;
  }

  switch (action) {
    case "submit": {
      const title = String(args.flags.title || "").trim();
      const textArg = args.flags.text ? String(args.flags.text) : "";
      if (!title || !textArg) {
        bad(ctx, 'usage: verify submit --title "<what>" --text <file|-> [--attach <file> ...] [--clause-pattern <regex>]');
        return 2;
      }
      // #34: the clause pattern is part of the frozen material (validated before any I/O)
      const patOpt = loadClausePattern(args);
      if (!patOpt.ok) {
        bad(ctx, patOpt.problem);
        return 2;
      }
      const clausePattern = patOpt.declared ? patOpt.pattern.source : undefined;
      let text: string;
      try {
        text = textArg === "-" ? readFileSync(0, "utf8") : readFileSync(textArg, "utf8");
      } catch (e: any) {
        bad(ctx, `cannot read --text ${textArg}: ${e?.message || e}`);
        return 1;
      }
      if (!text.trim()) {
        bad(ctx, "--text is empty — a submission with no material cannot be prepared");
        return 2;
      }
      const gate = metaGate(env, args, "submit");
      if (!gate.pass) return refuseMeta(env, gate);
      if (gate.warning && !ctx.json) out(ctx, paint(C.yellow, `  ! ${gate.warning}`, ctx.color));
      const metaWarning = gate.warning ?? (gate.report && gate.report.verdict !== "PASS" ? gate.message : undefined);
      const metaBypassed = gate.bypassed === true;
      const attachArgs: string[] = Array.isArray(args.flags.attach)
        ? args.flags.attach.map(String)
        : args.flags.attach
          ? [String(args.flags.attach)]
          : [];
      // A declared clause pattern is part of the material's identity: the same
      // text under another pattern is another material, never a silent retarget.
      const materialId = `mat_${short(sha256(clausePattern === undefined ? `${title}\n${text}` : `${title}\n${text}\n${clausePattern}`))}`;
      const dir = join(p.materials, materialId);
      mkdirSync(join(dir, "files"), { recursive: true });
      writeFileSync(join(dir, "material.txt"), text, "utf8");
      const files: MaterialRecord["files"] = [];
      for (const a of attachArgs) {
        if (!existsSync(a)) {
          bad(ctx, `attachment not found: ${a}`);
          return 1;
        }
        let ref;
        try {
          // 唯一写入面：CLI 与 HTTP 上传都走 blob-store（同哈希、同容量策略、同去重）。
          ref = putBlobFromFile(p.root, a);
        } catch (e: any) {
          bad(ctx, `cannot store attachment ${a}: ${e?.message || e}`);
          return 1;
        }
        files.push({
          path: basename(a),
          sha256: ref.sha256,
          mime: ref.mime,
          size: ref.size,
          stored: `${short(ref.sha256)}-${basename(a)}`,
          blob: true,
        });
      }
      const record: MaterialRecord = {
        material_id: materialId,
        title,
        created: new Date().toISOString(),
        text_sha256: sha256(text),
        text_path: "material.txt",
        files,
        ...(clausePattern !== undefined ? { clause_pattern: clausePattern } : {}),
      };
      writeJson(join(dir, "material.json"), record);
      // #25a: a --no-meta bypass must survive into the evidence chain, not just
      // the local events ledger. The canonical provenance (payload_sha256) is
      // stored with the material and later folded into the archive manifest.
      if (gate.bypass) writeJson(join(dir, "meta-bypass.json"), gate.bypass);
      if (ctx.json) {
        console.log(JSON.stringify({ ...record, ...(metaWarning ? { meta_warning: metaWarning } : {}), ...(metaBypassed ? { meta_bypassed: true } : {}) }));
        return 0;
      }
      out(ctx, `  ✓ material frozen: ${materialId}  (${text.length} chars${files.length ? `, ${files.length} attachment(s)` : ""})`);
      out(ctx, paint(C.dim, `  next: verify prepare ${materialId} --candidates <file> --reviews <file> --db <snapshot.sqlite>`, ctx.color));
      return 0;
    }

    case "prepare": {
      const materialId = rest[0];
      const candidatesPath = String(args.flags.candidates || "");
      const reviewsPath = String(args.flags.reviews || "");
      const dbPath = String(args.flags.db || "");
      if (!materialId || !candidatesPath || !reviewsPath || !dbPath) {
        bad(ctx, "usage: verify prepare <material-id> --candidates <file> --reviews <file> --db <snapshot.sqlite> [--spec-version N] [--draft] [--as-of <ISO-8601>]");
        return 2;
      }
      // as_of 双侧同校验（r22 ②）：可解析 → 归一 toISOString；不可解析 → rc=2（不落盘、不消耗版本）。
      // 放在最前面：旗标错误是用法错误，不该先做 material/db 的 I/O 再说。
      let asOf: string;
      try {
        asOf = normalizeAsOf(args.flags["as-of"], new Date().toISOString());
      } catch (e: any) {
        bad(ctx, `${e.message} (--as-of expects an ISO-8601 timestamp, e.g. 2026-10-20T09:00:00+08:00)`);
        return 2;
      }
      let material: MaterialRecord;
      try {
        material = findMaterial(env, materialId);
      } catch (e: any) {
        bad(ctx, e.message);
        return 1;
      }
      const text = readFileSync(join(p.materials, materialId, material.text_path), "utf8");
      const gate = metaGate(env, args, "prepare");
      if (!gate.pass) return refuseMeta(env, gate);
      if (gate.warning && !ctx.json) out(ctx, paint(C.yellow, `  ! ${gate.warning}`, ctx.color));
      const metaWarning = gate.warning ?? (gate.report && gate.report.verdict !== "PASS" ? gate.message : undefined);
      const metaBypassed = gate.bypassed === true;
      // 两种形态都收：裸数组，或 { candidates: [...] } / { reviews: [...] } 信封
      const candidatesRaw = readJson<unknown>(candidatesPath);
      const reviewsRaw = readJson<unknown>(reviewsPath);
      const candidatesFile = { candidates: Array.isArray(candidatesRaw) ? (candidatesRaw as PrepareCandidate[]) : ((candidatesRaw as { candidates?: PrepareCandidate[] }).candidates ?? []) };
      const reviewsFile = { reviews: Array.isArray(reviewsRaw) ? (reviewsRaw as Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }>) : ((reviewsRaw as { reviews?: Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }> }).reviews ?? []) };
      const schema = existsSync(dbPath) ? schemaOf(dbPath) : null;
      if (!schema) {
        bad(ctx, `--db snapshot not found: ${dbPath} (prepare needs the probed schema for column checks)`);
        return 1;
      }
      const materialIndex: MaterialIndex = {
        text,
        files: material.files.map((f) => ({ path: f.path, sha256: f.sha256, mime: f.mime, size: f.size })),
      };
      // 0.104.0：列探针问快照库要真实 schema（PRAGMA），DDL 文本漏 ALTER TABLE 加的列
      const schemaProbe = probeOfDb(dbPath);
      const covOpt = loadCoverageExempt(args);
      if (!covOpt.ok) {
        bad(ctx, covOpt.problem);
        return covOpt.code;
      }
      const patOpt = materialClausePattern(material);
      if (!patOpt.ok) {
        bad(ctx, patOpt.problem);
        return 1;
      }
      const attachmentStage = stageMaterialAttachments(env, material);
      const prevVersion = latestVersionOf(env, materialId);
      // ③ --draft：干跑——跑完整 P0–P5，但不落盘（不写 spec/prepare/trace，不消耗 spec_version）
      const draft = args.flags.draft === true;
      return prepareSpec(text, {
        runner: fileRunner(candidatesFile.candidates ?? []),
        reviewer: fileReviewer(reviewsFile.reviews ?? []),
        redteam: minimalRedTeam(schema.ddl, attachmentStage?.dir),
        coverageExempt: covOpt.exempt,
        clausePattern: patOpt.pattern,
        clausePatternDeclared: patOpt.declared,
        reviewedClauses: (reviewsFile.reviews ?? []).map((r) => String(r?.source_clause ?? "")),
        materialIndex,
        schemaProbe,
        specId: `spec_${short(sha256(materialId))}`,
        title: args.flags.title ? String(args.flags.title) : undefined,
        domain: args.flags.domain ? String(args.flags.domain) : undefined,
        specVersion: args.flags["spec-version"] ? Number(args.flags["spec-version"]) : prevVersion + 1,
        // as_of 由调用方（= 这里）给：默认冻结时刻；--as-of 可显式钉快照时点
        asOf: { kind: "snapshot", value: asOf },
        engineVersion: "0.1.0",
        corpusVersion: CORPUS_VERSION,
        knownMaterialHashes: knownMaterialHashes(env, materialId),
      }).then((res): number => {
        if (metaWarning) res.diagnostics.push({ stage: "META", message: metaWarning });
        // #25a: persist bypass provenance with the frozen spec (not for --draft,
        // which writes nothing). specDir is deterministic from res.spec.spec_id.
        if (gate.bypass && !draft && res.spec?.spec_id) {
          // The spec directory may not exist yet on a FIRST prepare of a new
          // spec (writePrepareRecord creates it only in the ready branch
          // below, and a not-ready verdict writes nothing) — mkdir before
          // the atomic write or the tmp-file creation ENOENTs (0.110.2
          // engine defect, reproduced by supervision: fresh material +
          // --no-meta prepare crashed until the dir was hand-created).
          const bypassDir = specDir(env, String(res.spec.spec_id));
          mkdirSync(bypassDir, { recursive: true });
          writeJson(join(bypassDir, "meta-bypass.json"), gate.bypass);
        }
        if (draft) {
          const payload = {
            draft: true,
            verdict: res.verdict,
            spec_id: res.spec?.spec_id,
            spec_version: res.spec?.spec_version,
            rounds: res.rounds,
            units: res.units.length,
            rejected: res.rejected.length,
            // 0.110.0: structured rejection detail (additive). `rejected` stays
            // a count for one release for old consumers; it will be removed in a
            // later minor with an explicit breaking-change note in CHANGELOG.
            rejected_detail: res.rejected,
            materials_sha256: res.materials_sha256,
            diagnostics: res.diagnostics,
            ...(res.coverage ? { coverage: res.coverage } : {}),
            ...(metaWarning ? { meta_warning: metaWarning } : {}), ...(metaBypassed ? { meta_bypassed: true } : {}),
            record: null,
          };
          if (ctx.json) {
            console.log(JSON.stringify(payload));
            return res.verdict === "ready" ? 0 : 1;
          }
          out(ctx, `  · draft ${res.verdict}: ${res.units.length} candidate unit(s), ${res.rounds} round(s), ${res.rejected.length} rejected — nothing written`);
          for (const d of res.diagnostics) out(ctx, paint(C.dim, `    [${d.stage}] ${d.message}`, ctx.color));
          for (const r of res.rejected.slice(0, 5)) out(ctx, paint(C.dim, `    · [${r.stage}] ${r.reason}`, ctx.color));
          return res.verdict === "ready" ? 0 : 1;
        }
        const dir = specDir(env, `spec_${short(sha256(materialId))}`);
        const created = new Date().toISOString();
        const ready = res.verdict === "ready" && !!res.spec;
        const recordPath = writePrepareRecord(dir, ready, {
          material_id: materialId,
          created,
          verdict: res.verdict,
          rounds: res.rounds,
          rejected: res.rejected,
          diagnostics: res.diagnostics,
          materials_sha256: res.materials_sha256,
          clause_scope: clauseScopeOf(patOpt, res.coverage),
        }, created);
        if (ready && res.spec) {
          writeJson(join(dir, "spec.json"), res.spec);
          writeJson(join(dir, "trace.json"), {
            material_id: materialId,
            spec_id: res.spec.spec_id,
            spec_version: res.spec.spec_version,
            units: res.spec.vu.map((v) => ({ id: v.id, title: v.title, source_clause: v.source_clause, severity: v.severity, checker: v.checker.type, expected_from: v.expected_from })),
            rejected: res.rejected,
          });
        }
        if (ctx.json) {
          // record：脚本要「这次尝试落在哪个文件」时直接拿，不用自己拼 attempts 时间戳（r22 P3②）
          const record = relative(paths(env).root, recordPath).split(sep).join("/");
          console.log(JSON.stringify({ verdict: res.verdict, spec_id: res.spec?.spec_id, spec_version: res.spec?.spec_version, rounds: res.rounds, rejected: res.rejected.length, rejected_detail: res.rejected, diagnostics: res.diagnostics, ...(res.coverage ? { coverage: res.coverage } : {}), ...(metaWarning ? { meta_warning: metaWarning } : {}), ...(metaBypassed ? { meta_bypassed: true } : {}), record }));
          return res.verdict === "ready" ? 0 : 1;
        }
        if (res.verdict === "ready") {
          out(ctx, `  ✓ prepared & frozen: ${res.spec?.spec_id} v${res.spec?.spec_version}  (${res.spec?.vu.length} unit(s), ${res.rounds} round(s))`);
          out(ctx, paint(C.dim, "  next: verify run " + res.spec?.spec_id + " --db <snapshot.sqlite>", ctx.color));
          return 0;
        }
        out(ctx, paint(C.red, `  ✗ not ready: ${res.verdict} — ${res.diagnostics.map((d) => `[${d.stage}] ${d.message}`).join("; ")}`, ctx.color));
        out(ctx, paint(C.dim, `  · attempt recorded: ${recordPath}`, ctx.color));
        for (const r of res.rejected.slice(0, 5)) out(ctx, paint(C.dim, `    · [${r.stage}] ${r.reason}`, ctx.color));
        return 1;
      }).finally(() => attachmentStage?.cleanup());
    }

    case "run": {
      const specId = rest[0];
      const dbPath = String(args.flags.db || "");
      if (!specId || !dbPath) {
        bad(ctx, "usage: verify run <spec-id> --db <snapshot.sqlite> [--submission <dir>]");
        return 2;
      }
      const specFile = join(specDir(env, specId), "spec.json");
      if (!existsSync(specFile)) {
        bad(ctx, `spec not found: ${specId} (prepare first)`);
        return 1;
      }
      const spec = readJson<VerifySpec>(specFile);
      const submission = args.flags.submission ? String(args.flags.submission) : undefined;
      let snap: { path: string; sha256: string; source: string };
      try {
        snap = snapshotCopy(dbPath);
      } catch (e: any) {
        bad(ctx, `cannot snapshot --db: ${e?.message || e}`);
        return 1;
      }
      try {
        retainSnapshot(p.root, snap);
      } catch {
        // 快照留存失败不阻塞判定；只有 `--with snapshot` 归档会要求它
      }
      const runner = new SqliteRunner(snap.path);
      const fileScans: FileScanRecord[] = [];
      return runVerify(spec, { runner, submissionDir: submission, mode: "open", onFileScan: (r) => fileScans.push(r) })
        .then((report): number => {
          const withSource = { ...report, data_source: { kind: "sqlite-snapshot", sha256: snap.sha256, source: snap.source, captured_at: new Date().toISOString() } } as VerifyReport;
          withSource.payload_sha256 = payloadHash(withSource);
          const file = join(p.reports, `${report.run_id}.json`);
          writeJson(file, withSource);
          // #28: file-scan provenance (paths + per-file sha256). This is not
          // report evidence (contract 1.2 frozen); it rides as a workspace
          // sidecar and enters the archive as an item.
          let scanFile: string | undefined;
          if (fileScans.length) {
            mkdirSync(join(p.root, "submission-scans"), { recursive: true });
            scanFile = join(p.root, "submission-scans", `${report.run_id}.json`);
            writeJson(scanFile, { run_id: report.run_id, spec_id: report.spec_id, dir: submission, scans: fileScans });
          }
          let archived: { path: string; filename: string; archive_id: string; archive_sha256: string; zip_sha256: string } | undefined;
          let archiveError = "";
          if (args.flags["no-archive"] !== true) {
            try {
              archived = archiveRun(p.root, report.run_id, { id: String(report.spec_id), version: report.verifier.spec_version }, args.flags);
            } catch (e: any) {
              archiveError = e?.message || String(e);
            }
          }
          if (ctx.json) {
            console.log(JSON.stringify({
              run_id: report.run_id,
              spec_id: report.spec_id,
              spec_version: report.verifier.spec_version,
              overall: report.overall,
              summary: report.summary,
              report_path: file,
              archive: archived ?? null,
              archive_error: archiveError || undefined,
              submission_scan: scanFile
                ? { path: scanFile, files: fileScans.reduce((n, x) => n + x.matched.length, 0), dir: submission }
                : undefined,
            }));
          } else {
            out(ctx, `  ${report.overall === "PASS" ? paint(C.green, "PASS", ctx.color) : report.overall === "FAIL" ? paint(C.red, "FAIL", ctx.color) : paint(C.yellow, report.overall, ctx.color)}  ${report.run_id}`);
            out(ctx, paint(C.dim, `  ${scopeLine(report)}`, ctx.color));
            out(ctx, `  pass ${report.summary.pass} · fail ${report.summary.fail} · needs-material ${report.summary.needs_material} · error ${report.summary.error}`);
            const titles = new Map(spec.vu.map((u) => [u.id, u.title]));
            for (const v of report.vu) {
              const mark = v.verdict === "PASS" ? paint(C.green, "✓", ctx.color) : v.verdict === "FAIL" ? paint(C.red, "✗", ctx.color) : paint(C.yellow, "…", ctx.color);
              out(ctx, `    ${mark} ${v.id} ${v.verdict}${titles.get(v.id) ? `  ${titles.get(v.id)}` : ""}${"witness" in v && v.witness ? `  (scanned ${v.witness.rows_scanned} / matched ${v.witness.rows_matched})` : ""}`);
            }
            if (scanFile) {
              const n = fileScans.reduce((acc, x) => acc + x.matched.length, 0);
              out(ctx, paint(C.dim, `  submission scan: ${n} matched file(s) hashed → ${scanFile}`, ctx.color));
            }
            out(ctx, paint(C.dim, `  report: ${file}`, ctx.color));
            if (archived) out(ctx, paint(C.dim, `  archive: ${archived.path}  (${archived.archive_id})`, ctx.color));
            else if (archiveError) out(ctx, paint(C.red, `  ✗ archive failed: ${archiveError}`, ctx.color));
            else out(ctx, paint(C.dim, "  archive: skipped (--no-archive)", ctx.color));
          }
          return archiveError ? 1 : 0; // rc 只表达过程：FAIL 是有效结论；归档失败是过程错误
        })
        .catch((e: any): number => {
          bad(ctx, `run failed: ${e?.message || e}`);
          return 1;
        });
    }

    case "graduate": {
      const specId = rest[0];
      if (!specId) {
        bad(ctx, "usage: verify graduate <spec-id> [--min-runs N] [--min-span-days DAYS] [--every MIN --schedule] [--db <source>] [--patrol]");
        return 2;
      }
      const thresholds = {
        min_runs: args.flags["min-runs"] ? Number(args.flags["min-runs"]) : 3,
        min_span_days: args.flags["min-span-days"] ? Number(args.flags["min-span-days"]) : 30,
      };
      if (!Number.isInteger(thresholds.min_runs) || thresholds.min_runs < 1) {
        bad(ctx, "--min-runs must be a positive integer");
        return 2;
      }
      if (!Number.isFinite(thresholds.min_span_days) || thresholds.min_span_days < 0) {
        bad(ctx, "--min-span-days must be a non-negative number");
        return 2;
      }
      const every = args.flags.every ? Number(args.flags.every) : 0;
      const wantSchedule = args.flags.schedule === true;
      // 用法错误必须先于任何落盘（r25 P3①：旧实现先冻结记录再报 --every 缺失，rc=2 却已写盘）。
      if (wantSchedule && (!Number.isInteger(every) || every < 1)) {
        bad(ctx, "--schedule needs --every <minutes> (>= 1)");
        return 2;
      }
      let el;
      try {
        el = checkEligibility(env, specId, thresholds);
      } catch (e: any) {
        bad(ctx, e instanceof GraduationError ? e.message : `graduate failed: ${e?.message || e}`);
        return 1;
      }
      const patrol = args.flags.patrol === true;
      if (!el.ok) {
        // 拒绝时点名每一条不满足的条件——毕业不是"再跑一次试试"，是"条件够了才毕业"。
        bad(ctx, `not eligible for graduation: ${el.reasons.join("; ")}`);
        return 1;
      }
      if (patrol) {
        const pe = patrolEligibility(env, el.data_source);
        if (!pe.ok) {
          bad(ctx, `cannot graduate to patrol: ${pe.reason}`);
          return 1;
        }
      }
      // GitHub #9: a blank --db ("  ") was truthy, so it was recorded as
      // origin:"override" while the command itself fell back to the report's
      // source — the freeze record disagreed with what ran. A flag made only of
      // whitespace is the same as absent.
      const dbOverrideRaw = args.flags.db ? String(args.flags.db).trim() : "";
      const dbOverride = dbOverrideRaw || null;
      const cmd = jobCommand(specId, el.data_source?.source ?? null, dbOverride);
      // 来源不可直接执行时不能登记作业——否则作业每分钟 ENOENT 失败（blob 引用），
      // 或者更糟：报告数据经 shell 执行（r26 P1 注入面）。两种都拒绝，且不回显原串。
      if (wantSchedule && !cmd.usable) {
        const why = cmd.unsafe
          ? `the verified source contains shell-unsafe characters (${cmd.rejected ?? "?"}) — refusing to build a recurring command out of report data`
          : `the verified source is not an executable --db (${el.data_source?.source ?? "none"})`;
        bad(ctx, `cannot schedule: ${why}; pass --db <snapshot.sqlite> to choose the recurring database`);
        return 1;
      }
      let written;
      try {
        written = writeGraduation(env, el, thresholds);
      } catch (e: any) {
        bad(ctx, e instanceof GraduationError ? e.message : `graduate failed: ${e?.message || e}`);
        return 1;
      }
      const record = written.record; // 响应一律回冻结值，不回请求值（r25 Q2 / P3②）
      const payload: Record<string, unknown> = {
        graduated: true,
        duplicate: written.duplicate,
        spec_id: el.spec_id,
        spec_version: el.spec_version,
        run_ids: record.run_ids,
        span_days: record.span_days,
        thresholds: record.thresholds,
        history: record.history,
        record: written.path,
        job_command: cmd.command,
        job_command_usable: cmd.usable,
        job_command_unsafe: cmd.unsafe,
        job_command_rejected: cmd.rejected,
        // Q2 (r26): --db 只换常驻目标，不改变资格、冻结记录与 patrol 判定。
        db_override: dbOverride ?? null,
        patrol: patrol ? "eligible" : "not-requested",
      };
      const emit = (jobRow?: { id?: string; every?: number; retargeted?: boolean }): number => {
        if (jobRow) {
          payload.job_id = jobRow.id;
          payload.job_every_minutes = jobRow.every ?? every;
          if (jobRow.retargeted) payload.job_retargeted = true;
          // r28 Q2: 排期意图写进冻结记录，但只动 job_target 一个字段
          // （run_ids/thresholds/created/data_source 逐字节不变）。
          try {
            const beforeTarget = (() => {
              try {
                return readJson<{ job_target?: { db?: string; job_id?: string | null; every_minutes?: number; updated_at?: string } }>(graduationPath(env, el.spec_id)).job_target ?? null;
              } catch {
                return null;
              }
            })();
            const withTarget = attachJobTarget(env, el.spec_id, {
              db: cmd.db,
              origin: dbOverride ? "override" : "report",
              usable: cmd.usable,
              job_id: jobRow.id ?? null,
              every_minutes: jobRow.every ?? every,
            });
            const jt = withTarget.job_target!;
            payload.job_target = jt;
            payload.job_target_retargeted =
              !beforeTarget ||
              beforeTarget.db !== jt.db ||
              beforeTarget.job_id !== jt.job_id ||
              beforeTarget.every_minutes !== jt.every_minutes ||
              beforeTarget.updated_at !== jt.updated_at;
          } catch (e: any) {
            // 记录已冻结但排期字段写失败：作业已经登记成功，不能把 rc 变成失败，
            // 但必须出声——审计者需要知道记录与作业对不上。
            payload.job_target_error = e?.message || String(e);
          }
        }
        if (ctx.json) {
          console.log(JSON.stringify(payload, null, 2));
          return 0;
        }
        out(ctx, `  ✓ ${written.duplicate ? "already graduated" : "graduated"}: ${el.spec_id} v${el.spec_version}  (${record.run_ids.length} run(s), span ${record.span_days}d)`);
        out(ctx, `  history: ${record.history.reports_same_version} report(s) at this version, ${record.history.non_pass} non-PASS${record.history.last_non_pass ? ` (last: ${record.history.last_non_pass.run_id}=${record.history.last_non_pass.overall})` : ""}`);
        out(ctx, paint(C.dim, `  record: ${written.path}`, ctx.color));
        if (jobRow) out(ctx, paint(C.dim, `  scheduled: job ${jobRow.id} every ${payload.job_every_minutes} min${jobRow.retargeted ? " (existing job updated in place)" : ""}`, ctx.color));
        // issue #9: a failed job_target write used to be JSON-only — the human
        // path said "scheduled" and nothing else, so an operator reading the
        // terminal could not tell the frozen record no longer matches the job.
        // Issue #3: this line is independent of the next-action chain below —
        // hanging the chain off this `if` made a successful --schedule also
        // print "next: job add …", inviting a duplicate recursive job.
        if (payload.job_target_error) {
          out(ctx, paint(C.yellow, `  ! job_target not written: ${String(payload.job_target_error)}  (the record still holds the previous scheduling intent; the job itself was registered)`, ctx.color));
        }
        if (!jobRow) {
          if (cmd.unsafe) out(ctx, paint(C.yellow, `  note: the verified source contains shell-unsafe characters — not echoed; job_command is a placeholder and --schedule is refused. Pass --db <file> to pick the recurring database`, ctx.color));
          else if (!cmd.usable) out(ctx, paint(C.yellow, `  note: source ${el.data_source?.source ?? "none"} is not an executable --db; pass --db <file> to register a job`, ctx.color));
          else out(ctx, paint(C.dim, `  next: job add "verify ${specId}" --every ${every || "<min>"} -- ${cmd.command}`, ctx.color));
        }
        if (dbOverride && cmd.usable) {
          out(ctx, paint(C.yellow, `  note: --db only retargets the recurring job; the frozen record still names the verified source (${el.data_source?.source ?? "none"})`, ctx.color));
        }
        return 0;
      };
      if (!wantSchedule) return emit();
      const title = `verify ${specId}`;
      return getOrm(env.db.path)
        .then((ds) =>
          // 已存在同名作业 → 就地改写命令（--db 重定向必须真的生效，r27 P2-1）；
          // 不存在 → 新建。jobAdd 自己按 title 幂等，这里不再叠一层 force。
          writes.jobRetarget(ds, { title, command: cmd.command, every }).then((retargeted: any) =>
            retargeted
              ? retargeted
              : writes.jobAdd(ds, { title, command: cmd.command, every, at: "", force: false }).then((job: any) => ({ row: job?.row ?? job, changed: false })),
          ),
        )
        .then((outcome: any): number => {
          const row = outcome?.row ?? outcome;
          return emit({ id: row?.id, every: row?.every_minutes ?? row?.every, retargeted: !!outcome?.changed });
        })
        .catch((e: any): number => {
          bad(ctx, `cannot schedule: ${e?.message || e}`);
          return 1;
        });
    }

    case "list": {
      if (args.flags.unarchived === true) {
        const runs = unarchivedRuns(p.root);
        if (ctx.json) {
          console.log(JSON.stringify(runs, null, 2));
          return 0;
        }
        if (!runs.length) {
          out(ctx, paint(C.dim, "  every run is archived", ctx.color));
          return 0;
        }
        table(ctx, runs, ["run_id", "spec_id", "overall", "created"], []);
        return 0;
      }
      const dirs = existsSync(p.specs) ? readdirSync(p.specs) : [];
      const rows = dirs
        .filter((d) => existsSync(join(p.specs, d, "spec.json")))
        .map((d) => {
          const spec = readJson<VerifySpec>(join(p.specs, d, "spec.json"));
          const prep = existsSync(join(p.specs, d, "prepare.json")) ? readJson<any>(join(p.specs, d, "prepare.json")) : {};
          const reports = existsSync(p.reports) ? readdirSync(p.reports).filter((f) => f.endsWith(".json")).map((f) => readJson<VerifyReport>(join(p.reports, f))).filter((r) => r.spec_id === spec.spec_id) : [];
          const last = reports.sort((a, b) => String(a.finished).localeCompare(String(b.finished))).pop();
          return { spec_id: spec.spec_id, version: spec.spec_version, title: spec.title, units: spec.vu.length, material: prep.material_id ?? "", runs: reports.length, last_overall: last?.overall ?? "", last_run: last?.run_id ?? "" };
        });
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) {
        out(ctx, paint(C.dim, "  no specs yet — verify submit → verify prepare", ctx.color));
        return 0;
      }
      table(ctx, rows, ["spec_id", "version", "units", "runs", "last_overall", "title"], []);
      return 0;
    }

    case "report": {
      const target = rest[0];
      if (!target) {
        bad(ctx, "usage: verify report <run-id> | verify report import <report.json>");
        return 2;
      }
      if (target === "import") {
        const file = rest[1];
        if (!file) {
          bad(ctx, "usage: verify report import <report.json>");
          return 2;
        }
        if (!existsSync(file)) {
          bad(ctx, `report file not found: ${file}`);
          return 1;
        }
        let report: VerifyReport;
        try {
          report = readJson<VerifyReport>(file);
        } catch (e: any) {
          bad(ctx, `report is not valid JSON: ${e?.message || e}`);
          return 1;
        }
        const problems: string[] = [];
        // 先验形状：整份报告缺 verifier/summary 时给"形状不对"，不要把 TypeError 当结论
        if (!report || typeof report !== "object" || !report.verifier || !report.summary) {
          problems.push("malformed report: missing verifier/summary — not a ygl-trees verify report");
        }
        const declared = report.payload_sha256 ?? "";
        const actual = problems.length ? "" : payloadHash({ ...report, payload_sha256: undefined } as VerifyReport);
        if (!declared) problems.push("payload tampered: report carries no payload_sha256");
        else if (declared !== actual) problems.push("payload tampered: payload_sha256 does not match the file contents");
        // 形状不对就别再往下摸字段：早退，给出可读结论（rc=1）
        if (problems.length) {
          if (ctx.json) console.log(JSON.stringify({ imported: false, problems }));
          else for (const pr of problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
          return 1;
        }
        const bin = report.verifier.binary_sha256;
        const regFile = join(p.registrations, `${bin ? binaryKey(bin) : "unsigned"}.json`);
        if (bin) {
          if (!existsSync(regFile)) problems.push(`unknown verifier: binary ${String(bin).slice(0, 16)}… has no build registration`);
          else {
            const reg = readJson<{ spec_version?: number; engine_version?: string; corpus_version?: string }>(regFile);
            if (reg.spec_version !== undefined && report.verifier.spec_version !== undefined && reg.spec_version !== report.verifier.spec_version) problems.push(`version mismatch: report spec_version ${report.verifier.spec_version} ≠ registered ${reg.spec_version}`);
            if (reg.engine_version !== undefined && reg.engine_version !== report.verifier.engine_version) problems.push(`version mismatch: report engine_version ${report.verifier.engine_version} ≠ registered ${reg.engine_version}`);
            if (reg.corpus_version !== undefined && reg.corpus_version !== report.verifier.corpus_version) problems.push(`version mismatch: report corpus_version ${report.verifier.corpus_version} ≠ registered ${reg.corpus_version}`);
            // 签验：签名封包必须验过（认表不认报文）；unsigned 旧二进制不拦。
            const recorded = (reg as any).signature;
            if (recorded?.signed && !recorded?.verified) problems.push(`binary signature was never verified: ${String(recorded.key_id ?? "").slice(0, 16)}…`);
            const workspaceBin = join(p.binaries, `${binaryKey(bin)}.bin`);
            if (existsSync(workspaceBin)) {
              // r16 P2①：文件名之外再核内容身份——把 binaries/<sha>.bin 换成同 key 签名的另一封包，
              // 文件名仍然对得上，但字节不是报告指名的那个构建。
              try {
                const probe = readSealedBinary(readFileSync(workspaceBin));
                if (probe.binary_sha256 !== bin) problems.push(`binary identity mismatch: workspace copy is ${probe.binary_sha256.slice(0, 16)}… but the report names ${String(bin).slice(0, 16)}…`);
              } catch (e: any) {
                problems.push(`cannot read workspace binary: ${e?.message || e}`);
              }
            }
            if (recorded?.signed) {
              const table = expectKeyTable(args) ?? loadKeyTable(env, args);
              const binPath = join(p.binaries, `${binaryKey(bin)}.bin`);
              if (!existsSync(binPath)) problems.push("binary not found in the workspace: the signed build cannot be re-verified (re-register it)");
              else {
                try {
                  const sealed = readSealedBinary(readFileSync(binPath));
                  const verdict = verifySealSignature(sealed, table);
                  if (!verdict.ok) problems.push(`binary signature does not verify: ${verdict.problems.join("; ")}`);
                  if (report.verifier.public_key_fingerprint && sealed.footer.key_id && report.verifier.public_key_fingerprint !== sealed.footer.key_id) {
                    problems.push("key mismatch: report public_key_fingerprint ≠ sealed binary key_id");
                  }
                } catch (e: any) {
                  problems.push(`cannot re-verify signed binary: ${e?.message || e}`);
                }
              }
            }
          }
        }
        if (problems.length) {
          if (ctx.json) console.log(JSON.stringify({ imported: false, problems }));
          else for (const pr of problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
          return 1;
        }
        // 封包报告自带规范字节：注册过的二进制把内嵌 spec 落回 specs/，否则归档/导出
        // 会因为「spec 不在工作区」无解——报告 + 二进制是自描述包，工作区只是缓存。
        let specRestored: string | null = null;
        if (bin) {
          const key = binaryKey(bin);
          const binPath = join(p.binaries, `${key}.bin`);
          const specId = report.spec_id;
          const specPath = specId ? join(p.specs, specId, "spec.json") : null;
          if (binPath && existsSync(binPath) && specPath && !existsSync(specPath)) {
            try {
              const embedded = readSealedBinary(readFileSync(binPath));
              mkdirSync(dirname(specPath), { recursive: true });
              writeFileSync(specPath, embedded.spec_text, "utf8");
              specRestored = specPath;
            } catch (e: any) {
              problems.push(`registered binary ${short(key)} is unreadable: ${e?.message || e}`);
            }
          }
        }
        if (problems.length) {
          if (ctx.json) console.log(JSON.stringify({ imported: false, problems }));
          else for (const pr of problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
          return 1;
        }
        const stored = join(p.reports, `${report.run_id ?? `imported_${short(sha256(readFileSync(file)))}`}.json`);
        writeJson(stored, report);
        // 防御纵深（r26 P1）：报告是数据，但它的 data_source.source 会被毕业通道
        // 拼进 shell 命令。导入时对可疑形态出声——不拒绝（跨机绝对路径合法），
        // 只让"这串东西不像路径"在最早的位置可见。
        const importedSource = (report as any)?.data_source?.source;
        const sourceWarning =
          typeof importedSource === "string" && importedSource.length > 0 && !importedSource.startsWith("blob:") && !shellSafePath(importedSource)
            ? "data_source.source is not a plain filesystem path — graduation will refuse to schedule it"
            : null;
        if (ctx.json) {
          console.log(JSON.stringify({ imported: true, run_id: report.run_id, report_path: stored, spec_restored: specRestored, source_warning: sourceWarning }));
        } else {
          out(ctx, `  ✓ report imported: ${report.run_id} → ${stored}`);
          if (specRestored) out(ctx, `    spec restored from the sealed binary: ${specRestored}`);
          if (sourceWarning) out(ctx, paint(C.yellow, `  ! ${sourceWarning}`, ctx.color));
        }
        return 0;
      }
      const file = join(p.reports, `${target}.json`);
      if (!existsSync(file)) {
        bad(ctx, `report not found: ${target}`);
        return 1;
      }
      const report = readJson<VerifyReport>(file);
      if (ctx.json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      out(ctx, `  ${report.overall}  ${report.run_id}  (spec ${report.spec_id ?? "?"} v${report.verifier.spec_version})`);
      out(ctx, paint(C.dim, `  ${scopeLine(report)}`, ctx.color));
      out(ctx, `  pass ${report.summary.pass} · fail ${report.summary.fail} · needs-material ${report.summary.needs_material} · error ${report.summary.error}`);
      for (const v of report.vu) out(ctx, `    ${v.verdict}  ${v.id}`);
      return 0;
    }

    case "self-check": {
      return selfCheckCase(env, p.root, args);
    }

    case "archive": {
      const target = rest[0];
      if (!target) {
        bad(ctx, "usage: verify archive <run-id|spec-id> [--with materials|snapshot|binary|all] [--snapshot <db>] [--out <file>] | verify archive verify <file>");
        return 2;
      }
      if (target === "verify") {
        const file = rest[1];
        if (!file) {
          bad(ctx, "usage: verify archive verify <file.yglverify.zip>");
          return 2;
        }
        const res = verifyArchiveFile(file);
        if (ctx.json) {
          console.log(JSON.stringify({ ok: res.ok, archive_id: res.manifest?.archive_id ?? null, archive_sha256: res.manifest?.archive_sha256 ?? null, items: res.manifest?.items.length ?? 0, problems: res.problems, warnings: res.warnings }));
        } else if (res.ok) {
          out(ctx, `  ✓ archive verified: ${res.manifest?.archive_id}  (${res.manifest?.items.length} item(s), contract ${res.manifest?.contract_version})`);
        } else {
          for (const pr of res.problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
        }
        for (const w of res.warnings) out(ctx, paint(C.yellow, `  ! ${w}`, ctx.color));
        return res.ok ? 0 : 1;
      }
      let runId = target;
      if (target.startsWith("spec_")) {
        const reports = existsSync(p.reports)
          ? readdirSync(p.reports)
              .filter((f) => f.endsWith(".json"))
              .map((f) => readJson<VerifyReport>(join(p.reports, f)))
              .filter((r) => r.spec_id === target)
              .sort((a, b) => String(a.finished).localeCompare(String(b.finished)))
          : [];
        const last = reports.pop();
        if (!last) {
          bad(ctx, `no runs for spec ${target} — run it first`);
          return 1;
        }
        runId = String(last.run_id);
      }
      const reportFile = join(p.reports, `${runId}.json`);
      if (!existsSync(reportFile)) {
        bad(ctx, `run not found: ${runId}`);
        return 1;
      }
      const report = readJson<VerifyReport>(reportFile);
      try {
        const built = buildArchive({
          verifyRoot: p.root,
          runId,
          with: archiveWithOf(args.flags.with),
          out: args.flags.out ? String(args.flags.out) : undefined,
          // 跨实现报告（Rust 直跑）没有 retained 快照：允许显式交同一份 --db 字节，校验 sha 后入包
          snapshotSource: args.flags.snapshot ? String(args.flags.snapshot) : undefined,
        });
        appendRegistry(p.root, runId, { id: String(report.spec_id), version: report.verifier.spec_version }, {
          archive_id: built.manifest.archive_id,
          archive_sha256: built.manifest.archive_sha256,
          zip_sha256: built.zip_sha256,
          filename: built.filename,
          path: built.path,
          created: built.manifest.created,
          with: built.manifest.with,
        });
        if (ctx.json) {
          console.log(JSON.stringify({ run_id: runId, path: built.path, filename: built.filename, archive_id: built.manifest.archive_id, archive_sha256: built.manifest.archive_sha256, zip_sha256: built.zip_sha256, with: built.manifest.with, items: built.manifest.items.length }));
        } else {
          out(ctx, `  ✓ archived ${runId} → ${built.path}`);
          out(ctx, paint(C.dim, `    ${built.manifest.archive_id}  ${built.manifest.items.length} item(s)  with=${built.manifest.with.join(",")}`, ctx.color));
        }
        return 0;
      } catch (e: any) {
        bad(ctx, `archive failed: ${e?.message || e}`);
        return 1;
      }
    }

    case "meta": {
      // charter §4.1 v1 (0.111.0): verifier-repo admission gate. Rules R1-R3
      // are frozen in verify/core/src/meta.ts; verdict is PASS/FAIL, rc mirrors
      // it (0/1) because the report IS the artifact here.
      const repoArg = rest[0] ? String(rest[0]) : process.cwd();
      const given = resolve(repoArg);
      if (!existsSync(given)) {
        bad(ctx, `repo not found: ${repoArg}`);
        return 2;
      }
      // #25c: a verifier repo is identified by walking UP (git root / AGENTS.md /
      // verify/), so `verify meta <repo>/subdir` judges the repo, not the subdir.
      const repo = metaRepoRootOf(given) ?? given;
      const report = runMeta(repo);
      if (ctx.json) {
        console.log(JSON.stringify(report));
        return report.verdict === "PASS" ? 0 : 1;
      }
      head(ctx, `verify meta — ${repo}`);
      for (const r of report.rules) {
        const mark = r.verdict === "PASS" ? "✓" : "✗";
        const color = r.verdict === "PASS" ? C.green : C.red;
        out(ctx, paint(color, `  ${mark} ${r.id} ${r.title}`, ctx.color));
        if (r.verdict === "FAIL") out(ctx, paint(C.dim, `      ${JSON.stringify(r.evidence)}`, ctx.color));
      }
      out(ctx, `  meta_version ${report.meta_version} · verdict ${report.verdict}`);
      return report.verdict === "PASS" ? 0 : 1;
    }

    case "example": {
      // 0.110.0 (可发现性): examples are DERIVED from the frozen corpus by
      // scripts/gen-examples.mjs (explicit checker→case map; golden-tested by
      // verify-example.spec.ts). The payload self-declares its source so a
      // consumer can trace which corpus digest it came from.
      const want = args.flags.checker ? String(args.flags.checker) : "";
      const types = CHECKER_EXAMPLES.map((e) => e.checker);
      if (want && !types.includes(want)) {
        bad(ctx, `unknown checker '${want}' — the seven types are: ${types.join(", ")}`);
        return 2;
      }
      const examples = want ? CHECKER_EXAMPLES.filter((e) => e.checker === want) : CHECKER_EXAMPLES;
      const payload: Record<string, unknown> = { _derived_from: EXAMPLES_DERIVED_FROM, examples };
      if (args.flags["null-ops"]) payload.null_ops = NULL_OPS_NOTE;
      if (ctx.json) {
        console.log(JSON.stringify(payload));
        return 0;
      }
      out(ctx, paint(C.dim, `  ${EXAMPLES_DERIVED_FROM} — paste a vu under candidates[], then: verify lint-candidates <file>`, ctx.color));
      for (const ex of examples) {
        out(ctx, `\n  ## ${ex.checker} — case ${ex.case_id}${ex.expects ? `  (${ex.expects})` : ""}`);
        out(ctx, paint(C.dim, JSON.stringify(ex.vu, null, 2).split("\n").map((l) => `  ${l}`).join("\n"), ctx.color));
      }
      if (args.flags["null-ops"]) {
        out(ctx, `\n  ## null ops\n  ${NULL_OPS_NOTE.note}`);
        out(ctx, paint(C.dim, JSON.stringify(NULL_OPS_NOTE.example, null, 2).split("\n").map((l) => `  ${l}`).join("\n"), ctx.color));
      }
      return 0;
    }

    case "probe": {
      // charter §4.3 (0.112.0): the 16-probe union as a CLI command — review
      // evidence must come from a command, never from ad-hoc scripts (P2).
      if (!args.flags.matrix && !args.flags.only) {
        bad(ctx, "usage: verify probe --matrix [--target <sealed-binary>] [--only <probe>] [--json]");
        return 2;
      }
      const target = args.flags.target ? String(args.flags.target) : undefined;
      if (target && !existsSync(target)) {
        bad(ctx, `target not found: ${target}`);
        return 1;
      }
      const only = args.flags.only ? String(args.flags.only) : undefined;
      return runProbeMatrix({ target }).then((report): number => {
        let probes = report.probes;
        if (only) {
          probes = probes.filter((p) => p.probe === only);
          if (!probes.length) {
            bad(ctx, `unknown probe '${only}' — known: ${report.probes.map((p) => p.probe).join(", ")}`);
            return 2;
          }
        }
        const verdict = probes.every((p) => p.verdict === "PASS") ? "PASS" : "FAIL";
        const payload = { ...report, probes, verdict };
        if (ctx.json) {
          console.log(JSON.stringify(payload));
          return verdict === "PASS" ? 0 : 1;
        }
        head(ctx, `verify probe --matrix — ${report.target}`);
        for (const p of probes) {
          const ok = p.verdict === "PASS";
          out(ctx, paint(ok ? C.green : C.red, `  ${ok ? "✓" : "✗"} ${p.probe}`, ctx.color));
        }
        out(ctx, `  probe_version ${report.probe_version} · ${probes.length} probes · verdict ${verdict}`);
        return verdict === "PASS" ? 0 : 1;
      });
    }

    case "lint-candidates": {
      // 0.110.0: the prepare gate without the ceremony — no spec file, no
      // spec_version bump, no events. rc expresses process only (0/2); the
      // verdict lives in the payload. P1 is skipped (and declared) when
      // --text is absent because verbatim matching needs the frozen material.
      const file = rest[0];
      if (!file) {
        bad(ctx, "usage: verify lint-candidates <candidates.json> [--text <material>] [--db <snapshot.sqlite>] [--reviews <file>] [--coverage-exempt <file>] [--clause-pattern <regex>] [--json]");
        return 2;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (e: any) {
        bad(ctx, `cannot read candidates ${file}: ${e?.message || e}`);
        return 1;
      }
      const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
      if (!Array.isArray(candidates)) {
        bad(ctx, "candidates file must be a JSON array or { candidates: [...] }");
        return 2;
      }
      let materialText: string | undefined;
      if (args.flags.text !== undefined) {
        const t = String(args.flags.text);
        try {
          materialText = t === "-" ? readFileSync(0, "utf8") : readFileSync(t, "utf8");
        } catch (e: any) {
          bad(ctx, `cannot read --text ${t}: ${e?.message || e}`);
          return 1;
        }
      }
      let schema: ReturnType<typeof probeOfDb> | undefined;
      if (args.flags.db) {
        try {
          schema = probeOfDb(String(args.flags.db));
        } catch (e: any) {
          bad(ctx, `cannot probe --db ${args.flags.db}: ${e?.message || e}`);
          return 1;
        }
      }
      const covOpt = loadCoverageExempt(args);
      if (!covOpt.ok) {
        bad(ctx, covOpt.problem);
        return covOpt.code;
      }
      const patOpt = loadClausePattern(args);
      if (!patOpt.ok) {
        bad(ctx, patOpt.problem);
        return 2;
      }
      // #34: --reviews checks the 1:1 candidate↔review pairing (orphan reviews,
      // unreviewed candidates) — the same pairing prepare refuses to freeze without.
      let reviewedClauses: string[] | undefined;
      if (args.flags.reviews !== undefined) {
        const rp = String(args.flags.reviews);
        let rawReviews: any;
        try {
          rawReviews = JSON.parse(readFileSync(rp, "utf8"));
        } catch (e: any) {
          bad(ctx, `cannot read --reviews ${rp}: ${e?.message || e}`);
          return 1;
        }
        const list = Array.isArray(rawReviews) ? rawReviews : rawReviews?.reviews;
        if (!Array.isArray(list)) {
          bad(ctx, "reviews file must be a JSON array or { reviews: [...] }");
          return 2;
        }
        reviewedClauses = list.map((r: any) => String(r?.source_clause ?? ""));
      }
      const res = lintCandidates(candidates, { materialText, schema, coverageExempt: covOpt.exempt, clausePattern: patOpt.pattern, clausePatternDeclared: patOpt.declared, reviewedClauses });
      if (ctx.json) {
        console.log(JSON.stringify(res));
        return 0;
      }
      const skipped = [
        res.p1_skipped ? "P1 skipped: no --text" : "",
        res.schema_skipped ? "P2 schema skipped: no --db" : "",
      ].filter(Boolean);
      const skippedTail = skipped.length ? ` (${skipped.join("; ")})` : "";
      if (res.coverage) {
        const cov = res.coverage;
        out(
          ctx,
          paint(
            C.dim,
            cov.clauses
              ? `  coverage: ${cov.covered}/${cov.clauses} clause(s) covered, ${cov.exempted} exempt${cov.uncovered.length ? `, ${cov.uncovered.length} uncovered` : ""} (clauses = lines matching ${cov.pattern})`
              : `  coverage: SKIPPED — ${noClauseLinesMessage(cov.pattern)}`,
            ctx.color,
          ),
        );
      }
      if (res.ok) {
        const warnings = res.issues.length;
        out(ctx, `  ✓ candidates lint ok: ${res.checked} checked${warnings ? `, ${warnings} warning(s)` : ""}${skippedTail}`);
        return 0;
      }
      out(ctx, paint(C.red, `  ✗ candidates lint: ${res.issues.length}/${res.checked} rejected${skippedTail}`, ctx.color));
      for (const i of res.issues) out(ctx, paint(C.dim, `    #${i.index} [${i.stage}] ${i.source_clause}: ${i.reason}`, ctx.color));
      return 0;
    }

    case "register": {
      const file = rest[0];
      if (!file) {
        bad(ctx, "usage: verify register <sealed-binary> [--no-copy]");
        return 2;
      }
      if (!existsSync(file)) {
        bad(ctx, `sealed binary not found: ${file}`);
        return 1;
      }
      const bytes = readFileSync(file);
      let sealed: ReturnType<typeof readSealedBinary>;
      try {
        sealed = readSealedBinary(bytes);
      } catch (e: any) {
        bad(ctx, `not a sealed yglverify binary: ${e?.message || e}`);
        return 1;
      }
      const spec = sealed.spec as VerifySpec;
      // 签验：认表不认报文（302cb119 签名批口径 ④）——签名的封包没有可信表就拒绝登记；
      // 旧 unsigned 封包（0.98.0 产物）按 unsigned 处理并告警，不 fail。
      let sig: { signed: boolean; ok: boolean; problems: string[] } = { signed: false, ok: false, problems: [] };
      const table = expectKeyTable(args) ?? loadKeyTable(env, args);
      try {
        sig = verifySealSignature(sealed, table);
      } catch (e: any) {
        bad(ctx, `cannot verify seal signature: ${e?.message || e}`);
        return 1;
      }
      if (sig.signed && !sig.ok) {
        bad(ctx, `sealed binary signature does not verify: ${sig.problems.join("; ")}`);
        return 1;
      }
      const key = binaryKey(sealed.binary_sha256);
      const regPath = join(p.registrations, `${key}.json`);
      const reg = {
        binary_sha256: sealed.binary_sha256,
        binary_key: key,
        spec_id: spec.spec_id,
        spec_version: spec.spec_version,
        engine_version: sealed.footer.engine_version,
        corpus_version: sealed.footer.corpus_version,
        build_sha256: sealed.footer.build_sha256,
        spec_sha256: sealed.footer.spec_sha256,
        platform: process.platform,
        arch: process.arch,
        size: bytes.length,
        format_version: sealed.footer.format_version ?? null,
        signature: {
          signed: sig.signed,
          verified: sig.ok,
          scheme: sealed.footer.sig_alg ?? null,
          key_id: sealed.footer.key_id ?? null,
        },
        registered_at: new Date().toISOString(),
      };
      writeJson(regPath, reg);
      let copied: string | null = null;
      if (args.flags["no-copy"] !== true) {
        copied = join(p.binaries, `${key}.bin`);
        writeFileSync(copied, bytes);
      }
      if (ctx.json) {
        console.log(
          JSON.stringify({
            registered: true,
            binary_sha256: sealed.binary_sha256,
            registration: regPath,
            binary_path: copied,
            spec_id: reg.spec_id,
            spec_version: reg.spec_version,
            engine_version: reg.engine_version,
            corpus_version: reg.corpus_version,
          }),
        );
      } else {
        out(ctx, `  ✓ registered ${short(key)} — spec ${reg.spec_id} v${reg.spec_version}, engine ${reg.engine_version}`);
        out(ctx, `    registration: ${regPath}${copied ? `
    binary:       ${copied}` : ""}`);
      }
      return 0;
    }

    case "signature": {
      const file = rest[0];
      if (!file) {
        bad(ctx, "usage: verify signature <sealed-binary> [--expect-key <hex|file>] [--keys <file>]");
        return 2;
      }
      if (!existsSync(file)) {
        bad(ctx, `sealed binary not found: ${file}`);
        return 1;
      }
      let sealed: ReturnType<typeof readSealedBinary>;
      try {
        sealed = readSealedBinary(readFileSync(file));
      } catch (e: any) {
        bad(ctx, `not a sealed yglverify binary: ${e?.message || e}`);
        return 1;
      }
      const table = expectKeyTable(args) ?? loadKeyTable(env, args);
      const verdict = verifySealSignature(sealed, table);
      const payload = {
        file,
        binary_sha256: sealed.binary_sha256,
        format_version: sealed.footer.format_version ?? null,
        signed: verdict.signed,
        verified: verdict.ok,
        signing_scheme: sealed.footer.sig_alg ?? null,
        public_key_fingerprint: sealed.footer.key_id ?? null,
        problems: verdict.problems,
      };
      if (ctx.json) console.log(JSON.stringify(payload));
      else {
        out(ctx, `  ${file}`);
        out(ctx, `  binary   ${sealed.binary_sha256}`);
        out(ctx, `  signed   ${verdict.signed ? (verdict.ok ? "yes (verified)" : "yes (NOT verified)") : "no"}`);
        for (const p of verdict.problems) out(ctx, paint(C.dim, `  · ${p}`, ctx.color));
      }
      return verdict.signed && verdict.ok ? 0 : 1;
    }

    case "trace": {
      const specId = rest[0];
      if (!specId) {
        bad(ctx, "usage: verify trace <spec-id>");
        return 2;
      }
      const file = join(specDir(env, specId), "trace.json");
      if (!existsSync(file)) {
        bad(ctx, `trace not found: ${specId} (was the spec prepared?)`);
        return 1;
      }
      const trace = readJson<any>(file);
      if (ctx.json) {
        console.log(JSON.stringify(trace, null, 2));
        return 0;
      }
      out(ctx, `  ${trace.spec_id} v${trace.spec_version}  ← material ${trace.material_id}`);
      for (const u of trace.units ?? []) out(ctx, `    ${u.id} [${u.severity}] ${u.checker}  “${String(u.source_clause).slice(0, 48)}”`);
      for (const r of trace.rejected ?? []) out(ctx, paint(C.dim, `    ✗ [${r.stage}] ${r.reason}`, ctx.color));
      return 0;
    }

    case "export": {
      const specId = rest[0];
      if (!specId) {
        bad(ctx, "usage: verify export <spec-id> [--out <file>]");
        return 2;
      }
      const src = join(specDir(env, specId), "spec.json");
      if (!existsSync(src)) {
        bad(ctx, `spec not found: ${specId}`);
        return 1;
      }
      const spec = readJson<VerifySpec>(src);
      const target = args.flags.out ? String(args.flags.out) : join(process.cwd(), `${specId}.yglverify.json`);
      writeJson(target, spec);
      if (ctx.json) console.log(JSON.stringify({ spec_id: spec.spec_id, version: spec.spec_version, path: target, sha256: sha256(readFileSync(target)) }));
      else out(ctx, `  ✓ exported ${spec.spec_id} v${spec.spec_version} → ${target}`);
      return 0;
    }

    default: {
      if (action) {
        bad(ctx, `unknown verify action: ${action}`);
        return 2;
      }
      out(ctx, "usage: verify submit|prepare|run|graduate|register|list|report|report import|trace|export|archive|archive verify|self-check");
      return 0;
    }
  }
}

function archiveWithOf(raw: unknown): ArchiveWith[] {
  if (raw === undefined || raw === null || raw === true) return ["materials"];
  const parts = String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const out: ArchiveWith[] = [];
  for (const part of parts) {
    if (part === "all") {
      out.push(...ARCHIVE_WITH);
      continue;
    }
    if (!ARCHIVE_WITH.includes(part as ArchiveWith)) throw new Error(`unknown --with kind: ${part} (allowed: ${ARCHIVE_WITH.join("|")}|all)`);
    out.push(part as ArchiveWith);
  }
  return out.length ? out : ["materials"];
}

/** 默认归档；`--no-archive` 关闭。归档失败不回滚报告，只把 rc 置 1（过程错误）。 */
export function archiveRun(
  root: string,
  reportRunId: string,
  spec: { id: string; version: number },
  flags: Record<string, unknown>,
): { path: string; filename: string; archive_id: string; archive_sha256: string; zip_sha256: string } {
  const withKinds = archiveWithOf(flags.with);
  const built = buildArchive({ verifyRoot: root, runId: reportRunId, with: withKinds, out: flags.out ? String(flags.out) : undefined });
  appendRegistry(root, reportRunId, spec, {
    archive_id: built.manifest.archive_id,
    archive_sha256: built.manifest.archive_sha256,
    zip_sha256: built.zip_sha256,
    filename: built.filename,
    path: built.path,
    created: built.manifest.created,
    with: built.manifest.with,
  });
  return { path: built.path, filename: built.filename, archive_id: built.manifest.archive_id, archive_sha256: built.manifest.archive_sha256, zip_sha256: built.zip_sha256 };
}

function mimeOf(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

/** 建表 DDL → prepare 的 schema 探针（表 → 列名）。 */
export function probeOf(ddl: string[]): { tables: Record<string, string[]> } {
  const tables: Record<string, string[]> = {};
  for (const sql of ddl) {
    const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z0-9_]+)["'`\]]?\s*\(([\s\S]*)\)/i);
    if (!m) continue;
    const cols: string[] = [];
    for (const raw of m[2].split(/,(?![^()]*\))/)) {
      const line = raw.trim();
      if (!line || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
      const name = line.match(/^["'`\[]?([A-Za-z0-9_]+)["'`\]]?/);
      if (name) cols.push(name[1]);
    }
    tables[m[1]] = cols;
  }
  return { tables };
}

/**
 * 快照库真实列 → prepare 的 schema 探针（PRAGMA table_info，0.104.0）。
 *
 * `probeOf(ddl)` 解析的是 `sqlite_master.sql` 里的 CREATE 语句，`ALTER TABLE … ADD COLUMN`
 * 加的列不在那条原始 DDL 文本里——结构上正确、数据里存在的列会被 P2 误判「列不在 schema」。
 * 探针必须问数据库要真实 schema（PRAGMA 认全部列与类型），DDL 文本只留给红队建空库。
 */
export function probeOfDb(dbPath: string): { tables: Record<string, string[]> } {
  const db = openDatabaseSync(dbPath, { readOnly: true });
  try {
    const tables: Record<string, string[]> = {};
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    for (const { name } of names) {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
      tables[name] = cols.map((c) => c.name);
    }
    return { tables };
  } finally {
    db.close();
  }
}

export function latestVersionOf(env: Env, materialId: string): number {
  const dir = specDir(env, `spec_${short(sha256(materialId))}`);
  const file = join(dir, "spec.json");
  if (!existsSync(file)) return 0;
  try {
    return Number(readJson<VerifySpec>(file).spec_version ?? 0);
  } catch {
    return 0;
  }
}

export function knownMaterialHashes(env: Env, currentMaterialId: string): string[] {
  const dir = paths(env).materials;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d !== currentMaterialId)
    .map((d) => {
      try {
        return readJson<MaterialRecord>(join(dir, d, "material.json")).text_sha256;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}
