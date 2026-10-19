/**
 * @module @ygl/verify-core/signature
 * 封包签名的字节口径（contract 1.1 / sealed footer v1）：
 * - 签名对象 = 域分隔串 + u32le(无签名 footer 的规范字节长度) + JCS(去签名字段的 footer)
 * - 文件里的 footer 必须是 JCS 规范形式（写入即规范化），验证先断言字节==JCS(parse) 再验签
 * - 签名字段：signature(base64) + signing_scheme + public_key_fingerprint(sha256(raw pubkey) hex)
 * - 信任锚是「带外登记 + 仓库密钥表」；公钥不得只随报告自证
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const SIGNING_SCHEME = "ed25519"; // footer `alg` / 报告 `signing_scheme` 的唯一合法值（跨实现同字节，勿加后缀）

/** 域分隔：让签名不可能被挪用到别的用途（\0 是 ASCII NUL）。 */
export const SIGNATURE_DOMAIN = "YGLVERIFY-SEAL-v1\0";

/** 签名覆盖面：域 + u32le(去签名 footer 规范字节长度) + 去签名 footer 的规范字节。 */
export function signaturePayload(canonicalWithoutSignature: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(canonicalWithoutSignature.length, 0);
  return Buffer.concat([Buffer.from(SIGNATURE_DOMAIN, "binary"), len, canonicalWithoutSignature]);
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 32 字节种子 → ed25519 私钥（PKCS#8 DER 包装，零依赖）。 */
export function privateKeyFromSeed(seed: Buffer): { privateKey: ReturnType<typeof createPrivateKey>; rawPublicKey: Buffer } {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, rawPublicKey: spki.subarray(spki.length - 32) };
}

export function publicKeyFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  if (raw.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function fingerprintOfRawPublicKey(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface SignedFooterParts {
  signature: string;
  signing_scheme: string;
  public_key_fingerprint: string;
}

/** 用 32 字节种子签「去签名 footer 的规范字节」。 */
export function signFooter(canonicalWithoutSignature: Buffer, seed: Buffer): SignedFooterParts {
  const { privateKey, rawPublicKey } = privateKeyFromSeed(seed);
  const sig = sign(null, signaturePayload(canonicalWithoutSignature), privateKey);
  return {
    signature: sig.toString("base64"),
    signing_scheme: SIGNING_SCHEME,
    public_key_fingerprint: fingerprintOfRawPublicKey(rawPublicKey),
  };
}

/** 验签：公钥由调用方按指纹从密钥表取出（认表不认报文）。 */
export function verifyFooter(
  canonicalWithoutSignature: Buffer,
  signatureB64: string,
  rawPublicKey: Buffer,
): boolean {
  try {
    return verify(null, signaturePayload(canonicalWithoutSignature), publicKeyFromRaw(rawPublicKey), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export interface SigningKeyEntry {
  /** raw ed25519 public key, hex（64 hex chars） */
  public_key: string;
  created: string;
  retired_at?: string;
  note?: string;
}

export interface SigningKeyTable {
  scheme: string;
  keys: Record<string, SigningKeyEntry>;
}

/** 验签认表：指纹必须在表内且未 retired，签名必须可验；缺一不可。 */
export function verifyAgainstTable(
  canonicalWithoutSignature: Buffer,
  parts: { signature?: string | null; signing_scheme?: string | null; public_key_fingerprint?: string | null },
  table: SigningKeyTable,
): { ok: true } | { ok: false; problem: string } {
  if (!parts.signature) return { ok: false, problem: "footer is not signed" };
  if (!parts.public_key_fingerprint) return { ok: false, problem: "footer is missing public_key_fingerprint" };
  if (parts.signing_scheme !== SIGNING_SCHEME) {
    return { ok: false, problem: `unsupported signing_scheme ${String(parts.signing_scheme)} — this build verifies ${SIGNING_SCHEME}` };
  }
  if (table.scheme !== SIGNING_SCHEME) return { ok: false, problem: `signing key table scheme is ${String(table.scheme)}, expected ${SIGNING_SCHEME}` };
  const entry = table.keys[parts.public_key_fingerprint];
  if (!entry) return { ok: false, problem: `public key ${parts.public_key_fingerprint} is not in the repository key table (unknown or never published)` };
  if (entry.retired_at) return { ok: false, problem: `public key ${parts.public_key_fingerprint} was retired at ${entry.retired_at} — artifacts signed with a retired key are not trusted` };
  const ok = verifyFooter(canonicalWithoutSignature, parts.signature, Buffer.from(entry.public_key, "hex"));
  if (!ok) return { ok: false, problem: "signature does not verify against the published key" };
  return { ok: true };
}
