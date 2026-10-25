/**
 * #37 三轮指名项的针对性复现（lineage / actor 切换点）：
 *  - 未提交的手工对齐重哈希（改文件+改 tooling sha、不写 reregistration）
 *    → meta-tooling --check 必须红（lineage：tooling sha ≠ 最后 new_sha256）
 *    → verify meta R2 必须红（同一规则进引擎面）
 *  - actor_required_from 之后的无 actor 记录 → --audit 必须红
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const REPO = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO, "scripts/meta-tooling.mjs");
const BIN = join(REPO, "dist/bundle/bin.cjs");

const shaOf = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const Z = "0".repeat(64);

function scratchIndex() {
  const root = mkdtempSync(join(tmpdir(), "ygl-37r3-"));
  mkdirSync(join(root, "verify"), { recursive: true });
  return root;
}

const tool = (root: string, args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000 });

describe("#37 round-3: lineage + actor cutoff", () => {
  it("uncommitted hand-aligned rehash → --check red (lineage), not just --against-git", () => {
    const root = scratchIndex();
    const idx = {
      meta_index_version: 2, orchestration: [],
      tooling: [{ path: "scripts/p.mjs", role: "gate", sha256: "a".repeat(64) }],
      reregistrations: [
        { path: "scripts/p.mjs", old_sha256: Z, new_sha256: "a".repeat(64), reason: "r1", actor: "t", at: "2026-10-24T00:00:00.000Z" },
        { path: "scripts/p.mjs", old_sha256: "a".repeat(64), new_sha256: "b".repeat(64), reason: "r2", actor: "t", at: "2026-10-24T02:00:00.000Z" },
      ],
    };
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    // 手工对齐：文件内容=新 sha c，tooling sha 也改成 c（drift 过）——但 c 不在链上
    mkdirSync(join(root, "scripts"), { recursive: true });
    const content = "hand-aligned" + String.fromCharCode(10);
    const c = shaOf(content);
    writeFileSync(join(root, "scripts", "p.mjs"), content);
    const mutated = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
    mutated.tooling[0].sha256 = c; // 对齐到未记录的新 sha
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(mutated, null, 2));
    const r = tool(root, ["--check"]);
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/lineage/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  it("uncommitted hand-aligned rehash → verify meta R2 red (engine face)", () => {
    const root = scratchIndex();
    const idx = {
      meta_index_version: 2, orchestration: [], specs: [],
      tooling: [{ path: "scripts/p.mjs", role: "gate", sha256: "c".repeat(64) }],
      reregistrations: [
        { path: "scripts/p.mjs", old_sha256: Z, new_sha256: "c".repeat(64), reason: "r1", actor: "t", at: "2026-10-24T00:00:00.000Z" },
        { path: "scripts/p.mjs", old_sha256: "c".repeat(64), new_sha256: "d".repeat(64), reason: "r2", actor: "t", at: "2026-10-24T02:00:00.000Z" },
      ],
    };
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    // 引擎从 cwd 取 repo；同时落对齐文件（drift 不干扰 lineage 判定）
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "p.mjs"), "engine-face" + String.fromCharCode(10));
    const e = shaOf(readFileSync(join(root, "scripts", "p.mjs")));
    idx.tooling[0].sha256 = e; // 对齐磁盘（drift 过）但 ≠ 最后 new d（lineage 红）
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    const home = mkdtempSync(join(tmpdir(), "ygl-37r3-home-"));
    spawnSync(process.execPath, [BIN, "db", "init"], { env: { ...process.env, YGL_HOME: home }, stdio: "ignore" });
    const r = spawnSync(process.execPath, [BIN, "verify", "meta", root, "--json"], {
      encoding: "utf8", env: { ...process.env, YGL_HOME: home }, timeout: 120_000,
    });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    let j: any = null;
    try { j = JSON.parse(r.stdout); } catch { /* */ }
    const r2 = (j?.rules ?? []).find((x: any) => x.id === "R2");
    expect(r2?.verdict, (r.stdout || "") + (r.stderr || "")).toBe("FAIL");
    expect(JSON.stringify(r2?.evidence)).toMatch(/lineage/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 120_000);

  it("actor_required_from cutoff: post-cutoff entry without actor → --audit red", () => {
    const root = scratchIndex();
    const idx = {
      meta_index_version: 2, orchestration: [],
      actor_required_from: "2026-10-25T00:00:00.000Z",
      tooling: [{ path: "scripts/p.mjs", role: "gate", sha256: "a".repeat(64) }],
      reregistrations: [
        { path: "scripts/p.mjs", old_sha256: Z, new_sha256: "a".repeat(64), reason: "legacy", at: "2026-10-24T00:00:00.000Z" },
        { path: "scripts/p.mjs", old_sha256: "a".repeat(64), new_sha256: "a".repeat(64), reason: "post-cutoff no actor", at: "2026-10-25T06:00:00.000Z" },
      ],
    };
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    const r = tool(root, ["--audit"]);
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/actor missing after cutoff/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);
});
