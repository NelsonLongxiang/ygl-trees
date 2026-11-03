/**
 * #171 第1项端到端：A 家 `export --portable` → 全新 B 家 `import` → `verify run` → `archive` → `archive verify` rc0。
 *
 * 这一项是「便携件存在」的理由：回装后 B 家必须真的能跑、能归档、归档能自校验——
 * 只验 import 的字节一致不够（B5 的 snapshot 链 + 本单的回装面拼在一起）。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildPortable, importPortable, portableToText, specIdOf } from "../src/verify-portable";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function cli(args: string[], home: string) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: REPO, encoding: "utf8", env: { ...process.env, YGL_HOME: home } as any });
  let j: any = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
}

describe.skipIf(!HAS_BIN)("#171 portable bundle — end-to-end run + archive in a fresh home", () => {
  it("A export --portable → B import → run → archive → archive verify rc0", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-portable-e2e-"));
    const homeA = join(root, "A");
    const homeB = join(root, "B");
    try {
      // ── A 家：建工作区 → 快照 → 冻结材料/spec → 便携导出
      expect(cli(["db", "init"], homeA).rc).toBe(0);
      expect(cli(["project", "new", "p1"], homeA).rc).toBe(0);
      const snap = cli(["db", "snapshot"], homeA);
      expect(snap.rc, snap.out).toBe(0);
      const snapPath = String(snap.j.path);

      const text = "快照里至少有一个项目。\n";
      const textSha = sha(text);
      const materialId = "mat_" + sha("e2e-material").slice(0, 12);
      const specId = specIdOf(materialId);
      const mdir = join(homeA, "verify", "materials", materialId);
      const sdir = join(homeA, "verify", "specs", specId);
      mkdirSync(mdir, { recursive: true });
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(mdir, "material.txt"), text);
      writeFileSync(join(mdir, "material.json"), JSON.stringify({
        material_id: materialId, title: "e2e", created: "2026-10-20T00:00:00.000Z",
        text_sha256: textSha, text_path: "material.txt", files: [],
      }));
      writeFileSync(join(sdir, "spec.json"), JSON.stringify({
        contract_version: "1.2", spec_id: specId, spec_version: 16, title: "e2e", domain: "general",
        created: "2026-10-24T00:00:00.000Z", runtime_min: "",
        verifier: { engine_version: "0.119.0", corpus_version: "1.2" },
        as_of: { kind: "snapshot", value: "2026-10-24T00:00:00.000Z" },
        materials_sha256: textSha, attachments: [], sealed: { review: false },
        vu: [{ id: "V1", role: "assert", title: "projects exist", severity: "S3", source_clause: "快照里至少有一个项目。",
          expected_from: { quote: "快照里至少有一个项目。", locator: "material.txt#L1" },
          checker: { type: "count", sql: "SELECT COUNT(*) AS n FROM projects", op: ">=", value: 1 } }],
      }));
      writeFileSync(join(sdir, "prepare.json"), JSON.stringify({ spec_id: specId, spec_version: 16, material_id: materialId, ready: true }));

      const bundle = buildPortable({ home: homeA } as any, specId);
      const file = join(root, "bundle.yglverify.json");
      writeFileSync(file, portableToText(bundle));

      // ── B 家：全新 home 回装 → 用同一快照跑 → 归档 → 归档自校验
      expect(cli(["db", "init"], homeB).rc).toBe(0);
      const imported = importPortable({ home: homeB } as any, file);
      expect(imported.rc, imported.error).toBe(0);
      expect(imported.spec_id).toBe(specId);
      expect(imported.spec_version).toBe(16);

      const runRes = cli(["verify", "run", specId, "--db", snapPath], homeB);
      expect(runRes.rc, runRes.out).toBe(0);
      expect(runRes.j.overall).toBe("PASS");

      // 冻结身份在 B 家报告里原样保留（回装不是重新 prepare）
      const report = JSON.parse(readFileSync(join(homeB, "verify", "reports", String(runRes.j.run_id) + ".json"), "utf8"));
      expect(report.spec_id).toBe(specId);
      expect(report.verifier.spec_version).toBe(16);

      const archive = cli(["verify", "archive", String(runRes.j.run_id)], homeB);
      expect(archive.rc, archive.out).toBe(0);
      const verify = cli(["verify", "archive", "verify", String(archive.j.path ?? archive.j.filename)], homeB);
      expect(verify.rc, verify.out).toBe(0);
      expect(verify.j.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 240_000);
});
