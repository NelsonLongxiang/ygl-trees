import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalStringify } from "../../../verify/core/src/canonical";
import {
  fingerprintOfRawPublicKey,
  privateKeyFromSeed,
  signFooter,
  SIGNING_SCHEME,
  verifyAgainstTable,
  type SigningKeyTable,
} from "../../../verify/core/src/signature";
import { readSealedBinary, SEALED_MAGIC } from "../src/sealed-binary";

const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const sha256hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

interface CraftOptions {
  format_version?: number | null;
  sign?: boolean;
  key_id?: string;
  tamperSignature?: boolean;
  prettyFooter?: boolean;
}

/** 用 TS 侧口径造一个封包（Rust `seal` 是生产方；这里造负例更快）。 */
function craftSealed(spec: unknown, opts: CraftOptions = {}): Buffer {
  const engine = Buffer.from("engine-bytes-v1", "utf8");
  const specBytes = Buffer.from(canonicalStringify(spec), "utf8");
  const { rawPublicKey } = privateKeyFromSeed(SEED);
  const fingerprint = fingerprintOfRawPublicKey(rawPublicKey);
  const keyId = opts.key_id ?? fingerprint;
  const sign = opts.sign !== false;
  const footer: Record<string, unknown> = {
    magic: SEALED_MAGIC,
    spec_offset: engine.length,
    spec_length: specBytes.length,
    spec_sha256: sha256hex(specBytes),
    build_sha256: sha256hex(Buffer.concat([engine, specBytes])),
    engine_sha256: sha256hex(engine),
    engine_version: "0.1.0",
    corpus_version: "1.0",
  };
  if (opts.format_version !== null) footer.format_version = opts.format_version ?? 1;
  // 签名输入 = JCS(去掉签名字段)，所以先落 footer 再加签名
  if (sign) {
    footer.sig_alg = SIGNING_SCHEME;
    footer.key_id = keyId;
    const input = Buffer.from(canonicalStringify(footer as never), "utf8");
    const real = signFooter(input, SEED);
    footer.sig_alg = SIGNING_SCHEME;
    footer.key_id = keyId;
    const sig = Buffer.from(real.signature, "base64");
    if (opts.tamperSignature) sig[7] ^= 0x01;
    footer.sig = sig.toString("base64");
  }
  const footerText = opts.prettyFooter ? JSON.stringify(footer, null, 2) : canonicalStringify(footer as never);
  const footerBytes = Buffer.from(footerText, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footerBytes.length, 0);
  return Buffer.concat([engine, specBytes, footerBytes, len]);
}

const SPEC = { contract_version: "1.1", spec_id: "spec_test", spec_version: 1, vu: [] };
const GOOD_TABLE = (): SigningKeyTable => {
  const { rawPublicKey } = privateKeyFromSeed(SEED);
  return { scheme: SIGNING_SCHEME, keys: { [fingerprintOfRawPublicKey(rawPublicKey)]: { public_key: rawPublicKey.toString("hex"), created: "2026-10-20" } } };
};

describe("封包签名与篡改矩阵（footer v1）", () => {
  it("正常封包：布局/哈希链/签名全过", () => {
    const sealed = readSealedBinary(craftSealed(SPEC));
    expect(sealed.footer.format_version).toBe(1);
    expect(sealed.footer.sig_alg).toBe(SIGNING_SCHEME);
    const verdict = verifyAgainstTable(Buffer.from(sealed.canonical_footer_without_signature, "utf8"), {
      signature: sealed.footer.sig ?? null,
      signing_scheme: sealed.footer.sig_alg ?? null,
      public_key_fingerprint: sealed.footer.key_id ?? null,
    }, GOOD_TABLE());
    expect(verdict).toEqual({ ok: true });
  });

  it("篡改矩阵：spec / engine / footer 非规范 / 签名 / key_id / format_version 各自点名", () => {
    const base = craftSealed(SPEC);

    // ① spec 字节翻转 → spec_sha256 不符
    const specStart = readSealedBinary(base).footer.spec_offset;
    const t1 = Buffer.from(base);
    t1[specStart + 2] ^= 0x01;
    expect(() => readSealedBinary(t1)).toThrow(/spec_sha256 mismatch/);

    // ② engine 字节翻转 → build_sha256 不符
    const t2 = Buffer.from(base);
    t2[0] ^= 0x01;
    expect(() => readSealedBinary(t2)).toThrow(/build_sha256 mismatch/);

    // ③ footer 非规范形（pretty JSON）→ 拒绝
    expect(() => readSealedBinary(craftSealed(SPEC, { prettyFooter: true }))).toThrow(/not canonical/);

    // ④ 签名字节翻转 → 验签失败
    const t4 = readSealedBinary(craftSealed(SPEC, { tamperSignature: true }));
    expect(verifyAgainstTable(Buffer.from(t4.canonical_footer_without_signature, "utf8"), {
      signature: t4.footer.sig ?? null,
      signing_scheme: t4.footer.sig_alg ?? null,
      public_key_fingerprint: t4.footer.key_id ?? null,
    }, GOOD_TABLE())).toMatchObject({ ok: false, problem: expect.stringContaining("does not verify") });

    // ⑤ key_id 指向未知指纹 → 认表不认报文
    const t5 = readSealedBinary(craftSealed(SPEC, { key_id: "0".repeat(64) }));
    expect(verifyAgainstTable(Buffer.from(t5.canonical_footer_without_signature, "utf8"), {
      signature: t5.footer.sig ?? null,
      signing_scheme: t5.footer.sig_alg ?? null,
      public_key_fingerprint: t5.footer.key_id ?? null,
    }, GOOD_TABLE())).toMatchObject({ ok: false, problem: expect.stringContaining("not in the repository key table") });

    // ⑥ format_version 未知 → 拒绝（0.98.0 的 legacy 无字段是唯一豁免）
    expect(() => readSealedBinary(craftSealed(SPEC, { format_version: 2 }))).toThrow(/format_version 2 is not supported/);

    // ⑦ 旧封包（无 format_version/签名）按 unsigned 读取，不假称已验证
    const legacy = readSealedBinary(craftSealed(SPEC, { format_version: null, sign: false }));
    expect(legacy.legacy).toBe(true);
    expect(legacy.footer.sig_alg).toBeUndefined();
  });

  it("retired 密钥：表里有但已退役 → 拒绝（轮换只增不换）", () => {
    const sealed = readSealedBinary(craftSealed(SPEC));
    const { rawPublicKey } = privateKeyFromSeed(SEED);
    const table: SigningKeyTable = {
      scheme: SIGNING_SCHEME,
      keys: { [sealed.footer.key_id as string]: { public_key: rawPublicKey.toString("hex"), created: "2026-10-20", retired_at: "2026-11-01" } },
    };
    expect(verifyAgainstTable(Buffer.from(sealed.canonical_footer_without_signature, "utf8"), {
      signature: sealed.footer.sig ?? null,
      signing_scheme: sealed.footer.sig_alg ?? null,
      public_key_fingerprint: sealed.footer.key_id ?? null,
    }, table)).toMatchObject({ ok: false, problem: expect.stringContaining("retired") });
  });
});
