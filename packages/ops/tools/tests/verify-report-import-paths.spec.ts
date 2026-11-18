import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { neutralCwd } from "../../../../tests/support/verification-fixtures";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { payloadHash } from "../../../verify/core/src/engine";
import { canonicalStringify } from "../../../verify/core/src/canonical";
import { run as verifyCommand } from "../src/verify-cmds";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
function report(overrides: Record<string, unknown> = {}): any {
  const value = {
    contract_version: "1.1", run_id: "run_import_boundary", spec_id: "spec_import_boundary",
    started: "2026-11-01T00:00:00.000Z", finished: "2026-11-01T00:00:01.000Z",
    verifier: { mode: "open", engine_version: "0.1.0", spec_version: 1, corpus_version: "1.0", sealed_review: false },
    as_of: { kind: "material-extract", captured_at: "2026-11-01T00:00:00.000Z" },
    summary: { pass: 1, fail: 0, needs_material: 0, error: 0 }, overall: "PASS", reason: "all 1 assert units passed",
    vu: [{ id: "V1", role: "assert", verdict: "PASS", severity: "S1", source_clause: "synthetic value matches", checker_type: "sql", witness: { rows_scanned: 1, rows_matched: 0 } }],
    exceptions: [], ...overrides,
  };
  return { ...value, payload_sha256: payloadHash(value as any) };
}
function sealedBytes(): Buffer {
  const engine = Buffer.from("SYNTHETIC-SEALED-ENGINE");
  const spec = Buffer.from(canonicalStringify({ contract_version: "1.1", spec_id: "spec_import_boundary", spec_version: 1, verifier: { engine_version: "0.1.0", corpus_version: "1.0" }, vu: [] }));
  const footer = Buffer.from(canonicalStringify({ magic: "YGLVF1", spec_offset: engine.length, spec_length: spec.length, spec_sha256: digest(spec), build_sha256: digest(Buffer.concat([engine, spec])), engine_version: "0.1.0", corpus_version: "1.0" }));
  const size = Buffer.alloc(4); size.writeUInt32LE(footer.length);
  return Buffer.concat([engine, spec, footer, size]);
}
async function fixture(fn: (f: { root: string; home: string; call(action: string, rest: string[]): Promise<{ rc: number; json: any }>; importReport(value: any): Promise<{ rc: number; json: any }>; register(): Promise<string> }) => Promise<void>) {
  const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, "report-import-paths-")), home = join(root, "home"), input = join(root, "inputs");
  mkdirSync(home); mkdirSync(input);
  let sequence = 0;
  const noDb = new Proxy({}, { get: (_target, key) => { throw new Error("report import unexpectedly accessed database: " + String(key)); } });
  const env = { home, ctx: { json: true, color: false, quiet: false }, db: noDb, store: noDb, asyncStore: noDb, group: "verify", args: { _: [], flags: { json: true } } } as any;
  async function call(action: string, rest: string[]) {
    const rows: string[] = [], log = vi.spyOn(console, "log").mockImplementation((...args) => { rows.push(args.map(String).join(" ")); });
    let rc: number;
    try { rc = await verifyCommand(env, action, rest, { flags: { json: true } }); } finally { log.mockRestore(); }
    expect(rows).toHaveLength(1);
    return { rc, json: JSON.parse(rows[0]) };
  }
  try {
    await fn({ root, home, call, importReport: async value => {
      const file = join(input, "report-" + sequence++ + ".json"); writeFileSync(file, JSON.stringify(value));
      return call("report", ["import", file]);
    }, register: async () => {
      const bin = join(input, "sealed.bin"); writeFileSync(bin, sealedBytes());
      const result = await call("register", [bin]); expect(result.rc).toBe(0); expect(result.json.registered).toBe(true);
      return result.json.binary_sha256;
    } });
  } finally {
    expect(dirname(root)).toBe(parent); expect(basename(root)).toMatch(/^report-import-paths-/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("report import artifact path inputs", () => {
  it.each(["../outside", "..\\outside", "nested/child", "nested\\child", "/absolute", "C:\\absolute", "//server/share", "run:stream", "run\u0000nul", "x".repeat(129), 7, {}, [], "run\n", "run\r", "", false].map(id => ({ id })))("rejects unsafe run_id $id without writing a report", async ({ id }) => fixture(async f => {
    const sentinel = join(f.home, "verify", "outside.json"); mkdirSync(dirname(sentinel), { recursive: true }); writeFileSync(sentinel, "keep");
    const result = await f.importReport(report({ run_id: id }));
    expect(result.rc).toBe(1); expect(result.json.imported).toBe(false); expect(result.json.problems.join(" ")).toMatch(/run_id/);
    expect(readFileSync(sentinel, "utf8")).toBe("keep"); expect(readdirSync(join(f.home, "verify", "reports"))).toEqual([]);
  }));
  it.each(["../outside", "..\\outside", "nested/child", "C:\\absolute", 7, {}, "spec\n", "spec\r", "", []].map(id => ({ id })))("rejects unsafe spec_id $id before sealed-spec restoration", async ({ id }) => fixture(async f => {
    const bin = await f.register();
    const result = await f.importReport(report({ spec_id: id, verifier: { ...report().verifier, mode: "sealed", binary_sha256: bin } }));
    expect(result.rc).toBe(1); expect(result.json.imported).toBe(false); expect(result.json.problems.join(" ")).toMatch(/spec_id/);
    expect(readdirSync(join(f.home, "verify", "specs"))).toEqual([]); expect(readdirSync(join(f.home, "verify", "reports"))).toEqual([]);
    expect(existsSync(join(f.home, "verify", "outside", "spec.json"))).toBe(false);
  }));
  it.each(["../outside", "sha256:../outside", "..\\outside", "not-a-hash", 7, {}, "a".repeat(64) + "\n", "sha256:" + "a".repeat(64) + "\r", []].map(value => ({ value })))("rejects unsafe binary_sha256 $value before reading a registration", async ({ value }) => fixture(async f => {
    writeFileSync(join(f.home, "marker.json"), "keep");
    const result = await f.importReport(report({ verifier: { ...report().verifier, binary_sha256: value } }));
    expect(result.rc).toBe(1); expect(result.json.imported).toBe(false); expect(result.json.problems.join(" ")).toMatch(/binary_sha256/);
    expect(readFileSync(join(f.home, "marker.json"), "utf8")).toBe("keep"); expect(readdirSync(join(f.home, "verify", "reports"))).toEqual([]);
  }));
  it("preserves safe identifiers, payload verification and sealed spec restoration", async () => fixture(async f => {
    const bin = await f.register(), value = report({ verifier: { ...report().verifier, mode: "sealed", binary_sha256: bin } });
    const result = await f.importReport(value); expect(result.rc).toBe(0); expect(result.json.imported).toBe(true);
    expect(result.json.report_path).toBe(join(f.home, "verify", "reports", value.run_id + ".json"));
    expect(result.json.spec_restored).toBe(join(f.home, "verify", "specs", value.spec_id, "spec.json"));
    expect(JSON.parse(readFileSync(result.json.report_path, "utf8"))).toEqual(value);
    const bytes = readFileSync(result.json.report_path);
    const bad = await f.importReport({ ...value, overall: "FAIL" }); expect(bad.rc).toBe(1); expect(bad.json.imported).toBe(false);
    expect(readFileSync(result.json.report_path)).toEqual(bytes);
  }));
  it("accepts the read-side identifier length boundary", async () => fixture(async f => {
    const value = report({ run_id: "r".repeat(128), spec_id: "s".repeat(128) }), result = await f.importReport(value);
    expect(result.rc).toBe(0); expect(result.json.imported).toBe(true);
    expect(JSON.parse(readFileSync(result.json.report_path, "utf8"))).toEqual(value);
  }));
  it("does not change legacy same-run-id replacement semantics", async () => fixture(async f => {
    const first = report(), accepted = await f.importReport(first); expect(accepted.rc).toBe(0);
    const replacement = report({ reason: "same run id, a different integrity-valid payload" });
    expect(replacement.payload_sha256).not.toBe(first.payload_sha256);
    const second = await f.importReport(replacement); expect(second.rc).toBe(0); expect(second.json.report_path).toBe(accepted.json.report_path);
    expect(JSON.parse(readFileSync(second.json.report_path, "utf8"))).toEqual(replacement);
  }));
  it("the published CLI rejects unsafe IDs and still imports a safe report", async () => fixture(async f => {
    expect(existsSync(BIN), "build the shipped CLI before this regression").toBe(true);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, YGL_HOME: f.home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_NO_UPDATE_CHECK: "1" };
    delete childEnv.YGL_PROJECT; delete childEnv.YGL_TREE; delete childEnv.NODE_OPTIONS;
    const invoke = (args: string[]) => {
      const result = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: neutralCwd(), env: childEnv, encoding: "utf8", timeout: 30000 });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      return { rc: result.status, json: JSON.parse(result.stdout) };
    };
    expect(invoke(["db", "init"]).rc).toBe(0);
    const input = join(f.root, "cli-report.json"), sentinel = join(f.home, "verify", "outside.json");
    mkdirSync(dirname(sentinel), { recursive: true }); writeFileSync(sentinel, "keep");
    for (const patch of [{ run_id: "../outside" }, { spec_id: "../outside" }, { verifier: { ...report().verifier, binary_sha256: "sha256:../outside" } }]) {
      writeFileSync(input, JSON.stringify(report(patch)));
      const result = invoke(["verify", "report", "import", input]);
      expect(result.rc).toBe(1); expect(result.json.imported).toBe(false); expect(result.json.problems).not.toHaveLength(0);
      expect(readFileSync(sentinel, "utf8")).toBe("keep"); expect(readdirSync(join(f.home, "verify", "reports"))).toEqual([]);
    }
    const safe = report(); writeFileSync(input, JSON.stringify(safe));
    const result = invoke(["verify", "report", "import", input]); expect(result.rc).toBe(0); expect(result.json.imported).toBe(true);
    expect(JSON.parse(readFileSync(result.json.report_path, "utf8"))).toEqual(safe);
  }));
  it.each([undefined, null])("preserves the existing missing run-id fallback (%j)", async id => fixture(async f => {
    const value = report({ run_id: id }), result = await f.importReport(value);
    expect(result.rc).toBe(0); expect(result.json.imported).toBe(true);
    const expected = "imported_" + digest(JSON.stringify(value)).slice(0, 12) + ".json";
    expect(result.json.report_path).toBe(join(f.home, "verify", "reports", expected));
  }));
});
