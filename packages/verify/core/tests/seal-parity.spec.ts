import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalStringify } from "../src/canonical";
import {
  fingerprintOfRawPublicKey,
  privateKeyFromSeed,
  signFooter,
  SIGNING_SCHEME,
  verifyAgainstTable,
  type SigningKeyTable,
} from "../src/signature";

const REPO = resolve(__dirname, "../../../..");
const RUST_BIN = join(REPO, "rust/yglverify/target/release/yglverify" + (process.platform === "win32" ? ".exe" : ""));
const hasRust = existsSync(RUST_BIN);
if (!hasRust && process.env.YGL_REQUIRE_RUST === "1") {
  throw new Error(`YGL_REQUIRE_RUST=1 but ${RUST_BIN} is missing — run: cargo build --release --manifest-path rust/yglverify/Cargo.toml`);
}

/** RFC 8032 §7.1 TEST 1（同一对密钥在 Rust 与 TS 两侧都必须是同一公钥/同一签名）。 */
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const SEED = Buffer.from(SEED_HEX, "hex");

interface Footer {
  magic: string;
  format_version?: number;
  spec_offset: number;
  spec_length: number;
  spec_sha256: string;
  build_sha256: string;
  engine_sha256?: string;
  engine_version: string;
  corpus_version: string;
  sig_alg?: string;
  key_id?: string;
  sig?: string;
}

function readFooter(bytes: Buffer): { footer: Footer; raw: string } {
  const len = bytes.readUInt32LE(bytes.length - 4);
  const raw = bytes.subarray(bytes.length - 4 - len, bytes.length - 4).toString("utf8");
  return { footer: JSON.parse(raw) as Footer, raw };
}

describe.skipIf(!hasRust)("封包签名跨实现 parity（同种子 → 同签名）", () => {
  const dir = mkdtempSync(join(tmpdir(), "ygl-seal-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("Rust seal 产出的 footer 签名与 TS signFooter 逐字节一致", () => {
    const specPath = join(REPO, "packages/verify/core/corpus/cases/sql-find-violation/spec.json");
    const seedPath = join(dir, "seed.hex");
    writeFileSync(seedPath, SEED_HEX, "utf8");
    const out = join(dir, "sealed.bin");
    const res = spawnSync(RUST_BIN, ["seal", "--spec", specPath, "--out", out, "--key", seedPath], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);

    const bytes = readFileSync(out);
    const { footer, raw } = readFooter(bytes);
    // footer 必须是规范形（JCS(parse) == raw），否则验签输入两侧会错位
    expect(canonicalStringify(footer as never)).toBe(raw);
    expect(footer.format_version).toBe(1);
    expect(footer.sig_alg).toBe(SIGNING_SCHEME);
    expect(footer.sig).toBeTruthy();

    const input = Buffer.from(canonicalStringify({ ...footer, sig: undefined } as never), "utf8");
    const tsSig = signFooter(input, SEED);
    expect(footer.sig).toBe(tsSig.signature);
    expect(footer.key_id).toBe(tsSig.public_key_fingerprint);

    // 公钥派生也一致，且能按仓库密钥表验过
    const { rawPublicKey } = privateKeyFromSeed(SEED);
    expect(fingerprintOfRawPublicKey(rawPublicKey)).toBe(footer.key_id);
    const table: SigningKeyTable = { scheme: SIGNING_SCHEME, keys: { [footer.key_id as string]: { public_key: rawPublicKey.toString("hex"), created: "2026-10-20" } } };
    expect(
      verifyAgainstTable(Buffer.from(canonicalStringify({ ...footer, sig: undefined } as never), "utf8"), {
        signature: footer.sig ?? null,
        signing_scheme: footer.sig_alg ?? null,
        public_key_fingerprint: footer.key_id ?? null,
      }, table),
    ).toEqual({ ok: true });

    // footer 里的引擎哈希与字节自洽
    const engine = bytes.subarray(0, footer.spec_offset);
    const spec = bytes.subarray(footer.spec_offset, footer.spec_offset + footer.spec_length);
    expect(createHash("sha256").update(engine).digest("hex")).toBe(footer.engine_sha256);
    expect(createHash("sha256").update(Buffer.concat([engine, spec])).digest("hex")).toBe(footer.build_sha256);
  }, 120_000);
});
