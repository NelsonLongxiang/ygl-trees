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

  it("source --batch missing file: rc=1（监督席 direct-7d8e3d8c 口径：404 类，与 evidence --file 对齐）", () => {
    const r = run(["research", "source", "add", "--batch", join(DIR, "nope.jsonl"), "-p", "b1"]);
    expect(r.rc).toBe(1);
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

  it("#91: repeated --db keeps last-wins on single-db commands (db stats)", () => {
    const f = join(DIR, "b91.db");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(f);
    d.exec("CREATE TABLE IF NOT EXISTS t(x)");
    d.close();
    const r = run(["db", "stats", "--db", "nope-first.db", "--db", f]);
    expect(r.rc, r.raw).toBe(0); // 末值胜：读 f，不再逗号拼接
    expect(r.raw).not.toMatch(/nope-first\.db,/);
  });

  it("#83 余项：evidence --batch happy path + duplicate + unknown field note", () => {
    const src = run(["research", "source", "add", "--title", "evsrc", "--url", "https://ex.com/ev", "-p", "b1", "--json"]);
    const sid = j(src).id ?? j(src).row?.id;
    const f = join(DIR, "ev-ok.jsonl");
    writeFileSync(f, [
      JSON.stringify({ source_id: sid, quote: "ev quote one", locator: "p1" }),
      JSON.stringify({ source_id: sid, quote: "ev quote one" }),
      JSON.stringify({ source_id: sid, quote: "ev quote two", project: "should-warn" }),
    ].join("\n"), "utf8");
    const r = run(["research", "evidence", "add", "--batch", f, "-p", "b1"]);
    expect(r.rc, r.raw).toBe(0);
    expect(r.out).toMatch(/batch evidence add: 2 added, 1 duplicates/);
    expect(r.out).toMatch(/line 3 ignored unknown field\(s\): project/);
  });

  it("#83 余项：source/claim --file 单对象入参", () => {
    const sf = join(DIR, "src-single.json");
    writeFileSync(sf, JSON.stringify({ title: "file src", url: "https://ex.com/fs" }), "utf8");
    const r1 = run(["research", "source", "add", "--file", sf, "-p", "b1", "--json"]);
    expect(r1.rc, r1.raw).toBe(0);
    expect(j(r1).title).toBe("file src");
    const cf = join(DIR, "clm-single.json");
    writeFileSync(cf, JSON.stringify({ text: "claim from file", confidence: "A" }), "utf8");
    const r2 = run(["research", "claim", "add", "--file", cf, "-p", "b1", "--json"]);
    expect(r2.rc, r2.raw).toBe(0);
    expect(j(r2).text).toBe("claim from file");
    const r3 = run(["research", "claim", "add", "positional", "--file", cf, "-p", "b1"]);
    expect(r3.rc).toBe(2);
    expect(r3.raw).toMatch(/--file cannot combine/);
  });

  it("#83 口径：批量文件缺失 rc1（404 类，与 evidence --file 对齐）", () => {
    const r = run(["research", "source", "add", "--batch", join(DIR, "definitely-missing.jsonl"), "-p", "b1"]);
    expect(r.rc).toBe(1);
    expect(r.raw).toMatch(/batch file not found/);
  });
});
