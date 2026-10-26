/**
 * #83（评审席 direct-f5453873 裁点）：research source/claim add --batch <file.jsonl>。
 * 语义钉：整批拒（先行全量校验——坏行点名行号+字段、rc=2、零写入；通过后在单个事务内落库，
 * 运行时失败整批回滚 rc1）；内容级重复按 duplicate 计数（幂等，非错误）；
 * --json 单对象 counts/rows；默认汇总一行、--verbose 逐行；MCP 同名参数（mcp.ts 路由在案）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let DIR = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, out: r.stdout || "", raw: (r.stdout || "") + (r.stderr || "") };
}
const j = (r: { out: string }) => JSON.parse(r.out);
const sourceCount = () => Number(j(run(["db", "sql", "SELECT COUNT(*) AS c FROM sources", "--json"]))[0]?.c ?? -1);
const claimCount = () => Number(j(run(["db", "sql", "SELECT COUNT(*) AS c FROM claims", "--json"]))[0]?.c ?? -1);

describe.skipIf(!HAS_BIN)("research --batch jsonl (#83 all-or-nothing)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-batch-"));
    DIR = mkdtempSync(resolve(tmpdir(), "ygl-batchfiles-"));
    run(["db", "init"]);
    run(["project", "new", "b1"]);
  });
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("source --batch happy path: added + duplicates counted, single-tx receipt", () => {
    const f = join(DIR, "src-ok.jsonl");
    writeFileSync(f, [
      JSON.stringify({ title: "alpha", url: "https://ex.com/a", relevance: 3 }),
      JSON.stringify({ title: "beta", url: "https://ex.com/b" }),
      JSON.stringify({ title: "alpha again", url: "https://ex.com/a" }), // 与行 1 同 url → duplicate
      "",
    ].join("\n"), "utf8");
    const before = sourceCount();
    const r = run(["research", "source", "add", "--batch", f, "-p", "b1", "--json"]);
    expect(r.rc).toBe(0);
    const res = j(r);
    expect(res).toMatchObject({ batch: "source.add", added: 2, duplicates: 1 });
    expect(res.rows).toHaveLength(3);
    expect(res.rows[2].duplicate).toBe(true);
    expect(sourceCount()).toBe(before + 2);
  });

  it("source --batch bad row: rc=2 names line+field, NOTHING written (整批拒)", () => {
    const f = join(DIR, "src-bad.jsonl");
    writeFileSync(f, [
      JSON.stringify({ title: "good1", url: "https://ex.com/g1" }),
      JSON.stringify({ title: "bad", url: "https://ex.com/bad", relevance: 4.5 }),
      JSON.stringify({ title: "good2", url: "https://ex.com/g2" }),
    ].join("\n"), "utf8");
    const before = sourceCount();
    const r = run(["research", "source", "add", "--batch", f, "-p", "b1"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/line 2: relevance must be an integer 0-5/);
    expect(sourceCount()).toBe(before); // 零写入
  });

  it("source --batch invalid JSON line: rc=2 names line, nothing written", () => {
    const f = join(DIR, "src-json.jsonl");
    writeFileSync(f, JSON.stringify({ title: "ok", url: "https://ex.com/ok" }) + "\n{not json}\n", "utf8");
    const before = sourceCount();
    const r = run(["research", "source", "add", "--batch", f, "-p", "b1"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/line 2: invalid JSON/);
    expect(sourceCount()).toBe(before);
  });

  it("source --batch missing file: rc=2", () => {
    const r = run(["research", "source", "add", "--batch", join(DIR, "nope.jsonl"), "-p", "b1"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/batch file not found/);
  });

  it("claim --batch happy path + duplicate counting + --verbose lines", () => {
    const f = join(DIR, "clm-ok.jsonl");
    writeFileSync(f, [
      JSON.stringify({ text: "claim one", confidence: "A" }),
      JSON.stringify({ text: "claim two" }),
      JSON.stringify({ text: "claim one" }), // duplicate
    ].join("\n"), "utf8");
    const before = claimCount();
    const r = run(["research", "claim", "add", "--batch", f, "-p", "b1", "--verbose"]);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/batch claim add: 2 added, 1 duplicates/);
    expect(r.out).toMatch(/duplicate/);
    expect(claimCount()).toBe(before + 2);
  });

  it("claim --batch bad row: rc=2 names line, nothing written", () => {
    const f = join(DIR, "clm-bad.jsonl");
    writeFileSync(f, [
      JSON.stringify({ text: "fine claim" }),
      JSON.stringify({ confidence: "A" }), // 缺 text
    ].join("\n"), "utf8");
    const before = claimCount();
    const r = run(["research", "claim", "add", "--batch", f, "-p", "b1"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/line 2: need text/);
    expect(claimCount()).toBe(before);
  });

  it("claim --batch --json is a single object (contract ②)", () => {
    const f = join(DIR, "clm-json.jsonl");
    writeFileSync(f, JSON.stringify({ text: "json shape claim" }) + "\n", "utf8");
    const r = run(["research", "claim", "add", "--batch", f, "-p", "b1", "--json"]);
    expect(r.rc).toBe(0);
    const res = j(r);
    expect(res).toMatchObject({ batch: "claim.add", added: 1, duplicates: 0 });
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("batch + --query 互斥：source 批量拒组合 rc2", () => {
    const f = join(DIR, "src-q.jsonl");
    writeFileSync(f, JSON.stringify({ title: "x", url: "https://ex.com/x" }) + "\n", "utf8");
    const r = run(["research", "source", "add", "--batch", f, "--query", "whatever", "-p", "b1"]);
    expect(r.rc).toBe(2);
    expect(r.raw).toMatch(/--batch cannot combine with --query/);
  });
});
