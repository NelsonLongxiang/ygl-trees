/**
 * MCP 写面扩展（0.114.26 方案 D，属主裁定「MCP 也是要的」）：
 *  - tools/list 恰 11 个（8 读面 + research_write/tree_write/verify）
 *  - research_write 幂等（同内容重跑同 id duplicate）
 *  - rc 保真：CLI rc≠0 → MCP isError:true + 机器可读 {rc, error} 载荷
 *  - 未知 action → isError（schema 外兜底）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");

let home = "";

interface Resp { id: number; result?: any; error?: any }

function mcpCall(): { send: (method: string, params?: unknown) => Promise<Resp>; kill: () => void } {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    cwd: REPO,
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-write-spec" } as any,
  });
  const pending = new Map<number, (r: Resp) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    } catch { /* noise */ }
  });
  let nextId = 1;
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 30_000);
      }),
    kill: () => child.kill(),
  };
}

describe("MCP write faces + rc fidelity (0.114.26)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-mcp-write-"));
    const boot = (args: string[]) =>
      new Promise<void>((res, rej) => {
        const r = spawn(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-write-spec" } as any });
        r.on("close", (c) => (c === 0 ? res() : rej(new Error(`boot ${args.join(" ")} rc=${c}`))));
      });
    await boot(["db", "init"]);
    await boot(["project", "new", "p1"]); // 研究写面严格闸：无 selection 时拒写
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("tools/list exposes exactly 11 tools incl. the three write faces", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/list");
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(11);
    for (const w of ["research_write", "tree_write", "verify"]) expect(names).toContain(w);
    c.kill();
  }, 60_000);

  it("research_write is idempotent (same content → same id, duplicate:true)", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const a1 = await c.send("tools/call", { name: "research_write", arguments: { action: "query-add", text: "MCP 写面幂等测试" } });
    const a2 = await c.send("tools/call", { name: "research_write", arguments: { action: "query-add", text: "MCP 写面幂等测试" } });
    expect(a1.result.isError).toBeFalsy();
    const j1 = JSON.parse(a1.result.content[0].text);
    const j2 = JSON.parse(a2.result.content[0].text);
    expect(j2.id).toBe(j1.id);
    expect(j2.duplicate).toBe(true);
    c.kill();
  }, 60_000);

  it("#68-① source-add passes --title flag (not positional) — title survives, not URL fallback", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "research_write",
      arguments: { action: "source-add", text: "我的来源标题", b: "https://example.com/mcp-src" },
    });
    expect(r.result.isError).toBeFalsy();
    const j = JSON.parse(r.result.content[0].text);
    expect(j.title).toBe("我的来源标题"); // 不是 URL 兜底
    expect(j.url).toBe("https://example.com/mcp-src");
    c.kill();
  }, 60_000);

  it("#68-② verify submit maps title and text-file separately (not path-as-title)", async () => {
    // 写一个临时材料文件
    const { writeFileSync } = await import("node:fs");
    const matFile = join(home, "mat.txt");
    writeFileSync(matFile, "S1 账单金额不得为负。\nS2 每期须附原件。\n", "utf8");
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "verify",
      arguments: { action: "submit", a: "MCP 提交测试", b: matFile },
    });
    expect(r.result.isError, JSON.stringify(r.result)).toBeFalsy();
    const j = JSON.parse(r.result.content[0].text);
    expect(j.title).toBe("MCP 提交测试"); // title 是 a，不是文件路径截断
    expect(j.material_id).toMatch(/^mat_/);
    c.kill();
  }, 60_000);

  it("#68-③ verify prepare accepts db param (not silently missing → rc=2)", async () => {
    // 准备一个最小快照库 + candidates + reviews
    const { writeFileSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = join(home, "snap.db");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE bills (id TEXT PRIMARY KEY, amount_cents INTEGER)");
    db.exec("INSERT INTO bills VALUES ('b1', -5)");
    db.close();
    const clause = "账单金额不得为负。";
    const anchor = { quote: clause, locator: "material.txt#L1" };
    const candFile = join(home, "cand.json");
    writeFileSync(candFile, JSON.stringify({ candidates: [{
      source_clause: clause, anchor,
      checker: { type: "sql", fail_when: "rows>0", predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] } } },
    }] }));
    const revFile = join(home, "rev.json");
    writeFileSync(revFile, JSON.stringify({ reviews: [{
      source_clause: clause,
      findings: [
        { question: "faithful", verdict: "ok", reason: "逐字", anchor },
        { question: "decidable", verdict: "ok", reason: "可判", anchor },
        { question: "not-vacuous", verdict: "ok", reason: "非空", anchor },
      ],
    }] }));
    // 先 submit 拿 material-id
    const matFile = join(home, "mat-prepare.txt");
    writeFileSync(matFile, clause + "\n", "utf8");
    const c = mcpCall();
    await c.send("initialize");
    const sub = await c.send("tools/call", { name: "verify", arguments: { action: "submit", a: "prepare 测试", b: matFile } });
    const mid = JSON.parse(sub.result.content[0].text).material_id;
    // prepare with db
    const r = await c.send("tools/call", {
      name: "verify",
      arguments: { action: "prepare", a: mid, b: candFile, c: revFile, db: dbFile },
    });
    // prepare 可能 ready 也可能 needs-material（红队）——关键是 **不是 rc=2 usage**
    // （--db 缺失时的失败模式）
    const j = JSON.parse(r.result.content[0].text);
    const isError = r.result.isError === true;
    if (isError) {
      expect(j.rc).not.toBe(2); // 不是用法错误（--db 已透传）
      expect(String(j.error)).not.toMatch(/--db snapshot not found/);
    } else {
      expect(j.verdict).toBeTruthy(); // ready 或 needs-material
    }
    c.kill();
  }, 60_000);

  it("rc fidelity: runtime error (rc=1) → isError:true + machine-readable {rc, error}", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "research_write",
      arguments: { action: "claim-resolve", text: "nosuchclaim00" },
    });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(j.rc).toBe(1);
    expect(String(j.error)).toMatch(/claim not found/);
    c.kill();
  }, 60_000);

  it("unknown action (schema bypass) → isError with usage-style message", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "tree_write",
      arguments: { action: "node-flatten" },
    });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(String(j.error)).toMatch(/unknown action/);
    c.kill();
  }, 60_000);
});
