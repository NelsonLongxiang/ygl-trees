/** verify 服务面（M13-2）——WebUI 三视图的只读数据面 + 材料草稿写入。
 *
 * 裁定（docs/spec-validator.md §8 / §9）：
 * - 构造追溯视图是**只读审计面**，没有 ✓/✗ 按钮——这里不提供 confirm/approve；
 * - 材料提交是唯一的人工入口：标题 + 一段话（附件上传走 CLI `verify submit --attach`，
 *   multipart 解析排在 M13-2 第二批，本文件不假装支持）；
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
import { join } from "node:path";

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
export function specDetail(env: Env, specId: string): { spec: unknown; prepare: unknown; trace: unknown } | null {
  const p = verifyPaths(env);
  const dir = join(p.specs, specId);
  const spec = readJson<any>(join(dir, "spec.json"));
  if (!spec) return null;
  return {
    spec,
    prepare: readJson<any>(join(dir, "prepare.json")),
    trace: readJson<any>(join(dir, "trace.json")),
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
export function listReports(env: Env): ReportRow[] {
  const p = verifyPaths(env);
  if (!existsSync(p.reports)) return [];
  return readdirSync(p.reports)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<any>(join(p.reports, f)))
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
    .sort((a, b) => String(b.finished).localeCompare(String(a.finished)));
}

/** 报告看板详情：报告原文 + 归档侧车（不重算、不改写——报告不可变）。 */
export function reportDetail(env: Env, runId: string): { report: unknown; archives: unknown[] } | null {
  const p = verifyPaths(env);
  const report = readJson<any>(join(p.reports, `${runId}.json`));
  if (!report) return null;
  const side = readJson<any>(join(p.archives, `${runId}.json`));
  return { report, archives: Array.isArray(side?.archives) ? side.archives : [] };
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
  const dir = join(p.materials, materialId);
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

/** 材料草稿写入（三视图里唯一的人工写入面）。
 *
 * 附件上传还没接（multipart 排在第二批）：这里明确拒收 `attachments` 字段，而不是
 * 静默丢弃——静默丢弃会让「提交成功」的假象掩盖材料缺失，而材料缺失是 prepare 的
 * NEEDS-MATERIAL 根因（验证器最怕的不是拒绝，是假装有材料）。
 */
export function createMaterialDraft(
  env: Env,
  input: { title?: unknown; text?: unknown; created?: string }
): { ok: true; material_id: string; text_sha256: string } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return { ok: false, error: "material text is empty — a material must say something in words" };
  const digest = sha256(text);
  const materialId = `mat_${digest.slice(0, 12)}`;
  const p = verifyPaths(env);
  const dir = join(p.materials, materialId);
  if (existsSync(dir)) {
    // 幂等：同正文草稿重提交返回同一个 id（与 CLI `verify submit` 同口径）。
    return { ok: true, material_id: materialId, text_sha256: digest };
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
        text_path: join(dir, "material.txt"),
        files: [],
        source: "webui-draft",
      },
      null,
      2
    ),
    "utf8"
  );
  return { ok: true, material_id: materialId, text_sha256: digest };
}

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
    return ok(listReports(env));
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
