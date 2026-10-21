/**
 * Release-input guard shared by `scripts/pack-repro.mjs`.
 *
 * 0.110.0 incident: the handoff tarball was produced from a working tree that
 * still carried another session's uncommitted `docs/doc-governance.md` (and an
 * old CRLF checkout). `pnpm pack` copies the `files:` entries FROM THE WORKTREE,
 * so the "reproducible" bytes silently depended on local dirt. Official release
 * bytes must come from a clean checkout + that checkout's own build.
 */
import { execFileSync } from "node:child_process";

/** Paths that make the worktree unclean (tracked changes + untracked, not ignored). */
export function dirtyPaths(root) {
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""));
}

/** Throw unless the worktree is clean (or the caller explicitly opts into dirt). */
export function assertCleanTree(root, { allowDirty = false } = {}) {
  const dirty = dirtyPaths(root);
  if (dirty.length && !allowDirty) {
    const shown = dirty.slice(0, 10).join("\n  ");
    throw new Error(
      `pack:repro refuses to seal bytes from a dirty worktree (${dirty.length} path(s)):\n  ${shown}` +
        (dirty.length > 10 ? `\n  … ${dirty.length - 10} more` : "") +
        `\nOfficial release bytes require: fresh worktree at the release commit + that tree's own build.` +
        `\nUse --allow-dirty only for local experiments (never for a published tarball).`,
    );
  }
  return dirty;
}
