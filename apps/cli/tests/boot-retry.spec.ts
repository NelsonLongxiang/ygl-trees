import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const boot = vi.hoisted(() => vi.fn());
vi.mock("../src/profile-boot", () => ({ bootApp: boot }));
import { main } from "../src/bin";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); boot.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
describe("CLI boot requires confirmed cleanup before retrying", () => {
  it.each([undefined, false, true])("honors dbOpenCleanupComplete=%s after a SQLite lock failure", async confirmed => {
    mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
    const home = mkdtempSync(join(process.cwd(), "tmp/boot-retry-")); roots.push(home);
    writeFileSync(join(home, "ygl-trees.db"), "not opened by the mocked boot");
    vi.stubEnv("YGL_DB_URL", "");
    const primary = new Error("database is locked: original boot"), terminal = new Error("second boot reached");
    if (confirmed !== undefined) Object.defineProperty(primary, "dbOpenCleanupComplete", { value: confirmed });
    boot.mockRejectedValueOnce(primary).mockRejectedValue(terminal);
    const output: string[] = []; vi.spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect(await main(["db", "path", "--home", home, "--json"])).toBe(1);
    expect(boot).toHaveBeenCalledTimes(confirmed === true ? 2 : 1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]).error).toContain(confirmed === true ? terminal.message : primary.message);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
  });
});
