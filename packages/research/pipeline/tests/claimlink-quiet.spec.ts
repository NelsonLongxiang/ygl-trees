/**
 * #84（用户反馈 2026-10-25）：claim link 批量时模型置信度三行淹没真正信号。
 * 语义：默认安静（审计行 events claim.eval 仍为唯一事实源）；--verbose 才展开
 * [模型] 行；--by-source 批量只在状态变化/预测跳晋级处打一行 [状态] 摘要；--json 不受影响。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let CID = "";
let PRED = "";
let SID = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, raw: (r.stdout || "") + (r.stderr || ""), out: r.stdout || "" };
}

// 网关可达探针（监督席 direct-bc90dd8a：无凭证环境必须离线安全）——
// 评估成功 model_confidence 为数值；离线回落 null（ops evalClaim 无凭证 ok:false）。
let HAS_EVAL = false;

describe.skipIf(!HAS_BIN)("claim link quiet-by-default (#84)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-linkquiet-"));
    run(["db", "init"]);
    run(["project", "new", "lq"]);
    const src = run(["research", "source", "add", "--url", "https://ex.com/lq", "--title", "lq-src", "--relevance", "4", "--confidence", "A", "-p", "lq", "--json"]);
    SID = JSON.parse(src.out).id ?? JSON.parse(src.out).row?.id;
    const ev1 = run(["research", "evidence", "add", SID, "--quote", "q1", "-p", "lq", "--json"]);
    const ev2 = run(["research", "evidence", "add", SID, "--quote", "q2", "-p", "lq", "--json"]);
    const cl = run(["research", "claim", "add", "plain claim text", "--confidence", "A", "-p", "lq", "--json"]);
    CID = JSON.parse(cl.out).id ?? JSON.parse(cl.out).row?.id;
    const pc = run(["research", "claim", "add", "[预测·7天] deadline claim", "--confidence", "A", "-p", "lq", "--json"]);
    PRED = JSON.parse(pc.out).id ?? JSON.parse(pc.out).row?.id;
    // 预链一条证据给两条 claim（by-source 批量只需 source 内 ≥1 条未链证据时 linked>0）
    run(["research", "claim", "link", CID, JSON.parse(ev1.out).id ?? JSON.parse(ev1.out).row?.id, "-p", "lq"]);
    // 预测 claim 故意不预链——批量时会触发 auto-promote skip 摘要行
    const probe = run(["research", "claim", "evaluate", CID, "-p", "lq", "--json"]);
    try { HAS_EVAL = typeof JSON.parse(probe.out)?.model_confidence === "number"; } catch { HAS_EVAL = false; }
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("usage text surfaces --verbose (#84.3 可发现性)", () => {
    const r = run(["research", "claim", "link"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/--verbose/);
  });

  it("default link is quiet: no [模型] line in stdout (#84.1)", () => {
    const ev = run(["research", "evidence", "add", SID, "--quote", "q2", "-p", "lq", "--json"]);
    const eid = JSON.parse(ev.out).id ?? JSON.parse(ev.out).row?.id;
    const r = run(["research", "claim", "link", CID, eid, "-p", "lq"]);
    expect(r.rc).toBe(0);
    expect(r.out).not.toMatch(/\[模型\]/);
    expect(r.out).toMatch(/claim status now:/);
  });

  it("batch --by-source prints one [状态] line on prediction auto-promote skip (#84.3)", () => {
    const r = run(["research", "claim", "link", PRED, SID, "--by-source", "-p", "lq"]);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/linked \d+ evidence from source/);
    expect(r.out).toMatch(/\[状态\] prediction claim stays .* auto-promote skipped/);
    expect(r.out).not.toMatch(/\[模型\]/);
  });

  it("batch --by-source with no status change prints no [状态] line", () => {
    // 重复跑同一条 by-source：全部 duplicate（linked=0）→ 无摘要行
    const r = run(["research", "claim", "link", PRED, SID, "--by-source", "-p", "lq"]);
    expect(r.rc).toBe(0);
    expect(r.out).not.toMatch(/\[状态\]/);
  });

  it("--json stays machine-readable and carries model fields when evaluated", () => {
    const ev = run(["research", "evidence", "add", SID, "--quote", "q3", "-p", "lq", "--json"]);
    const eid = JSON.parse(ev.out).id ?? JSON.parse(ev.out).row?.id;
    const r = run(["research", "claim", "link", CID, eid, "-p", "lq", "--json"]);
    expect(r.rc).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toHaveProperty("status");
    expect(typeof j.model_label === "string" || j.model_label === undefined).toBe(true);
    expect(r.out).not.toMatch(/\[模型\]/);
  });

  // 运行期门（it.runIf 是收集期求值，beforeAll 探针尚未跑——不能用）：
  // 网关不可达（无凭证离线环境）时 ctx.skip 带可见原因——监督席 direct-bc90dd8a/#90：
  // 套件必须无凭证全绿，verbose 接受性由 --verbose-accepted 断言无条件钉。
  it("--verbose expands the [模型] line when the evaluator is reachable (#84.2)", (ctx) => {
    if (!HAS_EVAL) ctx.skip("evaluator unreachable (offline, no credentials) — expansion assertion N/A");
    const ev = run(["research", "evidence", "add", SID, "--quote", "q4", "-p", "lq", "--json"]);
    const eid = JSON.parse(ev.out).id ?? JSON.parse(ev.out).row?.id;
    const r = run(["research", "claim", "link", CID, eid, "--verbose", "-p", "lq"]);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/\[模型\] 置信度/);
  });

  it("--verbose is accepted in offline environments (rc=0, quiet path)", (ctx) => {
    if (HAS_EVAL) ctx.skip("evaluator reachable here — quiet-path assertion covered by #84.1");
    const ev = run(["research", "evidence", "add", SID, "--quote", "q5", "-p", "lq", "--json"]);
    const eid = JSON.parse(ev.out).id ?? JSON.parse(ev.out).row?.id;
    const r = run(["research", "claim", "link", CID, eid, "--verbose", "-p", "lq"]);
    expect(r.rc).toBe(0);
    expect(r.out).not.toMatch(/\[模型\]/);
  });
});
