/**
 * F2 (0.110.x): `research claim show` / `research evidence show` — single-record
 * full views. Before this, `list` projected 7 columns and both link directions
 * required raw SQL. Read-only: no usage counters are bumped.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let CID = "";
let EID = "";
let KIND = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("F2 research show (0.110.x)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-show-"));
    jrun(["db", "init"]);
    jrun(["project", "new", "alpha"]);
    const src = jrun(["research", "source", "add", "--url", "https://ex.com/show", "--title", "show-src", "--relevance", "4", "--confidence", "A", "-p", "alpha", "--json"]);
    const sid = src.j?.id ?? src.j?.row?.id;
    const ev = jrun(["research", "evidence", "add", sid, "--quote", "show-quote", "--note", "show-note", "--locator", "p1", "-p", "alpha", "--json"]);
    EID = ev.j?.id ?? ev.j?.row?.id;
    const cl = jrun(["research", "claim", "add", "show-claim-text", "--confidence", "A", "-p", "alpha", "--json"]);
    CID = cl.j?.id ?? cl.j?.row?.id;
    jrun(["research", "claim", "link", CID, EID, "--stance", "refutes", "-p", "alpha"]);
    jrun(["project", "new", "beta"]);
    const kb = jrun(["research", "claim", "add", "beta-claim", "-p", "beta", "--json"]);
    KIND = kb.j?.id ?? kb.j?.row?.id;
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("claim show returns the full row + linked evidence with source summary", () => {
    const r = jrun(["research", "claim", "show", CID, "-p", "alpha", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j).toMatchObject({
      id: CID,
      project: "alpha",
      text: "show-claim-text",
      status: "refuted",
      confidence: "A",
      channel: "",
    });
    expect(typeof r.j.created).toBe("string");
    expect(r.j.created.length).toBeGreaterThan(0);
    expect(r.j.evidence).toHaveLength(1);
    expect(r.j.evidence[0]).toMatchObject({
      evidence_id: EID,
      stance: "refutes",
      quote: "show-quote",
      locator: "p1",
      note: "show-note",
      source: { title: "show-src", url: "https://ex.com/show" },
    });
  });

  it("evidence show returns the full row + linked claims + source metadata", () => {
    const r = jrun(["research", "evidence", "show", EID, "-p", "alpha", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j).toMatchObject({
      id: EID,
      project: "alpha",
      quote: "show-quote",
      note: "show-note",
      locator: "p1",
    });
    expect(r.j.source).toMatchObject({ title: "show-src", url: "https://ex.com/show", relevance: 4, confidence: "A" });
    expect(r.j.claims).toHaveLength(1);
    expect(r.j.claims[0]).toMatchObject({ claim_id: CID, stance: "refutes", status: "refuted", text: "show-claim-text" });
  });

  it("missing ids name the entity (rc=1, single error object)", () => {
    for (const [cmd, needle] of [
      [["research", "claim", "show", "cls_nope", "-p", "alpha", "--json"], /claim not found: cls_nope/],
      [["research", "evidence", "show", "evd_nope", "-p", "alpha", "--json"], /evidence not found: evd_nope/],
    ] as const) {
      const r = jrun([...cmd]);
      expect(r.rc).toBe(1);
      expect(String(r.j?.error)).toMatch(needle);
    }
  });

  it("cross-project claim link succeeds and is flagged (project field is the criterion)", () => {
    // evidence in beta, claim in alpha
    const src = jrun(["research", "source", "add", "--url", "https://ex.com/beta", "--title", "beta-src", "-p", "beta", "--json"]);
    const sid = src.j?.id ?? src.j?.row?.id;
    const ev = jrun(["research", "evidence", "add", sid, "--quote", "beta-quote", "-p", "beta", "--json"]);
    const eid = ev.j?.id ?? ev.j?.row?.id;
    const r = jrun(["research", "claim", "link", CID, eid, "--stance", "supports", "-p", "alpha", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.cross_project).toEqual({ claim: "alpha", evidence: "beta" });
    // same-project link carries no field
    const same = jrun(["research", "claim", "link", CID, EID, "--stance", "refutes", "-p", "alpha", "--json"]);
    expect(same.rc).toBe(0);
    expect(same.j.cross_project).toBeUndefined();
  });

  it("other-project ids guide the user to -p instead of looking missing", () => {
    const r = jrun(["research", "claim", "show", KIND, "-p", "alpha", "--json"]);
    expect(r.rc).toBe(1);
    expect(String(r.j?.error)).toMatch(/belongs to project 'beta'/);
    expect(String(r.j?.error)).toMatch(/use -p beta/);
  });
});
