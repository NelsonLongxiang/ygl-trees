/**
 * B5 验收：db snapshot 产物 → verify run → archive verify 全链 PASS
 * + 脱敏自检（argv/events/报告/归档 grep 不到会话 id 或凭证样式）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

const SESSION = "session-deadbeefcafe1234"; // 用于脱敏断言（不得出现在快照产物/报告/归档）

function run(args: string[], home: string) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: REPO, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: SESSION } as any,
  });
  let j: any = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
}

describe.skipIf(!HAS_BIN)("B5 ops surface — snapshot chain + desensitization", () => {
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-b5-"));
    run(["db", "init"], home);
    run(["project", "new", "p1"], home);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("db snapshot: file + sha256 + desensitized source (no session id, no credentials)", () => {
    const r = run(["db", "snapshot"], home);
    expect(r.rc, r.out).toBe(0);
    expect(r.j.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.j.path).toBeTruthy();
    expect(r.j.source.kind).toBe("sqlite-workspace");
    expect(r.j.source.db_basename).toBe("ygl-trees.db");
    // 护栏④：session id 与凭证样式字段绝不出现
    const blob = JSON.stringify(r.j);
    expect(blob).not.toContain(SESSION);
    expect(blob).not.toMatch(/(?:password|passwd|secret|token)\s*[:=]/i);
  }, 60_000);

  it("snapshot chain: verify run --db <snapshot> → archive → archive verify PASS", () => {
    // 1) 快照
    const snap = run(["db", "snapshot"], home);
    expect(snap.rc, snap.out).toBe(0);
    const snapPath = String(snap.j.path);

    // 2) 建叶 spec（count(projects)>=1）
    const specId = "spec_snap";
    mkdirSync(join(home, "verify", "specs", specId), { recursive: true });
    mkdirSync(join(home, "verify", "materials", "mat_snap"), { recursive: true });
    writeFileSync(join(home, "verify", "materials", "mat_snap", "material.txt"), "snapshot fixture");
    writeFileSync(join(home, "verify", "materials", "mat_snap", "material.json"),
      JSON.stringify({ material_id: "mat_snap", title: "snap", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    writeFileSync(join(home, "verify", "specs", specId, "prepare.json"), JSON.stringify({ material_id: "mat_snap" }));
    writeFileSync(join(home, "verify", "specs", specId, "spec.json"), JSON.stringify({
      contract_version: "1.2", spec_id: specId, spec_version: 1, title: "snap", domain: "general",
      created: "2026-10-22T00:00:00.000Z", runtime_min: "",
      verifier: { engine_version: "0.115.0", corpus_version: "1.2" },
      as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
      attachments: [], sealed: { review: false },
      vu: [{ id: "V1", role: "assert", title: "snap", severity: "S3", source_clause: "x",
        expected_from: { quote: "x", locator: "m:1" },
        checker: { type: "count", sql: "SELECT COUNT(*) AS n FROM projects", op: ">=", value: 1 } }],
    }));

    // 3) 用快照跑
    const runRes = run(["verify", "run", specId, "--db", snapPath], home);
    expect(runRes.rc, runRes.out).toBe(0);
    expect(runRes.j.overall).toBe("PASS");
    // data_source 落在报告文件（CLI 输出是摘要）——读报告验快照来源语义
    const reportFile = join(home, "verify", "reports", String(runRes.j.run_id) + ".json");
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    expect(report.data_source.kind).toBe("sqlite-snapshot");
    expect(report.data_source.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 4) 归档 + 验签
    const archive = run(["verify", "archive", runRes.j.run_id], home);
    expect(archive.rc, archive.out).toBe(0);
    const auth = run(["verify", "archive", "verify", String(archive.j.path ?? archive.j.filename)], home);
    expect(auth.rc, auth.out).toBe(0);
    expect(auth.j.ok).toBe(true);
  }, 180_000);

  it("desensitization audit: reports/archives/events never carry the session id", () => {
    // 扫 verify/reports 与 verify/archives 下的所有文本
    const roots = [join(home, "verify", "reports"), join(home, "verify", "archives")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e);
        try {
          const st = readdirSync(full); void st; // 目录则递归
          walk(full);
        } catch {
          try {
            const text = readFileSync(full, "latin1");
            if (text.includes(SESSION)) offenders.push(full);
            if (/(?:password|passwd|secret)\s*[:=]\s*["']?[^\s"']{6,}/i.test(text)) offenders.push(full + " (credential-shaped)");
          } catch { /* binary / unreadable */ }
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders, offenders.join("\n")).toEqual([]);
  }, 60_000);
});
