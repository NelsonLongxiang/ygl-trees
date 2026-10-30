/** verify archive —— 归档包（M13-1）：文件名规范、包内目录规范、manifest 全链、机械校验。
 *
 * 设计口径（docs/verify-contract.md §7）：
 * - 归档是默认动作（`verify run` 结束即归档）；可 `--no-archive` 关闭，但报告仍可复核。
 * - 报告不可变：归档元数据写在工作区侧车 `archives/<run_id>.json`，不写进 report.json
 *   （否则 payload_sha256 失效）。
 * - 包内只有一套目录布局，路径全 ASCII/POSIX/≤3 层，大小写不敏感冲突直接拒绝。
 * - 确定性：store-only zip + 固定 mtime + 路径排序 → `zip_sha256` 跨平台可复算。
 */
import { createHash } from "node:crypto";
import { readBlob } from "./blob-store";
import { updateListIndex } from "./verify-list-index";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalStringify } from "../../../verify/core/src/canonical";
import type { AsOfRef, VerifyReport, VerifySpec } from "../../../verify/core/src/contract";
import { payloadHash } from "../../../verify/core/src/engine";
import { binaryKey } from "./sealed-binary";
import { readZipStore, writeZipStore, type ZipEntry } from "./zip-store";

export const ARCHIVE_FORMAT_VERSION = "1.0";
export const ARCHIVE_EXT = ".yglverify.zip";
export type ArchiveWith = "materials" | "snapshot" | "binary";
export const ARCHIVE_WITH: ArchiveWith[] = ["materials", "snapshot", "binary"];

export interface ArchiveItem {
  path: string;
  sha256: string;
  size: number;
  role: string;
  original_name?: string;
}

export interface ArchiveManifest {
  format_version: string;
  archive_id: string;
  archive_sha256: string;
  created: string;
  filename: string;
  run_id: string;
  spec: { id: string; version: number; title: string; domain: string };
  contract_version: string;
  engine_version: string;
  corpus_version: string;
  payload_sha256: string;
  materials_sha256: string;
  as_of: AsOfRef;
  data_source?: VerifyReport["data_source"];
  with: ArchiveWith[];
  items: ArchiveItem[];
}

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
const short = (sha: string): string => sha.slice(0, 12);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 归档文件名语法：yglverify-<domain>-<slug>-v<n>-<utcstamp>-r<run8>.yglverify.zip */
export const ARCHIVE_NAME_RE = /^yglverify-([a-z][a-z0-9]{1,15})-([a-z0-9]+(?:-[a-z0-9]+)*)-v(\d{1,4})-(\d{8}T\d{6}Z)-r([0-9a-f]{8})\.yglverify\.zip$/;

export function slugifyTitle(title: string | undefined, specId: string): string {
  // 最小 spec 可以没有 title（契约里 title/domain 都是可选）：名字退化到 spec_id，不许崩
  const folded = String(title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return folded || `s${specId.replace(/^spec_/, "").replace(/[^0-9a-z]/g, "").slice(0, 8) || "unknown"}`;
}

export function utcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid archive timestamp: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function archiveFileName(input: { domain?: string | null; title?: string | null; specId: string; specVersion: number; created: string; runId: string }): string {
  const domain = String(input.domain || "general").toLowerCase().replace(/[^a-z0-9]/g, "");
  const safeDomain = /^[a-z][a-z0-9]{1,15}$/.test(domain) ? domain : "general";
  const run8 = input.runId.replace(/^run_/, "").replace(/[^0-9a-f]/g, "").slice(0, 8) || "00000000";
  return `yglverify-${safeDomain}-${slugifyTitle(input.title ?? undefined, input.specId)}-v${input.specVersion}-${utcStamp(input.created)}-r${run8}${ARCHIVE_EXT}`;
}

/** 包内单段文件名消毒：ASCII 化、保留 sha 前缀、Windows 保留名规避。 */
export function safeNameSegment(raw: string): string {
  let s = String(raw)
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  if (!s) s = "file";
  if (s.length > 60) s = s.slice(0, 60).replace(/[._]+$/g, "") || "file";
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** 归档路径规范校验（§7.2）：POSIX 相对、≤4 层、单段 ≤100、全路径 ≤240、无保留名/尾随点空格。 */
export function pathProblems(path: string): string[] {
  const problems: string[] = [];
  const p = String(path);
  if (!p) return ["empty path"];
  if (p.length > 240) problems.push(`path too long (>240): ${p}`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) problems.push(`absolute path not allowed: ${p}`);
  if (p.includes("\\")) problems.push(`backslash not allowed: ${p}`);
  const segs = p.split("/");
  if (segs.length > 4) problems.push(`path deeper than 4 segments: ${p}`);
  for (const s of segs) {
    if (!s || s === "." || s === "..") problems.push(`empty/dot segment in: ${p}`);
    else if (s.length > 100) problems.push(`segment too long (>100): ${p}`);
    else if (!/^[A-Za-z0-9._-]+$/.test(s)) problems.push(`segment is not portable ASCII: ${p}`);
    else if (RESERVED.test(s.replace(/\.[^.]*$/, ""))) problems.push(`Windows reserved name in: ${p}`);
    else if (/[. ]$/.test(s)) problems.push(`segment ends with dot/space: ${p}`);
  }
  return problems;
}

/** 大小写不敏感 + NFC 的路径冲突检测（Windows/macOS 解压会互相覆盖）。 */
export function collisionProblems(paths: string[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const p of paths) {
    const key = String(p).normalize("NFC").toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== p) problems.push(`case/NFC path collision: ${prev} vs ${p}`);
    else seen.set(key, p);
  }
  return problems;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Workspace sidecar written by `verify run --submission` (0.113.2, #28). `dir`
 *  fields are local absolute paths and never enter the archive. */
interface SubmissionScanSidecar {
  run_id?: string;
  spec_id?: string;
  dir?: string;
  scans?: Array<{ vu_id?: string; dir?: string; files?: number; ignored?: number; matched?: Array<{ path?: string; sha256?: string; size?: number }> }>;
}

/** Archive-facing shape of the scan trace: relative paths + hashes only. */
export interface ArchivedSubmissionScan {
  run_id: string;
  spec_id?: string;
  scans: Array<{ vu_id: string; files: number; ignored: number; matched: Array<{ path: string; sha256: string; size: number }> }>;
}

/** Whitelist projection sidecar → archive item (no `dir`, no absolute paths). */
export function projectSubmissionScan(raw: SubmissionScanSidecar): ArchivedSubmissionScan {
  const out: ArchivedSubmissionScan = {
    run_id: String(raw.run_id ?? ""),
    scans: (raw.scans ?? []).map((s) => ({
      vu_id: String(s.vu_id ?? ""),
      files: Number(s.files ?? 0),
      ignored: Number(s.ignored ?? 0),
      matched: (s.matched ?? []).map((m) => ({ path: String(m.path ?? ""), sha256: String(m.sha256 ?? ""), size: Number(m.size ?? 0) })),
    })),
  };
  if (raw.spec_id) out.spec_id = String(raw.spec_id);
  for (const s of out.scans) {
    for (const m of s.matched) {
      // The engine records `relOf(p)` (POSIX, relative to --submission). A leak
      // of an absolute or parent-escaping path is a bug upstream of us; refuse
      // rather than archive it.
      if (m.path.startsWith("/") || /^[A-Za-z]:/.test(m.path) || m.path.split("/").includes("..")) {
        throw new Error(`submission scan path is not relative: ${m.path} — refusing to archive it`);
      }
    }
  }
  return out;
}

export interface BuildArchiveOptions {
  /** $YGL_HOME/verify */
  verifyRoot: string;
  runId: string;
  with?: ArchiveWith[];
  /** 输出文件路径；缺省 = $YGL_HOME/verify/archives/<规范文件名> */
  out?: string;
  created?: string;
  /**
   * 快照源文件（r14 R1）：跨实现报告（如 Rust 直跑）不会在工作区留 retained 快照，
   * 由调用方交同一份 --db 字节；入包前按报告 data_source.sha256 校验，不符即拒绝。
   */
  snapshotSource?: string;
  /** A1 group archives: a group report has no material/prepare.json; skip the
   *  materials section instead of failing on a spec that never had one. */
  skipMaterials?: boolean;
}

export interface BuildArchiveResult {
  path: string;
  filename: string;
  manifest: ArchiveManifest;
  zip_sha256: string;
}

export function buildArchive(opts: BuildArchiveOptions): BuildArchiveResult {
  const root = opts.verifyRoot;
  const reportPath = join(root, "reports", `${opts.runId}.json`);
  if (!existsSync(reportPath)) throw new Error(`report not found for run: ${opts.runId}`);
  const report = readJsonFile<VerifyReport>(reportPath);
  // G4（评审 r12）：没有 payload_sha256 的报告归档出来必然过不了自校验链——入口 fail-closed。
  if (!report.payload_sha256) throw new Error(`report ${opts.runId} has no payload_sha256 — refusing to archive an unverifiable report`);
  const specId = report.spec_id;
  if (!specId) throw new Error(`report ${opts.runId} has no spec_id — cannot archive`);
  const specDir = join(root, "specs", specId);
  const specPath = join(specDir, "spec.json");
  if (!existsSync(specPath)) throw new Error(`spec not found: ${specId}`);
  const spec = readJsonFile<VerifySpec>(specPath);
  let withKinds = opts.with && opts.with.length ? [...new Set(opts.with)] : (["materials"] as ArchiveWith[]);
  if (opts.skipMaterials) withKinds = withKinds.filter((k) => k !== "materials");
  for (const k of withKinds) {
    if (!ARCHIVE_WITH.includes(k)) throw new Error(`unknown --with kind: ${k} (allowed: ${ARCHIVE_WITH.join("|")})`);
  }

  const entries: ZipEntry[] = [];
  const items: ArchiveItem[] = [];
  const push = (path: string, data: Buffer, role: string, originalName?: string): void => {
    const item: ArchiveItem = { path, sha256: sha256(data), size: data.length, role };
    if (originalName && originalName !== path) item.original_name = originalName;
    entries.push({ path, data });
    items.push(item);
  };

  push("report.json", readFileSync(reportPath), "report");
  push("spec.json", readFileSync(specPath), "spec");
  // #25a: a --no-meta bypass leaves a canonical provenance sidecar next to the
  // frozen spec; it enters the archive (and therefore the evidence chain) as a
  // first-class item so the audit claim is verifiable byte-for-byte.
  const specBypassPath = join(specDir, "meta-bypass.json");
  if (existsSync(specBypassPath)) {
    // The provenance file carries its own payload_sha256; the item sha256 in
    // manifest.items binds the exact bytes into the archive chain (no extra
    // manifest field, so the frozen manifest shape stays put).
    push("meta-bypass.json", readFileSync(specBypassPath), "meta-bypass");
  }
  for (const [file, role] of [["prepare.json", "prepare"], ["trace.json", "trace"]] as const) {
    const p = join(specDir, file);
    if (existsSync(p)) push(file, readFileSync(p), role);
  }

  // #28: the file checker's scan trace is archived as a first-class item so a
  // PASS can be audited back to the exact bytes it pointed at. The report
  // evidence shape and the manifest top-level shape stay frozen.
  const scanPath = join(root, "submission-scans", `${opts.runId}.json`);
  if (existsSync(scanPath)) {
    const scanRaw = readJsonFile<SubmissionScanSidecar>(scanPath);
    // #27 plan T1 (#28 residual): the archived copy is a WHITELIST projection of
    // the sidecar, not "the sidecar minus `dir`". Every `dir` (top level and per
    // scan) is a machine-local absolute path; dropping them by projection means
    // the archive never carries one, and the same scan yields the same bytes on
    // any machine (zip determinism, contract §7.3).
    push("submission-scan.json", Buffer.from(`${JSON.stringify(projectSubmissionScan(scanRaw), null, 2)}\n`, "utf8"), "submission-scan");
    const dir = String(scanRaw.dir ?? "");
    const seen = new Set<string>();
    for (const scan of scanRaw.scans ?? []) {
      for (const f of scan.matched ?? []) {
        const sha = String(f.sha256 ?? "");
        const rel = String(f.path ?? "");
        if (!sha || !rel || seen.has(sha)) continue;
        let bytes: Buffer;
        try {
          bytes = readFileSync(join(dir, rel));
        } catch {
          throw new Error(`submission file missing: ${rel} (${dir}) — scanned bytes cannot be archived`);
        }
        if (sha256(bytes) !== sha) throw new Error(`submission file changed since the scan: ${rel} — bytes no longer match the recorded sha256`);
        seen.add(sha);
        push(`submission/${sha}`, bytes, "submission-file", rel);
      }
    }
  }

  const prepPath = join(specDir, "prepare.json");
  const prep = existsSync(prepPath) ? readJsonFile<{ material_id?: string; materials_sha256?: string }>(prepPath) : undefined;

  if (withKinds.includes("materials")) {
    const materialId = prep?.material_id;
    if (!materialId) throw new Error(`cannot archive materials: ${specId}/prepare.json has no material_id`);
    const matDir = join(root, "materials", materialId);
    const recPath = join(matDir, "material.json");
    if (!existsSync(recPath)) throw new Error(`materials not found for ${materialId}`);
    const rec = readJsonFile<{
      text_path?: string;
      files?: Array<{ path: string; stored: string; sha256?: string; blob?: boolean }>;
    }>(recPath);
    push(`materials/${materialId}/${safeNameSegment(rec.text_path || "material.txt")}`, readFileSync(join(matDir, rec.text_path || "material.txt")), "material");
    const matBypassPath = join(matDir, "meta-bypass.json");
    if (existsSync(matBypassPath)) {
      const b = readFileSync(matBypassPath);
      push(`materials/${materialId}/meta-bypass.json`, b, "meta-bypass");
    }
    for (const f of rec.files ?? []) {
      // 附件字节的唯一真相：`blob: true` 的条目在内容寻址仓（CLI `--attach` 与
      // HTTP 上传共用同一写入函数）；旧工作区没有该标记，仍按 material 本地副本读。
      let bytes: Buffer;
      if (f.blob) {
        if (!f.sha256) throw new Error(`attachment entry has blob flag but no sha256: ${f.path}`);
        try {
          bytes = readBlob(root, f.sha256);
        } catch {
          throw new Error(`attachment blob missing: ${f.sha256} (${f.path}) — the blob store was pruned or moved`);
        }
      } else {
        const src = join(matDir, "files", f.stored);
        if (!existsSync(src)) throw new Error(`attachment missing on disk: ${materialId}/files/${f.stored}`);
        bytes = readFileSync(src);
      }
      push(`materials/${materialId}/files/${safeNameSegment(f.stored)}`, bytes, "attachment", f.path);
    }
  }

  if (withKinds.includes("snapshot")) {
    const shaRaw = report.data_source?.sha256;
    if (!shaRaw) throw new Error("cannot archive snapshot: report has no data_source.sha256");
    // 契约统一 "sha256:<hex>"（r14 R1：TS 曾写裸 hex、Rust 写前缀，跨实现归档断链）；
    // 保留裸 hex 候选只是为读得懂旧工作区，不再是写入形态。
    const sha = shaRaw.replace(/^sha256:/, "");
    const candidates = [join(root, "snapshots", `${sha}.sqlite`), join(root, "snapshots", `${short(sha)}.sqlite`)];
    const found = candidates.find((p) => existsSync(p));
    if (found) {
      push(`snapshot/${short(sha)}.sqlite`, readFileSync(found), "snapshot");
    } else if (opts.snapshotSource) {
      const bytes = readFileSync(opts.snapshotSource);
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== sha) {
        throw new Error(`--snapshot ${opts.snapshotSource} does not match report.data_source.sha256 (report ${short(sha)}, file ${short(got)})`);
      }
      push(`snapshot/${short(sha)}.sqlite`, bytes, "snapshot");
    } else {
      throw new Error(`snapshot ${short(sha)} is not retained in the workspace (${join(root, "snapshots")}); pass --snapshot <db> to archive the exact bytes`);
    }
  }

  if (withKinds.includes("binary")) {
    const binSha = report.verifier.binary_sha256;
    if (!binSha) throw new Error("cannot archive binary: report has no verifier.binary_sha256 (open-mode report)");
    const key = binaryKey(binSha);
    const reg = join(root, "registrations", `${key}.json`);
    if (existsSync(reg)) push("verifier/registration.json", readFileSync(reg), "registration");
    const bin = join(root, "binaries", `${key}.bin`);
    if (existsSync(bin)) {
      const bytes = readFileSync(bin);
      // r16 P2①：归档只收「报告指名的那个构建」——文件名是 sha，但工作区副本可能被换过。
      const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (got !== binSha) throw new Error(`workspace binary ${short(binSha)} has different bytes (${short(got)}) — refusing to archive a binary that is not the one in the report`);
      push("verifier/binary/yglverify", bytes, "binary");
    }
    if (!existsSync(reg) && !existsSync(bin)) throw new Error(`cannot archive binary ${short(binSha)}: neither registration nor binary bytes in workspace`);
  }

  // G1（评审 r12）：created 缺省不能取 now()——同一 run 两次归档会得到不同 zip_sha256，
  // 与契约 §7.3「同输入同字节」矛盾。默认从 report.finished 派生（报告不可变 → 归档字节确定）。
  // 302cb119 残留 nit：report.finished 缺失时不能回退 now()（那等于把不确定性写进归档身份），
  // fail-closed 要求调用方显式给 created。
  const created = opts.created ?? report.finished;
  if (!created) throw new Error("report has no finished timestamp; pass created explicitly (archive identity must be deterministic)");
  const filename = archiveFileName({ domain: spec.domain, title: spec.title, specId: spec.spec_id, specVersion: spec.spec_version, created, runId: opts.runId });
  const itemsSorted = [...items].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const base = {
    format_version: ARCHIVE_FORMAT_VERSION,
    created,
    filename,
    run_id: opts.runId,
    spec: { id: spec.spec_id, version: spec.spec_version, title: spec.title, domain: spec.domain },
    contract_version: report.contract_version,
    engine_version: report.verifier.engine_version,
    corpus_version: report.verifier.corpus_version,
    payload_sha256: report.payload_sha256 ?? payloadHash(report),
    materials_sha256: spec.materials_sha256 ?? prep?.materials_sha256 ?? "",
    as_of: spec.as_of,
    data_source: report.data_source,
    with: withKinds,
    items: itemsSorted,
  };
  const archiveSha = `sha256:${sha256(canonicalStringify(base))}`;
  const manifest: ArchiveManifest = {
    format_version: base.format_version,
    archive_id: `arc_${archiveSha.slice(7, 19)}`,
    archive_sha256: archiveSha,
    created: base.created,
    filename: base.filename,
    run_id: base.run_id,
    spec: base.spec,
    contract_version: base.contract_version,
    engine_version: base.engine_version,
    corpus_version: base.corpus_version,
    payload_sha256: base.payload_sha256,
    materials_sha256: base.materials_sha256,
    as_of: base.as_of,
    data_source: base.data_source,
    with: base.with,
    items: base.items,
  };

  const allPaths = ["manifest.json", ...itemsSorted.map((i) => i.path)];
  const problems = [...allPaths.flatMap((p) => pathProblems(p)), ...collisionProblems(allPaths)];
  if (problems.length) throw new Error(`archive layout is not portable: ${problems.join("; ")}`);

  const zip = writeZipStore([{ path: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") }, ...entries]);
  const out = opts.out ? opts.out : join(opts.verifyRoot, "archives", filename);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip);
  return { path: out, filename, manifest, zip_sha256: sha256(zip) };
}

export interface ArchiveVerifyResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  manifest?: ArchiveManifest;
}

function foldSummary(vu: Array<{ role?: string; verdict?: string }>): Record<string, number> {
  const summary = { pass: 0, fail: 0, needs_material: 0, error: 0 };
  for (const v of vu) {
    if (v.role === "source") continue;
    if (v.verdict === "PASS") summary.pass += 1;
    else if (v.verdict === "FAIL") summary.fail += 1;
    else if (v.verdict === "NEEDS-MATERIAL") summary.needs_material += 1;
    else summary.error += 1;
  }
  return summary;
}

function foldOverall(summary: Record<string, number>): string {
  if (summary.fail > 0) return "FAIL";
  if (summary.needs_material > 0) return "NEEDS-MATERIAL";
  if (summary.error > 0) return "ERROR";
  return "PASS";
}

/** 从归档字节重算全链：路径规范 → items 哈希 → manifest → 报告载荷/折叠 → 版本一致。 */
export function verifyArchiveBytes(buf: Buffer): ArchiveVerifyResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  let entries: ZipEntry[];
  try {
    entries = readZipStore(buf);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], warnings };
  }
  const map = new Map(entries.map((e) => [e.path, e.data]));
  const paths = entries.map((e) => e.path);
  problems.push(...paths.flatMap((p) => pathProblems(p)), ...collisionProblems(paths));
  const raw = map.get("manifest.json");
  if (!raw) return { ok: false, problems: [...problems, "missing manifest.json"], warnings };
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as ArchiveManifest;
  } catch {
    return { ok: false, problems: [...problems, "manifest.json is not valid JSON"], warnings };
  }
  if (manifest.format_version !== ARCHIVE_FORMAT_VERSION) problems.push(`unsupported archive format_version: ${String(manifest.format_version)} (want ${ARCHIVE_FORMAT_VERSION})`);
  const { archive_id: _id, archive_sha256: _sha, ...base } = manifest as ArchiveManifest & Record<string, unknown>;
  const recomputed = `sha256:${sha256(canonicalStringify(base))}`;
  if (recomputed !== manifest.archive_sha256) problems.push(`archive_sha256 mismatch: manifest says ${manifest.archive_sha256}, recomputed ${recomputed}`);
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  for (const item of items) {
    problems.push(...pathProblems(item.path));
    const data = map.get(item.path);
    if (!data) {
      problems.push(`missing item: ${item.path}`);
      continue;
    }
    if (sha256(data) !== item.sha256) problems.push(`item hash mismatch: ${item.path}`);
    if (data.length !== item.size) problems.push(`item size mismatch: ${item.path} (${data.length} vs ${item.size})`);
  }
  const declared = new Set(items.map((i) => i.path));
  for (const p of paths) if (p !== "manifest.json" && !declared.has(p)) problems.push(`undeclared entry in archive: ${p}`);

  const reportRaw = map.get("report.json");
  if (reportRaw) {
    let report: VerifyReport;
    try {
      report = JSON.parse(reportRaw.toString("utf8")) as VerifyReport;
    } catch {
      problems.push("report.json is not valid JSON");
      report = undefined as unknown as VerifyReport;
    }
    if (report) {
      const recomputedPayload = payloadHash(report);
      if (report.payload_sha256 !== recomputedPayload) problems.push(`report payload_sha256 mismatch: report says ${String(report.payload_sha256)}, recomputed ${recomputedPayload}`);
      if (recomputedPayload !== manifest.payload_sha256) problems.push(`manifest payload_sha256 does not match report payload`);
      const folded = foldSummary(report.vu ?? []);
      for (const k of ["pass", "fail", "needs_material", "error"] as const) {
        if ((report.summary as unknown as Record<string, number>)?.[k] !== folded[k]) problems.push(`report summary.${k} mismatch: report ${String((report.summary as unknown as Record<string, number>)?.[k])}, recomputed ${folded[k]}`);
      }
      if (report.overall !== foldOverall(folded)) problems.push(`report overall mismatch: report ${String(report.overall)}, recomputed ${foldOverall(folded)}`);
      if (report.contract_version !== manifest.contract_version) problems.push(`contract_version mismatch: report ${report.contract_version}, manifest ${manifest.contract_version}`);
      if (report.verifier?.corpus_version !== manifest.corpus_version) problems.push(`corpus_version mismatch between report and manifest`);
      // G5（评审 r12）：manifest 写了 engine_version 就必须在链路里比对，不能只写不比
      if (report.verifier?.engine_version !== manifest.engine_version) problems.push(`engine_version mismatch: report ${String(report.verifier?.engine_version)}, manifest ${String(manifest.engine_version)}`);
      if (report.run_id !== manifest.run_id) problems.push(`run_id mismatch: report ${report.run_id}, manifest ${manifest.run_id}`);
    }
  } else {
    problems.push("missing report.json");
  }

  const specRaw = map.get("spec.json");
  if (specRaw) {
    let spec: VerifySpec;
    try {
      spec = JSON.parse(specRaw.toString("utf8")) as VerifySpec;
    } catch {
      problems.push("spec.json is not valid JSON");
      spec = undefined as unknown as VerifySpec;
    }
    if (spec) {
      if (spec.spec_id !== manifest.spec?.id) problems.push(`spec id mismatch: spec ${spec.spec_id}, manifest ${String(manifest.spec?.id)}`);
      if (spec.spec_version !== manifest.spec?.version) problems.push(`spec version mismatch: spec ${spec.spec_version}, manifest ${String(manifest.spec?.version)}`);
      if (spec.contract_version !== manifest.contract_version) problems.push(`spec contract_version mismatch: spec ${spec.contract_version}, manifest ${manifest.contract_version}`);
      if (spec.verifier?.corpus_version !== manifest.corpus_version) problems.push(`spec corpus_version mismatch: spec ${spec.verifier?.corpus_version}, manifest ${manifest.corpus_version}`);
      if (spec.materials_sha256 && manifest.materials_sha256 !== spec.materials_sha256) problems.push(`materials_sha256 mismatch between spec and manifest`);
    }
  } else {
    problems.push("missing spec.json");
  }

  const derived = archiveFileName({
    domain: manifest.spec?.domain ?? "general",
    title: manifest.spec?.title ?? "",
    specId: manifest.spec?.id ?? "",
    specVersion: Number(manifest.spec?.version ?? 0),
    created: manifest.created,
    runId: manifest.run_id,
  });
  if (manifest.filename && manifest.filename !== derived) warnings.push(`manifest filename "${manifest.filename}" does not match derived "${derived}"`);
  return { ok: problems.length === 0, problems, warnings, manifest };
}

/** A1 tree run: pinned leaf reads the frozen report back out of its archive.
 *  Callers MUST verify the archive first (same verifier as `archive verify`). */
export function readArchiveReport(path: string): VerifyReport {
  const entries = readZipStore(readFileSync(path));
  const entry = entries.find((e) => e.path === "report.json");
  if (!entry) throw new Error(`archive has no report.json: ${path}`);
  return JSON.parse(entry.data.toString("utf8")) as VerifyReport;
}

export function verifyArchiveFile(path: string): ArchiveVerifyResult {
  if (!existsSync(path)) return { ok: false, problems: [`archive not found: ${path}`], warnings: [] };
  return verifyArchiveBytes(readFileSync(path));
}

/** 把运行期快照副本收进工作区（内容寻址、按 sha 去重），供归档与重放使用。 */
export function retainSnapshot(verifyRoot: string, snapshot: { path: string; sha256: string }): string {
  const dir = join(verifyRoot, "snapshots");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${snapshot.sha256.replace(/^sha256:/, "")}.sqlite`);
  if (!existsSync(target)) copyFileSync(snapshot.path, target);
  return target;
}

/** 归档侧车登记（报告保持不可变，归档身份写在包的旁边）。 */
export interface ArchiveRegistryEntry {
  archive_id: string;
  archive_sha256: string;
  zip_sha256: string;
  filename: string;
  path: string;
  created: string;
  with: ArchiveWith[];
}
export interface ArchiveRegistry {
  run_id: string;
  spec_id: string;
  spec_version: number;
  archives: ArchiveRegistryEntry[];
}

export function registryPath(verifyRoot: string, runId: string): string {
  return join(verifyRoot, "archives", `${runId}.json`);
}

export function readRegistry(verifyRoot: string, runId: string): ArchiveRegistry | undefined {
  const p = registryPath(verifyRoot, runId);
  return existsSync(p) ? readJsonFile<ArchiveRegistry>(p) : undefined;
}

export function appendRegistry(verifyRoot: string, runId: string, spec: { id: string; version: number }, entry: ArchiveRegistryEntry): ArchiveRegistry {
  const dir = join(verifyRoot, "archives");
  mkdirSync(dir, { recursive: true });
  const prev = readRegistry(verifyRoot, runId);
  const next: ArchiveRegistry = {
    run_id: runId,
    spec_id: spec.id,
    spec_version: spec.version,
    archives: [...(prev?.archives ?? []).filter((a) => a.path !== entry.path), entry],
  };
  writeFileSync(registryPath(verifyRoot, runId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  updateListIndex(registryPath(verifyRoot, runId), next);
  return next;
}

/** 工作区里「跑过但没归档」的 run（按报告文件与侧车对比）。 */
export function unarchivedRuns(verifyRoot: string): Array<{ run_id: string; spec_id: string; overall: string; created: string }> {
  const reportsDir = join(verifyRoot, "reports");
  if (!existsSync(reportsDir)) return [];
  const results: Array<{ run_id: string; spec_id: string; overall: string; created: string }> = [];
  for (const name of readdirSyncSafe(reportsDir)) {
    if (!name.endsWith(".json")) continue;
    const runId = name.replace(/\.json$/, "");
    if (readRegistry(verifyRoot, runId)) continue;
    try {
      const report = readJsonFile<VerifyReport>(join(reportsDir, name));
      results.push({ run_id: runId, spec_id: String(report.spec_id ?? ""), overall: String(report.overall ?? ""), created: String(report.finished ?? "") });
    } catch {
      results.push({ run_id: runId, spec_id: "", overall: "UNREADABLE", created: "" });
    }
  }
  return results.sort((a, b) => a.created.localeCompare(b.created));
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

