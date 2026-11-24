import { describe, expect, it } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
      if (status) {
        expect(result.stdout).toContain("unit 计数漂移: README=2 vitest=1（run: pnpm readme:count）");
        expect(result.stdout).toContain("readme-verify: 0/1 通过");
      } else {
        expect(result.stdout).toContain("unit 计数门锚: README 1 == vitest 1");
        expect(result.stdout).toContain("readme-verify: 1/1 通过");
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
