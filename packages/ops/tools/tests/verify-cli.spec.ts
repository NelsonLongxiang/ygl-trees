import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { VerifyReport } from "../../../verify/core/src/contract";
import { canonicalStringify } from "../../../verify/core/src/canonical";
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
  it("未知旗标是用法错误（--attachment 不再静默落空）", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    const text = join(home, "material.txt");
    writeFileSync(text, "账单总额须等于申报总额。\n", "utf8");
    const attach = join(home, "bill.xlsx");
    writeFileSync(attach, Buffer.from("fake-xlsx"));
    // 真旗标是 --attach；--attachment 曾经被解析器静默吞掉，结果是 files:[] 却 rc=0
    const r = run(["verify", "submit", "--title", "t", "--text", text, "--attachment", attach, "--json"]);
    expect(r.rc).toBe(2);
    const obj = JSON.parse(r.out) as { error: string };
    expect(obj.error).toMatch(/unknown flag.*--attachment/);
  });

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

  it("prepare --as-of 不可解析 → rc=2（用法错误，r22 ②）", () => {
    // 旗标校验先于 I/O：material/db 都不存在也应报用法错误而不是运行错误
    const r = run(["verify", "prepare", "mat_deadbeef0000", "--candidates", "c.json", "--reviews", "r.json", "--db", "s.sqlite", "--as-of", "not-a-time", "--json"]);
    expect(r.rc).toBe(2);
    const obj = JSON.parse(r.out) as { error: string };
    expect(obj.error).toMatch(/as_of/);
    expect(obj.error).toMatch(/ISO-8601/);
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

  it("--db 是业务库快照，不是工作区库（r15 P1-1：不得就地迁移业务库）", () => {
    const biz = join(home, "biz.sqlite");
    const db = new DatabaseSync(biz);
    db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, amount INTEGER)");
    db.exec("INSERT INTO orders VALUES ('o1', 100)");
    db.close();
    const before = createHash("sha256").update(require("node:fs").readFileSync(biz)).digest("hex");
    const r = run(["verify", "list", "--db", biz, "--json"]);
    expect(r.rc).toBe(0);
    const after = createHash("sha256").update(require("node:fs").readFileSync(biz)).digest("hex");
    expect(after).toBe(before);
    const check = new DatabaseSync(biz, { readOnly: true });
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    check.close();
    expect(tables).toEqual(["orders"]);
  });

  it("run --no-archive → rc=0 且不产归档（旗标在 ACTION_FLAGS 里）", () => {
    const caseDir = join(REPO, "packages", "verify", "core", "corpus", "cases", "sql-find-violation");
    const spec = JSON.parse(readFileSync(join(caseDir, "spec.json"), "utf8")) as { spec_id: string };
    const specDir = join(home, "verify", "specs", spec.spec_id);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.json"), readFileSync(join(caseDir, "spec.json")));
    const dbFile = join(home, "case.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec(readFileSync(join(caseDir, "db.sql"), "utf8"));
    db.close();
    const r = run(["verify", "run", spec.spec_id, "--db", dbFile, "--no-archive", "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { overall: string; archive: unknown };
    expect(obj.overall).toBe("FAIL");
    expect(obj.archive).toBeNull();
    const archives = join(home, "verify", "archives");
    expect(existsSync(archives) ? readdirSync(archives).length : 0).toBe(0);
  });

  it("prepare --draft 干跑：不写 spec/prepare/trace、不消耗 spec_version（r15 小项）", () => {
    const text = join(home, "draft-material.txt");
    writeFileSync(text, "账单金额不得为负。\n", "utf8");
    const sub = run(["verify", "submit", "--title", "d", "--text", text, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = (JSON.parse(sub.out) as { material_id: string }).material_id;
    const dbFile = join(home, "draft.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE bills (id TEXT PRIMARY KEY, amount_cents INTEGER)");
    db.exec("INSERT INTO bills VALUES ('b1', -5)");
    db.close();
    const clause = "账单金额不得为负。";
    const anchor = { quote: clause, locator: "material.txt#L1" };
    const candidates = join(home, "cand.json");
    writeFileSync(candidates, JSON.stringify({ candidates: [{
      source_clause: clause,
      anchor,
      checker: { type: "sql", fail_when: "rows>0", predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] } } },
    }] }), "utf8");
    const reviews = join(home, "rev.json");
    writeFileSync(reviews, JSON.stringify({ reviews: [[
      { vu_id: "V1", question: "faithful", verdict: "ok", reason: "逐字对应", anchor },
      { vu_id: "V1", question: "decidable", verdict: "ok", reason: "有机械判据", anchor },
      { vu_id: "V1", question: "not-vacuous", verdict: "ok", reason: "空表会被判 NM", anchor },
    ]] }), "utf8");
    const specsBefore = existsSync(join(home, "verify", "specs")) ? readdirSync(join(home, "verify", "specs")).length : 0;
    const r = run(["verify", "prepare", materialId, "--candidates", candidates, "--reviews", reviews, "--db", dbFile, "--draft", "--json"]);
    // ready 与否都可能（红队/自审），关键是 rc 与「什么都没写」
    expect([0, 1]).toContain(r.rc);
    const obj = JSON.parse(r.out) as { draft: boolean };
    expect(obj.draft).toBe(true);
    const specs = join(home, "verify", "specs");
    expect(existsSync(specs) ? readdirSync(specs).length : 0).toBe(specsBefore);
  }, 60_000);

  it("prepare 未 ready：只追加 attempts/<ts>.json，不覆盖已冻结的 prepare.json（0.102.2）", () => {
    const text = join(home, "attempt-material.txt");
    writeFileSync(text, "退款金额不得超过原单金额。", "utf8");
    const sub = run(["verify", "submit", "--title", "a", "--text", text, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = (JSON.parse(sub.out) as { material_id: string }).material_id;
    const dbFile = join(home, "attempt.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, amount_cents INTEGER)");
    db.exec("INSERT INTO orders VALUES ('o1', 100)");
    db.close();
    const clause = "退款金额不得超过原单金额。";
    const anchor = { quote: clause, locator: "material.txt#L1" };
    // 列不在 schema 里 → P2 列校验打回，必然不 ready
    const candidates = join(home, "cand-attempt.json");
    writeFileSync(candidates, JSON.stringify({ candidates: [{
      source_clause: clause,
      anchor,
      checker: { type: "sql", fail_when: "rows>0", predicate: { from: "orders", select: ["id"], where: { op: "and", conditions: [{ col: "amount_cents_missing", op: "<", value: 0 }] } } },
    }] }), "utf8");
    const reviews = join(home, "rev-attempt.json");
    writeFileSync(reviews, JSON.stringify({ reviews: [[
      { vu_id: "V1", question: "faithful", verdict: "ok", reason: "逐字对应", anchor },
      { vu_id: "V1", question: "decidable", verdict: "ok", reason: "有机械判据", anchor },
      { vu_id: "V1", question: "not-vacuous", verdict: "ok", reason: "空表会被判 NM", anchor },
    ]] }), "utf8");
    const specId = `spec_${createHash("sha256").update(materialId).digest("hex").slice(0, 12)}`;
    const specDir = join(home, "verify", "specs", specId);
    mkdirSync(specDir, { recursive: true });
    const sentinel = join(specDir, "prepare.json");
    writeFileSync(sentinel, JSON.stringify({ material_id: materialId, verdict: "ready", frozen: true }), "utf8");
    const before = createHash("sha256").update(readFileSync(sentinel)).digest("hex");
    const r = run(["verify", "prepare", materialId, "--candidates", candidates, "--reviews", reviews, "--db", dbFile, "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { verdict: string };
    expect(obj.verdict).not.toBe("ready");
    const after = createHash("sha256").update(readFileSync(sentinel)).digest("hex");
    expect(after).toBe(before);
    expect(readdirSync(join(specDir, "attempts")).length).toBe(1);
    // spec.json 不存在（没 ready 就不写规范）
    expect(existsSync(join(specDir, "spec.json"))).toBe(false);
  }, 60_000);

  it("照文档的对象形状 --reviews → ready，三文件落盘（r23 P2 正向回归）", () => {
    const text = join(home, "ready-material.txt");
    writeFileSync(text, "账单金额不得为负。" + String.fromCharCode(10), "utf8");
    const sub = run(["verify", "submit", "--title", "ready", "--text", text, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = (JSON.parse(sub.out) as { material_id: string }).material_id;
    const dbFile = join(home, "ready.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE bills (id TEXT PRIMARY KEY, amount_cents INTEGER)");
    db.exec("INSERT INTO bills VALUES ('b1', -5)");
    db.close();
    const clause = "账单金额不得为负。";
    const anchor = { quote: clause, locator: "material.txt#L1" };
    // 文档给的形状：候选裸对象数组 + 盲审按 source_clause 对齐（vu_id 由 prepare 生成）
    const candidates = join(home, "cand-ready.json");
    writeFileSync(candidates, JSON.stringify({ candidates: [{
      source_clause: clause,
      anchor,
      // 空快照判 FAIL 才过 P4 红队（rows==0 是违规），非空洞 PASS
      checker: { type: "sql", fail_when: "rows==0", predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] } } },
    }] }), "utf8");
    const reviews = join(home, "rev-ready.json");
    writeFileSync(reviews, JSON.stringify({ reviews: [{
      source_clause: clause,
      findings: [
        { question: "faithful", verdict: "ok", reason: "逐字对应", anchor },
        { question: "decidable", verdict: "ok", reason: "有机械判据", anchor },
        { question: "not-vacuous", verdict: "ok", reason: "空表判 FAIL", anchor },
      ],
    }] }), "utf8");
    const r = run(["verify", "prepare", materialId, "--candidates", candidates, "--reviews", reviews, "--db", dbFile, "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { verdict: string; record: string; spec_id: string };
    expect(obj.verdict).toBe("ready");
    // record 相对 verify 根（脚本可直接拼绝对路径）
    expect(obj.record).toBe(["specs", obj.spec_id, "prepare.json"].join("/"));
    const dir = join(home, "verify", "specs", obj.spec_id);
    for (const f of ["prepare.json", "spec.json", "trace.json"]) expect(existsSync(join(dir, f))).toBe(true);
    // 反向：旧版嵌套形状（r23 P2 的错例）永不 ready
    const nested = join(home, "rev-nested.json");
    writeFileSync(nested, JSON.stringify({ reviews: [[
      { vu_id: "V1", question: "faithful", verdict: "ok", reason: "逐字对应", anchor },
      { vu_id: "V1", question: "decidable", verdict: "ok", reason: "有机械判据", anchor },
      { vu_id: "V1", question: "not-vacuous", verdict: "ok", reason: "空表判 FAIL", anchor },
    ]] }), "utf8");
    const bad = run(["verify", "prepare", materialId, "--candidates", candidates, "--reviews", nested, "--db", dbFile, "--json"]);
    expect(bad.rc).toBe(1);
    expect((JSON.parse(bad.out) as { verdict: string }).verdict).not.toBe("ready");
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
    const specText = canonicalStringify({
      contract_version: "1.1",
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
      canonicalStringify({
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
      contract_version: "1.1",
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

  it("import 拒绝被换过的工作区二进制（文件名相同、字节不同；r16 P2①）", () => {
    const bin = join(home, "sealed-swap");
    writeFileSync(bin, sealedBytes("spec_swap", 1));
    const reg = JSON.parse(run(["verify", "register", bin, "--json"]).out) as { binary_sha256: string; binary_path: string };
    // 用另一份封包覆盖工作区副本：文件路径仍按注册时的 sha 命名，但字节不是报告指名的那个构建。
    writeFileSync(reg.binary_path, sealedBytes("spec_swap", 2));
    const report = {
      contract_version: "1.1",
      run_id: "run_swap",
      started: "2026-07-31T00:00:00.000Z",
      finished: "2026-07-31T00:00:01.000Z",
      spec_id: "spec_swap",
      verifier: {
        mode: "sealed",
        binary_sha256: reg.binary_sha256,
        engine_version: "0.1.0",
        spec_version: 1,
        corpus_version: "1.0",
        sealed_review: false,
      },
      as_of: { kind: "material-extract", captured_at: "2026-07-31T00:00:00.000Z" },
      summary: { pass: 1, fail: 0, needs_material: 0, error: 0 },
      overall: "PASS",
      reason: "all 1 assert units passed",
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
    const file = join(home, "report-swap.json");
    writeFileSync(file, JSON.stringify({ ...report, payload_sha256: payloadHash(report) }, null, 2), "utf8");
    const r = run(["verify", "report", "import", file, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("binary identity mismatch");
  });

  it("archive --with binary 拒绝被换过的工作区二进制（r17 P3①）", () => {
    const sealed = join(home, "sealed-archswap");
    writeFileSync(sealed, sealedBytes("spec_archswap", 1));
    const reg = JSON.parse(run(["verify", "register", sealed, "--json"]).out) as {
      binary_sha256: string;
      binary_path: string;
      registration: string;
    };
    // 先造一份指名该构建的报告（payload 自洽），再把工作区副本换成同 key 的另一封包。
    const report = {
      contract_version: "1.1",
      run_id: "run_archswap",
      started: "2026-07-31T00:00:00.000Z",
      finished: "2026-07-31T00:00:02.000Z",
      spec_id: "spec_archswap",
      verifier: {
        mode: "sealed",
        binary_sha256: reg.binary_sha256,
        engine_version: "0.1.0",
        spec_version: 1,
        corpus_version: "1.1",
        sealed_review: false,
      },
      as_of: { kind: "material-extract", captured_at: "2026-07-31T00:00:00.000Z" },
      summary: { pass: 1, fail: 0, needs_material: 0, error: 0 },
      overall: "PASS",
      reason: "all 1 assert units passed",
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
    // archive 会收 spec.json，先把它放到规范目录（最小合法形状）。
    const specDir = join(home, "verify", "specs", "spec_archswap");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "spec.json"),
      JSON.stringify(
        {
          contract_version: "1.1",
          spec_id: "spec_archswap",
          spec_version: 1,
          title: "归档身份用例",
          domain: "general",
          created: "2026-07-31T00:00:00.000Z",
          as_of: { kind: "material-extract", captured_at: "2026-07-31T00:00:00.000Z" },
          sealed: { review: false },
          attachments: [],
          vu: [
            {
              id: "V1",
              role: "assert",
              title: "账单总额",
              severity: "S2",
              source_clause: "账单总额须等于申报总额。",
              checker: { type: "sql", sql: "SELECT 1 WHERE 0", expect: "no rows" },
              expected_from: { kind: "material-extract", anchor: "m#1" },
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    const reportsDir = join(home, "verify", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, "run_archswap.json"),
      JSON.stringify({ ...report, payload_sha256: payloadHash(report) }, null, 2),
      "utf8"
    );
    writeFileSync(reg.binary_path, sealedBytes("spec_archswap", 2));
    const r = run(["verify", "archive", "run_archswap", "--with", "binary", "--json"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("refusing to archive");
  });

  it("blob 后端的附件随归档入包，归档可重算全链（M13-2 第二批）", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    const matText = join(home, "mat-blob.txt");
    writeFileSync(matText, ["每期运费账单须附原始 CSV。", ""].join(String.fromCharCode(10)), "utf8");
    const csv = join(home, "bill-2026-07.csv");
    const csvBytes = Buffer.from(["账单号,金额", "INV-1,1290.40", ""].join(String.fromCharCode(10)));
    writeFileSync(csv, csvBytes);

    const submitted = run(["verify", "submit", "--title", "blob 附件", "--text", matText, "--attach", csv, "--json"]);
    expect(submitted.rc).toBe(0);
    const mat = JSON.parse(submitted.out) as { material_id: string; files: Array<{ sha256: string; blob?: boolean; size: number }> };
    expect(mat.files).toHaveLength(1);
    expect(mat.files[0].blob).toBe(true);
    const sha = mat.files[0].sha256;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // 内容寻址：仓里只有一份，文件名不再参与定位
    expect(existsSync(join(home, "verify", "blobs", sha.slice(0, 2), sha))).toBe(true);

    // 语料 spec 改成本地 id 与 blob 附件，再跑一次（默认归档 = materials）
    const caseDir = join(REPO, "packages", "verify", "core", "corpus", "cases", "sql-find-violation");
    const spec = JSON.parse(readFileSync(join(caseDir, "spec.json"), "utf8")) as any;
    spec.spec_id = "spec_blobarch";
    spec.attachments = [{ path: "bill-2026-07.csv", sha256: sha, role: "baseline", mime: "text/csv", size: csvBytes.length }];
    const specDir = join(home, "verify", "specs", spec.spec_id);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.json"), JSON.stringify(spec, null, 2), "utf8");
    writeFileSync(join(specDir, "prepare.json"), JSON.stringify({ material_id: mat.material_id, materials_sha256: "" }, null, 2), "utf8");

    const dbFile = join(home, "blobarch.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec(readFileSync(join(caseDir, "db.sql"), "utf8"));
    db.close();
    const ran = run(["verify", "run", spec.spec_id, "--db", dbFile, "--json"]);
    expect(ran.rc).toBe(0);
    const report = JSON.parse(ran.out) as { archive?: { path: string } };
    expect(report.archive?.path).toBeTruthy();

    const verified = run(["verify", "archive", "verify", report.archive!.path, "--json"]);
    expect(verified.rc).toBe(0);
    const ok = JSON.parse(verified.out) as { ok: boolean; items: number };
    expect(ok.ok).toBe(true);
    // 材料正文 + 附件字节 + 报告 + 规范都在包里
    expect(ok.items).toBeGreaterThanOrEqual(5);
  });

  it("密钥表自检：key_id 必须是 sha256(public_key)（r16 P2②）", () => {
    const sealed = join(home, "sealed-for-keys");
    writeFileSync(sealed, sealedBytes("spec_keys", 1));
    const table = join(home, "keys-bad.json");
    writeFileSync(
      table,
      JSON.stringify({
        scheme: "ed25519",
        keys: { ["0".repeat(64)]: { public_key: "1".repeat(64), created: "2026-10-20" } },
      }),
      "utf8",
    );
    const r = run(["verify", "signature", sealed, "--keys", table, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("key table inconsistency");
  });
});
