import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { VerifyReport } from "../../../verify/core/src/contract";
import { payloadHash } from "../../../verify/core/src/engine";

/**
 * verify 命令面（M13-1）的 CLI 级契约：rc 只表达过程、--json 单对象/单数组、
 * 失败也机器可读（stdout 单 {"error":...}），用法错误 rc=2。
 *
 * 发布产物优先（demo/contract 同纪律）：dist/bundle/bin.cjs 不存在时跳过。
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-verify-cli-")) : "";

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, ...env },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

afterAll(() => {
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(!hasBundle)("verify 命令面（发布产物）", () => {
  it("submit 落冻结材料并回单对象（含 text_sha256）", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    const text = join(home, "material.txt");
    writeFileSync(text, "账单总额须等于申报总额。\n", "utf8");
    const r = run(["verify", "submit", "--title", "t", "--text", text, "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { material_id: string; text_sha256: string; files: unknown[] };
    expect(obj.material_id).toMatch(/^mat_[0-9a-f]{12}$/);
    expect(obj.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(obj.files).toEqual([]);
  });

  it("prepare 缺参数 → rc=2 且 --json 仍是单对象错误", () => {
    const r = run(["verify", "prepare", "mat_deadbeef0000", "--json"]);
    expect(r.rc).toBe(2);
    const obj = JSON.parse(r.out) as { error: string };
    expect(obj.error).toMatch(/usage: verify prepare/);
  });

  it("run 未知 spec → rc=1（运行错误，不是用法错误）", () => {
    const db = join(home, "snap.sqlite");
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE bills(id TEXT)");
    d.close();
    const r = run(["verify", "run", "spec_nope", "--db", db, "--json"]);
    expect(r.rc).toBe(1);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/spec not found|not found/i);
  });

  it("list 空工作区 → rc=0 空数组（读命令的 JSON 纯净）", () => {
    const r = run(["verify", "list", "--json"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("report import 不是报告 → rc=1 且问题点名单条", () => {
    const fake = join(home, "fake-report.json");
    writeFileSync(fake, JSON.stringify({ run_id: "r1", summary: {} }), "utf8");
    const r = run(["verify", "report", "import", fake, "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { imported: boolean; problems: string[] };
    expect(obj.imported).toBe(false);
    expect(obj.problems.join(" ")).toMatch(/payload_sha256/);
  });

  it("archive 未知 run → rc=1 且点名（不产半包）", () => {
    const r = run(["verify", "archive", "run_deadbeef00000000", "--json"]);
    expect(r.rc).toBe(1);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/run not found/);
  });

  it("archive verify 缺文件 → rc=1 且 problems 点名（机器可读）", () => {
    const r = run(["verify", "archive", "verify", join(home, "nope.zip"), "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { ok: boolean; problems?: string[]; error?: string };
    expect(obj.ok).toBe(false);
    expect((obj.problems ?? [obj.error ?? ""]).join(" ")).toMatch(/not found|ENOENT|no such file|cannot read/i);
  });

  it("archive verify 不是 zip → rc=1 且 problems 点名（判定不在 rc 里装）", () => {
    const fake = join(home, "fake.yglverify.zip");
    writeFileSync(fake, "not a zip at all", "utf8");
    const r = run(["verify", "archive", "verify", fake, "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { ok: boolean; problems: string[] };
    expect(obj.ok).toBe(false);
    expect(obj.problems.length).toBeGreaterThan(0);
  });

  it("self-check --no-cases → rc=0（环境/语料摘要/形状全绿，语料实跑显式 skip）", () => {
    const corpus = join(REPO, "packages", "verify", "core", "corpus");
    const r = run(["verify", "self-check", "--corpus", corpus, "--no-cases", "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { ok: boolean; items: Array<{ id: string; status: string }> };
    expect(obj.ok).toBe(true);
    expect(obj.items.find((i) => i.id === "corpus-cases")?.status).toBe("skip");
  }, 60_000);

  it("未知子命令 → rc=2（verify 组同其他组口径）", () => {
    const r = run(["verify", "frobnicate", "--json"]);
    expect(r.rc).toBe(2);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/unknown/i);
  });
});

describe.skipIf(!hasBundle)("verify 封包链（register → import → archive --with binary）", () => {
  const sha256hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  /** 构造一个合法的封包字节：`[engine][spec][footer json][u32]`（与 rust/src/sealed.rs 同布局）。 */
  function sealedBytes(specId = "spec_cli", specVersion = 1): Buffer {
    const engine = Buffer.from("FAKE-ENGINE-BYTES", "utf8");
    const specText = JSON.stringify({
      contract_version: "1.0",
      spec_id: specId,
      spec_version: specVersion,
      verifier: { engine_version: "0.1.0", corpus_version: "1.0" },
      as_of: { kind: "material-extract", captured_at: "2026-07-31T00:00:00.000Z" },
      sealed: { review: false },
      attachments: [],
      vu: [],
    });
    const spec = Buffer.from(specText, "utf8");
    const footer = Buffer.from(
      JSON.stringify({
        magic: "YGLVF1",
        spec_offset: engine.length,
        spec_length: spec.length,
        spec_sha256: sha256hex(spec),
        build_sha256: sha256hex(Buffer.concat([engine, spec])),
        engine_version: "0.1.0",
        corpus_version: "1.0",
      }),
      "utf8",
    );
    const len = Buffer.alloc(4);
    len.writeUInt32LE(footer.length, 0);
    return Buffer.concat([engine, spec, footer, len]);
  }

  it("register 落登记 + 二进制副本，非封包文件 rc=1", () => {
    const bin = join(home, "sealed-cli");
    writeFileSync(bin, sealedBytes());
    const r = run(["verify", "register", bin, "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { registered: boolean; binary_sha256: string; registration: string; binary_path: string; spec_id: string };
    expect(obj.registered).toBe(true);
    expect(obj.binary_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(obj.registration)).toBe(true);
    expect(existsSync(obj.binary_path)).toBe(true);
    expect(obj.spec_id).toBe("spec_cli");

    const plain = join(home, "not-sealed.txt");
    writeFileSync(plain, "hello", "utf8");
    const bad = run(["verify", "register", plain, "--json"]);
    expect(bad.rc).toBe(1);
    expect(bad.out).toContain("not a sealed yglverify binary");
  });

  it("import 封包报告：payload 重算一致才算导入，并从二进制恢复 spec", () => {
    const bin = join(home, "sealed-import");
    writeFileSync(bin, sealedBytes("spec_import", 2));
    const reg = JSON.parse(run(["verify", "register", bin, "--json"]).out) as { binary_sha256: string };
    const report = {
      contract_version: "1.0",
      run_id: "run_import",
      started: "2026-07-31T00:00:00.000Z",
      finished: "2026-07-31T00:00:01.000Z",
      spec_id: "spec_import",
      verifier: {
        mode: "sealed",
        binary_sha256: reg.binary_sha256,
        engine_version: "0.1.0",
        spec_version: 2,
        corpus_version: "1.0",
        sealed_review: false,
      },
      as_of: { kind: "material-extract", captured_at: "2026-07-31T00:00:00.000Z" },
      summary: { pass: 1, fail: 0, needs_material: 0, error: 0 },
      overall: "PASS",
      reason: "all 1 assert units passed",
      // 归档校验会从 VU 重算 overall/summary：夹具必须自洽（1 个 PASS 断言 ↔ summary.pass=1）
      vu: [
        {
          id: "V1",
          role: "assert",
          verdict: "PASS",
          severity: "S2",
          source_clause: "账单总额须等于申报总额。",
          checker_type: "sql",
          witness: { rows_scanned: 1, rows_matched: 0 },
        },
      ],
      exceptions: [],
    } as unknown as VerifyReport;
    const good = join(home, "report-good.json");
    writeFileSync(good, JSON.stringify({ ...report, payload_sha256: payloadHash(report) }, null, 2), "utf8");
    const ok = run(["verify", "report", "import", good, "--json"]);
    expect(ok.rc).toBe(0);
    const res = JSON.parse(ok.out) as { imported: boolean; spec_restored: string | null };
    expect(res.imported).toBe(true);
    expect(res.spec_restored).toBeTruthy();
    expect(existsSync(String(res.spec_restored))).toBe(true);

    const tampered = join(home, "report-tampered.json");
    writeFileSync(tampered, JSON.stringify({ ...report, overall: "FAIL", payload_sha256: payloadHash(report) }, null, 2), "utf8");
    const no = run(["verify", "report", "import", tampered, "--json"]);
    expect(no.rc).toBe(1);
    expect(no.out).toContain("payload tampered");
  });

  it("archive --with binary 收封包与登记，能重算全链", () => {
    const r = run(["verify", "archive", "run_import", "--with", "binary", "--json"]);
    expect(r.rc).toBe(0);
    const arc = JSON.parse(r.out) as { path: string; archive_id: string; items: number };
    expect(arc.archive_id).toMatch(/^arc_[0-9a-f]{12}$/);
    expect(arc.items).toBeGreaterThanOrEqual(4);
    const check = run(["verify", "archive", "verify", arc.path, "--json"]);
    expect(check.rc).toBe(0);
    expect(JSON.parse(check.out)).toMatchObject({ ok: true, archive_id: arc.archive_id });
  });
});
