import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const ROOT = resolve(__dirname, "../../../..");

describe("#168 bundle configuration boundary", () => {
  it("builds identical clone bytes with and without an executable parent decoy", () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const base = mkdtempSync(join(ROOT, "tmp/bundle-config-")), repo = join(base, "repo");
    const run = (command: string, args: string[], cwd: string) => {
      const r = spawnSync(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status, r.stdout + r.stderr).toBe(0);
      return r.stdout + r.stderr;
    };
    const bytes = (dir: string, prefix = ""): Record<string, string> => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => e.isDirectory()
      ? Object.entries(bytes(join(dir, e.name), prefix + e.name + "/"))
      : [[prefix + e.name, createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")]]));
    try {
      run("git", ["clone", "--quiet", "--shared", ROOT, repo], ROOT);
      // Exercise the working script, including a not-yet-committed repair, against cloned source.
      writeFileSync(join(repo, "package.json"), readFileSync(join(ROOT, "package.json")));
      const config = readFileSync(join(ROOT, "tsdown.config.mjs"), "utf8");
      writeFileSync(join(repo, "tsdown.config.mjs"), config);
      symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const build = () => run(process.execPath, [join(ROOT, "scripts/run-sh.mjs"), "pnpm build:bundle:only"], repo);
      const firstLog = build(), first = bytes(join(repo, "dist/bundle"));
      expect(Object.keys(first)).toContain("bin.cjs");
      writeFileSync(join(base, "tsdown.config.mjs"), "import {writeFileSync} from 'node:fs';writeFileSync(new URL('./decoy-loaded',import.meta.url),'executed');export default {minify:true};");
      const secondLog = build(), second = bytes(join(repo, "dist/bundle"));
      expect(secondLog).not.toContain(join(base, "tsdown.config.mjs"));
      expect(existsSync(join(base, "decoy-loaded"))).toBe(false);
      expect(second).toEqual(first);
      const configLine = (log: string) => log.split(/\r?\n/).filter(line => line.includes("config file:"));
      expect(configLine(firstLog)).toHaveLength(1);
      expect(configLine(secondLog)).toHaveLength(1);
      expect(configLine(firstLog)[0].replaceAll("\\", "/")).toContain(repo.replaceAll("\\", "/") + "/tsdown.config.mjs");
      expect(configLine(secondLog)[0].replaceAll("\\", "/")).toContain(repo.replaceAll("\\", "/") + "/tsdown.config.mjs");
      const minifiedSize = readFileSync(join(repo, "dist/bundle/bin.cjs")).length;
      writeFileSync(join(repo, "tsdown.config.mjs"), config.replace("minify: true", "minify: false"));
      build();
      expect(bytes(join(repo, "dist/bundle"))).not.toEqual(first);
      expect(readFileSync(join(repo, "dist/bundle/bin.cjs")).length).toBeGreaterThan(minifiedSize);
      expect(existsSync(join(base, "decoy-loaded"))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 180000);
});
