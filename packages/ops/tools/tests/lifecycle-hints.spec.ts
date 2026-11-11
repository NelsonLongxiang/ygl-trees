/**
 * #233: the lifecycle rules reach the moment of action. A read-only audit found 167 of 267 unlocked nodes with no
 * evidence, claim, source, artifact or kb behind them while doctor passed. These tests pin the four places that now
 * say so: the node command receipts (next_actions), the node import receipt, doctor `node_evidence`, and agent brief.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { attachEvidenceAction, groupByTree, reindexActions, shellWord } from "../../../techtree/model/src/evidence-gap";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");

describe("evidence-gap helpers (#233)", () => {
  it("shellWord keeps a hostile name on one line and inside one shell word", () => {
    const w = shellWord("t'1;$(touch x)\nnext");
    expect(w).toBe("'t'\\''1;$(touch x)\\nnext'");
    expect(w).not.toContain("\n");
    expect(attachEvidenceAction("t1", "a")).toBe("ygl-trees rel add 'node:t1/a' evidence:<evidenceId> --rel evidenced-by");
    expect(reindexActions("t1")).toEqual(["ygl-trees node index --tree='t1'", "ygl-trees node validate --tree='t1'"]);
  });

  it("groupByTree counts per tree and keeps the keys in order", () => {
    expect(groupByTree([{ tree: "a", key: "x" }, { tree: "a", key: "y" }, { tree: "b", key: "z" }])).toEqual([
      { tree: "a", count: 2, keys: ["x", "y"] },
      { tree: "b", count: 1, keys: ["z"] },
    ]);
  });
});

describe("lifecycle hints in the CLI (#233)", () => {
  let home = "";
  const cli = (args: string[], json = true) => {
    const r = spawnSync(process.execPath, [BIN, ...args, ...(json ? ["--json"] : [])], {
      encoding: "utf8", timeout: 60000,
      env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_SESSION: "hints-test", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1", NO_COLOR: "1" },
    });
    expect(r.error, r.stderr).toBeUndefined();
    let out: any = null;
    try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* human face */ }
    return { rc: r.status, json: out, text: r.stdout + r.stderr };
  };
  const nodeEvidence = () => (cli(["doctor"]).json as any[]).find((c) => c.name === "node_evidence");
  let evidenceId = "";

  beforeAll(() => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/hints-"));
    for (const a of [["db", "init"], ["project", "new", "p"], ["tree", "new", "t1"]]) expect(cli(a).rc).toBe(0);
    const src = cli(["research", "source", "add", "--title", "S", "--url", "https://example.com/s"]).json;
    evidenceId = cli(["research", "evidence", "add", src.id, "--quote", "q"]).json.id;
  });
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("node add / link / rm name node index + node validate while the index is dirty; a duplicate add names nothing", () => {
    const add = cli(["node", "add", "a"]);
    expect(add.rc).toBe(0);
    expect(add.json.next_actions).toEqual(reindexActions("t1"));
    expect(cli(["node", "add", "b"]).json.next_actions).toEqual(reindexActions("t1"));
    const link = cli(["node", "link", "a", "b"]);
    expect(link.rc).toBe(0);
    expect(link.json.next_actions).toEqual(reindexActions("t1"));
    expect(cli(["node", "index"]).rc).toBe(0);
    const dup = cli(["node", "add", "a"]);
    expect(dup.json.duplicate).toBe(true);
    expect(dup.json.next_actions).toBeUndefined();
    expect(cli(["node", "add", "gone"]).rc).toBe(0);
    const rm = cli(["node", "rm", "gone"]);
    expect(rm.rc).toBe(0);
    expect(rm.json).toMatchObject({ removed: "gone", next_actions: reindexActions("t1") });
    expect(cli(["node", "index"]).rc).toBe(0);
  });

  it("the human face prints the same steps as dim next: lines", () => {
    const h = cli(["node", "add", "c"], false);
    expect(h.rc).toBe(0);
    expect(h.text).toContain("next: ygl-trees node index --tree='t1'");
    expect(h.text).toContain("next: ygl-trees node validate --tree='t1'");
    expect(cli(["node", "index"]).rc).toBe(0);
  });

  it("unlock with nothing behind the node names rel add; with evidence, or on lock, it names nothing", () => {
    const bare = cli(["node", "unlock", "a"]);
    expect(bare.rc).toBe(0);
    expect(bare.json).toMatchObject({ key: "a", status: "unlocked", next_actions: [attachEvidenceAction("t1", "a")] });
    expect(cli(["node", "unlock", "a"], false).text).toContain(`next: ${attachEvidenceAction("t1", "a")}`);

    expect(cli(["rel", "add", "node:t1/b", `evidence:${evidenceId}`, "--rel", "evidenced-by"]).rc).toBe(0);
    const backed = cli(["node", "unlock", "b"]);
    expect(backed.rc).toBe(0);
    expect(backed.json.next_actions).toBeUndefined();

    const lock = cli(["node", "lock", "c"]);
    expect(lock.rc).toBe(0);
    expect(lock.json.next_actions).toBeUndefined();
  });

  it("a task or another node is not evidence; a claim, source or kb note is", () => {
    const task = cli(["task", "add", "track c"]).json.id;
    expect(cli(["rel", "add", "node:t1/c", `task:${task}`]).rc).toBe(0);
    expect(cli(["node", "unlock", "c"]).json.next_actions).toEqual([attachEvidenceAction("t1", "c")]);
    const note = cli(["kb", "add", "why c", "--body", "because"]).json.id;
    expect(cli(["rel", "add", `kb:${note}`, "node:t1/c"]).rc).toBe(0);
    expect(cli(["node", "unlock", "c"]).json.next_actions).toBeUndefined();
  });

  it("doctor node_evidence warns with the count per tree and the keys; the suggested rel add clears it", () => {
    const warn = nodeEvidence();
    expect(warn).toMatchObject({ status: "warn", trees: [{ tree: "t1", count: 1 }], keys: ["t1/a"] });
    expect(warn.detail).toContain("1 unlocked node(s) without evidence: t1 1");

    const brief = cli(["agent", "brief"]).json;
    expect(brief.next_actions).toContain(`${attachEvidenceAction("t1", "a")}   # tree t1: 1 unlocked node(s) without evidence`);

    expect(cli(["rel", "add", "node:t1/a", `evidence:${evidenceId}`, "--rel", "evidenced-by"]).rc).toBe(0);
    expect(nodeEvidence()).toMatchObject({ status: "pass" });
    expect(nodeEvidence().keys).toBeUndefined();
    expect(cli(["agent", "brief"]).json.next_actions.join("\n")).not.toContain("without evidence");
  });

  it("node import reports unlocked_without_evidence for the target tree", () => {
    const file = join(home, "t1.json");
    expect(cli(["node", "export", "--out", file]).rc).toBe(0);
    const fresh = cli(["node", "import", "--file", file, "--tree", "t2"]);
    expect(fresh.rc).toBe(0);
    expect(fresh.json).toMatchObject({ tree: "t2", unlocked_without_evidence: 0 });
    expect(fresh.json.next_actions).toBeUndefined();

    expect(cli(["node", "unlock", "a", "-t", "t2"]).rc).toBe(0);
    const merged = cli(["node", "import", "--file", file, "--tree", "t2", "--merge"]);
    expect(merged.rc).toBe(0);
    expect(merged.json).toMatchObject({ tree: "t2", unlocked_without_evidence: 1, next_actions: [attachEvidenceAction("t2", "a")] });
    expect(cli(["node", "import", "--file", file, "--tree", "t3"], false).text).toMatch(/imported tree t3: .*conditions/);
  });
});
