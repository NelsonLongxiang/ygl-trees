/**
 * User-level plugin distribution (spec R14 L3, 0.36.0) — DSH apps/cli exemplar:
 *
 * - profile at $YGL_HOME/plugins/ (pnpm-managed package, the DSH profile)
 * - $YGL_HOME/ygl.user.bundle.json declares the user layer over ygl.bundle.json
 * - install/remove mutate the profile under withFileLock (dsh-atomic-write,
 *   the same primitive DSH's `dsh plugin` uses on the profile package.json)
 * - installed-name resolution = dep-key DIFF before/after pnpm (no heuristics)
 * - a plugin may declare `"yglTrees": "^0.36.0"` in its package.json; a
 *   mismatch warns at load (never refuses — forward-compatible by default)
 *
 * Plugin contract (a business domain ships exactly this shape):
 *   exports.apply    — Cordis plugin body: apply(ctx, config)  (optional)
 *   exports.commands — { <group>: { run(env, action, rest, args) → rc } }  (optional)
 *
 * @module @ygl/ops-tools/plugins
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";

export interface UserPluginSpec {
  /** npm package name (resolvable from the profile's node_modules) */
  name: string;
  /** original install spec, kept for display */
  spec: string;
  /** Config handed to the plugin's apply(ctx, config). Absent → {}. */
  config?: Record<string, unknown>;
  /** false → entry stays in the bundle but is not mounted (disable without uninstalling). */
  enabled?: boolean;
}

export interface LoadedUserPlugin {
  name: string;
  apply?: (ctx: any, config?: any) => void;
  /** Config from the bundle entry (loader Entry-option parity, adopted without the loader). */
  config?: Record<string, unknown>;
  commands?: Record<string, { run: (env: any, action: string, rest: string[], args: any) => number | Promise<number> }>;
  /** yglTrees compatibility declared by the plugin; undefined = unconstrained */
  compat?: string;
}

export interface PluginIssue {
  name: string;
  error: string;
}

export function profileDir(home: string): string {
  return path.join(home, "plugins");
}

export function userBundleFile(home: string): string {
  return path.join(home, "ygl.user.bundle.json");
}

const PROFILE_PKG = () => ({
  name: "ygl-user-plugins",
  private: true,
  version: "0.0.0",
  description: "ygl-trees user plugin profile (spec R14 L3)",
});

/** Create the plugin profile package. Idempotent. */
export function initProfile(home: string): void {
  const dir = profileDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify(PROFILE_PKG(), null, 2) + "\n", "utf8");
  }
  if (!fs.existsSync(path.join(dir, ".npmrc"))) {
    fs.writeFileSync(path.join(dir, ".npmrc"), "auto-install-peers=false\n", "utf8");
  }
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        "# 用户插件 profile（spec R14 L3）",
        "",
        "本目录是 ygl-trees 工作区的插件仓（pnpm 管理）。安装的插件由",
        "`../ygl.user.bundle.json` 声明，启动时叠加在 base 组合之上。",
        "",
        "```bash",
        "ygl-trees plugin install <npm 包 | git 地址 | 本地目录（自动 link:）>",
        "ygl-trees plugin list          # 版本 / spec / 可解析态",
        "ygl-trees plugin remove <name>",
        "```",
        "",
        "插件契约与完整指南：docs/plugin-authoring.md（仓库内）。",
        "示例插件：examples/plugin-demo（仓库内）。",
        "",
        "注意：插件代码以进程全权限运行——只装你信任的包。",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

function readProfileDeps(home: string): Record<string, string> {
  const pkgFile = path.join(profileDir(home), "package.json");
  if (!fs.existsSync(pkgFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(pkgFile, "utf8")).dependencies || {};
  } catch {
    return {};
  }
}

export function readUserBundle(home: string): UserPluginSpec[] {
  const f = userBundleFile(home);
  if (!fs.existsSync(f)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(j.plugins)) return [];
    return j.plugins
      .filter((p: any) => p && typeof p.name === "string")
      .map((p: any) => {
        const out: UserPluginSpec = { name: p.name, spec: p.spec || p.name };
        if (p.config && typeof p.config === "object") out.config = p.config;
        if (p.enabled === false) out.enabled = false;
        return out;
      });
  } catch {
    return [];
  }
}

export function writeUserBundle(home: string, specs: UserPluginSpec[]): void {
  fs.writeFileSync(userBundleFile(home), JSON.stringify({ plugins: specs }, null, 2) + "\n", "utf8");
}

function pnpm(home: string, args: string[]): void {
  // packageManager is installation-owned (DSH exemplar): overridable for
  // embedded/offline carriers without touching this module. PATH may carry
  // broken .bin shims (observed: a parent node_modules shim pointing at a
  // missing pnpm.cjs under vitest) — resolve by probing, not first-hit.
  //
  // --ignore-workspace: pnpm walks UP from --dir to the nearest
  // pnpm-workspace.yaml. When the profile lives inside a workspace (the unit
  // tests' tmp/ profiles — or any repo-embedded home), the profile registered
  // as a workspace importer and leaked tmp/plugins-unit-* blocks into the
  // repo lockfile (committed that way through 0.66.0). Standalone profiles
  // (the real $YGL_HOME) are outside any workspace, so this flag is a no-op
  // there. Requires pnpm >= 9.4.
  const pm = process.env.YGL_PACKAGE_MANAGER || "pnpm";
  if (process.platform === "win32") {
    const q = (s: string) => `"${String(s).replace(/["&|<>^]/g, "")}"`;
    const exe = resolvePm(pm);
    execFileSync([q(exe), ...args.map(q), "--dir", q(profileDir(home)), "--ignore-workspace"].join(" "), { stdio: "pipe", shell: true });
    return;
  }
  execFileSync(pm, [...args, "--dir", profileDir(home), "--ignore-workspace"], { stdio: "pipe" });
}

let cachedPm: string | null | undefined;
function resolvePm(pm: string): string {
  if (cachedPm !== undefined) return cachedPm || pm;
  cachedPm = null;
  try {
    const where = execFileSync("where", [pm], { stdio: "pipe", shell: true }).toString().split(/\r?\n/).filter(Boolean);
    for (const candidate of where) {
      try {
        execFileSync([q2(candidate), "--version"].join(" "), { stdio: "pipe", shell: true });
        cachedPm = candidate;
        return candidate;
      } catch { /* broken shim — try next */ }
    }
  } catch { /* where failed — fall through to bare name */ }
  return pm;
}
const q2 = (s: string) => `"${String(s).replace(/["&|<>^]/g, "")}"`;

/** Install under the profile lock; name = dep-key diff (exact, no guessing).
 *  Idempotent: re-installing a bundled plugin returns its existing entry. */
export async function installPlugin(home: string, spec: string): Promise<{ name: string; spec: string }> {
  initProfile(home);
  const abs = path.resolve(spec);
  const installSpec = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? `link:${abs}` : spec;
  const existing = readUserBundle(home).find((p) => p.spec === installSpec || p.spec === spec);
  if (existing) return existing; // already installed — idempotent
  const before = new Set(Object.keys(readProfileDeps(home)));
  return withFileLock(path.join(profileDir(home), "package.json"), async () => {
    pnpm(home, ["add", installSpec]);
    const after = Object.keys(readProfileDeps(home));
    const added = after.filter((k) => !before.has(k));
    if (added.length !== 1) throw new Error(`expected exactly one new dependency, got: ${added.join(", ") || "(none)"}`);
    const name = added[0];
    const bundle = readUserBundle(home);
    if (!bundle.some((p) => p.name === name)) {
      bundle.push({ name, spec: installSpec });
      writeUserBundle(home, bundle);
    }
    return { name, spec: installSpec };
  });
}

export async function removePlugin(home: string, name: string): Promise<void> {
  const bundle = readUserBundle(home);
  if (!bundle.some((p) => p.name === name)) throw new Error(`plugin not in user bundle: ${name}`);
  await withFileLock(path.join(profileDir(home), "package.json"), async () => {
    pnpm(home, ["remove", name]);
    writeUserBundle(home, bundle.filter((p) => p.name !== name));
  });
}

/** Profile contents + bundle composition (for `plugin list` / doctor). */
/** Flip an installed entry's `enabled` flag (keeps it installed). */
export function setPluginEnabled(home: string, name: string, enabled: boolean): UserPluginSpec {
  const bundle = readUserBundle(home);
  const entry = bundle.find((p) => p.name === name);
  if (!entry) throw new Error(`'${name}' is not in the user bundle (see: plugin list)`);
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  writeUserBundle(home, bundle);
  return entry;
}

/** Replace an entry's config block (what its apply(ctx, config) receives). */
export function setPluginConfig(home: string, name: string, config: Record<string, unknown>): UserPluginSpec {
  const bundle = readUserBundle(home);
  const entry = bundle.find((p) => p.name === name);
  if (!entry) throw new Error(`'${name}' is not in the user bundle (see: plugin list)`);
  if (config && Object.keys(config).length) entry.config = config;
  else delete entry.config;
  writeUserBundle(home, bundle);
  return entry;
}

export function listPlugins(home: string): { name: string; spec: string; version?: string; compat?: string; resolvable: boolean; enabled: boolean; has_config: boolean }[] {
  const bundle = readUserBundle(home);
  const dir = profileDir(home);
  return bundle.map((p) => {
    let version: string | undefined;
    let compat: string | undefined;
    let resolvable = false;
    try {
      const pkgJson = require.resolve(path.join(p.name, "package.json"), { paths: [dir] });
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      version = pkg.version;
      compat = pkg.yglTrees;
      require.resolve(p.name, { paths: [dir] });
      resolvable = true;
    } catch {
      /* unresolved */
    }
    return { name: p.name, spec: p.spec, version, compat, resolvable, enabled: p.enabled !== false, has_config: !!p.config };
  });
}

export interface UserLoadResult {
  plugins: LoadedUserPlugin[];
  issues: PluginIssue[];
}

/**
 * Load user plugins one-by-one, collecting per-plugin issues instead of
 * failing wholesale (DSH exemplar: startup diagnostics are per-entry). A
 * plugin without apply AND without commands loads as a no-op with a warning.
 */
export function loadUserPlugins(home: string): UserLoadResult {
  const dir = profileDir(home);
  if (!fs.existsSync(dir)) return { plugins: [], issues: [] };
  const plugins: LoadedUserPlugin[] = [];
  const issues: PluginIssue[] = [];
  for (const p of readUserBundle(home)) {
    if (p.enabled === false) continue; // disabled entries stay installed, just not mounted
    try {
      const mod = require(require.resolve(p.name, { paths: [dir] }));
      if (typeof mod.apply !== "function" && !mod.commands) {
        issues.push({ name: p.name, error: "exports neither apply() nor commands — nothing to load" });
        continue;
      }
      let compat: string | undefined;
      try {
        compat = JSON.parse(fs.readFileSync(require.resolve(path.join(p.name, "package.json"), { paths: [dir] }), "utf8")).yglTrees;
      } catch { /* unconstrained */ }
      plugins.push({ name: p.name, apply: mod.apply, config: p.config, commands: mod.commands, compat });
    } catch (e: any) {
      issues.push({ name: p.name, error: String(e?.message || e) });
    }
  }
  return { plugins, issues };
}
