import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../src/shell";
import { resolveCommand } from "../src/Pipeline";

/**
 * #101 (P1): the copied `claim resolve` command put the project name in bare,
 * so pasting a command for a project named `x;touch /tmp/pwn` ran `touch`.
 * Every data argument now goes through one POSIX single-quote helper.
 */

describe("shellQuote", () => {
  it("leaves plainly safe values bare so ordinary ids and names stay readable", () => {
    expect(shellQuote("d8a2eef159")).toBe("d8a2eef159");
    expect(shellQuote("jf-expert-agents-taste")).toBe("jf-expert-agents-taste");
  });

  it("single-quotes anything else, writing a quote as '\\''", () => {
    expect(shellQuote("x;touch /tmp/pwn")).toBe("'x;touch /tmp/pwn'");
    expect(shellQuote("a$(id)")).toBe("'a$(id)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("my proj")).toBe("'my proj'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("中文项目")).toBe("'中文项目'");
  });
});

describe("resolveCommand — the exact clipboard text (#101)", () => {
  const cases: Array<[string, string]> = [
    ["x;touch /tmp/pwn", "ygl-trees research claim resolve c1 --as supported -p 'x;touch /tmp/pwn'"],
    ["a$(id)", "ygl-trees research claim resolve c1 --as supported -p 'a$(id)'"],
    ["it's", "ygl-trees research claim resolve c1 --as supported -p 'it'\\''s'"],
    ["my proj", "ygl-trees research claim resolve c1 --as supported -p 'my proj'"],
  ];
  for (const [project, text] of cases) {
    it(`project ${JSON.stringify(project)}`, () => {
      expect(resolveCommand("c1", "supported", project)).toBe(text);
    });
  }

  it("quotes the claim id too, and leaves out -p when there is no project", () => {
    expect(resolveCommand("c 1;id", "refuted")).toBe("ygl-trees research claim resolve 'c 1;id' --as refuted");
  });
});

/**
 * The real proof: hand the copied text to /bin/sh with `ygl-trees` swapped for
 * a printer of its arguments. Each hostile name must arrive as ONE argument,
 * byte for byte, and nothing in it may run (no file appears in the probe dir).
 */
describe.skipIf(process.platform === "win32" || !existsSync("/bin/sh"))("pasted into a real POSIX shell", () => {
  const hostile = ["x;touch PWNED", "a$(touch PWNED2)", "it's", "my proj", "`touch PWNED3`", "q\"d'q", "nl\ntouch PWNED4"];

  for (const project of hostile) {
    it(`${JSON.stringify(project)} arrives intact and runs nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ygl-quote-"));
      try {
        const line = resolveCommand("c1", "supported", project).replace(/^ygl-trees /, "printf '%s\\n' ");
        const r = spawnSync("/bin/sh", ["-c", line], { cwd: dir, encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(["research", "claim", "resolve", "c1", "--as", "supported", "-p", project].join("\n") + "\n");
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
