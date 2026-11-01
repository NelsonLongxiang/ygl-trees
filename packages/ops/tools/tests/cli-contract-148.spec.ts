/**
 * #148 CLI contract gaps — spawn-based spec against the REAL bundle.
 *   ④ every group's unknown-action path under --json writes exactly one
 *     {"error"} object to stdout (no trailing human usage line), rc=2;
 *   ⑤ `node add` rejects unknown flags (rc=2, nothing written);
 *   claim link receipts name the real reason auto-promote was skipped;
 *   `skill link` from a cwd with no skills/ links the installed package's skills;
 *   `job --help` shows the job block (it used to be swallowed by patrol).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const BIN = path.join(REPO, "dist/bundle/bin.cjs");

let home: string;
let cwd: string;

function run(args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? cwd,
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "spec-148", YGL_TEST: "1", NO_COLOR: "1", YGL_EVAL_OFFLINE: "1" },
  });
  return { rc: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

function firstId(args: string[], pick: (rows: any[]) => any = (rows) => rows[0]): string {
  return pick(JSON.parse(run([...args, "--json"]).stdout)).id;
}

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error("dist/bundle/bin.cjs missing — run pnpm build first");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-148-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-148-cwd-"));
  for (const a of [["db", "init"], ["project", "new", "p", "-q", "q"], ["tree", "new", "t"]]) {
    expect(run(a).rc).toBe(0);
  }
});

afterAll(() => {
  for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("#148 contract ④: unknown action under --json is one {error} object", () => {
  const GROUPS = ["config", "db", "skill", "project", "research", "verify", "produce", "task", "kb", "job",
    "patrol", "tree", "node", "webui", "rel", "plugin", "agent"];
  for (const g of GROUPS) {
    it(`${g} __bogus__ --json`, () => {
      const r = run([g, "__bogus__", "--json"]);
      expect(r.rc).toBe(2);
      const parsed = JSON.parse(r.stdout);
      expect(typeof parsed.error).toBe("string");
    });
  }
});

describe("#148 contract ⑤: node add rejects unknown flags", () => {
  it("--title is a usage error and writes nothing", () => {
    const r = run(["node", "add", "k-title", "--title", "T", "--json"]);
    expect(r.rc).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/unknown flag.*--title/);
    const list = JSON.parse(run(["node", "list", "--json"]).stdout) as any[];
    expect(list.some((n) => n.key === "k-title")).toBe(false);
  });
  it("known flags still work", () => {
    const r = run(["node", "add", "k-ok", "--name", "全称", "--tier", "1", "--json"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout).name).toBe("全称");
  });
});

describe("#148 claim link receipt names the lock reason", () => {
  it("arbitrated vs prediction", () => {
    expect(run(["research", "source", "add", "--url", "https://example.com/148", "--title", "S"]).rc).toBe(0);
    const sid = firstId(["research", "source", "list"]);
    expect(run(["research", "evidence", "add", sid, "--quote", "q148"]).rc).toBe(0);
    const eid = firstId(["research", "evidence", "list"]);

    expect(run(["research", "claim", "add", "普通断言 148"]).rc).toBe(0);
    const cid = firstId(["research", "claim", "list"], (rows) => rows.find((c: any) => c.text === "普通断言 148"));
    expect(run(["research", "claim", "resolve", cid, "--as", "contested"]).rc).toBe(0);
    const plain = run(["research", "claim", "link", cid, eid]);
    expect(plain.rc).toBe(0);
    expect(plain.stdout).toMatch(/arbitrated claim stays contested/);
    expect(plain.stdout).not.toMatch(/prediction/);

    expect(run(["research", "claim", "add", "[预测·7天] 2099-01-01 前 树≥1"]).rc).toBe(0);
    const pid = firstId(["research", "claim", "list"], (rows) => rows.find((c: any) => c.text.startsWith("[预测")));
    const pred = run(["research", "claim", "link", pid, eid]);
    expect(pred.rc).toBe(0);
    expect(pred.stdout).toMatch(/prediction claim stays/);
  });
});

describe("#148 help / skill link", () => {
  it("job add --help shows the job block, not patrol's", () => {
    const r = run(["job", "add", "--help"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toMatch(/add <title> \[--every <min>/);
    expect(r.stdout).not.toMatch(/boundary assertions/);
  });
  it("skill link outside a repo links the installed package's skills", () => {
    const r = run(["skill", "link", "--json"]);
    expect(r.rc).toBe(0);
    const linked = fs.readdirSync(path.join(cwd, ".agents", "skills"));
    expect(linked).toContain("ygl-trees-quickstart");
  });
});
