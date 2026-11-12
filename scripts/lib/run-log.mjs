/**
 * Log handle for G8's child processes (#178).
 *
 * G8 (`scripts/post-release-check.mjs`) wires a child's stdout and stderr
 * straight to a log file descriptor. That fd used to come from
 * `openSync(file, "a")`. On Windows, libuv opens O_APPEND files with
 * FILE_APPEND_DATA access only (no FILE_WRITE_DATA). Node and cmd write to
 * such a handle fine, but MSYS/Git-bash builtins fail on it silently, rc 1.
 * In the tag-clone `pnpm test` chain the first bash builtin to write stdout is
 * `examples/demo.sh`'s opening `echo`, under `set -e`, so demo died before its
 * first line, with no error text (that write failed too). Every test was
 * green and the chain still exited 1.
 *
 * Each G8 log name is used once per run inside a fresh mkdtemp WORK
 * directory, so truncating is safe: open with "w".
 */
import { openSync } from "node:fs";

/** A write-mode fd every child (node, cmd, MSYS bash) can write to. */
export function openLog(file) {
  return openSync(file, "w");
}
