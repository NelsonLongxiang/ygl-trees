#!/usr/bin/env node
/**
 * Release-order guard (GitHub #17): refuse to publish when the release tag is
 * missing from HEAD or the remote, or its commit is not on freshly fetched remote master.
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

let remote, remoteMaster;
let remoteVerified = false;
if (remoteFlag >= 0) {
  remote = args[remoteFlag + 1];
  if (!remote || remote.startsWith("-")) die("usage: --remote <git-remote> (e.g. origin)", 2);
  if (!noNetwork) {
    const known = tryGit("remote");
    if (!known.ok || !known.out.split("\n").includes(remote)) die(`unknown git remote: ${remote}`, 2);
    const remoteR = tryGit("ls-remote", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
    if (!remoteR.ok) die(`cannot verify remote '${remote}' (network required for release verification): ${remoteR.out}`);
    if (!remoteR.out) die(`${tag} is not on remote '${remote}' yet — push it before publishing: git push ${remote} ${tag}`);
    const remoteTags = new Map(remoteR.out.split("\n").map(line => { const [sha, ref] = line.trim().split(/\s+/); return [ref, sha]; }));
    const remoteTagCommit = remoteTags.get(`refs/tags/${tag}^{}`) || remoteTags.get(`refs/tags/${tag}`);
    if (remoteTagCommit !== head) die(`${tag} remote tag target ${remoteTagCommit || "(unknown)"} differs from local tag commit ${head}`);
    const masterRef = `refs/remotes/${remote}/master`;
    const fetched = tryGit("fetch", "--no-tags", remote, `+refs/heads/master:${masterRef}`);
    if (!fetched.ok) die(`${tag} commit ${head}: cannot freshly fetch ${remote}/master; remote master SHA unverified`);
    const masterR = tryGit("rev-parse", "--verify", `${masterRef}^{commit}`);
    if (!masterR.ok) die(`${tag} commit ${head}: remote master SHA unverified`);
    remoteMaster = masterR.out;
    if (!tryGit("merge-base", "--is-ancestor", head, remoteMaster).ok) {
      die(`${tag} commit ${head} is not an ancestor of ${remote}/master ${remoteMaster}; merge the release and push master before publishing`);
    }
    remoteVerified = true;
  }
}

if (asJson) console.log(JSON.stringify({ ok: true, version, tag, head, remote, remote_master: remoteMaster, remote_verified: remoteVerified }));
else console.log(`prepublish-guard: ok — ${tag} anchored at ${head.slice(0, 12)}; ${remoteVerified ? `ancestor of ${remote}/master ${remoteMaster}` : "local-only check, remote release order NOT verified"}`);
