/**
 * GitHub #49: mechanical missing-argument sweep. Every verb with a required
 * positional must fail closed with rc=2 and ONE JSON error object — never a
 * driver-level leak (`Unsupported type for binding …`, `skill not found:
 * undefined`, or a silent rc=0/rc=1 read).
 *
 * The table is the command-surface inventory: adding a verb with a required
 * positional means adding a row here (same discipline as llms/help).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "" },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** [command path without args, human label] */
const VERBS: Array<[string[], string]> = [
  // config / db
  [["config", "get"], "config get <key>"],
  [["config", "set"], "config set <key> <value>"],
  [["config", "reset"], "config reset <key>"],
  [["db", "export"], "db export <file.sql>"],
  [["db", "sync"], "db sync pg <url>"],
  [["db", "migrate"], "db migrate pg <url>"],
  [["db", "sql"], "db sql <sql>"],
  // skill
  [["skill", "import"], "skill import <file.md>"],
  [["skill", "show"], "skill show <name>"],
  [["skill", "rm"], "skill rm <name>"],
  [["skill", "enable"], "skill enable <name>"],
  [["skill", "disable"], "skill disable <name>"],
  [["skill", "match"], "skill match <query>"],
  [["skill", "refs", "add"], "skill refs add <skill> <path>"],
  [["skill", "refs", "show"], "skill refs show <skill> <path>"],
  // project
  [["project", "new"], "project new <name>"],
  [["project", "use"], "project use <name>"],
  // research
  [["research", "query", "add"], "research query add <text>"],
  [["research", "query", "attach"], "research query attach <qid> <sid>"],
  [["research", "query", "done"], "research query done <qid>"],
  [["research", "source", "fetch"], "research source fetch <url>"],
  [["research", "source", "show"], "research source show <id>"],
  [["research", "source", "rm"], "research source rm <id>"],
  [["research", "evidence", "add"], "research evidence add <sourceId>"],
  [["research", "evidence", "show"], "research evidence show <id>"],
  [["research", "evidence", "assess"], "research evidence assess <id>"],
  [["research", "evidence", "rm"], "research evidence rm <id>"],
  [["research", "claim", "add"], "research claim add <text>"],
  [["research", "claim", "link"], "research claim link <claimId> <evidenceId>"],
  [["research", "claim", "unlink"], "research claim unlink <claimId> <evidenceId>"],
  [["research", "claim", "resolve"], "research claim resolve <claimId>"],
  [["research", "claim", "unresolve"], "research claim unresolve <claimId>"],
  [["research", "claim", "evaluate"], "research claim evaluate <claimId>"],
  [["research", "claim", "show"], "research claim show <id>"],
  // verify
  [["verify", "submit"], "verify submit --title <t> --text <file>"],
  [["verify", "prepare"], "verify prepare <material-id>"],
  [["verify", "run"], "verify run <spec-id> --db <snapshot>"],
  [["verify", "graduate"], "verify graduate <spec-id>"],
  [["verify", "register"], "verify register <sealed-binary>"],
  [["verify", "signature"], "verify signature <sealed-binary>"],
  [["verify", "report"], "verify report <run-id>"],
  [["verify", "trace"], "verify trace <spec-id>"],
  [["verify", "export"], "verify export <spec-id>"],
  [["verify", "archive"], "verify archive <run-id|spec-id>"],
  [["verify", "archive", "verify"], "verify archive verify <file>"],
  [["verify", "lint-candidates"], "verify lint-candidates <file>"],
  // job / patrol
  [["job", "add"], "job add <title>"],
  [["job", "run"], "job run <id|title>"],
  [["job", "enable"], "job enable <id|title>"],
  [["job", "disable"], "job disable <id|title>"],
  [["patrol", "add"], "patrol add <title>"],
  [["patrol", "enable"], "patrol enable <id>"],
  [["patrol", "disable"], "patrol disable <id>"],
  // produce / task
  [["produce", "section"], "produce section <title>"],
  [["produce", "spec"], "produce spec <title>"],
  [["produce", "design"], "produce design <title>"],
  [["produce", "task-add"], "produce task-add <title>"],
  [["produce", "show"], "produce show <artifactId>"],
  [["produce", "export"], "produce export <artifactId>"],
  [["task", "add"], "task add <title>"],
  [["task", "todo"], "task todo <id>"],
  [["task", "doing"], "task doing <id>"],
  [["task", "done"], "task done <id>"],
  // tree / node
  [["tree", "new"], "tree new <name>"],
  [["tree", "use"], "tree use <name>"],
  [["node", "add"], "node add <key>"],
  [["node", "link"], "node link <parent> <child>"],
  [["node", "unlink"], "node unlink <parent> <child>"],
  [["node", "move"], "node move <key>"],
  [["node", "cond"], "node cond <key>"],
  [["node", "can"], "node can <key>"],
  [["node", "path"], "node path <key>"],
  // kb / rel
  [["kb", "show"], "kb show <key>"],
  [["kb", "link"], "kb link <note-a> <note-b>"],
  [["kb", "ingest"], "kb ingest <artifactId>"],
  [["rel", "add"], "rel add <type:ref> <type:ref>"],
];

describe.skipIf(!HAS_BIN)("missing-argument sweep (#49)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-missing-args-"));
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
    expect(run(["tree", "new", "t"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  for (const [args, label] of VERBS) {
    it(`${label} → rc=2 single usage-shaped JSON error`, () => {
      const r = run(args);
      expect(r.rc, `${label}\n${r.out}${r.err}`).toBe(2);
      expect(r.j, label).toBeTruthy();
      expect(typeof r.j?.error, label).toBe("string");
      expect(String(r.j.error), label).not.toMatch(/Unsupported type for binding|not found: undefined/);
      expect(r.err, label).toBe("");
    });
  }
});
