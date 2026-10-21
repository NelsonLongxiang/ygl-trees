/**
 * #28: `verify run --submission` must leave a reconstructable trace of what the
 * file checker scanned. Report evidence stays contract-1.2 frozen; the trace
 * rides as a workspace sidecar and enters the archive as first-class items.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readZipStore } from "../src/zip-store";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let HOME = "";
let specId = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
    cwd: HOME,
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("verify run --submission file-scan trace (#28)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-scan-home-"));
    jrun(["db", "init"]);
    specId = "spec_scan00000001";
    const dir = join(HOME, "verify", "specs", specId);
    mkdirSync(dir, { recursive: true });
    const spec = {
      contract_version: "1.2",
      spec_id: specId,
      spec_version: 1,
      title: "scan trace",
      domain: "probe",
      created: "2026-10-21T00:00:00.000Z",
      verifier: { engine_version: "0.1.0", corpus_version: "1.2" },
      as_of: { kind: "snapshot", value: "2026-10-21T00:00:00.000Z" },
      attachments: [],
      sealed: { review: false },
      vu: [
        {
          id: "V1",
          role: "assert",
          title: "two txt files",
          severity: "S1",
          source_clause: "交付物必须包含两份文本。",
          expected_from: { kind: "material-extract", source_id: "materials", anchor: "probe!A1", quote: "交付物必须包含两份文本。" },
          checker: { type: "file", glob: "*.txt", min: 2 },
        },
      ],
    };
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2), "utf8");
    // default archive includes materials, so the frozen workspace needs them
    const matId = "mat_scan0001";
    const mdir = join(HOME, "verify", "materials", matId);
    mkdirSync(mdir, { recursive: true });
    const MATERIAL = "交付物必须包含两份文本。\n";
    writeFileSync(join(mdir, "material.txt"), MATERIAL, "utf8");
    writeFileSync(join(mdir, "material.json"), JSON.stringify({ material_id: matId, title: "scan", created: "2026-10-21T00:00:00.000Z", text_sha256: sha(Buffer.from(MATERIAL)), text_path: "material.txt", files: [] }), "utf8");
    writeFileSync(join(dir, "prepare.json"), JSON.stringify({ material_id: matId }, null, 2), "utf8");
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("records matched paths + hashes and archives them as items", () => {
    const sub = join(HOME, "submission");
    mkdirSync(join(sub, "nested"), { recursive: true });
    writeFileSync(join(sub, "a.txt"), "alpha", "utf8");
    writeFileSync(join(sub, "b.txt"), "beta", "utf8");
    writeFileSync(join(sub, "ignored.log"), "nope", "utf8");
    const db = join(HOME, "snap.db");
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE bills(id TEXT PRIMARY KEY, amount INTEGER)");
    d.close();

    const r = jrun(["verify", "run", specId, "--db", db, "--submission", sub, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.overall).toBe("PASS");
    const runId = String(r.j.run_id);

    // sidecar: matched paths + per-file sha256 (ignored file absent)
    const scanPath = join(HOME, "verify", "submission-scans", `${runId}.json`);
    expect(existsSync(scanPath)).toBe(true);
    const scan = JSON.parse(readFileSync(scanPath, "utf8"));
    const rec = scan.scans.find((x: any) => x.vu_id === "V1");
    expect(rec.matched.map((m: any) => m.path).sort()).toEqual(["a.txt", "b.txt"]);
    const a = rec.matched.find((m: any) => m.path === "a.txt");
    expect(a.sha256).toBe(sha(Buffer.from("alpha")));
    expect(rec.matched.some((m: any) => m.path === "ignored.log")).toBe(false);

    // report evidence shape stays contract-1.2 frozen
    const report = JSON.parse(readFileSync(join(HOME, "verify", "reports", `${runId}.json`), "utf8"));
    const vu = report.vu.find((v: any) => v.id === "V1");
    expect(Object.keys(vu.evidence).sort()).toEqual(["files", "ignored", "matched", "problems"]);

    // archive: submission-scan item + content-addressed matched bytes
    const archive = String(r.j.archive?.path ?? "");
    expect(archive.endsWith(".yglverify.zip")).toBe(true);
    const entries = readZipStore(readFileSync(archive));
    const roles = entries.map((e) => e.path);
    expect(roles).toContain("submission-scan.json");
    expect(roles).toContain(`submission/${sha(Buffer.from("alpha"))}`);
    expect(roles).toContain(`submission/${sha(Buffer.from("beta"))}`);
    const archivedScan = JSON.parse(entries.find((e) => e.path === "submission-scan.json")!.data.toString("utf8"));
    expect(archivedScan.dir).toBeUndefined(); // local absolute path never enters the archive
  }, 60_000);
});
