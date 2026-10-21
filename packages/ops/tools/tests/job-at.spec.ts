/** job add --at 解析回归（0.84.1）：Windows npm shim 会把带空格的值再切分，
 * 尾式裸 `--at YYYY-MM-DD HH:MM` 必须跨平台可解析；前置 flag 式在直调
 * （无 shim）路径下也必须进 flags.at。spawn 发布产物，scratch home。 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = resolve(__dirname, "../../../.."); // packages/ops/tools/tests -> repo root
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_EVAL_OFFLINE: "1" },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

beforeAll(() => {
  HOME = mkdtempSync(resolve(tmpdir(), "ygl-jobat-"));
  run(["db", "init"]);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("job add --at", () => {
  it("尾式裸日期时间（shim 再切分形态）解析为一次性计划", () => {
    const r = run([
      "job", "add", "at-tail-bare",
      "--", "echo", "hi", "--at", "2026-10-31", "09:00",
    ]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("2026-10-31 09:00"); // schedule 打印出 at
    expect(r.stdout).not.toMatch(/command:.*--at/); // --at 不残留在命令里
  });

  it("尾式引号形态仍可解析", () => {
    const r = run([
      "job", "add", "at-tail-quoted",
      "--", "echo", "hi", "--at", '"2026-11-01 08:30"',
    ]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("2026-11-01 08:30");
    expect(r.stdout).not.toMatch(/command:.*--at/);
  });

  it("前置 flag 式（无 shim 直调）进 flags.at，command 干净", () => {
    const r = run([
      "job", "add", "at-leading",
      "--at", "2026-12-02 10:15",
      "--", "echo", "hi",
    ]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("2026-12-02 10:15");
    expect(r.stdout).toContain("command:  echo hi");
  });
});

describe("workerSessionId (K3 0.106.0)", () => {
  it("scopes a job run under its parent session and chains nested workers", async () => {
    const { workerSessionId } = await import("../src/job-cmds");
    expect(workerSessionId("job_1", "sess")).toBe("sess/job_1");
    // a worker that itself ticks another job keeps the whole chain traceable
    expect(workerSessionId("job_2", "sess/job_1")).toBe("sess/job_1/job_2");
    const prev = process.env.YGL_SESSION;
    process.env.YGL_SESSION = "env-sid";
    try {
      expect(workerSessionId("job_3")).toBe("env-sid/job_3");
    } finally {
      if (prev === undefined) delete process.env.YGL_SESSION; else process.env.YGL_SESSION = prev;
    }
  });

  it("plain shell parents under the selection bucket (default), never the actor fallback (cli)", async () => {
    const { workerSessionId } = await import("../src/job-cmds");
    const prevSid = process.env.YGL_SESSION;
    const prevDsh = process.env.DSH_SESSION_ID;
    delete process.env.YGL_SESSION;
    delete process.env.DSH_SESSION_ID;
    try {
      // GitHub #7 余项: `project use` in a plain shell writes
      // current_project@default, so the worker chain must start at "default";
      // "cli" is the audit-actor bucket and has no selection key.
      expect(workerSessionId("job_plain")).toBe("default/job_plain");
      expect(workerSessionId("job_plain")).not.toBe("cli/job_plain");
    } finally {
      if (prevSid === undefined) delete process.env.YGL_SESSION; else process.env.YGL_SESSION = prevSid;
      if (prevDsh === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = prevDsh;
    }
  });
});
