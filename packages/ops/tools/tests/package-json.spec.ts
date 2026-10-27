/**
 * GitHub #20: `package.json` carried two `prepublishOnly` keys (JSON last-wins),
 * so the release chain silently dropped the older `pnpm test && pnpm pack:check`
 * gate and kept only the tag guard. This guard scans the pretty-printed file for
 * duplicate keys per object depth and pins the single merged release chain.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const RAW = readFileSync(resolve(REPO, "package.json"), "utf8");

function duplicateKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    // a key line at the current depth: "key": ...
    const m = /^"([^"]+)"\s*:/.exec(trimmed);
    if (m) {
      const cur = stack[stack.length - 1];
      if (!cur) continue;
      if (cur.has(m[1])) dups.push(m[1]);
      cur.add(m[1]);
    }
    for (let i = 0; i < opens; i++) stack.push(new Set());
    for (let i = 0; i < closes; i++) stack.pop();
  }
  return dups;
}

describe("#20 package.json release-chain integrity", () => {
  it("has no duplicate keys in any object", () => {
    expect(duplicateKeys(RAW)).toEqual([]);
  });

  it("single prepublishOnly chains tag guard + test + pack:check", () => {
    const keys = RAW.match(/"prepublishOnly"/g) ?? [];
    expect(keys).toHaveLength(1);
    const chain = JSON.parse(RAW).scripts.prepublishOnly as string;
    // G12（#98 同批）：shell 链经 run-sh.mjs 钉解释器（bash -c 在 win/cmd 下仍漂 PATH——实证 WSL），链序不变
    expect(chain).toBe('node scripts/run-sh.mjs "node scripts/prepublish-guard.mjs && pnpm test && pnpm pack:check"');
    expect(chain.indexOf("prepublish-guard")).toBeLessThan(chain.indexOf("pnpm test"));
  });
});
