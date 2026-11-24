import { describe, expect, it } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const source = readFileSync(join(root, "examples/demo.sh"), "utf8");
const cases = [
  { name: "too few cold-start skills", marker: "冷启动技能数：", variable: "NS", value: "3", status: 1, text: "冷启动技能数：3（期望 ≥9）" },
  { name: "enough cold-start skills", marker: "冷启动技能数：", variable: "NS", value: "9", status: 0, text: "冷启动内置技能自动导入（9 个，agent match 即可用）" },
  { name: "session source success echo", marker: "selection_source=", variable: "SRC", value: "session", status: 0, text: "project use 写会话键放行（selection_source=session）" },
  { name: "non-session source rejection", marker: "selection_source=", variable: "SRC", value: "other", status: 1, text: "use/select: src=other" },
  { name: "unknown-group wrong return code", marker: "未知组 rc=", variable: "UG", value: "1", status: 1, text: "未知组 rc=1（期望 2）" },
  { name: "unknown-group expected return code", marker: "未知组 rc=", variable: "UG", value: "2", status: 0, text: "未知组退出码契约 rc=2（干净用法错误）" },
  { name: "disabled-group wrong return code", marker: "disable 后 rc=", variable: "DG", value: "1", status: 1, text: "disable 后 rc=1（期望 2）" },
  { name: "disabled-group expected return code", marker: "disable 后 rc=", variable: "DG", value: "2", status: 0, text: "plugin disable 后命令组不可达（且仍是干净 rc=2）" },
];

describe.skipIf(process.platform === "win32")("demo diagnostics under real Bash 3.2 UTF-8 set -u", () => {
  it.each(cases)("$name retains its diagnostic and exit $status", item => {
    const lines = source.split(/\r?\n/).filter(line => line.includes(item.marker));
    expect(lines).toHaveLength(1);
    mkdirSync(join(root, "tmp"), { recursive: true });
    const home = mkdtempSync(join(root, "tmp/demo-shell-diagnostic-"));
    try {
      const version = spawnSync("/bin/bash", ["--version"], { encoding: "utf8" });
      expect(version.status).toBe(0);
      if (process.platform === "darwin") expect(version.stdout).toContain("version 3.2");
      // Inject only producer values and the claim-list CLI; execute the actual production conditional unchanged.
      const program = ["set -u", "Y=demo_cli", 'demo_cli() { [ "$*" = "research claim list --json" ]; }',
        "NS=9", "SRC=session", "UG=2", "DG=2", item.variable + "=$1", lines[0]].join("\n");
      const result = spawnSync("/bin/bash", ["-c", program, "demo-diagnostics", item.value], {
        cwd: home, env: { ...process.env, LC_ALL: "en_US.UTF-8", TMPDIR: home }, encoding: "utf8", timeout: 10000,
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain("unbound variable");
      expect(result.status, result.stdout + result.stderr).toBe(item.status);
      expect(result.stdout).toContain(item.text);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
