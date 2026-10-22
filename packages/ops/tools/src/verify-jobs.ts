/** 作业式验证面（M13-2 第三批）：HTTP 上的 prepare / run。
 *
 * 与只读三视图的分界：三视图是审计面（读盘），这里是**执行面**（跑引擎、落报告、
 * 归档）。因此它默认关闭，必须由 `webui serve --enable-verify-jobs` 显式打开——
 * 一个嵌入方不该因为调了 `serve` 就默默获得"能执行任意 spec"的能力。
 *
 * 三条安全不变量（评审 fdc757f6 裁定，r18/r19 的同一口径延续）：
 * 1. **请求体永不携带可执行面**：没有 argv、没有 commandAllowlist、没有路径。
 *    command 型检查器的白名单在 serve 启动时定下并注入这里（`JobsDeps`），
 *    请求体里出现 `allowlist`/`argv`/`submission_dir` 一律不认。
 * 2. **快照只能按内容寻址引用**：请求给 `snapshot_sha256`，服务端到 blob 仓取字节。
 *    不暴露任意路径，天然挡住 `../` 与盘符差异；缺 blob 就 404，不做"猜路径"。
 * 3. **run 只碰副本**（裁定 A）：blob 里的快照先 `snapshotCopy` 到临时文件再跑，
 *    报告记 `data_source` 指向 blob 的 sha256——报告可复核，原始字节不被改动。
 *
 * 状态码语义与 CLI 的 rc 同构：HTTP 状态只表达**过程**（请求坏 / 找不到 / 引擎拒绝），
 * 判定结论在 body 的 `verdict`/`overall` 里——prepare 不 ready 也是 200，run 出 FAIL 也是 200。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Env } from "../../../core/database/src/types";
import { CORPUS_VERSION } from "../../../verify/core/src/contract";
import type { ReviewFinding, VerifyReport, VerifySpec } from "../../../verify/core/src/contract";
import type { PrepareCandidate } from "../../../verify/core/src/prepare";
import { payloadHash, runVerify } from "../../../verify/core/src/engine";
import { prepareSpec } from "../../../verify/core/src/prepare";
import { SqliteRunner } from "../../../verify/core/src/sqlite-runner";
import {
  archiveRun,
  fileReviewer,
  fileRunner,
  findMaterial,
  knownMaterialHashes,
  latestVersionOf,
  minimalRedTeam,
  normalizeAsOf,
  writePrepareRecord,
  probeOf,
  probeOfDb,
  readJson,
  schemaOf,
  sha256,
  short,
  snapshotCopy,
  specDir,
  writeJson,
} from "./verify-cmds";
import { retainSnapshot } from "./archive";
import { verifyPaths } from "./verify-web";
import { blobPath, hasBlob } from "./blob-store";

export interface JobsDeps {
  /** command 型检查器允许的 argv[0]；serve 启动时注入，请求体不可覆盖。 */
  commandAllowlist: string[];
}

export interface HttpResult {
  status: number;
  body: unknown;
}

const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function fail(status: number, error: string): HttpResult {
  return { status, body: { error } };
}

function snapshotPath(env: Env, raw: unknown): { sha256: string; path: string } | HttpResult {
  const sha = String(raw ?? "").trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    return fail(400, "snapshot_sha256 must be 64 lowercase hex characters (upload the snapshot with PUT /api/verify/blob?name=snapshot.sqlite first)");
  }
  const root = verifyPaths(env).root;
  if (!hasBlob(root, sha)) {
    return fail(404, `snapshot blob not found: ${sha} (upload it with PUT /api/verify/blob?name=snapshot.sqlite first; this endpoint never accepts filesystem paths)`);
  }
  return { sha256: sha, path: blobPath(root, sha) };
}

/** 数组 or `{candidates:[...]}` / `{reviews:[...]}` 信封——与 CLI 的文件形态同宽。 */
function listOf(raw: unknown, key: string): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  const env = raw as Record<string, unknown> | null;
  const inner = env && Array.isArray(env[key]) ? (env[key] as unknown[]) : null;
  return inner;
}

export async function prepareViaHttp(env: Env, input: unknown): Promise<HttpResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const materialId = String(body.material_id ?? "");
  if (!ID_RE.test(materialId)) return fail(400, "material_id must match ^[A-Za-z0-9_-]{1,128}$");
  // as_of 双侧同校验（r22 ②，顺序 0.102.4）：**先于任何 I/O** —— 缺材料 + 非法 as_of 必须报 400
  // as_of 而不是 404 material（CLI 侧同理，旗标错误不该先读盘再报成运行错误）。
  let asOf: string;
  try {
    asOf = normalizeAsOf(body.as_of, new Date().toISOString());
  } catch (e: any) {
    return fail(400, String(e?.message || e));
  }
  const candidates = listOf(body.candidates, "candidates") as PrepareCandidate[] | null;
  const reviews = listOf(body.reviews, "reviews") as Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }> | null;
  if (!candidates || !reviews) {
    return fail(400, "candidates and reviews must be JSON arrays (the agent's construction artifacts; this server does not invent them)");
  }
  let material;
  try {
    material = findMaterial(env, materialId);
  } catch (e: any) {
    return fail(404, String(e?.message || e));
  }
  const snap = snapshotPath(env, body.snapshot_sha256);
  if ("status" in snap) return snap;
  const paths = verifyPaths(env);
  const text = readFileSync(join(paths.materials, materialId, material.text_path), "utf8");
  let schema: { ddl: string[]; fingerprint: string };
  try {
    schema = schemaOf(snap.path);
  } catch (e: any) {
    return fail(422, `snapshot is not a readable sqlite file: ${e?.message || e}`);
  }
  const draft = body.draft === true;
  const requested = Number(body.spec_version);
  const res = await prepareSpec(text, {
    runner: fileRunner(candidates),
    reviewer: fileReviewer(reviews),
    // #34: same candidate↔review pairing as CLI prepare (orphan review blocks ready)
    reviewedClauses: reviews.map((r) => String(r?.source_clause ?? "")),
    redteam: minimalRedTeam(schema.ddl),
    materialIndex: { text, files: material.files.map((f) => ({ path: f.path, sha256: f.sha256, mime: f.mime, size: f.size })) },
    schemaProbe: probeOfDb(snap.path),
    specId: `spec_${short(sha256(materialId))}`,
    title: body.title ? String(body.title) : undefined,
    domain: body.domain ? String(body.domain) : undefined,
    specVersion: Number.isInteger(requested) && requested > 0 ? requested : latestVersionOf(env, materialId) + 1,
    // as_of 是「材料/快照的时点」，由调用方钉（P5 冻版责任在构造方）；HTTP 给可选入口，
    // 不给就按本次请求时刻——与 CLI --as-of 同语义，不做服务端猜测；可解析性由 normalizeAsOf 双侧统一。
    asOf: { kind: "snapshot", value: asOf },
    engineVersion: "0.1.0",
    corpusVersion: CORPUS_VERSION,
    knownMaterialHashes: knownMaterialHashes(env, materialId),
  });
  const ready = res.verdict === "ready" && !!res.spec;
  let record: string | null = null;
  if (!draft) {
    const dir = specDir(env, `spec_${short(sha256(materialId))}`);
    const created = new Date().toISOString();
    const recordPath = writePrepareRecord(dir, ready, {
      material_id: materialId,
      created,
      verdict: res.verdict,
      rounds: res.rounds,
      rejected: res.rejected,
      diagnostics: res.diagnostics,
      materials_sha256: res.materials_sha256,
    }, created);
    record = relative(dir, recordPath).split(sep).join("/");
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
  }
  return {
    status: 200,
    body: {
      draft,
      verdict: res.verdict,
      spec_id: res.spec?.spec_id ?? null,
      spec_version: res.spec?.spec_version ?? null,
      rounds: res.rounds,
      units: res.units.length,
      rejected: res.rejected.length,
      materials_sha256: res.materials_sha256,
      diagnostics: res.diagnostics,
      record,
      written: !draft && ready,
    },
  };
}

export async function runViaHttp(env: Env, input: unknown, deps: JobsDeps): Promise<HttpResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const specId = String(body.spec_id ?? "");
  if (!ID_RE.test(specId)) return fail(400, "spec_id must match ^[A-Za-z0-9_-]{1,128}$");
  if (body.submission_dir !== undefined || body.submission !== undefined) {
    // file 型的提交物是目录树，blob 仓是字节仓——HTTP 面没有安全的目录来源，
    // 与其半支持后被人塞本地路径，不如明确拒绝（CLI/封包路径仍是完整能力）。
    return fail(400, "submission_dir is not accepted over HTTP: file checkers need a directory tree that this service has no safe source for (use the CLI for submissions)");
  }
  const specFile = join(specDir(env, specId), "spec.json");
  if (!existsSync(specFile)) return fail(404, `spec not found: ${specId} (prepare first)`);
  const snap = snapshotPath(env, body.snapshot_sha256);
  if ("status" in snap) return snap;
  const spec = readJson<VerifySpec>(specFile);
  let copy: { path: string; sha256: string; source: string };
  try {
    copy = snapshotCopy(snap.path);
  } catch (e: any) {
    return fail(422, `cannot copy snapshot: ${e?.message || e}`);
  }
  const root = verifyPaths(env).root;
  try {
    retainSnapshot(root, copy);
  } catch {
    // 快照留存失败不阻塞判定；只有 `--with snapshot` 归档会要求它
  }
  let report: VerifyReport;
  try {
    report = await runVerify(spec, { runner: new SqliteRunner(copy.path), commandAllowlist: deps.commandAllowlist, mode: "open" });
  } catch (e: any) {
    // 引擎的契约钉版 / R13 / N2 / S2 都是硬拒绝：这是 spec 的问题，不是请求格式的问题。
    return fail(422, `run rejected: ${e?.message || e}`);
  }
  const withSource = {
    ...report,
    data_source: { kind: "sqlite-snapshot", sha256: copy.sha256, source: `blob:${snap.sha256.slice(0, 12)}`, captured_at: new Date().toISOString() },
  } as VerifyReport;
  withSource.payload_sha256 = payloadHash(withSource);
  const reportPath = join(verifyPaths(env).reports, `${report.run_id}.json`);
  writeJson(reportPath, withSource);
  let archived: { path: string; filename: string; archive_id: string; archive_sha256: string; zip_sha256: string } | undefined;
  let archiveError = "";
  if (body.no_archive !== true) {
    try {
      archived = archiveRun(root, report.run_id, { id: String(report.spec_id), version: report.verifier.spec_version }, {});
    } catch (e: any) {
      archiveError = e?.message || String(e);
    }
  }
  return {
    status: 200,
    body: {
      run_id: report.run_id,
      spec_id: report.spec_id,
      spec_version: report.verifier.spec_version,
      overall: report.overall,
      summary: report.summary,
      report_path: reportPath,
      archive: archived ?? null,
      archive_error: archiveError || undefined,
    },
  };
}
