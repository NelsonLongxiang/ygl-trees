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
import { jcsCanonical } from "./jcs";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { openDatabaseSync } from "../../../verify/core/src/sqlite-bindings";

import type { Env } from "../../../core/database/src/types";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";
import { bad, C, head, ok, out, paint, table } from "../../../core/text/src/fmt";
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
import { appendRegistry, ARCHIVE_WITH, buildArchive, readArchiveReport, retainSnapshot, unarchivedRuns, verifyArchiveBytes, verifyArchiveFile } from "./archive";
import { BLOB_LIMIT, blobPath, mimeFor, putBlob, putBlobFromFile } from "./blob-store";
import { binaryKey, readSealedBinary, verifySealSignature } from "./sealed-binary";
import { attachJobTarget, checkEligibility, GraduationError, graduationPath, jobCommand, patrolEligibility, shellSafePath, writeGraduation } from "./graduate";
import type { SigningKeyTable } from "../../../verify/core/src/signature";
import { fingerprintOfRawPublicKey, SIGNING_SCHEME } from "../../../verify/core/src/signature";

const KINDS = ["materials", "specs", "reports", "registrations", "binaries", "trees", "tree-reports"] as const;

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
    trees: join(root, "trees"),
    "tree-reports": join(root, "tree-reports"),
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
  /** #62: set when submit normalized a UTF-8 BOM (id still hashes the text). */
  text_encoding?: string;
}

/** #62: material text must be UTF-8. A UTF-8 BOM is stripped (and recorded);
 *  UTF-16 (BOM or NUL pattern) is refused by name so a mojibake material never
 *  freezes and later produces a misleading P1 "fabricated criterion". */
export function decodeMaterialText(buf: Buffer): { ok: true; text: string; encoding?: string } | { ok: false; reason: string } {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { ok: false, reason: "材料编码非 UTF-8（检出 UTF-16 BOM）——请转码为 UTF-8 后重交" };
  }
  // UTF-16 without BOM: ASCII-ish material shows a NUL every other byte.
  if (buf.length >= 8) {
    let nul = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) nul++;
    if (buf.length % 2 === 0 && nul / buf.length > 0.05) {
      return { ok: false, reason: "材料编码非 UTF-8（检出 UTF-16/NUL 字节）——请转码为 UTF-8 后重交" };
    }
  }
  let body = buf;
  let encoding: string | undefined;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    body = buf.subarray(3);
    encoding = "utf-8-bom-stripped";
  }
  const text = body.toString("utf8");
  // Node replaces invalid UTF-8 with U+FFFD; round-trip catches it.
  if (!Buffer.from(text, "utf8").equals(body)) {
    return { ok: false, reason: "材料字节不是合法 UTF-8——请转码为 UTF-8 后重交" };
  }
  return { ok: true, text, encoding };
}

/** A1 契约 v1.0（docs/reviews/verify-tree-run-contract.md）：树 spec 冻结面。 */
export interface TreeSpecNode {
  id: string;
  kind: "leaf" | "group";
  spec_id?: string;
  spec_version?: number;
  /** optional frozen snapshot binding (contract v1.1 V21) */
  db?: string;
  aggregate?: string;
  children?: string[];
}
export interface TreeSpec {
  tree_spec_id: string;
  tree_spec_version: 1;
  tree_spec_sha256: string;
  source_material_id: string;
  title: string;
  created: string;
  root: string;
  nodes: TreeSpecNode[];
  pinned: Record<string, string>;
  /** Q8（v1.2 §2.1）：冻结的 target 投影 {kind,id,sha256?}——prepare 期钉死，
   *  进 canonical digest；run 期以此为基准比对全叶 data_source。 */
  target?: { kind: string; id: string; sha256?: string };
  /** Q8：subject = repo + commit（跨 repo/commit 不声称可比）。 */
  subject?: { repo: string; commit: string };
  /** G8（v1.2 §0）：tree spec 冻结引擎/语料/契约版本——prepare 期校验实况。 */
  engine_version?: string;
  corpus_version?: string;
  contract_version?: string;
}

/** Freeze-time validation (A1 §3.1): everything invalid → rc=2. */
function validateTreeSpec(
  raw: any,
  materialId: string,
  title: string,
  specExists: (id: string) => boolean
): { spec?: TreeSpec; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "tree spec must be a JSON object" };
  if (raw.tree_spec_version !== 1) return { error: "tree_spec_version must be 1" };
  if (typeof raw.root !== "string" || !raw.root) return { error: "root must be a node id" };
  // Q8：target 投影（kind+id 恒定，sha256 可选）
  let target: { kind: string; id: string; sha256?: string } | undefined;
  if (raw.target !== undefined) {
    if (!raw.target || typeof raw.target !== "object") return { error: "target must be {kind,id[,sha256]}" };
    if (typeof raw.target.kind !== "string" || !raw.target.kind) return { error: "target.kind required" };
    if (typeof raw.target.id !== "string" || !raw.target.id) return { error: "target.id required" };
    if (raw.target.sha256 !== undefined && (typeof raw.target.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.target.sha256))) {
      return { error: "target.sha256 must be sha256:<64hex>" };
    }
    target = { kind: raw.target.kind, id: raw.target.id, ...(raw.target.sha256 ? { sha256: raw.target.sha256 } : {}) };
  }
  if (!Array.isArray(raw.nodes) || !raw.nodes.length) return { error: "nodes must be a non-empty array" };
  const nodes: TreeSpecNode[] = [];
  const byId = new Map<string, TreeSpecNode>();
  for (const n of raw.nodes) {
    if (!n || typeof n !== "object") return { error: "node must be an object" };
    if (typeof n.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(n.id)) return { error: "bad node id: " + String(n.id) };
    if (byId.has(n.id)) return { error: "duplicate node id: " + n.id };
    if (n.kind !== "leaf" && n.kind !== "group") return { error: "node " + n.id + ": kind must be leaf|group" };
    const node: TreeSpecNode = { id: n.id, kind: n.kind };
    if (n.kind === "leaf") {
      if (typeof n.spec_id !== "string" || !n.spec_id) return { error: "leaf " + n.id + ": spec_id required" };
      if (!specExists(n.spec_id)) return { error: "leaf " + n.id + ": spec not found: " + n.spec_id + " (prepare it first)" };
      node.spec_id = n.spec_id;
      if (Number.isInteger(n.spec_version)) node.spec_version = n.spec_version;
      if (n.db !== undefined) {
        if (typeof n.db !== "string" || !n.db) return { error: "leaf " + n.id + ": db must be a snapshot path" };
        node.db = n.db;
      }
      if (n.children !== undefined) return { error: "leaf " + n.id + ": children not allowed" };
    } else {
      if (!Array.isArray(n.children) || (n.children as any[]).some((c) => typeof c !== "string")) {
        return { error: "group " + n.id + ": children must be an array of node ids" };
      }
      if (!n.children.length) return { error: "group " + n.id + ": empty group rejected (Q6)" };
      const agg = String(n.aggregate ?? "");
      if (agg === "all_pass" || agg === "count_fail") {
        node.aggregate = agg;
      } else {
        const qm = /^quorum\(([0-9]+)\)$/.exec(agg);
        if (!qm) return { error: "group " + n.id + ": unknown aggregate '" + agg + "' (want all_pass|count_fail|quorum(N))" };
        const q = Number(qm[1]);
        if (!Number.isInteger(q) || q < 1 || q > n.children.length) {
          return { error: "group " + n.id + ": quorum(N) needs 1 <= N <= " + n.children.length };
        }
        node.aggregate = "quorum(" + q + ")";
      }
      node.children = [...n.children];
    }
    nodes.push(node);
    byId.set(node.id, node);
  }
  // reachability + dangling + cycle + depth (Q7 = 16)
  const seen = new Set<string>();
  const stack = new Set<string>();
  const walk = (id: string, depth: number): string | null => {
    if (depth > 16) return "tree depth exceeds 16 at node " + id + " (Q7)";
    if (stack.has(id)) return "cycle detected at node " + id;
    if (seen.has(id)) return "node reached twice: " + id;
    const n = byId.get(id);
    if (!n) return "dangling child reference: " + id;
    stack.add(id);
    seen.add(id);
    for (const c of n.children ?? []) {
      const err = walk(c, depth + 1);
      if (err) return err;
    }
    stack.delete(id);
    return null;
  };
  const walkErr = walk(raw.root, 0);
  if (walkErr) return { error: walkErr };
  if (seen.size !== nodes.length) {
    const missing = nodes.map((n) => n.id).filter((id) => !seen.has(id));
    return { error: "unreachable node(s) from root: " + missing.join(", ") };
  }
  // pinned frozen at prepare (v0.3 R-2): leaf ids only, sha256 shape.
  const pinned: Record<string, string> = {};
  if (raw.pinned !== undefined) {
    if (!raw.pinned || typeof raw.pinned !== "object" || Array.isArray(raw.pinned)) {
      return { error: "pinned must be an object {nodeId: sha256}" };
    }
    for (const [nid, sha] of Object.entries(raw.pinned as Record<string, unknown>)) {
      const node = byId.get(nid);
      if (!node) return { error: "pinned target not found: " + nid };
      if (node.kind !== "leaf") return { error: "pinned target must be a leaf: " + nid };
      if (typeof sha !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/.test(sha)) {
        return { error: "pinned " + nid + ": sha256 must be 64 lowercase hex chars (optionally sha256: prefix)" };
      }
      pinned[nid] = sha.startsWith("sha256:") ? sha : "sha256:" + sha;
    }
  }
  // Q8/G8：canonical 覆盖 root/nodes/pinned/target/subject/engine pin——
  // 冻结主体与引擎面，任何一项变化都换新 tree_spec_id。
  const subject = raw.subject && typeof raw.subject === "object"
    ? { repo: String(raw.subject.repo ?? ""), commit: String(raw.subject.commit ?? "") }
    : undefined;
  const canonical = jcsCanonical({
    root: raw.root,
    nodes: nodes.slice().sort((a, b) => a.id.localeCompare(b.id)),
    pinned,
    target: target ?? null,
    subject: subject ?? null,
    engine_version: raw.engine_version !== undefined ? String(raw.engine_version) : null,
    corpus_version: raw.corpus_version !== undefined ? String(raw.corpus_version) : null,
    contract_version: raw.contract_version !== undefined ? String(raw.contract_version) : null,
  });
  const digest = sha256(canonical);
  return {
    spec: {
      tree_spec_id: "ts_" + short(digest),
      tree_spec_version: 1,
      tree_spec_sha256: digest,
      source_material_id: materialId,
      title,
      created: new Date().toISOString(),
      root: raw.root,
      nodes,
      pinned,
      ...(target ? { target } : {}),
      ...(subject ? { subject } : {}),
      ...(raw.engine_version !== undefined ? { engine_version: String(raw.engine_version) } : {}),
      ...(raw.corpus_version !== undefined ? { corpus_version: String(raw.corpus_version) } : {}),
      ...(raw.contract_version !== undefined ? { contract_version: String(raw.contract_version) } : {}),
    },
  };
}


/** 树节点五值映射（v1.2 §2.4）：叶 report 的 ERROR/NEEDS-MATERIAL 不进 nodes[].verdict
 *  的五值枚举——映射到 INFRA_BLOCKED（保守：既非通过也非业务失败），原四值留在
 *  report_verdict 供审计。 */
export function toTreeVerdict(reportOverall: string): string {
  const v = String(reportOverall).toUpperCase();
  if (v === "PASS" || v === "FAIL") return v;
  // ERROR / NEEDS-MATERIAL / 其他 → INFRA_BLOCKED（树五值内最保守）
  return "INFRA_BLOCKED";
}

/** A1 五值聚合（契约 v1.2 Q10-B）：全序 NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS。
 *
 *  算法 = 基础结果（算子+遮蔽序）→ Q10-B cap（只封顶 PASS，不降级 FAIL）。
 *  STALE：沿父链传播、阻断 PASS（不稀释 FAIL——被遮蔽的 FAIL 在 nodes[]/审计可见）。
 *  quorum 分母只计 PASS+FAIL（ERROR/NEUTRALIZED/STALE 不进分母）。
 *  纯函数，导出以便单测直接钉 5×5 矩阵。 */
export function aggregateTreeVerdict(op: string, verdicts: string[]): string {
  const vs = verdicts.map((v) => String(v).toUpperCase());
  // ── 第 1 步：基础结果（不看 ERROR cap；按算子 + 全序遮蔽）──
  // NEUTRALIZED > STALE 恒最高（阻断 PASS，不稀释 FAIL——被遮蔽 FAIL 在 nodes[] 可见）
  if (vs.includes("NEUTRALIZED")) return "NEUTRALIZED";
  if (vs.includes("STALE")) return "STALE";
  let base: string;
  if (op.startsWith("quorum(")) {
    const n = Number(op.slice(7, -1));
    const pass = vs.filter((v) => v === "PASS").length;
    const fail = vs.filter((v) => v === "FAIL").length;
    // 分母只计 PASS+FAIL；ERROR/NEUTRALIZED/STALE 不进分母
    if (pass >= n) base = "PASS";
    else if (fail > 0 || pass > 0) base = "FAIL";
    else base = "INFRA_BLOCKED";
  } else if (vs.includes("FAIL")) {
    base = "FAIL"; // any FAIL → FAIL（非 quorum 算子）
  } else if (vs.includes("ERROR")) {
    base = "INFRA_BLOCKED"; // 无 FAIL 但有 ERROR → 不可判定（Q10-B 前身）
  } else if (vs.length > 0 && vs.every((v) => v === "PASS")) {
    base = "PASS";
  } else {
    base = "INFRA_BLOCKED"; // NEEDS-MATERIAL / 空子集 → 保守 INFRA_BLOCKED
  }
  // ── 第 2 步：Q10-B cap——只封顶 PASS，不降级 FAIL/INFRA_BLOCKED ──
  // 裁定补正（fdc 2026-10-25）：cap 只作用于 PASS。FAIL+ERROR=FAIL、FAIL+INFRA_BLOCKED=FAIL、
  // PASS+ERROR=INFRA_BLOCKED。quorum 基础 PASS 被 cap；基础 FAIL 保持 FAIL。
  if (base === "PASS" && (vs.includes("ERROR") || vs.includes("INFRA_BLOCKED"))) {
    return "INFRA_BLOCKED";
  }
  return base;
}

/** A1 tree run：叶真跑（runVerify+archive）或 pinned 归档回读，后序聚合，写树报告。
 *  组层自 0.114.20 起生成真实 report+archive（合成 spec + buildArchive
 *  skipMaterials + registry 登记）；v1.2 五态（STALE）与 JCS digest 待 Q10 返工。 */
async function treeRun(env: Env, ctx: any, spec: TreeSpec, args: any): Promise<number> {
  const p = paths(env);
  // G1/G2（Q8/Q9）：target 投影 = {kind, id, sha256?}；kind+id 恒比，声明 sha 时才比。
  // 缺被比字段 → fail-closed stale。声明 target 的叶失配 → 该叶 STALE 沿父链传播。
  // Q12-B：本轮开始时间——pinned 归档 created 必须早于此值（同轮自引用拒绝）。
  const roundStartedAt = new Date().toISOString();
  // Q8：两条来源——① --target 字符串（run 期覆盖）② spec.target 冻结对象（prepare 期声明）。
  // 冻结对象若被 String() 会变 "[object Object]"，故必须分开处理。
  let target: { kind: string; id: string; sha256?: string } | null = null;
  if (args.flags.target !== undefined) {
    const targetRaw = String(args.flags.target);
    const hashIdx = targetRaw.indexOf("#");
    const base = hashIdx >= 0 ? targetRaw.slice(0, hashIdx) : targetRaw;
    const sha = hashIdx >= 0 ? targetRaw.slice(hashIdx + 1) : undefined;
    const colon = base.indexOf(":");
    if (colon <= 0) { bad(ctx, "usage: --target <kind>:<id>[#sha256]"); return 2; }
    target = { kind: base.slice(0, colon), id: base.slice(colon + 1), ...(sha ? { sha256: sha } : {}) };
  } else {
    const frozen = (spec as any).target;
    if (frozen && typeof frozen === "object" && typeof frozen.kind === "string" && typeof frozen.id === "string") {
      target = { kind: frozen.kind, id: frozen.id, ...(frozen.sha256 ? { sha256: frozen.sha256 } : {}) };
    }
  }
  const dbFlag = args.flags.db;
  const dbArgs: string[] = Array.isArray(dbFlag) ? dbFlag.map(String) : dbFlag ? [String(dbFlag)] : [];
  const byNode: Record<string, string> = {};
  let defaultDb = "";
  for (const d of dbArgs) {
    const i = d.indexOf("=");
    if (i > 0) byNode[d.slice(0, i)] = d.slice(i + 1);
    else defaultDb = d;
  }
  const nodeById = new Map(spec.nodes.map((n) => [n.id, n]));
  const snapshots = new Map<string, { path: string; sha256: string; source: string }>();
  const getSnapshot = (file: string) => {
    if (!snapshots.has(file)) {
      const snap = snapshotCopy(file);
      retainSnapshot(p.root, snap);
      snapshots.set(file, snap);
    }
    return snapshots.get(file)!;
  };
  const nodes: any[] = [];
  const pinnedShas: Record<string, string> = { ...spec.pinned };
  const failed: string[] = [];
  const evalNode = async (id: string): Promise<string> => {
    const n = nodeById.get(id);
    if (!n) throw new Error("tree node missing: " + id);
    if (n.kind === "group") {
      const childVerdicts: string[] = [];
      for (const c of n.children ?? []) childVerdicts.push(await evalNode(c));
      const verdict = aggregateTreeVerdict(String(n.aggregate), childVerdicts);
      // §3.1/S-3: every level is a real report + archive. A group report is a
      // standard-shaped VerifyReport whose asserts are the children; the tree
      // verdict rides in the additive `tree` envelope (archive verifier checks
      // the standard fold, which stays consistent for PASS/FAIL/ERROR).
      let groupReportId: string | null = null;
      let groupArchive: any = null;
      try {
        const gSpecId = "treeg_" + short(spec.tree_spec_id) + "_" + String(n.id).replace(/[^A-Za-z0-9_.-]/g, "_");
        const now = new Date().toISOString();
        const gSpec = {
          contract_version: "1.2", spec_id: gSpecId, spec_version: 1, title: "tree group " + n.id,
          domain: "tree", created: now, runtime_min: "",
          verifier: { engine_version: String((env as any).version || "0.114.19"), corpus_version: "1.2" },
          as_of: { kind: "snapshot", value: "1970-01-01T00:00:00.000Z" },
          vu: [], attachments: [], sealed: { review: false },
        };
        mkdirSync(join(p.specs, gSpecId), { recursive: true });
        writeJson(join(p.specs, gSpecId, "spec.json"), gSpec);
        const childNodes = nodes.filter((x) => (n.children ?? []).includes(x.node_id));
        const vu = childNodes.map((c) => ({
          id: c.node_id, role: "assert" as const,
          // NEUTRALIZED is tree-only; fold sees ERROR so it can never look PASS.
          verdict: c.verdict === "NEUTRALIZED" ? "ERROR" : c.verdict,
          severity: "S3" as const, source_clause: "tree child " + c.node_id,
          checker_type: "command" as const,
        }));
        const hasFail = vu.some((v) => v.verdict === "FAIL");
        const hasErr = vu.some((v) => v.verdict === "ERROR");
        const hasPass = vu.some((v) => v.verdict === "PASS");
        const overall = hasFail ? "FAIL" : hasErr ? "ERROR" : hasPass ? "PASS" : "NEEDS-MATERIAL";
        const summary = {
          pass: vu.filter((v) => v.verdict === "PASS").length,
          fail: vu.filter((v) => v.verdict === "FAIL").length,
          needs_material: vu.filter((v) => v.verdict === "NEEDS-MATERIAL").length,
          error: vu.filter((v) => v.verdict === "ERROR").length,
        };
        const gRunId = "run_" + short(sha256(spec.tree_spec_id + "|" + n.id + "|" + Date.now().toString(36) + Math.random().toString(36)));
        const gReport: any = {
          contract_version: "1.2", run_id: gRunId, spec_id: gSpecId, started: now, finished: now,
          verifier: { mode: "open", engine_version: gSpec.verifier.engine_version, spec_version: 1, corpus_version: "1.2", sealed_review: false },
          as_of: gSpec.as_of, summary, overall, reason: "tree group aggregation (" + n.aggregate + ")",
          vu, exceptions: [],
          tree: { tree_spec_id: spec.tree_spec_id, node_id: n.id, verdict, aggregate: n.aggregate },
        };
        gReport.payload_sha256 = payloadHash(gReport);
        writeJson(join(p.reports, gRunId + ".json"), gReport);
        groupReportId = gRunId;
        if (args.flags["no-archive"] !== true) {
          const built = buildArchive({ verifyRoot: p.root, runId: gRunId, with: [], skipMaterials: true });
          appendRegistry(p.root, gRunId, { id: gSpecId, version: 1 }, {
            archive_id: built.manifest.archive_id, archive_sha256: built.manifest.archive_sha256,
            zip_sha256: built.zip_sha256, filename: built.filename, path: built.path,
            created: built.manifest.created, with: built.manifest.with,
          });
          groupArchive = { archive_sha256: built.manifest.archive_sha256, path: built.path };
        }
      } catch (e: any) {
        groupArchive = { error: e?.message || String(e) };
      }
      nodes.push({
        node_id: n.id, kind: "group", aggregate: n.aggregate, children: n.children, verdict,
        report_id: groupReportId, archive_sha256: groupArchive?.archive_sha256 ?? null,
        ...(groupArchive?.path ? { archive_path: groupArchive.path } : {}),
        ...(groupArchive?.error ? { archive_error: groupArchive.error } : {}),
      });
      return verdict;
    }
    const pinnedShaRaw = pinnedShas[n.id];
    const pinnedSha = pinnedShaRaw ? (pinnedShaRaw.startsWith("sha256:") ? pinnedShaRaw : "sha256:" + pinnedShaRaw) : "";
    if (pinnedSha) {
      const arcDir = join(p.root, "archives");
      let entryPath = "";
      let entryZip = "";
      let entryCreated = "";
      try {
        for (const f of readdirSync(arcDir)) {
          if (!f.endsWith(".json")) continue;
          const reg = readJson<any>(join(arcDir, f));
          const hit = (reg?.archives ?? []).find((a: any) => a?.archive_sha256 === pinnedSha);
          if (hit?.path) {
            entryPath = String(hit.path);
            entryZip = String(hit.zip_sha256 ?? "");
            entryCreated = String(hit.created ?? "");
            break;
          }
        }
      } catch { /* no registry */ }
      // Q12-B：同轮自引用拒绝——pinned 归档必须在本轮 started 之前创建。
      // （检查放在 registry 扫描的 try 之外：这里是判定，不是读盘容错。）
      if (entryPath && entryCreated && entryCreated >= roundStartedAt) {
        throw new Error(
          "pinned " + n.id + ": archive " + pinnedSha + " was created at " + entryCreated +
          " >= this round's start (" + roundStartedAt + ") — same-round self-reference is rejected (Q12-B). " +
          "Run the child in an earlier round, then pin its archive.",
        );
      }
      if (!entryPath) {
        // Q12-B/Q13-A：pinned 必须来自**本 workspace 已完成的 run**。找不到时
        // 不区分「没跑过」和「跨 workspace」，错误文本给两条出处指引。
        throw new Error(
          "pinned " + n.id + ": archive not found for " + pinnedSha +
          " (Q12-B: pinned must come from a COMPLETED run in this workspace; " +
          "Q13-A: cross-workspace archives are rejected — run the child here first, archive verify it, then pin)",
        );
      }
      const zipMutated = !!(entryZip && sha256(readFileSync(entryPath)) !== entryZip);
      if (zipMutated) {
        nodes.push({ node_id: n.id, kind: "leaf", spec_id: n.spec_id, pinned: true, archive_sha256: pinnedSha, verdict: "NEUTRALIZED", stale: false, neutralized_reason: "archive zip_sha256 mismatch (mutated after archiving)" });
        return "NEUTRALIZED";
      }
      const av = verifyArchiveFile(entryPath);
      if (!av.ok) {
        // S-6: a tampered child archive neutralizes its subtree — never a silent
        // drop and never a PASS.
        nodes.push({ node_id: n.id, kind: "leaf", spec_id: n.spec_id, pinned: true, archive_sha256: pinnedSha, verdict: "NEUTRALIZED", stale: false, neutralized_reason: av.problems[0] ?? "archive verify failed" });
        return "NEUTRALIZED";
      }
      const rep = readArchiveReport(entryPath);
      // Q9（语义主体在 pinned）：pinned report 的 target/spec_version 也要与冻结面比对；
      // 缺被比字段 fail-closed 判 stale。
      let pinnedStale = false;
      const pinnedReasons: string[] = [];
      if (target) {
        const pds: any = (rep as any).data_source ?? {};
        if (!pds.kind || !pds.id) {
          pinnedStale = true; // fail-closed：缺 data_source 字段
          pinnedReasons.push("pinned report missing data_source (fail-closed)");
        } else {
          const kindOk = String(pds.kind) === target.kind;
          const idOk = String(pds.id) === target.id;
          const shaOk = target.sha256 === undefined ? true : String(pds.sha256 ?? "") === target.sha256;
          if (!kindOk || !idOk || !shaOk) {
            pinnedStale = true;
            pinnedReasons.push(`pinned target mismatch (${pds.kind}:${pds.id} vs ${target.kind}:${target.id})`);
          }
        }
      }
      const frozenVer = (n as any).spec_version;
      if (frozenVer !== undefined) {
        const actualVer = Number((rep as any).verifier?.spec_version);
        if (Number.isFinite(actualVer) ? actualVer !== Number(frozenVer) : true) {
          pinnedStale = true;
          pinnedReasons.push(`pinned spec_version drift (frozen v${frozenVer} vs archived v${String((rep as any).verifier?.spec_version ?? "?")})`);
        }
      }
      const pinnedVerdict = pinnedStale ? "STALE" : toTreeVerdict(rep.overall);
      nodes.push({
        node_id: n.id, kind: "leaf", spec_id: n.spec_id, pinned: true, archive_sha256: pinnedSha,
        report_id: rep.run_id, verdict: pinnedVerdict, report_verdict: rep.overall, stale: pinnedStale,
        ...(pinnedReasons.length ? { stale_reason: pinnedReasons.join("; ") } : {}),
      });
      return pinnedVerdict;
    }
    const specFile = join(p.specs, String(n.spec_id), "spec.json");
    if (!existsSync(specFile)) throw new Error("leaf " + n.id + ": spec not found: " + n.spec_id);
    const leafSpec = readJson<VerifySpec>(specFile);
    const dbFile = byNode[n.id] || n.db || defaultDb;
    if (!dbFile) throw new Error("leaf " + n.id + ": no --db binding (pass --db <path> or --db " + n.id + "=<path>)");
    const snap = getSnapshot(dbFile);
    const runner = new SqliteRunner(snap.path);
    const report = await runVerify(leafSpec, { runner, mode: "open" });
    // Q8：叶 data_source 投影（kind+id 恒比；声明 sha256 时才比 sha）。
    const dsProjection: { kind: string; id: string; sha256?: string } = {
      kind: "sqlite-snapshot",
      id: String(n.id),
      sha256: snap.sha256,
    };
    const withSource = { ...report, data_source: { ...dsProjection, source: snap.source, captured_at: new Date().toISOString() } } as VerifyReport;
    withSource.payload_sha256 = payloadHash(withSource);
    writeJson(join(p.reports, report.run_id + ".json"), withSource);
    let archived: { archive_sha256: string; path: string } | null = null;
    if (args.flags["no-archive"] !== true) {
      archived = archiveRun(p.root, report.run_id, { id: String(leafSpec.spec_id), version: report.verifier.spec_version }, args);
    }
    // G1/G2 + Q9：引用失配判定（沿父链传播，阻 PASS）——
    // ① target 投影失配（Q8）；② 子 spec_version 相对 tree 冻结版本漂移（Q9 选项 D）。
    // 无 data_source 的叶（file/command）不参与 target 比较（Q8 (b) 仍适用）。
    let stale = false;
    const staleReasons: string[] = [];
    if (target) {
      const kindOk = dsProjection.kind === target.kind;
      const idOk = dsProjection.id === target.id;
      const shaOk = target.sha256 === undefined ? true : dsProjection.sha256 === target.sha256;
      if (!kindOk || !idOk || !shaOk) {
        stale = true;
        staleReasons.push(`target mismatch (leaf ${dsProjection.kind}:${dsProjection.id}${dsProjection.sha256 ? "#" + dsProjection.sha256.slice(0, 12) : ""} vs target ${target.kind}:${target.id}${target.sha256 ? "#" + target.sha256.slice(0, 12) : ""})`);
      }
    }
    // Q9：冻结版本漂移——tree spec 节点声明的 spec_version 与实际 spec/report 版本比对。
    // 缺被比字段 → fail-closed（fanout: 声明了但 spec 无版本也判 stale）。
    const frozenVer = (n as any).spec_version;
    if (frozenVer !== undefined) {
      const actualVer = Number(report.verifier?.spec_version);
      if (Number.isFinite(actualVer) ? actualVer !== Number(frozenVer) : true) {
        stale = true;
        staleReasons.push(`spec_version drift (frozen v${frozenVer} vs run v${String(report.verifier?.spec_version ?? "?")})`);
      }
    }
    const treeVerdict = stale ? "STALE" : toTreeVerdict(report.overall);
    nodes.push({
      node_id: n.id, kind: "leaf", spec_id: n.spec_id, report_id: report.run_id,
      archive_sha256: archived?.archive_sha256 ?? null, ...(archived?.path ? { archive_path: archived.path } : {}),
      verdict: treeVerdict,
      report_verdict: report.overall, // 叶原四值保留（v1.2 §2.4）
      stale, ...(staleReasons.length ? { stale_reason: staleReasons.join("; ") } : {}),
      data_source: dsProjection,
    });
    return treeVerdict;
  };
  try {
    const verdict = await evalNode(spec.root);
    const roundId = "r" + Date.now().toString(36);
    // G8（v1.2 裁定）：verdict_digest 走 JCS（RFC 8785）canonical——键全序、
    // 无空白、数字最短表示；覆盖判定投影（tree_spec_sha256/root/target/nodes/pinned），
    // 不含 audit/时钟/archive 字节。
    const verdictDigest = sha256(jcsCanonical({
      tree_spec_sha256: spec.tree_spec_sha256,
      root: spec.root,
      target: (spec as any).target ?? null,
      nodes: nodes.slice().sort((a, b) => String(a.node_id).localeCompare(String(b.node_id))).map((n) => ({
        id: n.node_id, verdict: n.verdict, aggregate: n.aggregate ?? null, pinned: n.pinned === true,
        stale: n.stale === true, report_verdict: n.report_verdict ?? null,
      })),
      pinned: pinnedShas,
    }));
    // Q11（v1.2 裁定）：删除 run 幂等声明——tree_run_id 每次运行新生成，
    // 不再从 verdict_digest 派生（同输入双跑 digest 仍相等，但 run id 必须不同）。
    const treeRunId = "tr_" + short(sha256(verdictDigest + "|" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
    const treeReport = {
      tree_run_id: treeRunId,
      tree_spec_id: spec.tree_spec_id,
      tree_spec_sha256: spec.tree_spec_sha256,
      round_id: roundId,
      verdict,
      verdict_digest: verdictDigest,
      audit: { generated_at: new Date().toISOString(), host: process.platform, duration_ms: 0 },
      nodes,
      pinned: pinnedShas,
    };
    writeJson(join(p["tree-reports"], treeRunId + ".json"), treeReport);
    try {
      env.db.run(
        "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
        ["ev" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), new Date().toISOString(), process.env.YGL_SESSION || "cli", "verify.tree.run", "tree_spec", spec.tree_spec_id, JSON.stringify({ tree_run_id: treeRunId, verdict }), verdict === "PASS" ? "info" : "warn"]
      );
    } catch { /* events best effort */ }
    if (ctx.json) {
      console.log(JSON.stringify({ ...treeReport, report_path: join(p["tree-reports"], treeRunId + ".json") }));
    } else {
      out(ctx, paint(verdict === "PASS" ? C.green : verdict === "FAIL" ? C.red : C.yellow, "  " + verdict + "  " + treeRunId, ctx.color));
      for (const n of nodes) out(ctx, paint(C.dim, "    " + n.node_id + " " + n.kind + " " + n.verdict, ctx.color));
      out(ctx, paint(C.dim, "  tree report: " + join(p["tree-reports"], treeRunId + ".json"), ctx.color));
    }
    return 0;
  } catch (e: any) {
    const msg = String(e?.message || e);
    // Q12-B/Q13-A 是冻结面用法错误（同轮自引用 / 跨 workspace）→ rc2；
    // 其余是运行时故障 → rc1。
    if (/same-round self-reference|Q13-A: cross-workspace/.test(msg)) {
      bad(ctx, msg);
      return 2;
    }
    bad(ctx, "tree run failed: " + msg);
    return 1;
  }
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
/** #reviews shape (release-seat report): `--reviews` entries used to reach
 *  `hit.findings.map` unvalidated and crash with TypeError on a missing field.
 *  CLI validates before prepare; the runner keeps a defensive fallback for
 *  library callers. */
export function reviewsShapeProblem(reviews: unknown): string | null {
  if (!Array.isArray(reviews)) return 'reviews must be an array of {source_clause, findings[]} (got ' + typeof reviews + ')';
  const Q = new Set(["faithful", "decidable", "not-vacuous"]);
  const V = new Set(["ok", "reject", "unclear"]);
  const checkFinding = (f: any, where: string): string | null => {
    if (!f || typeof f !== "object") return `${where} must be an object`;
    if (typeof f.question !== "string" || !Q.has(f.question)) return `${where}.question must be faithful|decidable|not-vacuous`;
    if (typeof f.verdict !== "string" || !V.has(f.verdict)) return `${where}.verdict must be ok|reject|unclear`;
    if (typeof f.reason !== "string") return `${where}.reason must be a string`;
    return null;
  };
  for (let i = 0; i < reviews.length; i++) {
    const r = reviews[i] as { source_clause?: unknown; findings?: unknown } | unknown[];
    // Legacy positional form: reviews[i] is the finding array itself (kept for
    // the existing CLI callers/tests). Object form carries source_clause.
    if (Array.isArray(r)) {
      for (let j = 0; j < r.length; j++) {
        const bad = checkFinding(r[j], `reviews[${i}][${j}]`);
        if (bad) return bad;
      }
      continue;
    }
    if (!r || typeof r !== "object") return `reviews[${i}] must be an object or finding array`;
    if (typeof r.source_clause !== "string" || !r.source_clause.trim()) return `reviews[${i}].source_clause must be a non-empty string`;
    if (!Array.isArray(r.findings)) return `reviews[${i}].findings must be an array (schema: [{question: faithful|decidable|not-vacuous, verdict: ok|reject|unclear, reason}])`;
    for (let j = 0; j < r.findings.length; j++) {
      const bad = checkFinding(r.findings[j], `reviews[${i}].findings[${j}]`);
      if (bad) return bad;
    }
  }
  return null;
}

export function fileReviewer(reviews: Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }>): ReviewRunner {
  return {
    async review(req) {
      const hit = reviews.find((r) => r.source_clause === req.vu.source_clause);
      if (!hit) return []; // 没有该候选的盲审结论 → prepare 的 fail-closed 会判"自审不完整"
      const findings = Array.isArray(hit.findings) ? hit.findings : [];
      return findings.map((f) => ({ ...f, vu_id: req.vu.id }));
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
      // GitHub #18.1: 先判 file-checker 缺附件——它是**作者可修的构造输入缺口**，
      // 不是 construction bug；只有当 ERROR 里还有非 file 型时才报 construction bug，
      // 避免误导性的第一诊断把作者带离正确修法。
      const fileErroneous = report.vu.filter(
        (r) => r.verdict === "ERROR" && String((r as any).evidence?.reason ?? "").includes("file checker requires --attachments"),
      );
      const otherErroneous = report.vu.filter(
        (r) => r.verdict === "ERROR" && !fileErroneous.includes(r),
      );
      if (report.overall === "ERROR" && otherErroneous.length > 0) {
        failures.push("spec errors out on an empty snapshot (construction bug, not a data finding)");
      }
      for (const r of report.vu) {
        if (r.verdict === "PASS" && (r.witness?.rows_scanned ?? 0) === 0) failures.push(`${r.id} passes on an empty snapshot — vacuous pass`);
      }
      for (const r of fileErroneous) {
        failures.push(
          `${r.id} is a file checker: no attachments were staged for this prepare — submit them with ` +
            "`verify submit --attach <file>` so the red-team gate can run the file checkers against the material's attachments",
        );
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
  tree: ["pinned", "no-archive", "target"],
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
    case "tree": {
      const sub = rest[0];
      if (sub === "run") {
        const treeSpecId = rest[1];
        if (!treeSpecId) {
          bad(ctx, "usage: verify tree run <tree-spec-id> [--db <path>] [--db <node>=<path> ...] [--json]");
          return 2;
        }
        const specFile = join(paths(env).trees, treeSpecId + ".json");
        if (!existsSync(specFile)) {
          bad(ctx, "tree spec not found: " + treeSpecId + " (verify tree prepare first)");
          return 1;
        }
        return treeRun(env, ctx, readJson<TreeSpec>(specFile), args);
      }
      if (sub === "report") {
        const runId = rest[1];
        if (!runId) {
          bad(ctx, "usage: verify tree report <tree-run-id> [--json]");
          return 2;
        }
        const f = join(paths(env)["tree-reports"], runId + ".json");
        if (!existsSync(f)) {
          bad(ctx, "tree run not found: " + runId);
          return 1;
        }
        if (ctx.json) console.log(JSON.stringify(readJson<any>(f)));
        else out(ctx, JSON.stringify(readJson<any>(f), null, 2));
        return 0;
      }
      if (sub === "trace") {
        const treeSpecId = rest[1];
        if (!treeSpecId) {
          bad(ctx, "usage: verify tree trace <tree-spec-id> [--json]");
          return 2;
        }
        const dir = paths(env)["tree-reports"];
        const rows = existsSync(dir)
          ? readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => readJson<any>(join(dir, x))).filter((r) => r.tree_spec_id === treeSpecId)
          : [];
        if (ctx.json) console.log(JSON.stringify(rows));
        else for (const r of rows) out(ctx, r.tree_run_id + "  " + r.verdict + "  " + r.round_id);
        return 0;
      }
      if (sub !== "prepare") {
        bad(ctx, "usage: verify tree prepare|run|report|trace ...");
        return 2;
      }
      const materialId = rest[1];
      if (!materialId) {
        bad(ctx, "usage: verify tree prepare <material-id> [--pinned <node>=<sha256> ...] [--json]");
        return 2;
      }
      const p = paths(env);
      const mDir = join(p.materials, materialId);
      const mFile = join(mDir, "material.json");
      if (!existsSync(mFile)) {
        bad(ctx, "material not found: " + materialId + " (verify submit first)");
        return 1;
      }
      const material = readJson<MaterialRecord>(mFile);
      const textFile = join(mDir, material.text_path || "material.txt");
      let raw: any;
      try {
        raw = JSON.parse(readFileSync(textFile, "utf8"));
      } catch (e: any) {
        bad(ctx, "tree spec is not valid JSON: " + (e?.message || e));
        return 2;
      }
      const extraPinned: Record<string, string> = {};
      const pinnedArgs: string[] = Array.isArray(args.flags.pinned)
        ? args.flags.pinned.map(String)
        : args.flags.pinned
          ? [String(args.flags.pinned)]
          : [];
      for (const pv of pinnedArgs) {
        const idx = pv.indexOf("=");
        if (idx <= 0) {
          bad(ctx, "bad --pinned '" + pv + "' (want <node>=<sha256>)");
          return 2;
        }
        extraPinned[pv.slice(0, idx)] = pv.slice(idx + 1);
      }
      if (Object.keys(extraPinned).length) raw = { ...raw, pinned: { ...(raw.pinned || {}), ...extraPinned } };
      const res = validateTreeSpec(raw, materialId, material.title, (sid) => existsSync(join(p.specs, sid, "spec.json")));
      if (res.error || !res.spec) {
        bad(ctx, "tree spec invalid: " + res.error);
        return 2;
      }
      // G8（v1.2 §0）：tree spec 冻结的引擎面必须与实况一致——不一致拒跑（rc2，
      // 点名字段）。冻结的是「哪套引擎产出的判定」，引擎换了判定不可比。
      {
        const actual = {
          engine_version: String((env as any).version || ""),
          corpus_version: "1.2",
          contract_version: "1.2",
        };
        const claimed = {
          engine_version: res.spec.engine_version,
          corpus_version: res.spec.corpus_version,
          contract_version: res.spec.contract_version,
        };
        for (const k of Object.keys(actual) as Array<keyof typeof actual>) {
          if (claimed[k] !== undefined && String(claimed[k]) !== actual[k]) {
            bad(ctx, `G8: tree spec pins ${k}=${claimed[k]} but this engine is ${actual[k]} — engine/pin mismatch, refusing (re-prepare with matching versions or drop the pin)`);
            return 2;
          }
        }
      }
      // §3.1 pinned = node exists + archive signature checks (#60): resolve the
      // archive through the workspace registry and run the same verifier as
      // `verify archive verify`; unknown sha is a freeze-time rc=2.
      for (const [nid, rawSha] of Object.entries(res.spec.pinned)) {
        const sha = rawSha.startsWith("sha256:") ? rawSha : "sha256:" + rawSha;
        const arcDir = join(p.root, "archives");
        let entryPath = "";
        let entryZip = "";
        try {
          for (const f of readdirSync(arcDir)) {
            if (!f.endsWith(".json")) continue;
            const reg = readJson<any>(join(arcDir, f));
            const hit = (reg?.archives ?? []).find((a: any) => a?.archive_sha256 === sha);
            if (hit?.path) { entryPath = String(hit.path); entryZip = String(hit.zip_sha256 ?? ""); break; }
          }
        } catch { /* no registry dir */ }
        if (!entryPath) {
          bad(ctx, "tree spec invalid: pinned " + nid + ": archive not found for sha256 " + sha + " (archive it first)");
          return 2;
        }
        // Any byte change (even an appended trailer) changes the zip hash; the
        // in-zip manifest alone cannot see trailing bytes, so compare the file
        // against the registry's zip_sha256 (V6 injection is exactly this).
        if (entryZip && sha256(readFileSync(entryPath)) !== entryZip) {
          bad(ctx, "tree spec invalid: pinned " + nid + ": archive zip_sha256 mismatch (file mutated after archiving)");
          return 2;
        }
        const av = verifyArchiveFile(entryPath);
        if (!av.ok) {
          bad(ctx, "tree spec invalid: pinned " + nid + ": archive verification failed (" + (av.problems[0] ?? "unknown") + ")");
          return 2;
        }
      }
      const outFile = join(p.trees, res.spec.tree_spec_id + ".json");
      writeJson(outFile, res.spec);
      if (ctx.json) {
        console.log(JSON.stringify({
          tree_spec_id: res.spec.tree_spec_id,
          tree_spec_sha256: res.spec.tree_spec_sha256,
          title: res.spec.title,
          root: res.spec.root,
          nodes: res.spec.nodes.length,
          pinned: Object.keys(res.spec.pinned).length,
          path: outFile,
        }));
      } else {
        ok(ctx, "tree spec frozen: " + res.spec.tree_spec_id + "  (" + res.spec.nodes.length + " nodes, root " + res.spec.root + ")");
        out(ctx, paint(C.dim, "  sha256: " + res.spec.tree_spec_sha256, ctx.color));
        out(ctx, paint(C.dim, "  file:   " + outFile, ctx.color));
      }
      return 0;
    }

    case "submit": {
      const title = String(args.flags.title || "").trim();
      const textArg = args.flags.text ? String(args.flags.text) : "";
      if (!title || !textArg) {
        bad(ctx, 'usage: verify submit --title "<what>" --text <file|-> [--attach <file> ...] [--clause-pattern <regex>] [--meta-repo <verifier-root> | --require-meta | --no-meta]');
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
      let textEncoding: string | undefined;
      try {
        const raw = textArg === "-" ? readFileSync(0) : readFileSync(textArg);
        const decoded = decodeMaterialText(raw);
        if (!decoded.ok) {
          bad(ctx, decoded.reason);
          return 2;
        }
        text = decoded.text;
        textEncoding = decoded.encoding;
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
      const seenSha = new Set<string>();
      const usedPaths = new Set<string>();
      /** #55: keep the directory part in `path` (x/c.txt and y/c.txt are two
       *  files), but strip traversal/absolute prefixes so staging stays under
       *  its temp dir. */
      const attachPath = (raw: string): string => {
        const norm = raw.split("\\").join("/");
        const absolute = /^(?:[A-Za-z]:)?\//.test(norm);
        let comps = norm.split("/").filter((c) => c && c !== "." && c !== ".." && !c.endsWith(":"));
        // Absolute inputs would leak the whole temp/home path into the material
        // manifest; two trailing components keep same-basename files distinct
        // (x/c.txt vs y/c.txt) without the absolute prefix.
        if (absolute && comps.length > 2) comps = comps.slice(-2);
        let cand = comps.join("/") || "attachment";
        if (usedPaths.has(cand)) {
          // same relative path twice with different content: qualify by parent
          for (let i = comps.length - 2; i >= 0; i--) {
            const alt = comps.slice(i).join("/");
            if (!usedPaths.has(alt)) { cand = alt; break; }
          }
        }
        let n = 2;
        const base = cand;
        while (usedPaths.has(cand)) cand = `${base.replace(/(\.[^./]+)$/, "")}-${n++}$1`;
        usedPaths.add(cand);
        return cand;
      };
      for (const a of attachArgs) {
        if (!existsSync(a)) {
          bad(ctx, `attachment not found: ${a}`);
          return 1;
        }
        // #55: a directory is a usage error (rc=2), not a runtime failure;
        // --attach can repeat, so name the fix.
        const st = statSync(a);
        if (st.isDirectory()) {
          bad(ctx, `usage: verify submit --attach <file> — directories are not accepted (attach files individually; --attach can repeat): ${a}`);
          return 2;
        }
        let ref;
        try {
          // 唯一写入面：CLI 与 HTTP 上传都走 blob-store（同哈希、同容量策略、同去重）。
          ref = putBlobFromFile(p.root, a);
        } catch (e: any) {
          bad(ctx, `cannot store attachment ${a}: ${e?.message || e}`);
          return 1;
        }
        // #55: the same file passed twice is one material file (blob store
        // already deduped bytes; the manifest must not list it twice).
        if (seenSha.has(ref.sha256)) continue;
        seenSha.add(ref.sha256);
        files.push({
          path: attachPath(a),
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
        ...(textEncoding ? { text_encoding: textEncoding } : {}),
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
        bad(ctx, "usage: verify prepare <material-id> --candidates <file> --reviews <file> --db <snapshot.sqlite> [--spec-version N] [--draft] [--as-of <ISO-8601>] [--meta-repo <verifier-root> | --require-meta | --no-meta]");
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
      const reviewsProblem = reviewsShapeProblem(reviewsFile.reviews);
      if (reviewsProblem) {
        bad(ctx, `invalid --reviews: ${reviewsProblem}`);
        return 2;
      }
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
      const examples = (want ? CHECKER_EXAMPLES.filter((e) => e.checker === want) : CHECKER_EXAMPLES).map((e) => ({
        ...e,
        // #63: prepare's candidate face uses `anchor` (p1 accepts expected_from
        // as an alias); emitting the candidate shape keeps "copy → prepare"
        // one-step instead of forcing a spec→candidate translation.
        candidates: e.vu.map((v: any) => ({
          id: v.id,
          source_clause: v.source_clause,
          anchor: v.expected_from ? { quote: v.expected_from.quote, locator: v.expected_from.locator } : undefined,
          checker: v.checker,
        })),
      }));
      const payload: Record<string, unknown> = {
        _derived_from: EXAMPLES_DERIVED_FROM,
        _shape_note: "`vu` is the SPEC face (expected_from + raw sql, used by run/corpus); `candidates` mirrors the PREPARE shape (anchor + id). SQL-family candidates still need predicate AST — see skills/ygl-trees-verify §2b.",
        examples,
      };
      if (args.flags["null-ops"]) payload.null_ops = NULL_OPS_NOTE;
      if (ctx.json) {
        console.log(JSON.stringify(payload));
        return 0;
      }
      out(ctx, paint(C.dim, `  ${EXAMPLES_DERIVED_FROM} — spec VU shape (expected_from; used by run/corpus)`, ctx.color));
      out(ctx, paint(C.dim, `  prepare candidates are projected below as candidates[] (anchor); SQL-family candidates still need predicate AST — see skills/ygl-trees-verify §2b`, ctx.color));
      for (const ex of examples) {
        out(ctx, `\n  ## ${ex.checker} — case ${ex.case_id}${ex.expects ? `  (${ex.expects})` : ""}`);
        out(ctx, paint(C.dim, JSON.stringify(ex.vu, null, 2).split("\n").map((l) => `  ${l}`).join("\n"), ctx.color));
        if (ex.candidates?.length) {
          out(ctx, paint(C.dim, "  candidates[] (prepare shape):", ctx.color));
          out(ctx, paint(C.dim, JSON.stringify(ex.candidates, null, 2).split("\n").map((l) => `  ${l}`).join("\n"), ctx.color));
        }
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
          // #69: same encoding normalization as submit — BOM stripped,
          // UTF-16 refused by name (lint must not silently lose the first
          // clause of a BOM-prefixed material).
          const rawBuf = t === "-" ? readFileSync(0) : readFileSync(t);
          const decoded = decodeMaterialText(rawBuf);
          if (!decoded.ok) {
            bad(ctx, decoded.reason);
            return 2;
          }
          materialText = decoded.text;
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
      // #79 discoverability: a rejected lint ships a pasteable candidate
      // skeleton. The schema otherwise has to be archaeology'd out of
      // examples.generated.ts, whose `vu` shape is the SPEC face
      // (expected_from + raw sql), not the prepare-candidate face.
      const lintHint = [
        "minimal candidate skeleton (replace <…>; see skills/ygl-trees-verify §2b):",
        '[{"source_clause":"<material clause line>","anchor":{"quote":"<verbatim>","locator":"material.md#S1"},"checker":{"type":"count","predicate":{"from":"<table>","select":["<col>"]},"op":">=","value":1}}]',
        "`expected_from` + raw `sql` are the spec-VU face (verify example's `vu`), not a prepare candidate; use `anchor` + predicate AST.",
      ].join("\n");
      if (ctx.json) {
        console.log(JSON.stringify(res.ok ? res : { ...res, hint: lintHint }));
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
      out(ctx, paint(C.dim, `  hint: ${lintHint}`, ctx.color));
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
