/**
 * #66: webui task status machine must be server-authoritative —
 * a stale page cannot drag a done task back to doing.
 * Fix: POST /api/task re-reads the STORED status and only allows
 * forward (todo→doing→done) or idempotent same-status; backward → 409.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let home = "";
let server: ReturnType<typeof spawn> | null = null;
let port = 0;

function startServer(): Promise<void> {
  return new Promise((res, rej) => {
    // find a free port
    const net = require("node:net") as typeof import("node:net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      port = (s.address() as any).port;
      s.close(() => {
        server = spawn(process.execPath, [BIN, "webui", "serve", "--port", String(port)], {
          env: { ...process.env, YGL_HOME: home, YGL_SESSION: "task-sm-spec", YGL_SERVE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        const onOut = (d: Buffer) => { if (!settled && d.toString().includes("dashboard live")) { settled = true; res(); } };
        (server as any).stdout.on("data", onOut);
        (server as any).stderr.on("data", onOut);
        setTimeout(() => rej(new Error("server did not start")), 10_000);
      });
    });
  });
}

function post(path: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
  return new Promise((res) => {
    const data = JSON.stringify(body);
    const req = require("node:http") as typeof import("node:http");
    const r = req.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (resp: any) => {
      let out = "";
      resp.on("data", (d: Buffer) => (out += d));
      resp.on("end", () => {
        try { res({ status: resp.statusCode, json: JSON.parse(out), text: out }); }
        catch { res({ status: resp.statusCode, json: null, text: out }); }
      });
    });
    r.write(data);
    r.end();
  });
}

describe.skipIf(!HAS_BIN)("#66 webui task status machine (server-authoritative)", () => {
  let taskId = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-task-sm-"));
    const boot = (args: string[]) =>
      new Promise<void>((res, rej) => {
        const r = spawn(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, YGL_HOME: home, YGL_SESSION: "task-sm-spec" } as any });
        r.on("close", (c) => (c === 0 ? res() : rej(new Error(`boot ${args.join(" ")} rc=${c}`))));
      });
    await boot(["db", "init"]);
    await boot(["project", "new", "p1"]);
    // create a task
    const r = spawnSync(process.execPath, [BIN, "task", "add", "状态机测试", "-p", "p1", "--json"], {
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "task-sm-spec" }, encoding: "utf8",
    });
    taskId = (JSON.parse(r.stdout) as any).id;
    await startServer();
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    // Windows: give the server process a moment to release file handles
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  });

  it("forward: todo → doing → done works normally", async () => {
    const doing = await post("/api/task", { id: taskId, status: "doing" });
    expect(doing.status).toBe(200);
    const done = await post("/api/task", { id: taskId, status: "done" });
    expect(done.status).toBe(200);
  });

  it("stale page: done → doing is rejected 409 (server-authoritative)", async () => {
    const r = await post("/api/task", { id: taskId, status: "doing" });
    expect(r.status).toBe(409);
    expect(r.json.current_status).toBe("done");
    expect(r.json.expected_next).toBe("done");
  });

  it("idempotent: done → done accepted (same status, NO state advance)", async () => {
    const r = await post("/api/task", { id: taskId, status: "done" });
    expect(r.status).toBe(200);
    expect(r.json.idempotent).toBe(true);
    expect(r.json.from).toBe("done");
    expect(r.json.to).toBe("done"); // true idempotent — not advanced
  });

  it("#70: todo → todo is true idempotent (NOT advanced to doing)", async () => {
    // 新建一个 todo 任务
    const r0 = spawnSync(process.execPath, [BIN, "task", "add", "幂等不推进测试", "-p", "p1", "--json"], {
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "task-sm-spec" }, encoding: "utf8",
    });
    const tid = (JSON.parse(r0.stdout) as any).id;
    // 发送 status=todo（与当前同）——不应推进到 doing
    const r = await post("/api/task", { id: tid, status: "todo" });
    expect(r.status).toBe(200);
    expect(r.json.idempotent).toBe(true);
    expect(r.json.from).toBe("todo");
    expect(r.json.to).toBe("todo"); // #70 修复前：错误推进到 doing
  });
}, 60_000);
