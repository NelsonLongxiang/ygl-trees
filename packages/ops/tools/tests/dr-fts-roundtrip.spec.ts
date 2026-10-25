/**
 * DR 修单验收：db export → 回放 → FTS 检索面可用（五表往返）。
 *
 * 缺陷（总工席派单，运维席演练定位）：dump 滤掉了 CREATE VIRTUAL TABLE 本体，
 * 回放后 skills/sources/evidence/kb/nodes 五张 fts5 表不存在——kbSearch 等
 * 检索面全断。
 *
 * 修法：影子表组仍排除；虚拟表 DDL 随 dump（数据行之后建）+ 数据行回填。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

function run(args: string[], home: string) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: REPO, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "dr-fts" } as any,
  });
  let j: any = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
}

describe.skipIf(!HAS_BIN)("DR: db export FTS5 roundtrip (five search tables)", () => {
  let home = "";
  let dumpPath = "";
  let home2 = "";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-dr-src-"));
    run(["db", "init"], home);
    run(["project", "new", "p1"], home);
    // 三个检索面各写一条：kb / source / skill（skills 随 init 导入——再补一条 kb 与 source 够证明）
    run(["kb", "add", "--title", "往返验证笔记", "--body", "外部内容检索恢复验证", "-p", "p1"], home);
    run(["research", "source", "add", "--title", "DR来源", "--url", "https://example.com/dr", "-p", "p1"], home);
    dumpPath = join(home, "dump.sql");
    const ex = run(["db", "export", dumpPath], home);
    expect(ex.rc, ex.out).toBe(0);
    home2 = mkdtempSync(join(tmpdir(), "ygl-dr-dst-"));
  });
  afterAll(() => {
    for (const h of [home, home2]) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("dump contains the five CREATE VIRTUAL TABLE statements", () => {
    const dump = readFileSync(dumpPath, "utf8");
    for (const t of ["skills_fts", "sources_fts", "evidence_fts", "kb_fts", "nodes_fts"]) {
      expect(dump, `${t} missing from dump`).toMatch(new RegExp(`CREATE VIRTUAL TABLE[^;]*${t}`, "i"));
    }
  });

  it("dump carries fts data rows (not only DDL)", () => {
    const dump = readFileSync(dumpPath, "utf8");
    expect(dump).toMatch(/INSERT OR REPLACE INTO kb_fts\(/);
    expect(dump).toMatch(/INSERT OR REPLACE INTO sources_fts\(/);
  });

  it("replay into a fresh workspace keeps search surfaces alive", () => {
    // 回放：dump 自带全量 DDL——直接灌进**全新空文件**（等价 sqlite3 new.db < dump.sql）
    const dbFile = join(home2, "ygl-trees.db");
    const replay = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const fs = require("node:fs");
      const db = new DatabaseSync(process.argv[1]);
      db.exec(fs.readFileSync(process.argv[2], "utf8"));
      db.close();
    `, dbFile, dumpPath], { encoding: "utf8", timeout: 120_000 });
    expect(replay.status, (replay.stdout || "") + (replay.stderr || "")).toBe(0);
    // 检索面：kb search 在回放库上命中
    const search = run(["kb", "search", "往返验证", "-p", "p1"], home2);
    expect(search.rc, search.out).toBe(0);
    expect(JSON.stringify(search.j)).toContain("往返验证笔记");
    // source search 同样
    const srcSearch = run(["research", "source", "search", "DR来源", "-p", "p1"], home2);
    expect(srcSearch.rc, srcSearch.out).toBe(0);
    expect(JSON.stringify(srcSearch.j)).toContain("DR来源");
  }, 180_000);

  it("shadow tables are still excluded (no _data/_idx CREATE)", () => {
    const dump = readFileSync(dumpPath, "utf8");
    expect(dump).not.toMatch(/CREATE TABLE[^;]*_fts_data/i);
    expect(dump).not.toMatch(/CREATE TABLE[^;]*_fts_idx/i);
  });
});
