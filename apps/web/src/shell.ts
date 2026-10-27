/**
 * Every free-text argument of a command this page puts on the clipboard goes
 * through here (#101, G13). The page never runs commands, but the expert pastes
 * them into a shell: a project named `x;touch /tmp/pwn` or `a$(id)` would run
 * the injected part, `my proj` would split in two, and zsh (macOS's default)
 * expands a leading `=` — `=ls` becomes /bin/ls (review of 4ca51fd).
 *
 * So: always POSIX single quotes, no "looks safe" shortcut. Nothing inside
 * them is special in sh, bash or zsh; a quote itself is written `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
