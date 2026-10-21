#!/usr/bin/env node
/**
 * Release-order guard (GitHub #17): refuse to publish when the release tag is
 * missing from HEAD or from the remote.
 *
 * 0.110.0 shipped with npm published ~3.5 minutes BEFORE the annotated tag
 * existed. The tag ended up anchored correctly, but the window in which
 * "latest on npm" had no tag to point at is exactly the kind of drift that
 * cannot be detected after the fact.
 *
 * Two entry points, because npm only runs lifecycle hooks for directory
 * publishes — our release flow publishes an exact-bytes tarball (`npm publish
 * <tgz>`), which does NOT execute `prepublishOnly`:
 *   - package.json `prepublishOnly` → dir-publish backstop
 *   - release SOP: run `node scripts/prepublish-guard.mjs --remote <name>`
 *     before `npm publish <tgz>`
 *
 * Usage: node scripts/prepublish-guard.mjs [--remote <git-remote>] [--no-network] [--json]
 * rc: 0 tag anchored (and remote present when asked) · 1 guard violation · 2 usage
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const remoteFlag = args.indexOf("--remote");
const noNetwork = args.includes("--no-network");
const asJson = args.includes("--json");
const root = resolve(process.cwd());

function die(message, rc = 1) {
  if (asJson) console.log(JSON.stringify({ ok: false, version, tag, error: message }));
  else console.error(`prepublish-guard: ${message}`);
  process.exit(rc);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (e) {
  console.error(`prepublish-guard: cannot read package.json under ${root}: ${e?.message || e}`);
  process.exit(1);
}
const version = String(pkg.version ?? "");
const tag = `v${version}`;
if (!version) die("package.json has no version");

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", timeout: 20_000 }).trim();
const tryGit = (...a) => {
  try {
    return { ok: true, out: git(...a) };
  } catch (e) {
    return { ok: false, out: String(e?.stderr || e?.message || e) };
  }
};

const headR = tryGit("rev-parse", "HEAD");
if (!headR.ok) die(`not a git worktree: ${headR.out}`);
const head = headR.out;
const tagsR = tryGit("tag", "--points-at", "HEAD");
if (!tagsR.ok) die(`git tag --points-at HEAD failed: ${tagsR.out}`);
const tagsAtHead = tagsR.out.split("\n").map((s) => s.trim()).filter(Boolean);
if (!tagsAtHead.includes(tag)) {
  die(
    `${tag} does not point at HEAD (${head.slice(0, 12)}). Tags here: ${tagsAtHead.join(", ") || "(none)"}. ` +
      `Create the annotated tag first: git tag -a ${tag} ${head} -m "${tag}"`,
  );
}

if (remoteFlag >= 0) {
  const remote = args[remoteFlag + 1];
  if (!remote || remote.startsWith("-")) die("usage: --remote <git-remote> (e.g. origin)", 2);
  if (!noNetwork) {
    const remoteR = tryGit("ls-remote", remote, `refs/tags/${tag}`);
    if (!remoteR.ok) die(`cannot verify remote '${remote}' (offline? retry with --no-network): ${remoteR.out}`);
    if (!remoteR.out) die(`${tag} is not on remote '${remote}' yet — push it before publishing: git push ${remote} ${tag}`);
  }
}

if (asJson) console.log(JSON.stringify({ ok: true, version, tag, head }));
else console.log(`prepublish-guard: ok — ${tag} anchored at ${head.slice(0, 12)}`);
