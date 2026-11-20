import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const repo = resolve(__dirname, "../../..");
let root: string;
beforeAll(() => {
  mkdirSync(join(repo, "tmp"), { recursive: true }); root = mkdtempSync(join(repo, "tmp/skill-library-"));
  mkdirSync(join(root, "skills", "library"), { recursive: true });
  writeFileSync(join(root, "skills", "library", "SKILL.md"), [
    "# Library examples", "", "```bash", "ygl-trees library list --kind claim --json", "```", "",
    "Select a project with `library list --kind claim --project no-such-project --json`.", "",
  ].join("\n"));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe("library command literals participate in the skill truth gate", () => {
  it("executes both fenced and inline library examples rather than silently skipping them", () => {
    const result = spawnSync(process.execPath, [join(repo, "scripts/skills-audit.mjs"), "--skills", join(root, "skills"), "--json"], {
      cwd: repo, encoding: "utf8", timeout: 60000,
      env: { ...process.env, YGL_NO_UPDATE_CHECK: "1", YGL_DB_URL: "", YGL_PG_URL: "", YGL_PROJECT: "" },
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ checked: 2, rejected: 0, findings: [] });
  });
});
