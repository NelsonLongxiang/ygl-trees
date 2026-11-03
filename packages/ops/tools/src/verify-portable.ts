/**
 * #171 第1项：冻结件的**便携导出与回装**。
 *
 * 背景：`verify export` 只写裸 `spec.json`，新 home 里无法回装——只能重新 prepare，
 * 而重新 prepare 会让 `spec_version` 从 v1 起算、`as_of` 取当前时刻，于是 tree 判 STALE、
 * graduate 历史清零、两台机器的报告无法对质。本模块提供可回装的便携件：
 *
 * - 导出件是一个 JSON 信封：`entries[]`（role / 逻辑路径 / size / sha256）+ `payload`（base64 原字节）
 *   + `digest`（对 entries 的 JCS 规范化摘要）。`exported`（时间/引擎）只作信息，不参与身份。
 * - 回装先做**全量预检**（结构、路径、size/hash、契约、spec↔material 身份、附件闭合），
 *   再原子落位：材料/blob 先按内容寻址幂等落位，spec 目录最后 rename（可运行提交点）。
 * - 不变量：原样保留 spec_id / spec_version / as_of / created / materials_sha256 /
 *   schema_fingerprint / VU / sealed / 冻结 engine_version，绝不取 now/env 覆盖。
 * - 幂等/冲突：同 spec_id + 同版本 + 全部冻结字节相同 → duplicate（rc0）；
 *   同 spec_id 任一冻结字节或版本不同 → 冲突（rc1，保留原件，无 --force、不隐式升降版）。
 *
 * hash 只证明自洽与传输完整性，不证明作者可信：本模块不输出 signed/trusted，
 * 也不恢复封包登记或授予 command 权限。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Env } from "../../../core/database/src/types";
import { jcsCanonical } from "./jcs";
import { blobPath } from "./blob-store";

export const PORTABLE_FORMAT = "ygl-trees/verify-portable";
export const PORTABLE_VERSION = 1;

/** 允许的 role。任何其它 role 一律拒绝（清单定位不是任意磁盘路径）。 */
const ROLES = new Set(["spec", "prepare", "trace", "material", "material-text", "meta-bypass", "attachment"]);
/** 逻辑路径：固定形状，拒绝绝对路径、`..`、反斜杠与多级目录（附件统一 files/<sha256>）。 */
const SAFE_PATH = /^(?:[a-z0-9][a-z0-9.-]{0,40}|files\/[0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9_-]{3,80}$/;

export interface PortableEntry {
  role: string;
  path: string;
  size: number;
  sha256: string;
}

export interface PortableBundle {
  format: string;
  format_version: number;
  spec_id: string;
  spec_version: number;
  material_id: string;
  /** 信息字段：导出时刻与导出方引擎版本，**不参与身份**，导入不据此覆盖任何冻结值。 */
  exported: { at: string; engine: string };
  entries: PortableEntry[];
  /** 逻辑路径 → 原字节 base64。 */
  payload: Record<string, string>;
  /** 对 entries（按 path 排序）的 JCS 规范化摘要。 */
  digest: string;
}

export class PortableError extends Error {
  constructor(message: string, readonly code: 1 | 2 = 1) {
    super(message);
  }
}

const sha256hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const short = (hex: string): string => hex.slice(0, 12);

function readJsonFile(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** verify 根（与 verify-cmds 的 paths() 同构，但不在此处创建目录）。 */
function verifyRoots(env: Env) {
  const root = join(env.home, "verify");
  return {
    root,
    materials: join(root, "materials"),
    specs: join(root, "specs"),
    blobs: join(root, "blobs"),
  };
}

function safeId(value: unknown, what: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new PortableError(`${what} is not a safe id: ${String(value).slice(0, 60)}`, 2);
  return value;
}

/** spec_id 由 material_id 推导（`spec_<sha256(material_id)[:12]>`）——回装时用它校验身份。 */
export function specIdOf(materialId: string): string {
  return `spec_${short(sha256hex(materialId))}`;
}

/** 按 materials_sha256 反查材料目录（spec 不存 material_id，只能用内容哈希定位）。 */
function findMaterialIdByTextSha(materialsRoot: string, textSha: string): string | null {
  if (!existsSync(materialsRoot)) return null;
  for (const d of readdirSync(materialsRoot)) {
    const file = join(materialsRoot, d, "material.json");
    if (!existsSync(file)) continue;
    try {
      const rec = readJsonFile(file);
      if (rec?.text_sha256 === textSha) return String(rec.material_id ?? d);
    } catch {
      /* 坏材料目录不参与匹配 */
    }
  }
  return null;
}

function entryOf(role: string, logicalPath: string, bytes: Buffer): PortableEntry {
  return { role, path: logicalPath, size: bytes.length, sha256: sha256hex(bytes) };
}

function digestOf(entries: PortableEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return sha256hex(jcsCanonical(sorted));
}

/**
 * 构造便携件。导出面只读：不写任何东西，也不改冻结件。
 * 缺 prepare.json 时拒绝导出（回装后无法对质构造过程），错误码 1。
 */
export function buildPortable(env: Env, specId: string): PortableBundle {
  safeId(specId, "spec_id");
  const r = verifyRoots(env);
  const sdir = join(r.specs, specId);
  const specFile = join(sdir, "spec.json");
  if (!existsSync(specFile)) throw new PortableError(`spec not found: ${specId}`, 1);
  const spec = readJsonFile(specFile);
  if (spec?.spec_id !== specId) throw new PortableError(`spec.json identity mismatch: file says ${spec?.spec_id}, expected ${specId}`, 1);
  if (!existsSync(join(sdir, "prepare.json"))) throw new PortableError(`prepare.json missing for ${specId}: a portable bundle must carry the frozen prepare record (re-run verify prepare in this home first)`, 1);

  const textSha = String(spec?.materials_sha256 ?? "");
  const materialId = findMaterialIdByTextSha(r.materials, textSha);
  if (!materialId) throw new PortableError(`material for materials_sha256 ${textSha.slice(0, 16)}… not found in this home; cannot build a portable bundle`, 1);
  if (specIdOf(materialId) !== specId) throw new PortableError(`spec_id ${specId} does not match its material (${materialId} → ${specIdOf(materialId)})`, 1);

  const mdir = join(r.materials, materialId);
  const material = readJsonFile(join(mdir, "material.json"));
  if (material?.material_id !== materialId) throw new PortableError(`material.json identity mismatch in ${materialId}`, 1);

  const entries: PortableEntry[] = [];
  const payload: Record<string, string> = {};
  const put = (role: string, logicalPath: string, bytes: Buffer) => {
    entries.push(entryOf(role, logicalPath, bytes));
    payload[logicalPath] = bytes.toString("base64");
  };

  put("spec", "spec.json", readFileSync(specFile));
  put("prepare", "prepare.json", readFileSync(join(sdir, "prepare.json")));
  const traceFile = join(sdir, "trace.json");
  if (existsSync(traceFile)) put("trace", "trace.json", readFileSync(traceFile));
  const bypassFile = join(sdir, "meta-bypass.json");
  if (existsSync(bypassFile)) put("meta-bypass", "meta-bypass.json", readFileSync(bypassFile));
  put("material", "material.json", readFileSync(join(mdir, "material.json")));

  const textPath = String(material?.text_path ?? "material.txt");
  const textFile = join(mdir, textPath);
  if (!existsSync(textFile)) throw new PortableError(`material text missing: ${textPath}`, 1);
  const textBytes = readFileSync(textFile);
  if (sha256hex(textBytes) !== textSha) throw new PortableError(`material text sha256 mismatch for ${materialId}`, 1);
  put("material-text", "material.txt", textBytes);

  for (const f of Array.isArray(material?.files) ? material.files : []) {
    const sha = String(f?.sha256 ?? "");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new PortableError(`material file has an unusable sha256: ${sha}`, 1);
    const src = f?.blob ? blobPath(r.root, sha) : join(mdir, String(f?.path ?? ""));
    if (!existsSync(src)) throw new PortableError(`attachment bytes missing for ${sha.slice(0, 16)}…`, 1);
    const bytes = readFileSync(src);
    if (sha256hex(bytes) !== sha) throw new PortableError(`attachment sha256 mismatch for ${sha.slice(0, 16)}…`, 1);
    put("attachment", `files/${sha}`, bytes);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    format: PORTABLE_FORMAT,
    format_version: PORTABLE_VERSION,
    spec_id: specId,
    spec_version: Number(spec?.spec_version ?? 0),
    material_id: materialId,
    exported: { at: new Date().toISOString(), engine: String((env as any)?.version ?? "") },
    entries,
    payload,
    digest: digestOf(entries),
  };
}

/** 便携件的落盘文本（稳定缩进，便于 diff/审查）。 */
export function portableToText(bundle: PortableBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
interface DecodedBundle {
  spec: Buffer;
  prepare: Buffer;
  trace?: Buffer;
  bypass?: Buffer;
  material: Buffer;
  text: Buffer;
  attachments: Map<string, Buffer>;
}

const rand = (): string => Math.random().toString(36).slice(2, 10);

/** 同步小睡（导入锁重试用）：CLI 是短进程，这里只要不空转烧 CPU。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 结构面校验（rc=2 类：坏件/不合规清单）。只做**不执行任何 checker、不读源库**的静态检查：
 * 信封字段、role 闭集、逻辑路径安全、清单无重复、size/sha256 与 payload 一致、总摘要一致。
 */
export function decodePortable(raw: unknown): DecodedBundle {
  if (!raw || typeof raw !== "object") throw new PortableError("portable bundle is not a JSON object", 2);
  const b = raw as Partial<PortableBundle>;
  if (b.format !== PORTABLE_FORMAT) throw new PortableError(`not a portable bundle: format=${String(b.format)} (expected ${PORTABLE_FORMAT}); a bare spec export cannot be re-installed — re-export with --portable in the original home`, 2);
  if (b.format_version !== PORTABLE_VERSION) throw new PortableError(`unsupported portable format_version: ${String(b.format_version)} (this CLI understands ${PORTABLE_VERSION})`, 2);
  if (!Array.isArray(b.entries) || b.entries.length === 0) throw new PortableError("portable bundle has no entries", 2);
  if (!b.payload || typeof b.payload !== "object") throw new PortableError("portable bundle has no payload map", 2);

  const seen = new Set<string>();
  const byRole = new Map<string, PortableEntry>();
  const attachments = new Map<string, Buffer>();
  const buffers = new Map<string, Buffer>();

  for (const e of b.entries as PortableEntry[]) {
    if (!e || typeof e !== "object") throw new PortableError("portable entry is not an object", 2);
    const role = String(e.role ?? "");
    const path = String(e.path ?? "");
    if (!ROLES.has(role)) throw new PortableError(`unknown entry role: ${role}`, 2);
    if (!SAFE_PATH.test(path)) throw new PortableError(`unsafe entry path: ${path} (logical paths only; no absolute, no "..", no nested dirs except files/<sha256>)`, 2);
    if (seen.has(path)) throw new PortableError(`duplicate entry path: ${path}`, 2);
    seen.add(path);
    const b64 = (b.payload as Record<string, string>)[path];
    if (typeof b64 !== "string") throw new PortableError(`payload missing for entry: ${path}`, 2);
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length !== Number(e.size)) throw new PortableError(`size mismatch for ${path}: manifest ${e.size}, payload ${bytes.length}`, 2);
    const got = sha256hex(bytes);
    if (got !== e.sha256) throw new PortableError(`sha256 mismatch for ${path}: manifest ${e.sha256}, payload ${got}`, 2);
    buffers.set(path, bytes);
    if (role === "attachment") {
      const m = /^files\/([0-9a-f]{64})$/.exec(path);
      if (!m) throw new PortableError(`attachment path must be files/<sha256>: ${path}`, 2);
      if (m[1] !== got) throw new PortableError(`attachment path does not match its bytes: ${path}`, 2);
      attachments.set(got, bytes);
    } else {
      if (byRole.has(role)) throw new PortableError(`duplicate role: ${role}`, 2);
      byRole.set(role, e);
    }
  }

  const wantDigest = sha256hex(jcsCanonical([...(b.entries as PortableEntry[])].sort((x, y) => x.path.localeCompare(y.path))));
  if (b.digest !== wantDigest) throw new PortableError(`bundle digest mismatch: manifest ${String(b.digest)}, recomputed ${wantDigest}`, 2);

  for (const required of ["spec", "prepare", "material", "material-text"]) {
    if (!byRole.has(required)) throw new PortableError(`portable bundle is missing the ${required} entry`, 2);
  }
  const take = (role: string): Buffer | undefined => {
    const e = byRole.get(role);
    return e ? buffers.get(e.path) : undefined;
  };
  return {
    spec: take("spec")!,
    prepare: take("prepare")!,
    trace: take("trace"),
    bypass: take("meta-bypass"),
    material: take("material")!,
    text: take("material-text")!,
    attachments,
  };
}

/** 冻结身份校验（rc=1 类：内容不合契约/身份对不上）。全部静态检查，不执行 checker。 */
function validateFrozenIdentity(bundle: PortableBundle, d: DecodedBundle): { spec: any; material: any } {
  const spec = JSON.parse(d.spec.toString("utf8"));
  const material = JSON.parse(d.material.toString("utf8"));
  safeId(bundle.spec_id, "spec_id");
  safeId(bundle.material_id, "material_id");

  if (spec?.spec_id !== bundle.spec_id) throw new PortableError(`spec.json spec_id ${spec?.spec_id} != manifest ${bundle.spec_id}`, 1);
  const version = Number(spec?.spec_version);
  if (!Number.isInteger(version) || version < 1) throw new PortableError(`spec_version must be a positive integer, got ${String(spec?.spec_version)}`, 1);
  if (version !== Number(bundle.spec_version)) throw new PortableError(`spec_version mismatch: spec.json ${version}, manifest ${bundle.spec_version}`, 1);
  // as_of 是冻结时间锚：字符串，或 { kind: "snapshot", value: "<ISO>" } 信封（verify prepare 的落盘形）
  const asOfRaw = spec?.as_of;
  const asOfValue = typeof asOfRaw === "string" ? asOfRaw : asOfRaw && typeof asOfRaw === "object" ? String((asOfRaw as any).value ?? "") : "";
  if (!asOfValue || !Number.isFinite(Date.parse(asOfValue))) throw new PortableError(`as_of is not a parseable timestamp: ${JSON.stringify(asOfRaw)}`, 1);
  if (specIdOf(bundle.material_id) !== bundle.spec_id) throw new PortableError(`spec_id ${bundle.spec_id} does not match material ${bundle.material_id} (expected ${specIdOf(bundle.material_id)})`, 1);

  if (material?.material_id !== bundle.material_id) throw new PortableError(`material.json material_id ${material?.material_id} != manifest ${bundle.material_id}`, 1);
  const textSha = sha256hex(d.text);
  if (material?.text_sha256 !== textSha) throw new PortableError(`material text sha256 mismatch: material.json ${String(material?.text_sha256)}, bundle ${textSha}`, 1);
  if (spec?.materials_sha256 !== textSha) throw new PortableError(`spec materials_sha256 ${String(spec?.materials_sha256)} does not match the bundled material text ${textSha}`, 1);

  const files = Array.isArray(material?.files) ? material.files : [];
  for (const f of files) {
    const sha = String(f?.sha256 ?? "");
    if (!d.attachments.has(sha)) throw new PortableError(`attachment missing from bundle: ${sha.slice(0, 16)}…`, 1);
    if (d.attachments.get(sha)!.length !== Number(f?.size)) throw new PortableError(`attachment size mismatch for ${sha.slice(0, 16)}…`, 1);
  }
  const referenced = new Set(files.map((f: any) => String(f?.sha256 ?? "")));
  if (d.attachments.size !== referenced.size) throw new PortableError("bundle carries attachments the material does not reference", 1);

  // prepare/trace 的身份字段（存在即必须一致；旧记录没有这些字段时不强加要求）
  for (const [label, buf] of [["prepare.json", d.prepare], ["trace.json", d.trace]] as const) {
    if (!buf) continue;
    let rec: any;
    try {
      rec = JSON.parse(buf.toString("utf8"));
    } catch {
      throw new PortableError(`${label} is not valid JSON`, 1);
    }
    if (rec?.spec_id !== undefined && rec.spec_id !== bundle.spec_id) throw new PortableError(`${label} spec_id ${rec.spec_id} != ${bundle.spec_id}`, 1);
    if (rec?.spec_version !== undefined && Number(rec.spec_version) !== version) throw new PortableError(`${label} spec_version ${rec.spec_version} != ${version}`, 1);
    if (rec?.material_id !== undefined && rec.material_id !== bundle.material_id) throw new PortableError(`${label} material_id ${rec.material_id} != ${bundle.material_id}`, 1);
  }
  return { spec, material };
}
export interface PortableImportResult {
  rc: 0 | 1 | 2;
  spec_id?: string;
  spec_version?: number;
  material_id?: string;
  duplicate?: boolean;
  error?: string;
}

const sameBytes = (a: string, b: Buffer): boolean => {
  try {
    return readFileSync(a).equals(b);
  } catch {
    return false;
  }
};

/** 目录内容与给定文件逐字节相同？缺文件即不同。 */
function dirMatches(dir: string, files: Record<string, Buffer>): boolean {
  for (const [name, bytes] of Object.entries(files)) {
    if (!sameBytes(join(dir, name), bytes)) return false;
  }
  return true;
}

/** 同卷临时目录 → 逐文件写 → rename 成目标（目标必须不存在）。 */
function writeDirAtomic(target: string, files: Record<string, Buffer>): void {
  const stage = `${target}.tmp-${rand()}`;
  mkdirSync(stage, { recursive: true });
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(stage, name), bytes);
    renameSync(stage, target);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

/** blob 按内容寻址幂等落位（已存在且字节相同即复用）。 */
function putBlobBytes(blobsRoot: string, sha: string, bytes: Buffer): void {
  const target = blobPath(join(blobsRoot, ".."), sha);
  if (existsSync(target) && sameBytes(target, bytes)) return;
  mkdirSync(join(target, ".."), { recursive: true });
  const stage = `${target}.tmp-${rand()}`;
  writeFileSync(stage, bytes);
  try {
    renameSync(stage, target);
  } catch (e) {
    rmSync(stage, { force: true });
    throw e;
  }
}

/**
 * 回装：预检 → 加锁 → 重新判重/冲突 → blob 与材料先落位 → spec 目录最后 rename。
 * 提交点 = spec 目录出现；崩溃最多留下不可见的孤立 staging/blob，不会出现可运行的半份 spec。
 */
export function importPortable(env: Env, filePath: string): PortableImportResult {
  const r = verifyRoots(env);
  if (!existsSync(filePath)) return { rc: 1, error: `portable bundle not found: ${filePath}` };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e: any) {
    return { rc: 2, error: `cannot parse portable bundle: ${e?.message || e}` };
  }

  let decoded: DecodedBundle;
  let spec: any;
  let material: any;
  try {
    decoded = decodePortable(raw);
    ({ spec, material } = validateFrozenIdentity(raw as PortableBundle, decoded));
  } catch (e: any) {
    if (e instanceof PortableError) return { rc: e.code, error: e.message };
    return { rc: 1, error: String(e?.message || e) };
  }

  const bundle = raw as PortableBundle;
  const specId = bundle.spec_id;
  const materialId = bundle.material_id;
  const sdir = join(r.specs, specId);
  const mdir = join(r.materials, materialId);

  const specFiles: Record<string, Buffer> = { "spec.json": decoded.spec, "prepare.json": decoded.prepare };
  if (decoded.trace) specFiles["trace.json"] = decoded.trace;
  if (decoded.bypass) specFiles["meta-bypass.json"] = decoded.bypass;
  const materialFiles: Record<string, Buffer> = { "material.json": decoded.material, [String(material?.text_path ?? "material.txt")]: decoded.text };

  // 预检（无锁）：明显的冲突尽早失败，不白占锁
  if (existsSync(sdir) && !dirMatches(sdir, specFiles)) {
    return { rc: 1, error: `conflict: ${specId} already exists in this home with different frozen bytes or version (no --force, no implicit version bump)` };
  }
  if (existsSync(mdir) && !dirMatches(mdir, materialFiles)) {
    return { rc: 1, error: `conflict: material ${materialId} already exists in this home with different bytes` };
  }

  mkdirSync(r.root, { recursive: true });
  mkdirSync(r.materials, { recursive: true });
  mkdirSync(r.specs, { recursive: true });

  const lock = join(r.root, ".import.lock");
  let held = false;
  for (let i = 0; i < 120 && !held; i++) {
    try {
      mkdirSync(lock, { recursive: false });
      held = true;
    } catch {
      sleepSync(50);
    }
  }
  if (!held) return { rc: 1, error: "another import holds the verify workspace lock (timeout after ~6s)" };

  try {
    // 锁内重判：并发导入同一件时，一份落位、其余 duplicate；不同件一份成功、其余冲突
    if (existsSync(sdir)) {
      if (!dirMatches(sdir, specFiles)) return { rc: 1, error: `conflict: ${specId} was installed concurrently with different bytes` };
      if (!existsSync(mdir)) writeDirAtomic(mdir, materialFiles);
      return { rc: 0, spec_id: specId, spec_version: bundle.spec_version, material_id: materialId, duplicate: true };
    }
    if (existsSync(mdir) && !dirMatches(mdir, materialFiles)) {
      return { rc: 1, error: `conflict: material ${materialId} was installed concurrently with different bytes` };
    }

    for (const [sha, bytes] of decoded.attachments) putBlobBytes(r.blobs, sha, bytes);
    if (!existsSync(mdir)) writeDirAtomic(mdir, materialFiles);
    // spec 目录最后落位：它的出现就是「这份冻结件可运行」的提交点
    writeDirAtomic(sdir, specFiles);
    return { rc: 0, spec_id: specId, spec_version: bundle.spec_version, material_id: materialId };
  } catch (e: any) {
    return { rc: 1, error: `import failed: ${e?.message || e}` };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
