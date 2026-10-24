/**
 * The task buttons against the REAL server (review of e879e43): the client and
 * server specs each mocked the other, so #67's request body and #70's server
 * contract drifted apart with every test green. Here the page's own code —
 * stepTarget() for the body, advanceTask() for the call, stepOutcome() for the
 * toast — drives `webui serve` from the built bundle over HTTP.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { advanceTask } from "../src/api";
import { stepOutcome, stepTarget } from "../src/Tasks";

const REPO = resolve(__dirname, "../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
// Never a silent skip (review of f92bfa3): no bundle → skip, said out loud, and red under
// YGL_REQUIRE_BUNDLE=1 (same switch as YGL_REQUIRE_RUST); a bundle that exists but cannot even
// print its version is always red — `pnpm test` builds first, so that is the case it can hit.
const BIN_PRESENT = existsSync(BIN);
const version = BIN_PRESENT ? spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }) : null;
if (version && version.status !== 0) {
  throw new Error(`${BIN} exists but \`--version\` exited ${version.status}: ${version.stderr || version.stdout}`);
}
const HAS_BIN = BIN_PRESENT;
const SKIP_WHY = HAS_BIN ? "" : `${BIN} is missing — run: pnpm build`;
if (!HAS_BIN) {
  if (process.env.YGL_REQUIRE_BUNDLE === "1") throw new Error(`YGL_REQUIRE_BUNDLE=1 but ${SKIP_WHY}`);
  // raw stderr: vitest drops console output from a file whose suites all skip
  process.stderr.write(`\n[task-bundle.spec] SKIPPED — the task buttons were NOT checked against a real server: ${SKIP_WHY}\n\n`);
}

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

describe.skipIf(!HAS_BIN)(`task buttons ↔ real webui serve (bundle)${SKIP_WHY && ` — SKIPPED: ${SKIP_WHY}`}`, () => {
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

  afterAll(async () => {
    vi.unstubAllGlobals();
    server?.kill();
    // Windows: server process needs a moment to release file handles before rmSync
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 5; i++) {
      try { if (home) rmSync(home, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
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

  it("a page ahead of the server (CLI stepped the task back) gets 409 on 完成, and the reset stands", async () => {
    const id = addTask("真实服务端：CLI 退回后点完成");
    cli("task", "doing", id, "-p", "p1"); // the page shows 进行中
    cli("task", "todo", id, "-p", "p1"); // agent steps it back; the page has not caught up
    const err = await click(id, "doing").catch((e: Error) => e); // 完成 asks for done
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("is 'todo'");
    expect(stored(id)).toBe("todo");
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
