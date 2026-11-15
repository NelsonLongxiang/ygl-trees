import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

/** Only the cwd is neutral. Every CLI fixture must still supply its own absolute YGL_HOME and inputs. */
export function neutralCwd(): string {
  const root = parse(resolve(__dirname, "../..")).root;
  for (const marker of [".git", "AGENTS.md", "verify/meta.json", "verify/specs"]) {
    if (existsSync(join(root, marker))) throw new Error("fixture cwd is not neutral: " + root);
  }
  return root;
}

/** A real empty repository stops discovery at this fixture, never at the enclosing project. */
export function initFixtureRepo(directory: string): void {
  const parent = realpathSync(resolve(__dirname, "../../tmp")), target = realpathSync(directory);
  const child = relative(parent, target);
  if (!child || child.startsWith("..") || isAbsolute(child) || lstatSync(directory).isSymbolicLink() || existsSync(join(target, ".git"))) {
    throw new Error("expected an owned, new project-tmp repository fixture: " + directory);
  }
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: target, encoding: "utf8", timeout: 15000 });
    if (r.error || r.signal || r.status !== 0) throw new Error("fixture Git failed: " + (r.error?.message ?? r.stderr));
    return r.stdout.trim();
  };
  run(["-c", "init.defaultBranch=fixture", "init", "--quiet", "--template="]);
  if (realpathSync(run(["rev-parse", "--show-toplevel"])) !== target) throw new Error("fixture Git root differs from the owned directory");
}
