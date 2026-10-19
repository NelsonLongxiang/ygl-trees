/** 封包二进制读取与验签（M13-1b / 契约 §5，footer v1）。
 *
 * 布局：`[engine][spec json (JCS)][footer json (JCS)][u32 footer_len]`。
 * 与 Rust `src/sealed.rs` 是同一套字节布局的两份实现——这里只读不写：
 * 构建侧（`yglverify seal`）在 Rust，登记/验签侧在 TS。
 *
 * 校验面（顺序固定，各自点名）：布局 → footer/spec 规范形（raw == JCS(parse)）→
 * spec_sha256 → build_sha256 → engine_sha256。签名不在封包内自证：调用方按仓库密钥表验证。
 */
import { createHash } from "node:crypto";

import { canonicalStringify } from "../../../verify/core/src/canonical";
import type { SigningKeyTable } from "../../../verify/core/src/signature";
import { verifyAgainstTable } from "../../../verify/core/src/signature";

export const SEALED_MAGIC = "YGLVF1";
export const SEALED_FORMAT_VERSION = 1;

export interface SealedFooter {
  magic: string;
  format_version?: number;
  engine_sha256?: string;
  spec_offset: number;
  spec_length: number;
  spec_sha256: string;
  build_sha256: string;
  engine_version: string;
  corpus_version: string;
  sig_alg?: string;
  key_id?: string;
  sig?: string;
}

export interface SealedBinary {
  footer: SealedFooter;
  /** footer 去掉签名字段后的规范字节（验签输入） */
  canonical_footer_without_signature: string;
  spec_text: string;
  spec: unknown;
  binary_sha256: string;
  engine_length: number;
  /** 旧封包（0.98.0 及之前，footer 无 format_version）：按 unsigned 处理 */
  legacy: boolean;
}

const sha256hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** 二进制文件名键：`sha256:abc…` 里的冒号在 Windows 上非法，落盘一律剥前缀。 */
export function binaryKey(sha: string): string {
  return sha.replace(/^sha256:/, "");
}

/** 解析封包字节；不是封包或校验不过都抛错（fail-closed，调用方决定怎么报）。 */
export function readSealedBinary(bytes: Buffer): SealedBinary {
  if (bytes.length < 4 + 2) throw new Error("sealed binary is truncated (no footer)");
  const footerLen = bytes.readUInt32LE(bytes.length - 4);
  if (footerLen === 0 || footerLen + 4 > bytes.length) throw new Error("sealed footer length is out of range");
  const footerStart = bytes.length - 4 - footerLen;
  const footerRaw = bytes.subarray(footerStart, bytes.length - 4);
  let footer: SealedFooter;
  try {
    footer = JSON.parse(footerRaw.toString("utf8")) as SealedFooter;
  } catch (e: any) {
    throw new Error(`sealed footer is not JSON: ${e?.message || e}`);
  }
  if (footer.magic !== SEALED_MAGIC) throw new Error(`sealed footer magic is ${JSON.stringify(footer.magic)}, expected ${SEALED_MAGIC}`);
  const legacy = footer.format_version === undefined;
  if (!legacy && footer.format_version !== SEALED_FORMAT_VERSION) {
    throw new Error(`sealed footer format_version ${String(footer.format_version)} is not supported (expects ${SEALED_FORMAT_VERSION})`);
  }
  // 规范形断言（fdc757f6 裁定②）：verify 侧同样执行，非规范即点名拒绝。
  if (canonicalStringify(footer as never) !== footerRaw.toString("utf8")) {
    throw new Error("sealed footer is not canonical (raw != JCS(parse)) — refusing to trust a non-canonical footer");
  }
  const specStart = footer.spec_offset;
  const specEnd = specStart + footer.spec_length;
  if (!Number.isInteger(specStart) || !Number.isInteger(specEnd) || specStart < 0 || specEnd !== footerStart) {
    throw new Error("sealed layout mismatch: spec bytes are not adjacent to the footer");
  }
  const engine = bytes.subarray(0, specStart);
  const specBytes = bytes.subarray(specStart, specEnd);
  if (sha256hex(specBytes) !== footer.spec_sha256) throw new Error("sealed spec_sha256 mismatch — the embedded spec was modified");
  if (sha256hex(Buffer.concat([engine, specBytes])) !== footer.build_sha256) {
    throw new Error("sealed build_sha256 mismatch — engine or spec was tampered with");
  }
  if (footer.engine_sha256 && sha256hex(engine) !== footer.engine_sha256) {
    throw new Error("sealed engine_sha256 mismatch — the engine was modified");
  }
  const specText = specBytes.toString("utf8");
  let spec: unknown;
  try {
    spec = JSON.parse(specText);
  } catch (e: any) {
    throw new Error(`embedded spec is not JSON: ${e?.message || e}`);
  }
  if (canonicalStringify(spec as never) !== specText) {
    throw new Error("sealed spec is not canonical (raw != JCS(parse)) — the embedded spec was re-serialized");
  }
  const bare: SealedFooter = { ...footer };
  delete bare.sig;
  return {
    footer,
    canonical_footer_without_signature: canonicalStringify(bare as never),
    spec_text: specText,
    spec,
    binary_sha256: `sha256:${sha256hex(bytes)}`,
    engine_length: specStart,
    legacy,
  };
}

export interface SealSignatureVerdict {
  signed: boolean;
  ok: boolean;
  problems: string[];
}

/** 验签：认表不认报文（公钥按指纹从仓库/工作区密钥表取，缺一不可）。 */
export function verifySealSignature(binary: SealedBinary, table: SigningKeyTable | null): SealSignatureVerdict {
  const parts = { signature: binary.footer.sig, signing_scheme: binary.footer.sig_alg, public_key_fingerprint: binary.footer.key_id };
  if (!parts.signature) {
    return { signed: false, ok: false, problems: binary.legacy ? [] : ["sealed binary is not signed (alg=none) — integrity only, provenance unproven"] };
  }
  if (!table) return { signed: true, ok: false, problems: ["sealed binary is signed but no signing key table was provided (pass --keys <file>)"] };
  const res = verifyAgainstTable(Buffer.from(binary.canonical_footer_without_signature, "utf8"), parts, table);
  return res.ok ? { signed: true, ok: true, problems: [] } : { signed: true, ok: false, problems: [res.problem] };
}
