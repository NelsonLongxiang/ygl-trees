/**
 * The task buttons against the REAL server (review of e879e43): the client and
 * server specs each mocked the other, so #67's request body and #70's server
 * contract drifted apart with every test green. Here the page's own code —
 * stepTarget() for the body, advanceTask() for the call, stepOutcome() for the
 * toast — drives `webui serve` from the built bundle over HTTP.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { advanceTask } from "../src/api";
import { stepOutcome, stepTarget } from "../src/Tasks";

const REPO = resolve(__dirname, "../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let home = "";
let server: ChildProcess | null = null;
let base = "";
const realFetch = globalThis.fetch;

const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    env: { ...process.env, YGL_HOME: home, YGL_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${args.join(" ")} rc=${r.status}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout || "null");
};
const addTask = (title: string): string => cli("task", "add", title, "-p", "p1").id;
const stored = (id: string): string =>
  (cli("task", "list", "-p", "p1") as Array<{ id: string; status?: string; meta?: string }>)
    .map((t) => ({ id: t.id, status: t.status ?? JSON.parse(t.meta || "{}").status }))
    .find((t) => t.id === id)!.status;

/** What a click does: body from the status on screen, call through the client. */
const click = (id: string, onScreen: string) => advanceTask(id, stepTarget(onScreen)!);

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as any).port;
      s.close(() => res(port));
    });
  });

describe.skipIf(!HAS_BIN)("task buttons ↔ real webui serve (bundle)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-web-task-"));
    cli("db", "init");
    cli("project", "new", "p1");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [BIN, "webui", "serve", "--port", String(port)], {
      env: { ...process.env, YGL_HOME: home, YGL_PROJECT: "p1", YGL_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("webui serve did not start")), 10_000);
      const onOut = (d: Buffer) => { if (d.toString().includes("dashboard live")) { clearTimeout(t); res(); } };
      server!.stdout!.on("data", onOut);
      server!.stderr!.on("data", onOut);
    });
    // the client calls relative "api/task" like the page does; resolve it against the live server
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => realFetch(`${base}/${url}`, init));
  }, 30_000);

  afterAll(() => {
    vi.unstubAllGlobals();
    server?.kill();
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("开始 then 完成 really move the stored task, and the toast says so", async () => {
    const id = addTask("真实服务端：开始再完成");
    const r1 = await click(id, "todo");
    expect(stepOutcome("t", r1).changed).toBe(true);
    expect(stored(id)).toBe("doing");
    const r2 = await click(id, "doing");
    expect(stepOutcome("t", r2).changed).toBe(true);
    expect(stored(id)).toBe("done");
  });

  it("a page one step behind gets a no-change receipt, not a success toast", async () => {
    const id = addTask("真实服务端：页面落后一步");
    cli("task", "doing", id, "-p", "p1"); // agent moved it; the page still shows 待办
    const r = await click(id, "todo");
    expect(stepOutcome("t", r).changed).toBe(false);
    expect(stored(id)).toBe("doing");
  });

  it("a page two steps behind is refused with the server's words, and the task stays done", async () => {
    const id = addTask("真实服务端：页面落后两步");
    cli("task", "done", id, "-p", "p1"); // page still shows 待办 → asks for doing
    const err = await click(id, "todo").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("is 'done'");
    expect((err as Error).message).not.toMatch(/^\{/);
    expect(stored(id)).toBe("done");
  });
});
