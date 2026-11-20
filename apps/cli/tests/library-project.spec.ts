import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { main, groupHelp, generateLlmsManifest } from "../src/bin";
import { LIBRARY_LIST_USAGE, LIBRARY_PROJECT_HELP } from "../../../packages/ops/tools/src/library-usage";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe("library project usage before workspace startup", () => {
  it("exposes the same project contract in group help and the capability manifest", () => {
    for (const text of [groupHelp("library"), generateLlmsManifest()]) {
      expect(text).toContain(LIBRARY_LIST_USAGE); expect(text).toContain(LIBRARY_PROJECT_HELP);
    }
  });
  it.each(["claim", "note", "skill", "check"])("rejects bare --project before opening the missing workspace (%s)", async kind => {
    mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); const root = mkdtempSync(join(process.cwd(), "tmp/library-project-cli-")); roots.push(root);
    const home = join(root, "unopened"), output: string[] = [];
    vi.stubEnv("YGL_DB_URL", ""); vi.spyOn(console, "log").mockImplementation(j => { output.push(String(j)); }); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["library", "list", "--kind", kind, "--project", "--home", home, "--json"])).toBe(2);
    expect(output).toHaveLength(1); expect(JSON.parse(output[0]).error).toMatch(/project.*value|project.*name/); expect(existsSync(home)).toBe(false);
  });
  it("rejects an explicit empty project before opening the workspace", async () => {
    mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); const root = mkdtempSync(join(process.cwd(), "tmp/library-project-cli-")); roots.push(root);
    const home = join(root, "unopened"), output: string[] = []; vi.stubEnv("YGL_DB_URL", "");
    vi.spyOn(console, "log").mockImplementation(j => { output.push(String(j)); }); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["library", "list", "--kind", "claim", "--project=", "--home", home, "--json"])).toBe(2);
    expect(output).toHaveLength(1); expect(JSON.parse(output[0]).error).toMatch(/project.*value|project.*name/); expect(existsSync(home)).toBe(false);
  });
});
