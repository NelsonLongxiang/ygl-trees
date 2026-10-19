/** 封包二进制读取（M13-1b）：`[engine][spec][footer json][u32 footer_len]`。
 *
 * 与 Rust `src/sealed.rs` 是同一套字节布局的两份实现——这里只读不写：
 * 构建侧（`yglverify seal`）在 Rust，登记侧（`verify register`）在 TS，
 * 两边都必须拒绝 「magic 不对 / spec_sha256 不符 / build_sha256 不符」。
 */
import { createHash } from "node:crypto";

export const SEALED_MAGIC = "YGLVF1";

export interface SealedFooter {
  magic: string;
  spec_offset: number;
  spec_length: number;
  spec_sha256: string;
  build_sha256: string;
  engine_version: string;
  corpus_version: string;
}

export interface SealedBinary {
  footer: SealedFooter;
  spec_text: string;
  spec: unknown;
  binary_sha256: string;
  engine_length: number;
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
  let footer: SealedFooter;
  try {
    footer = JSON.parse(bytes.subarray(footerStart, bytes.length - 4).toString("utf8")) as SealedFooter;
  } catch (e: any) {
    throw new Error(`sealed footer is not JSON: ${e?.message || e}`);
  }
  if (footer.magic !== SEALED_MAGIC) throw new Error(`sealed footer magic is ${JSON.stringify(footer.magic)}, expected ${SEALED_MAGIC}`);
  const specStart = footer.spec_offset;
  const specEnd = specStart + footer.spec_length;
  if (!Number.isInteger(specStart) || !Number.isInteger(specEnd) || specStart < 0 || specEnd !== footerStart) {
    throw new Error("sealed layout mismatch: spec bytes are not adjacent to the footer");
  }
  const engine = bytes.subarray(0, specStart);
  const specBytes = bytes.subarray(specStart, specEnd);
  if (sha256hex(specBytes) !== footer.spec_sha256) throw new Error("sealed spec_sha256 mismatch — the embedded spec was modified");
  if (sha256hex(Buffer.concat([engine, specBytes])) !== footer.build_sha256) throw new Error("sealed build_sha256 mismatch — engine or spec was tampered with");
  const specText = specBytes.toString("utf8");
  let spec: unknown;
  try {
    spec = JSON.parse(specText);
  } catch (e: any) {
    throw new Error(`embedded spec is not JSON: ${e?.message || e}`);
  }
  return { footer, spec_text: specText, spec, binary_sha256: `sha256:${sha256hex(bytes)}`, engine_length: specStart };
}
