/** verify 服务面（M13-2）——WebUI 三视图的只读数据面 + 材料草稿写入。
 *
 * 裁定（docs/spec-validator.md §8 / §9）：
 * - 构造追溯视图是**只读审计面**，没有 ✓/✗ 按钮——这里不提供 confirm/approve；
 * - 材料提交是唯一的人工入口：标题 + 一段话 + 附件引用（附件字节先经
 *   `PUT /api/verify/blob` 落到内容寻址仓，本文件只收 sha256 引用——服务端不再
 *   解析 multipart，浏览器一个 `fetch(..., {body: file})` 即可，字节保真且天然去重）；
 * - 报告与规范都是文件工件，读盘即可，不碰工作区数据库，因此这里没有任何写入风险面
 *   以外的副作用。
 *
 * 与 CLI 的存储布局保持一致（packages/ops/tools/src/verify-cmds.ts `paths()`）：
 *   材料 = materials/<material-id> 下的 material.txt 与 material.json；
 *   规范 = specs/<spec-id> 下的 spec.json / prepare.json / trace.json；
 *   报告 = reports/<run-id>.json；归档侧车 = archives/<run-id>.json。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { BLOB_LIMIT, blobPath, createBlobSink, hasBlob, mimeFor, pruneIncoming } from "./blob-store";
import { shellSafePath } from "./graduate";

import type { Env } from "../../../core/database/src/types";

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

export interface VerifyPaths {
  root: string;
  materials: string;
  specs: string;
  reports: string;
  archives: string;
}

export function verifyPaths(env: Env): VerifyPaths {
  const root = join(env.home, "verify");
  for (const k of ["materials", "specs", "reports", "archives"]) mkdirSync(join(root, k), { recursive: true });
  return {
    root,
    materials: join(root, "materials"),
    specs: join(root, "specs"),
    reports: join(root, "reports"),
    archives: join(root, "archives"),
  };
}


/** 工件 id 的字符集（material/spec/run 全是自己生成的 ASCII 短名）。 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 把 id 拼到工件根下，同时挡住路径穿越（r18 P1：`?run=../../leak` 曾读到
 * verify 根外的文件）。两道门：id 白名单 + resolve 后的包含性断言——只做前者
 * 会漏掉平台差异（盘符、UNC、`..%2f` 解码后形态），只做后者又太晚。
 */
function safeJoin(root: string, id: string, suffix = ""): string | null {
  if (!ID_RE.test(id)) return null;
  if (suffix && !/^\.[A-Za-z0-9]{1,8}$/.test(suffix)) return null;
  const base = resolve(root);
  const full = resolve(base, id + suffix);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export interface SpecRow {
  spec_id: string;
  spec_version: number;
  title: string;
  domain: string;
  created: string;
  units: number;
  verdict: string;
  rounds: number;
  material: string;
  runs: number;
  last_overall: string;
  last_run: string;
}

/** 规范清单：spec.json + prepare.json 的投影，附该规范的历史 run 数。 */
export function listSpecs(env: Env): SpecRow[] {
  const p = verifyPaths(env);
  const reports = listReports(env);
  return listDirs(p.specs)
    .map((d) => {
      const spec = readJson<any>(join(p.specs, d, "spec.json"));
      if (!spec) return null;
      const prep = readJson<any>(join(p.specs, d, "prepare.json")) ?? {};
      const runs = reports.filter((r) => r.spec_id === spec.spec_id);
      const last = runs.slice().sort((a, b) => String(a.finished).localeCompare(String(b.finished))).pop();
      return {
        spec_id: String(spec.spec_id),
        spec_version: Number(spec.spec_version ?? 0),
        title: String(spec.title ?? ""),
        domain: String(spec.domain ?? ""),
        created: String(spec.created ?? ""),
        units: Array.isArray(spec.vu) ? spec.vu.length : 0,
        verdict: String(prep.verdict ?? ""),
        rounds: Number(prep.rounds ?? 0),
        material: String(prep.material_id ?? ""),
        runs: runs.length,
        last_overall: String(last?.overall ?? ""),
        last_run: String(last?.run_id ?? ""),
      } satisfies SpecRow;
    })
    .filter((x): x is SpecRow => x !== null);
}

/** 构造追溯视图的载荷：规范 + prepare 产物 + trace（全部只读）。 */
export function specDetail(env: Env, specId: string): { spec: unknown; prepare: unknown; trace: unknown; attempts: Array<{ file: string; created: string | null; verdict: string | null }> } | null {
  const p = verifyPaths(env);
  const dir = safeJoin(p.specs, specId);
  if (!dir) return null;
  const spec = readJson<any>(join(dir, "spec.json"));
  if (!spec) return null;
  // 失败尝试的审计投影（r22 建议①）：只读文件名/created/verdict，正文仍在 spec 目录的 attempts/ 里。
  const attemptsDir = join(dir, "attempts");
  const attempts = existsSync(attemptsDir)
    ? readdirSync(attemptsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
          const rec = readJson<any>(join(attemptsDir, f));
          return { file: f, created: typeof rec?.created === "string" ? rec.created : null, verdict: typeof rec?.verdict === "string" ? rec.verdict : null };
        })
    : [];
  return {
    spec,
    prepare: readJson<any>(join(dir, "prepare.json")),
    trace: readJson<any>(join(dir, "trace.json")),
    attempts,
  };
}

export interface ReportRow {
  run_id: string;
  spec_id: string;
  spec_version: number;
  overall: string;
  reason: string;
  summary: { pass: number; fail: number; needs_material: number; error: number };
  started: string;
  finished: string;
  mode: string;
  binary_sha256: string;
  archived: number;
}

/** 报告清单（看板摘要行）。归档数量从 archives 侧车读，不猜。 */
export function listReports(env: Env, specId?: string): ReportRow[] {
  const p = verifyPaths(env);
  if (!existsSync(p.reports)) return [];
  return readdirSync(p.reports)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<any>(join(p.reports, f)))
    // 坏报告静默跳过是**显式决定**（r19 N2 WONTFIX）：一条损坏/半写的 report.json 不该让整块
    // 看板 500——单条诊断由 `verify report <run>` 点名（它会把解析错误打出来），这里只保证列表可用。
    // 若将来要在 UI 加「N 条损坏」脚注，从本函数旁路收集计数再做，不要把错误塞进 ReportRow。
    .filter((r): r is any => !!r && !!r.run_id)
    .map((r) => {
      const side = readJson<any>(join(p.archives, `${r.run_id}.json`));
      return {
        run_id: String(r.run_id),
        spec_id: String(r.spec_id ?? ""),
        spec_version: Number(r.verifier?.spec_version ?? 0),
        overall: String(r.overall ?? ""),
        reason: String(r.reason ?? ""),
        summary: {
          pass: Number(r.summary?.pass ?? 0),
          fail: Number(r.summary?.fail ?? 0),
          needs_material: Number(r.summary?.needs_material ?? 0),
          error: Number(r.summary?.error ?? 0),
        },
        started: String(r.started ?? ""),
        finished: String(r.finished ?? ""),
        mode: String(r.verifier?.mode ?? ""),
        binary_sha256: String(r.verifier?.binary_sha256 ?? ""),
        archived: Array.isArray(side?.archives) ? side.archives.length : 0,
      } satisfies ReportRow;
    })
    .filter((r) => (specId ? r.spec_id === specId : true))
    .sort((a, b) => String(b.finished).localeCompare(String(a.finished)));
}

/** 归档清单（跨 run 展开，按创建时刻倒序）——报告看板的「归档」列的事实源。 */
export interface ArchiveRow {
  run_id: string;
  archive_id: string;
  filename: string;
  archive_sha256: string;
  zip_sha256: string;
  created: string;
  with: string[];
}

export function listArchives(env: Env): ArchiveRow[] {
  const p = verifyPaths(env);
  if (!existsSync(p.archives)) return [];
  const rows: ArchiveRow[] = [];
  for (const f of readdirSync(p.archives)) {
    if (!f.endsWith(".json")) continue;
    const runId = f.slice(0, -5);
    if (!ID_RE.test(runId)) continue;
    const side = readJson<any>(join(p.archives, f));
    for (const a of Array.isArray(side?.archives) ? side.archives : []) {
      rows.push({
        run_id: runId,
        archive_id: String(a?.archive_id ?? ""),
        filename: String(a?.filename ?? ""),
        archive_sha256: String(a?.archive_sha256 ?? ""),
        zip_sha256: String(a?.zip_sha256 ?? ""),
        created: String(a?.created ?? ""),
        with: Array.isArray(a?.with) ? a.with.map(String) : [],
      });
    }
  }
  return rows.sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * 报告看板详情：报告原文 + 归档侧车（不重算、不改写——报告不可变）。
 *
 * `source_warning` 是把 `report import` 的那句提醒**投影到读面**（r27 Q1）：跨机绝对
 * 路径合法，但 shell 装不下的来源（含元字符、尾随分隔符）在 graduate --schedule 时
 * 必被拒，看板要能提前看见，而不是等执行才踩。只出声、不改变报告内容。
 */
export function reportDetail(env: Env, runId: string): { report: unknown; archives: unknown[]; source_warning: string | null } | null {
  const p = verifyPaths(env);
  const at = safeJoin(p.reports, runId, ".json");
  if (!at) return null;
  const report = readJson<any>(at);
  if (!report) return null;
  const sidePath = safeJoin(p.archives, runId, ".json");
  const side = sidePath ? readJson<any>(sidePath) : null;
  const source = typeof report?.data_source?.source === "string" ? report.data_source.source : "";
  const sourceWarning = source && !source.startsWith("blob:") && !shellSafePath(source) ? "data_source.source is not a plain filesystem path — graduation will refuse to schedule it" : null;
  return { report, archives: Array.isArray(side?.archives) ? side.archives : [], source_warning: sourceWarning };
}

export interface MaterialRow {
  material_id: string;
  title: string;
  created: string;
  text_sha256: string;
  files: number;
}

/** 材料清单：只回投影，不回正文（正文走 getMaterial）。 */
export function listMaterials(env: Env): MaterialRow[] {
  const p = verifyPaths(env);
  return listDirs(p.materials)
    .map((d) => {
      const m = readJson<any>(join(p.materials, d, "material.json"));
      if (!m) return null;
      return {
        material_id: String(m.material_id ?? d),
        title: String(m.title ?? ""),
        created: String(m.created ?? ""),
        text_sha256: String(m.text_sha256 ?? ""),
        files: Array.isArray(m.files) ? m.files.length : 0,
      } satisfies MaterialRow;
    })
    .filter((x): x is MaterialRow => x !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

/** 材料正文（专家提交的「一段话」原文——构造追溯视图左列的事实源）。 */
export function getMaterial(env: Env, materialId: string): { record: unknown; text: string } | null {
  const p = verifyPaths(env);
  const dir = safeJoin(p.materials, materialId);
  if (!dir) return null;
  const record = readJson<any>(join(dir, "material.json"));
  if (!record) return null;
  let text = "";
  try {
    text = readFileSync(join(dir, "material.txt"), "utf8");
  } catch {
    text = "";
  }
  return { record, text };
}

function safeBaseName(name: string): string {
  const base = basename(String(name || "")).replace(/[\u0000-\u001f]/g, "").trim();
  if (!base || base === "." || base === "..") return "attachment";
  return base.slice(0, 120);
}

export interface MaterialFileRow {
  path: string;
  sha256: string;
  mime: string;
  size: number;
  stored: string;
  blob: true;
}

/** 材料草稿写入（三视图里唯一的人工写入面）。
 *
 * 附件以 sha256 引用提交：字节早已由 `PUT /api/verify/blob` 落到内容寻址仓。
 * 引用不存在的 blob 一律拒绝（不静默丢弃，也不凭名字猜内容）——材料缺失是
 * prepare 的 NEEDS-MATERIAL 根因，验证器最怕的不是拒绝，是假装有材料。
 */
export function createMaterialDraft(
  env: Env,
  input: { title?: unknown; text?: unknown; attachments?: unknown; created?: string }
):
  | { ok: true; material_id: string; text_sha256: string; files: MaterialFileRow[] }
  | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return { ok: false, error: "material text is empty — a material must say something in words" };
  const p = verifyPaths(env);

  let refs: MaterialFileRow[] = [];
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) return { ok: false, error: "attachments must be an array of {sha256,name}" };
    for (const raw of input.attachments) {
      const sha = typeof (raw as any)?.sha256 === "string" ? String((raw as any).sha256) : "";
      const name = typeof (raw as any)?.name === "string" ? String((raw as any).name) : "";
      if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, error: `attachment sha256 must be 64 lowercase hex chars: ${sha || "(missing)"}` };
      if (!hasBlob(p.root, sha)) return { ok: false, error: `attachment blob not found: ${sha} — upload it to PUT /api/verify/blob first` };
      let size = 0;
      try { size = statSync(blobPath(p.root, sha)).size; } catch { size = 0; }
      // mime 由服务端按扩展名定：客户端声明只作记录（见 blob-store clientMimeOf），
      // 不参与任何判定，也不写进规范。
      refs.push({
        path: safeBaseName(name || sha),
        sha256: sha,
        mime: mimeFor(name || sha),
        size,
        stored: `${sha.slice(0, 12)}-${safeBaseName(name || sha)}`,
        blob: true,
      });
    }
  }

  const digest = sha256(text);
  const materialId = `mat_${digest.slice(0, 12)}`;
  const dir = join(p.materials, materialId);
  if (existsSync(dir)) {
    // 幂等：同正文草稿重提交返回同一个 id（与 CLI `verify submit` 同口径）。
    const existing = readJson<any>(join(dir, "material.json"));
    const known = (Array.isArray(existing?.files) ? existing.files : []).map((f: any) => ({
      path: String(f.path ?? ""),
      sha256: String(f.sha256 ?? ""),
      mime: String(f.mime ?? ""),
      size: Number(f.size ?? 0),
      stored: String(f.stored ?? ""),
      blob: true as const,
    }));
    return { ok: true, material_id: materialId, text_sha256: digest, files: known };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "material.txt"), text, "utf8");
  writeFileSync(
    join(dir, "material.json"),
    JSON.stringify(
      {
        material_id: materialId,
        title: title || `draft ${materialId}`,
        created: input.created ?? new Date().toISOString(),
        text_sha256: digest,
        // 相对路径：与 CLI 的 material.json 同口径（早先这里写绝对路径，
        // 归档时 join(matDir, 绝对路径) 在 Windows 上会拼出无效路径）。
        text_path: "material.txt",
        files: refs,
        source: "webui-draft",
      },
      null,
      2
    ),
    "utf8"
  );
  return { ok: true, material_id: materialId, text_sha256: digest, files: refs };
}

/** 上传接口的开关：绑非回环地址时必须显式开启（写端点 + 任意字节 = 磁盘填充面）。 */
export function uploadAllowed(host: string): boolean {
  if (process.env.YGL_VERIFY_ALLOW_UPLOAD === "1") return true;
  if (process.env.YGL_VERIFY_ALLOW_UPLOAD === "0") return false;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** `PUT /api/verify/blob?name=<filename>` 的流式收字节入口（webui 负责连接生命周期）。 */
export function openBlobUpload(env: Env) {
  const p = verifyPaths(env);
  mkdirSync(join(p.root, "blobs"), { recursive: true });
  pruneIncoming(p.root);
  return createBlobSink(p.root);
}

export { BLOB_LIMIT };

export interface VerifyApiResult {
  status: number;
  body: unknown;
  /** true = 调用方应直接结束响应；false = 本模块不认这个路径。 */
  handled: boolean;
}

/** `/api/verify/*` 的只读分发。返回 handled=false 时由调用方走 404。 */
export function handleVerifyApi(env: Env, method: string, url: URL): VerifyApiResult {
  const path = url.pathname;
  const q = url.searchParams;
  const ok = (body: unknown): VerifyApiResult => ({ status: 200, body, handled: true });
  const miss = (msg: string): VerifyApiResult => ({ status: 404, body: { error: msg }, handled: true });
  const deny = (msg: string): VerifyApiResult => ({ status: 405, body: { error: msg }, handled: true });

  if (path === "/api/verify/specs") {
    if (method !== "GET") return deny("GET only");
    return ok(listSpecs(env));
  }
  if (path === "/api/verify/spec") {
    if (method !== "GET") return deny("GET only — material drafts are POST /api/verify/material");
    const id = q.get("id") || "";
    if (!id) return { status: 400, body: { error: "usage: /api/verify/spec?id=<spec-id>" }, handled: true };
    const d = specDetail(env, id);
    return d ? ok(d) : miss(`spec not found: ${id}`);
  }
  if (path === "/api/verify/reports") {
    if (method !== "GET") return deny("GET only");
    const spec = q.get("spec") || "";
    if (spec && !ID_RE.test(spec)) return miss(`spec not found: ${spec}`);
    return ok(listReports(env, spec || undefined));
  }
  if (path === "/api/verify/archives") {
    if (method !== "GET") return deny("GET only");
    return ok(listArchives(env));
  }
  if (path === "/api/verify/report") {
    if (method !== "GET") return deny("GET only");
    const run = q.get("run") || "";
    if (!run) return { status: 400, body: { error: "usage: /api/verify/report?run=<run-id>" }, handled: true };
    const d = reportDetail(env, run);
    return d ? ok(d) : miss(`report not found: ${run}`);
  }
  if (path === "/api/verify/materials") {
    if (method !== "GET") return deny("GET only");
    return ok(listMaterials(env));
  }
  if (path === "/api/verify/material") {
    if (method !== "GET") return deny("GET only");
    const id = q.get("id") || "";
    if (!id) return { status: 400, body: { error: "usage: /api/verify/material?id=<material-id>" }, handled: true };
    const m = getMaterial(env, id);
    return m ? ok(m) : miss(`material not found: ${id}`);
  }
  return { status: 404, body: { error: `unknown verify endpoint: ${path}` }, handled: false };
}

/** 写入面的 JSON body 上限（与 /api/task 同口径 64 KB）。 */
export const VERIFY_BODY_LIMIT = 64 * 1024;

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
