/**
 * #44: selection-bucket signals and owner-named refusals.
 *  - F1: `project new` / `project use --json` expose selected/prior/session and
 *    a `selection_warning` when the write lands in the shared `default` bucket.
 *  - F2: an implicit selection that owns neither end of a cross-project claim
 *    link gets a `selection_note` (behaviour unchanged; the ruling is #45 D1-D3).
 *  - F3: id-addressed verbs refuse with the owning project's name.
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
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "", DSH_SESSION_ID: "", YGL_PROJECT: "" },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe.skipIf(!HAS_BIN)("#44 selection signals (0.114.7)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-sel44-"));
    expect(run(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("F1: project new --json names the selected bucket and warns when it is the shared default", () => {
    const p1 = run(["project", "new", "p1", "--json"]);
    expect(p1.rc).toBe(0);
    expect(p1.j.selected).toBe("p1");
    expect(p1.j.session).toBe("default");
    expect(p1.j.prior).toBeNull();
    expect(p1.j.selection_warning).toBeUndefined(); // single project: no other sid-less agent to disturb

    const p2 = run(["project", "new", "p2", "--json"]);
    expect(p2.rc).toBe(0);
    expect(p2.j.selected).toBe("p2");
    expect(p2.j.prior).toBe("p1");
    expect(p2.j.session).toBe("default");
    expect(String(p2.j.selection_warning)).toMatch(/shared "default" bucket/);
    expect(String(p2.j.selection_warning)).toMatch(/p1/);

    const use = run(["project", "use", "p1", "--json"]);
    expect(use.rc).toBe(0);
    expect(use.j.selected).toBe("p1");
    expect(use.j.prior).toBe("p2");
    expect(use.j.session).toBe("default");
    expect(String(use.j.selection_warning)).toMatch(/shared "default" bucket/);
  });

  it("K3 0.114.22: shared-bucket signals on tree use / query add / node add + doctor", () => {
    // p1/p2 already exist from F1; re-establish a bare-shell selection.
    expect(run(["project", "use", "p1", "--json"]).rc).toBe(0);
    expect(run(["tree", "new", "t1", "-p", "p1", "--json"]).rc).toBe(0);
    expect(run(["tree", "new", "t2", "-p", "p1", "--json"]).rc).toBe(0);

    // tree use into the shared default bucket (multi-tree workspace)
    const tu = run(["tree", "use", "t1", "--json"]);
    expect(tu.rc, tu.out + tu.err).toBe(0);
    expect(String(tu.j.selection_warning)).toMatch(/shared "default" bucket/);

    // write-time: project.use within 90 s -> query add warns (no actor compare)
    const q = run(["research", "query", "add", "k3 signal", "--json"]);
    expect(q.rc, q.out + q.err).toBe(0);
    expect(String(q.j.selection_warning)).toMatch(/shared "default" bucket/);
    expect(String(q.j.selection_warning)).toMatch(/project\.use changed \d+s ago/);

    // write-time: tree.use within 90 s -> node add warns
    const n = run(["node", "add", "k3-node", "--json"]);
    expect(n.rc, n.out + n.err).toBe(0);
    expect(String(n.j.selection_warning)).toMatch(/tree\.use changed \d+s ago/);

    // doctor surfaces the tree-side default bucket
    const doc = run(["doctor", "--json"]);
    const checks = Array.isArray(doc.j) ? doc.j : [];
    const treeCheck = checks.find((c: any) => c.name === "selection_hygiene_trees");
    expect(treeCheck?.status).toBe("warn");
    expect(String(treeCheck?.detail)).toMatch(/default.*tree selection bucket/);

    // 90 s window: an old selection event no longer warns
    expect(run(["db", "sql", "UPDATE events SET ts='2000-01-01T00:00:00.000Z' WHERE kind='project.use'"]).rc).toBe(0);
    const q2 = run(["research", "query", "add", "k3 stale", "--json"]);
    expect(q2.rc, q2.out + q2.err).toBe(0);
    expect(q2.j.selection_warning).toBeUndefined();
  });

  it("F3: id-addressed refusals name the owning project", () => {
    const claim = run(["research", "claim", "add", "账目必须对平", "-p", "p1", "--json"]);
    expect(claim.rc, claim.out + claim.err).toBe(0);
    const claimId = claim.j.id as string;
    const src = run(["research", "source", "add", "账单", "--url", "https://example.com/x", "-p", "p2", "--json"]);
    expect(src.rc).toBe(0);
    const srcId = src.j.id as string;
    const ev = run(["research", "evidence", "add", srcId, "--quote", "账面余额 1 元", "-p", "p2", "--json"]);
    expect(ev.rc).toBe(0);
    const evId = ev.j.id as string;

    // selection p3 owns neither end
    expect(run(["project", "new", "p3", "--json"]).rc).toBe(0);
    expect(run(["project", "use", "p3", "--json"]).rc).toBe(0);

    const resolve = run(["research", "claim", "resolve", claimId, "--as", "refuted", "-p", "p3", "--json"]);
    expect(resolve.rc).toBe(1);
    expect(String(resolve.j?.error)).toMatch(/belongs to project 'p1'/);

    const unresolve = run(["research", "claim", "unresolve", claimId, "-p", "p3", "--json"]);
    expect(unresolve.rc).toBe(1);
    expect(String(unresolve.j?.error)).toMatch(/belongs to project 'p1'/);

    const show = run(["research", "source", "show", srcId, "-p", "p3", "--json"]);
    expect(show.rc).toBe(1);
    expect(String(show.j?.error)).toMatch(/belongs to project 'p2'/);

    const addEv = run(["research", "evidence", "add", srcId, "--quote", "x", "-p", "p3", "--json"]);
    expect(addEv.rc).toBe(1);
    expect(String(addEv.j?.error)).toMatch(/belongs to project 'p2'/);

    const unlink = run(["research", "claim", "unlink", claimId, evId, "-p", "p3", "--json"]);
    expect(unlink.rc).toBe(1);
    expect(String(unlink.j?.error)).toMatch(/belongs to project 'p1'/);
  });

  it("#47: task / produce / remaining research id verbs name the owning project", () => {
    // p2 owns a task, an artifact, an evidence row and a query; selection p3.
    const t = run(["task", "add", "跨项目任务", "-p", "p2", "--json"]);
    expect(t.rc).toBe(0);
    const taskId = t.j.id as string;
    const outline = run(["produce", "outline", "-p", "p2", "--json"]);
    expect(outline.rc).toBe(0);
    const artifactId = outline.j.id as string;
    const src = run(["research", "source", "add", "p2源", "--url", "https://example.com/z", "-p", "p2", "--json"]);
    const ev = run(["research", "evidence", "add", src.j.id, "--quote", "p2证据", "-p", "p2", "--json"]);
    const q = run(["research", "query", "add", "p2问题", "-p", "p2", "--json"]);
    expect(ev.rc).toBe(0);
    expect(q.rc).toBe(0);

    expect(run(["project", "use", "p3", "--json"]).rc).toBe(0);

    const cases: Array<[string[], RegExp]> = [
      [["task", "done", taskId, "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["produce", "show", artifactId, "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["produce", "export", artifactId, join(HOME, "x.md"), "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["research", "claim", "evaluate", "dummy", "-p", "p3", "--json"], /claim not found: dummy/],
      [["research", "evidence", "assess", ev.j.id, "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["research", "evidence", "rm", ev.j.id, "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["research", "source", "rm", src.j.id, "-p", "p3", "--json"], /belongs to project 'p2'/],
      [["research", "query", "done", q.j.id, "-p", "p3", "--json"], /belongs to project 'p2'/],
    ];
    for (const [args, needle] of cases) {
      const r = run(args);
      expect(r.rc, `${args.join(" ")} → ${r.out}${r.err}`).toBe(1);
      expect(String(r.j?.error), `${args.join(" ")}`).toMatch(needle);
    }
  });

  it("F2: a cross-project link made on an implicit selection reports that the selection owned neither end", () => {
    const claim = run(["research", "claim", "add", "跨项目断言", "-p", "p1", "--json"]);
    const src = run(["research", "source", "add", "跨项目来源", "--url", "https://example.com/y", "-p", "p2", "--json"]);
    const ev = run(["research", "evidence", "add", src.j.id, "--quote", "跨项目证据", "-p", "p2", "--json"]);
    const link = run(["research", "claim", "link", claim.j.id, ev.j.id, "--json"]);
    expect(link.rc).toBe(0);
    expect(link.j.cross_project).toMatchObject({ claim: "p1", evidence: "p2" });
    expect(String(link.j.selection_note)).toMatch(/owns neither end/);
    expect(link.j.selection_note).toMatch(/p3/);
  });
});
