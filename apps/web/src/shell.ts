/**
 * Every argument of a command this page puts on the clipboard goes through
 * here (#101). The page never runs commands, but the expert pastes them into a
 * shell: a project name like `x;touch /tmp/pwn` or `a$(id)` would run the
 * injected part, and `my proj` would split into two arguments.
 *
 * POSIX single quotes: nothing inside them is special, and a quote itself is
 * written `'\''` (close, escaped quote, reopen). A value made only of plainly
 * safe characters is left bare so ordinary ids and names stay readable.
 */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value: string): string {
  if (SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
