import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { payloadHash } from "../../../verify/core/src/engine";
import type { VerifyReport } from "../../../verify/core/src/contract";
import { attachProducer, loadProducerFile, parseProducer, producerBaseline, producerHash } from "../src/verify-provenance";

const producer = { probe_sha256: "a".repeat(64), platform: "win32-x64", runtime: "node24", package_manager: "pnpm10", identity: "test-role" };
function report(id = "run_a"): VerifyReport {
  return { run_id: id, spec_id: "spec_a", started: "2026-11-01T00:00:00Z", verifier: { spec_version: 16 }, data_source: { kind: "sqlite-snapshot", sha256: "s", captured_at: "t" } } as VerifyReport;
}
describe("measurement producer provenance", () => {
  it("normalizes hashes and produces a stable fingerprint independent of input key order", () => {
    const value = parseProducer(producer)!;
    expect(value.probe_sha256).toBe("sha256:" + "a".repeat(64));
    expect(producerHash(value)).toBe(producerHash(parseProducer({ identity: producer.identity, package_manager: producer.package_manager, runtime: producer.runtime, platform: producer.platform, probe_sha256: producer.probe_sha256.toUpperCase() })!));
  });
  it("rejects malformed or credential-shaped extra fields instead of serializing them", () => {
    for (const raw of [null, [], true, {}, { ...producer, token: "not-a-real-token" }, { ...producer, runtime: 1 }, { ...producer, identity: "x\n" }, { ...producer, probe_sha256: "oops" }]) {
      expect(() => parseProducer(raw)).toThrow(/provenance/);
    }
    expect(parseProducer(undefined)).toBeUndefined();
    expect(() => loadProducerFile(true)).toThrow(/needs a JSON file path/);
  });
  it("keeps unmeasured legacy reports unchanged and records first/same/changed/missing provenance", () => {
    const legacy = report(); const before = JSON.stringify(legacy);
    attachProducer(legacy, undefined);
    expect(JSON.stringify(legacy)).toBe(before);
    const value = parseProducer(producer)!;
    const baseline = report(); attachProducer(baseline, value);
    expect(baseline.data_source?.provenance?.status).toBe("first");
    const same = report("run_b"); attachProducer(same, value, baseline);
    expect(same.data_source?.provenance?.status).toBe("same");
    const changed = report("run_c"); attachProducer(changed, { ...value, probe_sha256: "sha256:" + "b".repeat(64) }, baseline);
    expect(changed.data_source?.provenance?.status).toBe("changed");
    const missing = report("run_d"); attachProducer(missing, undefined, baseline);
    expect(missing.data_source?.provenance?.status).toBe("changed");
    expect(missing.data_source?.producer).toBeUndefined();
  });
  it("selects an integrity-valid baseline for the same spec version without rewriting report bytes", () => {
    const scratch = join(resolve(__dirname, "../../../.."), "tmp");
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, "producer-unit-"));
    try {
      mkdirSync(join(dir, "reports")); const reports = join(dir, "reports");
      const baseline = report(); attachProducer(baseline, parseProducer(producer)); baseline.payload_sha256 = payloadHash(baseline);
      const file = join(reports, "a.json"); writeFileSync(file, JSON.stringify(baseline)); const bytes = readFileSync(file);
      writeFileSync(join(reports, "bad.json"), "{");
      writeFileSync(join(reports, "tampered.json"), JSON.stringify({ ...baseline, run_id: "tampered", started: "2000-01-01" }));
      expect(producerBaseline(reports, "spec_a", 16)?.run_id).toBe("run_a");
      expect(producerBaseline(reports, "spec_a", 17)).toBeUndefined();
      expect(readFileSync(file)).toEqual(bytes);
      expect(loadProducerFile(writeProducer(dir))).toEqual(parseProducer(producer));
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});
function writeProducer(dir: string) { const file = join(dir, "producer.json"); writeFileSync(file, JSON.stringify(producer)); return file; }
