import { describe, expect, it } from "vitest";

import {
  fingerprintOfRawPublicKey,
  privateKeyFromSeed,
  publicKeyFromRaw,
  signFooter,
  SIGNING_SCHEME,
  verifyAgainstTable,
  verifyFooter,
  type SigningKeyTable,
} from "../src/signature";

/** RFC 8032 §7.1 TEST 1 的种子与公钥（跨实现签名向量的锚）。 */
const RFC8032_SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const RFC8032_PUB = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const CANONICAL = Buffer.from('{"alg":"ed25519","format_version":1,"magic":"YGLVF1","spec_offset":8}', "utf8");

describe("封包签名（contract 1.1 / footer v1）", () => {
  it("从种子派生公钥并算指纹（sha256(raw pubkey)）", () => {
    const { rawPublicKey } = privateKeyFromSeed(RFC8032_SEED);
    expect(rawPublicKey.equals(RFC8032_PUB)).toBe(true);
    expect(fingerprintOfRawPublicKey(rawPublicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("签名可被同口径验证；改一个字节即失败", () => {
    const signed = signFooter(CANONICAL, RFC8032_SEED);
    expect(signed.signing_scheme).toBe(SIGNING_SCHEME);
    expect(Buffer.from(signed.signature, "base64").length).toBe(64);
    expect(verifyFooter(CANONICAL, signed.signature, RFC8032_PUB)).toBe(true);
    expect(verifyFooter(Buffer.concat([CANONICAL, Buffer.from(" ")]), signed.signature, RFC8032_PUB)).toBe(false);
    const tampered = Buffer.from(signed.signature, "base64");
    tampered[0] ^= 0x01;
    expect(verifyFooter(CANONICAL, tampered.toString("base64"), RFC8032_PUB)).toBe(false);
  });

  it("签名是确定性的：同输入同种子同字节（跨实现 parity 的前提）", () => {
    const a = signFooter(CANONICAL, RFC8032_SEED);
    const b = signFooter(CANONICAL, RFC8032_SEED);
    expect(a.signature).toBe(b.signature);
    expect(a.public_key_fingerprint).toBe(b.public_key_fingerprint);
  });

  it("认表不认报文：表里没有的指纹拒绝，retired 也拒绝", () => {
    const signed = signFooter(CANONICAL, RFC8032_SEED);
    const parts = { signature: signed.signature, signing_scheme: SIGNING_SCHEME, public_key_fingerprint: signed.public_key_fingerprint };
    const base = { public_key: RFC8032_PUB.toString("hex"), created: "2026-10-20" };
    const good: SigningKeyTable = { scheme: SIGNING_SCHEME, keys: { [signed.public_key_fingerprint]: base } };
    expect(verifyAgainstTable(CANONICAL, parts, good)).toEqual({ ok: true });

    const unknown: SigningKeyTable = { scheme: SIGNING_SCHEME, keys: {} };
    expect(verifyAgainstTable(CANONICAL, parts, unknown)).toMatchObject({ ok: false, problem: expect.stringContaining("not in the repository key table") });

    const retired: SigningKeyTable = { scheme: SIGNING_SCHEME, keys: { [signed.public_key_fingerprint]: { ...base, retired_at: "2026-12-01" } } };
    expect(verifyAgainstTable(CANONICAL, parts, retired)).toMatchObject({ ok: false, problem: expect.stringContaining("retired") });

    const wrongScheme: SigningKeyTable = { scheme: "rsa-whatever", keys: { [signed.public_key_fingerprint]: base } };
    expect(verifyAgainstTable(CANONICAL, parts, wrongScheme)).toMatchObject({ ok: false });

    expect(verifyAgainstTable(CANONICAL, { ...parts, signature: null }, good)).toMatchObject({ ok: false, problem: expect.stringContaining("not signed") });
  });

  it("公钥长度与种子长度都有守门", () => {
    expect(() => privateKeyFromSeed(Buffer.alloc(31))).toThrow(/32 bytes/);
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});
