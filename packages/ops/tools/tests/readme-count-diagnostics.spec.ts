import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the production count gate in the real shell, without replaying unrelated CLI examples.
const root = process.cwd();
const source = readFileSync(join(root, "scripts/readme-verify.sh"), "utf8");
const marker = 'if [ "${README_UNIT_COUNT_GATE:-1}" != "0" ]; then';
const start = source.indexOf(marker);
const gate = source.slice(start);

describe.skipIf(process.platform === "win32")("README count diagnostics under /bin/bash set -u", () => {
  it.each([{ readme: 2, status: 1 }, { readme: 1, status: 0 }])("README=$readme, measured=1 returns $status with a complete diagnostic", ({ readme, status }) => {
    expect(start).toBeGreaterThan(0);
    mkdirSync(join(root, "tmp"), { recursive: true });
    const home = mkdtempSync(join(root, "tmp/readme-count-diagnostic-"));
    try {
      writeFileSync(join(home, "README.md"), "vitest " + readme + " 例");
      const version = spawnSync("/bin/bash", ["--version"], { encoding: "utf8" });
      expect(version.status).toBe(0);
      if (process.platform === "darwin") expect(version.stdout).toContain("version 3.2");
      // Only the embedded vitest producer is substituted; parsing, comparison, output and exit are production code.
      // UTF-8 is essential: C locale masks the old Bash 3.2 variable-boundary failure.
      const script = "set -u\nN=0\nF=0\nnode() { printf '      Tests  1 passed (1)\\n'; }\n" + gate;
      const result = spawnSync("/bin/bash", ["-c", script], {
        cwd: home, env: { ...process.env, LC_ALL: "en_US.UTF-8", README_UNIT_COUNT_GATE: "1", TMPDIR: home }, encoding: "utf8", timeout: 10000,
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.stderr).not.toContain("unbound variable");
      expect(result.status, result.stdout + result.stderr).toBe(status);
      const logs = readdirSync(join(home, "tmp")).filter(n => n.startsWith("readme-count-vitest-"));
      if (status) {
        expect(result.stdout).toContain("unit 计数漂移: README=2 vitest=1（run: pnpm readme:count）");
        expect(result.stdout).toContain("完整输出：tmp/readme-count-vitest-");
        expect(result.stdout).toContain("readme-verify: 0/1 通过");
        expect(logs).toHaveLength(1); // drift keeps the round's log for diagnosis
      } else {
        expect(result.stdout).toContain("unit 计数门锚: README 1 == vitest 1");
        expect(result.stdout).toContain("readme-verify: 1/1 通过");
        expect(logs).toEqual([]); // a passing gate leaves nothing under tmp/
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

function runDiagnostic(program: string, files: Record<string, string>, producer: string) {
  mkdirSync(join(root, "tmp"), { recursive: true });
  const home = mkdtempSync(join(root, "tmp/readme-failure-diagnostic-"));
  try {
    for (const [file, body] of Object.entries(files)) writeFileSync(join(home, file), body);
    const version = spawnSync("/bin/bash", ["--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    if (process.platform === "darwin") expect(version.stdout).toContain("version 3.2");
    const result = spawnSync("/bin/bash", ["-c", "set -u\nN=0\nF=0\nnode() { " + producer + "\n}\n" + program], {
      cwd: home, env: { ...process.env, LC_ALL: "en_US.UTF-8", README_UNIT_COUNT_GATE: "1", TMPDIR: home }, encoding: "utf8", timeout: 10000,
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain("unbound variable");
    return result;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe.skipIf(process.platform === "win32")("README version and producer-failure diagnostics under Bash 3.2 UTF-8", () => {
  it.each([{ version: "0.126.0", status: 1 }, { version: "0.127.0", status: 0 }])("llms version $version produces a complete diagnostic and returns $status", ({ version, status }) => {
    const from = source.indexOf("# llms.txt 发布面新鲜度");
    const to = source.indexOf("# #75: unit 计数门锚");
    const end = source.indexOf('echo "readme-verify:');
    expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from); expect(end).toBeGreaterThan(to);
    // Execute the production version check and final refusal, substituting only the package-version producer.
    const result = runDiagnostic(source.slice(from, to) + source.slice(end), { "llms.txt": "# ygl-trees v" + version + "\n" }, "printf '0.127.0\\n'");
    expect(result.status, result.stdout + result.stderr).toBe(status);
    if (status) {
      expect(result.stdout).toContain("llms.txt 版本头 ≠ v0.127.0（run: ygl-trees llms 刷新后提交）");
      expect(result.stdout).toContain("readme-verify: 0/1 通过");
    } else {
      expect(result.stdout).toContain("llms.txt 版本头 = v0.127.0");
      expect(result.stdout).toContain("readme-verify: 1/1 通过");
    }
  });

  it("keeps an embedded vitest failure, its summary and failing test name in the refusal diagnostic", () => {
    expect(start).toBeGreaterThan(0);
    const result = runDiagnostic(gate, { "README.md": "vitest 3 例" }, "printf '      Tests  1 failed | 2 passed (3)\\n FAIL synthetic-count-fixture\\n'; return 7");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("unit 计数门：内嵌 vitest rc=7（");
    expect(result.stdout).toContain("1 failed | 2 passed (3)");
    expect(result.stdout).toContain("README=3 vitest=3；失败用例：");
    expect(result.stdout).toContain("synthetic-count-fixture");
    expect(result.stdout).toContain("完整输出：tmp/readme-count-vitest-");
    expect(result.stdout).toContain("readme-verify: 0/1 通过");
  });
});
