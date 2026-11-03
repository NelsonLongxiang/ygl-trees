/** Measurement provenance shared by CLI, HTTP and tree reports. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MeasurementProducer, VerifyReport } from "../../../verify/core/src/contract";
import { payloadHash } from "../../../verify/core/src/engine";
import { jcsCanonical } from "./jcs";

const FIELDS = ["probe_sha256", "platform", "runtime", "package_manager", "identity"] as const;

/** Keep only a closed, bounded, explicitly supplied description; never inspect host credentials. */
export function parseProducer(raw: unknown): MeasurementProducer | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("provenance must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !FIELDS.includes(key as typeof FIELDS[number]))) {
    throw new Error("provenance contains unknown fields; only probe_sha256, platform, runtime, package_manager and identity are accepted");
  }
  for (const key of FIELDS) {
    const text = value[key];
    if (typeof text !== "string" || !text.trim() || text.length > 256 || /[\x00-\x1f\x7f]/.test(text)) {
      throw new Error("provenance." + key + " must be a nonempty string of at most 256 characters without control characters");
    }
  }
  if (!/^(?:sha256:)?[0-9a-fA-F]{64}$/.test(value.probe_sha256 as string)) {
    throw new Error("provenance.probe_sha256 must be a SHA-256 digest (64 hex characters)");
  }
  return {
    probe_sha256: "sha256:" + String(value.probe_sha256).replace(/^sha256:/, "").toLowerCase(),
    platform: String(value.platform).trim(), runtime: String(value.runtime).trim(),
    package_manager: String(value.package_manager).trim(), identity: String(value.identity).trim(),
  };
}

export function loadProducerFile(raw: unknown): MeasurementProducer | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("--provenance needs a JSON file path");
  return parseProducer(JSON.parse(readFileSync(raw, "utf8")));
}

export function producerHash(producer: MeasurementProducer): string {
  return "sha256:" + createHash("sha256").update(jcsCanonical(producer)).digest("hex");
}

/** Find the first integrity-valid measured report for this frozen spec version. */
export function producerBaseline(reportsDir: string, specId: string, version: number): VerifyReport | undefined {
  if (!existsSync(reportsDir)) return undefined;
  const reports: VerifyReport[] = [];
  for (const name of readdirSync(reportsDir).filter(name => name.endsWith(".json"))) {
    let report: VerifyReport;
    try { report = JSON.parse(readFileSync(join(reportsDir, name), "utf8")); }
    catch (error: any) { if (error instanceof SyntaxError) continue; throw error; }
    if (report?.spec_id !== specId || report.verifier?.spec_version !== version || !report.data_source?.producer) continue;
    if (!report.payload_sha256 || report.payload_sha256 !== payloadHash(report)) continue;
    try { parseProducer(report.data_source.producer); } catch { continue; }
    if (typeof report.started !== "string" || typeof report.run_id !== "string") continue;
    reports.push(report);
  }
  return reports.sort((a, b) => a.started.localeCompare(b.started) || a.run_id.localeCompare(b.run_id))[0];
}

/** Attach before hashing/writing/archiving; existing unmeasured histories retain their old shape. */
export function attachProducer(report: VerifyReport, producer: MeasurementProducer | undefined, baseline?: VerifyReport): void {
  if (!report.data_source || (!producer && !baseline)) return;
  const current = producer && producerHash(producer);
  const previous = baseline?.data_source?.producer;
  const previousHash = previous && producerHash(previous);
  report.data_source = {
    ...report.data_source,
    ...(producer ? { producer } : {}),
    provenance: {
      status: !previous ? "first" : current === previousHash ? "same" : "changed",
      ...(current ? { producer_sha256: current } : {}),
      ...(baseline && previousHash ? { baseline_run_id: baseline.run_id, baseline_sha256: previousHash } : {}),
    },
  };
}
