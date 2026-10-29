import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shellQuote } from "../src/shell";
import { resolveCommand } from "../src/Pipeline";

/**
 * #101 (P1) / G13: the copied `claim resolve` command put the project name in
 * bare, so pasting it for a project named `x;touch /tmp/pwn` ran `touch`. Every
 * free-text argument now goes through one POSIX single-quote helper, always
 * (review of 4ca51fd: zsh expands a bare leading `=`), and the project rides as
 * `--project=<value>` so a leading dash cannot turn into a flag.
 */

describe("shellQuote always single-quotes", () => {
  it("quotes even plain-looking values, writing a quote as '\\''", () => {
    expect(shellQuote("d8a2eef159")).toBe("'d8a2eef159'");
    expect(shellQuote("x;touch /tmp/pwn")).toBe("'x;touch /tmp/pwn'");
    expect(shellQuote("a$(id)")).toBe("'a$(id)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("my proj")).toBe("'my proj'");
    expect(shellQuote("=ls")).toBe("'=ls'");
    expect(shellQuote("--global")).toBe("'--global'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("resolveCommand — the exact clipboard text (#101, G13)", () => {
  const head = "ygl-trees research claim resolve 'c1' --as supported";
  const cases: Array<[string, string]> = [
    ["x;touch /tmp/pwn", `${head} --project='x;touch /tmp/pwn'`],
    ["a$(id)", `${head} --project='a$(id)'`],
    ["it's", `${head} --project='it'\\''s'`],
    ["my proj", `${head} --project='my proj'`],
    ["=ls", `${head} --project='=ls'`],
    ["--global", `${head} --project='--global'`],
  ];
  for (const [project, text] of cases) {
    it(`project ${JSON.stringify(project)}`, () => {
      expect(resolveCommand("c1", "supported", project)).toBe(text);
    });
  }

  it("quotes the claim id too, and leaves the project out when there is none", () => {
    expect(resolveCommand("c 1;id", "refuted")).toBe("ygl-trees research claim resolve 'c 1;id' --as refuted");
  });
});

const HOSTILE = ["x;touch PWNED", "a$(touch PWNED2)", "it's", "my proj", "`touch PWNED3`", "q\"d'q", "nl\ntouch PWNED4", "=ls", "--global", "~root", "*", "!!"];
// The list is fixed and each case skips on its own, so every platform registers
// the same cases: filtering the list made them vanish from the total (#108).
const ALL_SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash"];
const hasShell = (sh: string) => process.platform !== "win32" && existsSync(sh);
const SHELLS = ALL_SHELLS.filter(hasShell);

/**
 * Hand the copied text to each shell with `ygl-trees` swapped for a printer of
 * its arguments. Every hostile name must arrive as ONE argument, byte for byte,
 * and nothing in it may run (no file appears in the probe dir).
 */
describe("pasted into real shells (sh, zsh, bash)", () => {
  for (const sh of ALL_SHELLS) {
    for (const project of HOSTILE) {
      it.skipIf(!hasShell(sh))(`${sh}: ${JSON.stringify(project)} arrives intact and runs nothing`, () => {
        const dir = mkdtempSync(join(tmpdir(), "ygl-quote-"));
        try {
          const line = resolveCommand("c1", "supported", project).replace(/^ygl-trees /, "printf '%s\\n' ");
          const r = spawnSync(sh, ["-c", line], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: dir } });
          expect(r.status, r.stderr).toBe(0);
          expect(r.stdout).toBe(["research", "claim", "resolve", "c1", "--as", "supported", `--project=${project}`].join("\n") + "\n");
          expect(readdirSync(dir)).toEqual([]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

/**
 * End to end: the pasted command, run by zsh against the built CLI, resolves the
 * claim in the project the page named — `--global` and `=ls` included.
 */
const BIN = resolve(__dirname, "../../../dist/bundle/bin.cjs");
const ZSH = SHELLS.find((s) => s.endsWith("zsh")) ?? SHELLS[0];
describe.skipIf(!SHELLS.length || !existsSync(BIN))("pasted command drives the real CLI", () => {
  for (const project of ["--global", "=ls", "my proj"]) {
    it(`${JSON.stringify(project)}: the claim in that project is resolved`, () => {
      const home = mkdtempSync(join(tmpdir(), "ygl-quote-cli-"));
      const env = { ...process.env, YGL_HOME: home, YGL_NO_UPDATE_CHECK: "1" };
      const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a, "--json"], { env, encoding: "utf8" });
      try {
        expect(cli("db", "init").status).toBe(0);
        expect(cli("project", "new", "--", project, "-q", "q").status).toBe(0);
        const claim = JSON.parse(cli("research", "claim", "add", "可验证的断言", `--project=${project}`).stdout);
        const line = resolveCommand(claim.id, "supported", project).replace(/^ygl-trees /, `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} `);
        const r = spawnSync(ZSH, ["-c", `${line} --json`], { env, encoding: "utf8" });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        const list = JSON.parse(cli("research", "claim", "list", `--project=${project}`).stdout) as Array<{ id: string; status: string }>;
        expect(list.find((c) => c.id === claim.id)?.status).toBe("supported");
      } finally {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});
