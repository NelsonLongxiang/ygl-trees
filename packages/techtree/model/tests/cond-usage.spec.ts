/**
 * 0.89.1（direct-b1de0e86，预测席上报）：`node cond <key> --op eval --value q`
 * 缺 --name 时旧行为落进 list 模式——"(empty)" + rc=0 + 零落账，成功形回执
 * 掩盖 no-op（与单2 unlink 同族）。修复：add 形 flags 无 --name → usage rc=2；
 * 裸 `node cond <key>` 仍是 list（rc=0）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const BIN = path.join(REPO, "dist", "bundle", "bin.cjs");
const has = fs.existsSync(BIN);
const d = describe.skipIf(!has);

let home: string;

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, YGL_HOME: home, YGL_EVAL_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { rc: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(process.cwd(), "tmp", "cond-usage-"));
  run(["db", "init"]);
  run(["project", "new", "cu"]);
  run(["tree", "new", "cu-t"]);
  run(["node", "add", "base", "-t", "cu-t"]);
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

d("node cond add 形 flags 缺 --name（0.89.1）", () => {
  it("--op eval --value q 无 --name → usage rc=2，不落账", () => {
    const r = run(["node", "cond", "base", "-t", "cu-t", "--op", "eval", "--value", "probe q"]);
    expect(r.rc).toBe(2);
    expect(r.out).toMatch(/condition add requires --name/);
    expect(r.out).not.toMatch(/\(empty\)/);
  });

  it("--value n 无 --name → usage rc=2（比较形同样算 add 形）", () => {
    const r = run(["node", "cond", "base", "-t", "cu-t", "--op", ">=", "--value", "3"]);
    expect(r.rc).toBe(2);
  });

  it("裸 `node cond <key>` 仍是 list（rc=0）", () => {
    const r = run(["node", "cond", "base", "-t", "cu-t"]);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/\(empty\)/);
  });

  it("带 --name 正常添加不受影响", () => {
    const r = run(["node", "cond", "base", "-t", "cu-t", "--name", "c1", "--kind", "flag", "--op", "eval", "--value", "q"]);
    expect(r.rc).toBe(0);
    const l = run(["node", "cond", "base", "-t", "cu-t"]);
    expect(l.out).toMatch(/c1/);
  });
});
