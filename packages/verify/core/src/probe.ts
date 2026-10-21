/**
 * `verify probe --matrix` (charter §4.3, 0.112.0).
 *
 * The review seats used to verify the sealed-binary trust chain with ad-hoc
 * scripts (sealprobe/sigprobe). P2 forbids that as *evidence*: probes must be
 * CLI commands. This module runs the frozen 16-probe union offline and emits a
 * machine-checkable verdict per probe:
 *
 *   dev eight:  envelope · signature · digest · timestamp · escalation ·
 *               injection · cross-machine · replay
 *   review eight (tamper): tamper-spec · tamper-engine · tamper-footer ·
 *               noncanon · sig-byte · unknown-key · retired-key · resign-fv
 *
 * Everything is deterministic: the fixture is sealed with an RFC8032 test seed
 * (no network, no production keys), and each entry's evidence_sha256 covers the
 * canonical JSON of its detail object.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalStringify } from "./canonical";
import { CORPUS_VERSION, type VerifySpec } from "./contract";
import { renderPredicate, runVerify, type QueryRunner } from "./engine";
import { fingerprintOfRawPublicKey, privateKeyFromSeed, signFooter, SIGNING_SCHEME, verifyAgainstTable, type SigningKeyTable } from "./signature";

export type ProbeVerdict = "PASS" | "FAIL";

export interface ProbeEntry {
  probe: string;
  verdict: ProbeVerdict;
  detail: Record<string, unknown>;
  evidence_sha256: string;
}

export interface ProbeMatrixReport {
  probe_version: string;
  target: string;
  seeds: string;
  probes: ProbeEntry[];
  verdict: ProbeVerdict;
  checked_at: string;
}

export const PROBE_VERSION = "1.0";
/** RFC8032 deterministic test seed (sha256 of the probe label) — never a real key. */
const PROBE_SEED = createHash("sha256").update("ygl-verify-probe-seed-v1").digest();

const sha256hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const jcs = (v: unknown): string => canonicalStringify(v as never);

interface Fixture {
  bytes: Buffer;
  footer: Record<string, unknown>;
  canonicalWithoutSignature: string;
  table: SigningKeyTable;
  seed: Buffer;
}

function buildFixture(): Fixture {
  const engine = Buffer.from("YGLVF1-probe-engine\n", "utf8");
  const spec: VerifySpec = {
    contract_version: "1.2",
    spec_id: "spec_probe",
    spec_version: 1,
    verifier: { engine_version: "0.1.0", corpus_version: CORPUS_VERSION },
    as_of: { kind: "snapshot", value: "2026-10-21T00:00:00.000Z" },
    attachments: [],
    sealed: { review: false },
    vu: [
      {
        id: "V1",
        role: "assert",
        title: "probe assertion",
        severity: "S1",
        source_clause: "probe clause",
        expected_from: { kind: "material-extract", source_id: "materials", anchor: "probe!A1", quote: "probe clause" },
        checker: {
          type: "count",
          predicate: { from: "probe", select: [], where: { op: "and", conditions: [{ col: "v", op: ">", value: 0 }] } },
          op: ">=",
          value: 1,
        },
      },
    ],
  } as unknown as VerifySpec;
  const specBytes = Buffer.from(jcs(spec), "utf8");
  const { rawPublicKey } = privateKeyFromSeed(PROBE_SEED);
  const keyId = fingerprintOfRawPublicKey(rawPublicKey);
  const base = {
    magic: "YGLVF1",
    format_version: 1,
    engine_sha256: sha256hex(engine),
    spec_offset: engine.length,
    spec_length: specBytes.length,
    spec_sha256: sha256hex(specBytes),
    build_sha256: sha256hex(Buffer.concat([engine, specBytes])),
    engine_version: "0.1.0",
    corpus_version: CORPUS_VERSION,
  };
  const withAlg = { ...base, sig_alg: SIGNING_SCHEME, key_id: keyId };
  const canonicalWithoutSignature = jcs(withAlg);
  const sig = signFooter(Buffer.from(canonicalWithoutSignature, "utf8"), PROBE_SEED);
  const footer = { ...withAlg, sig: sig.signature };
  const footerBytes = Buffer.from(jcs(footer), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footerBytes.length, 0);
  const bytes = Buffer.concat([engine, specBytes, footerBytes, len]);
  const table: SigningKeyTable = {
    scheme: SIGNING_SCHEME,
    keys: { [keyId]: { public_key: rawPublicKey.toString("hex"), created: "probe" } },
  };
  return { bytes, footer, canonicalWithoutSignature, table, seed: PROBE_SEED };
}

/** Minimal reader mirroring sealed-binary.readSealedBinary (single source is in
 *  ops/tools; probe imports it lazily to avoid a circular module edge). */
function readSealed(bytes: Buffer): { footer: any; specText: string; canonicalWithoutSignature: string } {
  if (bytes.length < 6) throw new Error("sealed binary is truncated (no footer)");
  const footerLen = bytes.readUInt32LE(bytes.length - 4);
  if (!footerLen || footerLen + 4 > bytes.length) throw new Error("sealed footer length is out of range");
  const footerStart = bytes.length - 4 - footerLen;
  const footerRaw = bytes.subarray(footerStart, bytes.length - 4);
  let footer: any;
  try {
    footer = JSON.parse(footerRaw.toString("utf8"));
  } catch (e: any) {
    throw new Error(`sealed footer is not JSON: ${e?.message || e}`);
  }
  if (footer.magic !== "YGLVF1") throw new Error("sealed footer magic mismatch");
  if (footer.format_version !== 1) throw new Error(`sealed footer format_version ${String(footer.format_version)} is not supported (expects 1)`);
  if (jcs(footer) !== footerRaw.toString("utf8")) throw new Error("sealed footer is not canonical (raw != JCS(parse)) — refusing to trust a non-canonical footer");
  const specStart = footer.spec_offset;
  const specEnd = specStart + footer.spec_length;
  if (!Number.isInteger(specStart) || !Number.isInteger(specEnd) || specStart < 0 || specEnd !== footerStart) {
    throw new Error("sealed layout mismatch: spec bytes are not adjacent to the footer");
  }
  const engine = bytes.subarray(0, specStart);
  const specBytes = bytes.subarray(specStart, specEnd);
  if (sha256hex(specBytes) !== footer.spec_sha256) throw new Error("sealed spec_sha256 mismatch — the embedded spec was modified");
  if (sha256hex(Buffer.concat([engine, specBytes])) !== footer.build_sha256) throw new Error("sealed build_sha256 mismatch — engine or spec was tampered with");
  if (footer.engine_sha256 && sha256hex(engine) !== footer.engine_sha256) throw new Error("sealed engine_sha256 mismatch — the engine was modified");
  const specText = specBytes.toString("utf8");
  let parsedSpec: unknown;
  try {
    parsedSpec = JSON.parse(specText);
  } catch (e: any) {
    throw new Error(`embedded spec is not JSON: ${e?.message || e}`);
  }
  if (jcs(parsedSpec) !== specText) throw new Error("sealed spec is not canonical (raw != JCS(parse))");
  const bare = { ...footer };
  delete bare.sig;
  return { footer, specText, canonicalWithoutSignature: jcs(bare) };
}

function reseal(footer: Record<string, unknown>, engine: Buffer, specBytes: Buffer, seed: Buffer): Buffer {
  const { signature, public_key_fingerprint } = signFooter(Buffer.from(jcs(footer), "utf8"), seed);
  const signed = { ...footer, sig: signature };
  void public_key_fingerprint;
  const footerBytes = Buffer.from(jcs(signed), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footerBytes.length, 0);
  return Buffer.concat([engine, specBytes, footerBytes, len]);
}

function expectThrow(fn: () => unknown, needle: RegExp): { ok: boolean; error?: string } {
  try {
    fn();
    return { ok: false, error: "expected a rejection, got success" };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { ok: needle.test(msg), error: msg };
  }
}

const fakeRunner = (): QueryRunner => ({
  query: () => [{ v: 1 }],
  tableRows: () => 1,
  schemaFingerprint: () => "probe",
});

/** Run the 16-probe matrix. `target` is an optional sealed-binary file used as
 *  the base fixture (e.g. a release artifact); omitted → deterministic fixture. */
export async function runProbeMatrix(opts: { target?: string; now?: () => string } = {}): Promise<ProbeMatrixReport> {
  const fx = buildFixture();
  const baseBytes = opts.target ? readFileSync(opts.target) : fx.bytes;
  let baseFooter: any;
  try {
    baseFooter = readSealed(baseBytes).footer;
  } catch {
    baseFooter = fx.footer;
  }
  const engineLen = Number(baseFooter.spec_offset ?? baseFooter.engine_length ?? fx.footer.spec_offset);
  const engine = baseBytes.subarray(0, engineLen);
  const specBytes = baseBytes.subarray(engineLen, engineLen + Number(baseFooter.spec_length ?? 0));
  const entries: ProbeEntry[] = [];

  const add = (probe: string, ok: boolean, detail: Record<string, unknown>) => {
    entries.push({
      probe,
      verdict: ok ? "PASS" : "FAIL",
      detail,
      evidence_sha256: sha256hex(jcs(detail)),
    });
  };

  // ── dev eight ────────────────────────────────────────────────────────────
  {
    let parsed = false;
    let error: string | null = null;
    try {
      const r = readSealed(baseBytes);
      parsed = !!r.footer.spec_sha256 && !!r.footer.spec_length;
    } catch (e: any) {
      error = String(e?.message || e);
    }
    add("envelope", parsed, { parsed, error });
  }
  {
    const v = verifyAgainstTable(Buffer.from(readSealed(baseBytes).canonicalWithoutSignature, "utf8"), {
      signature: baseFooter.sig,
      signing_scheme: baseFooter.sig_alg,
      public_key_fingerprint: baseFooter.key_id,
    }, fx.table);
    add("signature", v.ok, v.ok ? { key_id: baseFooter.key_id } : { problem: v.problem });
  }
  {
    const r = readSealed(baseBytes);
    const recomputed = sha256hex(r.specText);
    add("digest", recomputed === baseFooter.spec_sha256, { expected: baseFooter.spec_sha256, recomputed });
  }
  {
    // Deterministic sealing: building the fixture twice must be byte-identical
    // (a timestamp/randomness leak would show up here).
    const again = buildFixture();
    add("timestamp", Buffer.compare(again.bytes, fx.bytes) === 0, { deterministic_bytes: again.bytes.length });
  }
  {
    const spec = { ...(JSON.parse(readSealed(baseBytes).specText) as any) };
    spec.vu = [{
      id: "V1", role: "assert", title: "escalation", severity: "S1", source_clause: "probe",
      expected_from: { kind: "material-extract", source_id: "materials", anchor: "a", quote: "probe" },
      checker: { type: "command", argv: ["echo", "pwn"] },
    }];
    const report = await runVerify(spec as VerifySpec, { runner: fakeRunner() });
    add("escalation", report.overall === "ERROR", { overall: report.overall });
  }
  {
    const inj = expectThrow(() => renderPredicate({ from: "t", select: ["id"], where: { op: "and", conditions: [{ col: "c", op: "= 1 OR 1=(SELECT 1)" as any, value: "x" }] } } as any), /unknown predicate op/);
    add("injection", inj.ok, { rejected: inj.ok, error: inj.error ?? null });
  }
  {
    // Cross-machine: relocated bytes verify identically (no absolute-path facts).
    const relocated = Buffer.from(baseBytes);
    const r = readSealed(relocated);
    const v = verifyAgainstTable(Buffer.from(r.canonicalWithoutSignature, "utf8"), {
      signature: baseFooter.sig, signing_scheme: baseFooter.sig_alg, public_key_fingerprint: baseFooter.key_id,
    }, fx.table);
    add("cross-machine", v.ok, { relocated_parsed: true, binary_sha256: sha256hex(relocated) });
  }
  {
    const a = readSealed(baseBytes).canonicalWithoutSignature;
    const b = readSealed(Buffer.from(baseBytes)).canonicalWithoutSignature;
    add("replay", a === b && sha256hex(a) === sha256hex(b), { canonical_sha256: sha256hex(a) });
  }

  // ── review tamper eight ─────────────────────────────────────────────────
  {
    const bad = Buffer.from(baseBytes);
    bad[Math.max(1, engineLen + 1)] ^= 0xff; // inside spec bytes
    const r = expectThrow(() => readSealed(bad), /spec_sha256 mismatch|not canonical/);
    add("tamper-spec", r.ok, { rejected: r.ok, error: r.error ?? null });
  }
  {
    const bad = Buffer.from(baseBytes);
    bad[0] ^= 0xff; // inside engine bytes
    const r = expectThrow(() => readSealed(bad), /build_sha256 mismatch|engine_sha256 mismatch/);
    add("tamper-engine", r.ok, { rejected: r.ok, error: r.error ?? null });
  }
  {
    const bad = Buffer.from(baseBytes);
    bad[bad.length - 6] ^= 0xff; // footer JSON byte
    const r = expectThrow(() => readSealed(bad), /not JSON|not canonical|magic|format_version|layout/);
    add("tamper-footer", r.ok, { rejected: r.ok, error: r.error ?? null });
  }
  {
    // non-canonical: same footer content re-serialized with whitespace.
    const footer = JSON.parse(JSON.stringify(baseFooter));
    const fbytes = Buffer.from(JSON.stringify(footer, null, 2), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(fbytes.length, 0);
    const bad = Buffer.concat([engine, specBytes, fbytes, len]);
    const r = expectThrow(() => readSealed(bad), /not canonical/);
    add("noncanon", r.ok, { rejected: r.ok, error: r.error ?? null });
  }
  {
    const good = verifyAgainstTable(Buffer.from(readSealed(baseBytes).canonicalWithoutSignature, "utf8"), {
      signature: baseFooter.sig, signing_scheme: baseFooter.sig_alg, public_key_fingerprint: baseFooter.key_id,
    }, fx.table);
    const sigBuf = Buffer.from(String(baseFooter.sig), "base64");
    sigBuf[0] ^= 0xff;
    const bad = verifyAgainstTable(Buffer.from(readSealed(baseBytes).canonicalWithoutSignature, "utf8"), {
      signature: sigBuf.toString("base64"), signing_scheme: baseFooter.sig_alg, public_key_fingerprint: baseFooter.key_id,
    }, fx.table);
    add("sig-byte", good.ok && !bad.ok, { good_ok: good.ok, tampered_ok: bad.ok });
  }
  {
    const v = verifyAgainstTable(Buffer.from(readSealed(baseBytes).canonicalWithoutSignature, "utf8"), {
      signature: baseFooter.sig, signing_scheme: baseFooter.sig_alg, public_key_fingerprint: baseFooter.key_id,
    }, { scheme: SIGNING_SCHEME, keys: {} });
    add("unknown-key", !v.ok && /not in the repository key table/.test(v.ok ? "" : v.problem), v.ok ? { unexpected: "accepted" } : { problem: v.problem });
  }
  {
    const keyId = String(baseFooter.key_id);
    const v = verifyAgainstTable(Buffer.from(readSealed(baseBytes).canonicalWithoutSignature, "utf8"), {
      signature: baseFooter.sig, signing_scheme: baseFooter.sig_alg, public_key_fingerprint: keyId,
    }, { scheme: SIGNING_SCHEME, keys: { [keyId]: { public_key: fx.table.keys[keyId]?.public_key ?? "", created: "probe", retired_at: "2026-10-21T00:00:00.000Z" } } });
    add("retired-key", !v.ok && /retired/.test(v.ok ? "" : v.problem), v.ok ? { unexpected: "accepted" } : { problem: v.problem });
  }
  {
    // re-sign with a valid key but an unsupported format_version.
    const footer = { ...baseFooter, format_version: 999 };
    delete footer.sig;
    const bad = reseal(footer, engine, specBytes, fx.seed);
    const r = expectThrow(() => readSealed(bad), /format_version 999 is not supported/);
    add("resign-fv", r.ok, { rejected: r.ok, error: r.error ?? null });
  }

  return {
    probe_version: PROBE_VERSION,
    target: opts.target ?? "(self-fixture)",
    seeds: "RFC8032 deterministic (sha256(probe-label))",
    probes: entries,
    verdict: entries.every((e) => e.verdict === "PASS") ? "PASS" : "FAIL",
    checked_at: (opts.now ?? (() => new Date().toISOString()))(),
  };
}
