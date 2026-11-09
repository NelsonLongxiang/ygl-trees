import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #241: superseded-by between claims is honored everywhere the claim is read —
 * produce report drops the old item and names the replacement once, claim show
 * carries superseded_by, claim list marks it, agent brief stops counting it, and
 * a rel that crosses projects or closes a cycle is refused with both ids named.
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-sup241-")) : "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim() };
}
const j = (r: { out: string }) => JSON.parse(r.out);
const addClaim = (text: string) => j(run(["research", "claim", "add", text, "--confidence", "A", "-p", "p241"]));

beforeAll(() => {
  if (!hasBundle) return;
  expect(run(["db", "init"]).rc).toBe(0);
  expect(run(["project", "new", "p241"]).rc).toBe(0);
  expect(run(["project", "new", "p241b"]).rc).toBe(0);
  expect(run(["project", "use", "p241"]).rc).toBe(0);
});
afterAll(() => { if (home && existsSync(home)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("claim superseded-by (#241)", () => {
  it("report/show/list/brief honor the replacement; cross-project and cyclic rels are refused", () => {
    const oldC = addClaim("旧措辞的断言");
    const newC = addClaim("新措辞的断言");
    expect(j(run(["rel", "add", "claim:" + oldC.id, "claim:" + newC.id, "--rel", "superseded-by"])).id).toBeTruthy();
    // report: old text gone, replacement named once
    const rep = j(run(["produce", "report"]));
    const text = String(rep.content);
    // the 主要结论 section must not list the replaced claim (the summary's
    // replacement line names it once — that is required, not a leak)
    const conclusions = text.slice(text.indexOf("## 主要结论"), text.indexOf("## 证据清单"));
    expect(conclusions).not.toContain("旧措辞的断言");
    expect(conclusions).toContain("新措辞的断言");
    expect(text).toMatch(/已由新版替代：旧措辞的断言/);
    // show: names the replacement; json carries superseded_by
    const show = j(run(["research", "claim", "show", oldC.id]));
    expect(show.superseded_by).toBe(newC.id);
    // list: marks it
    const list = j(run(["research", "claim", "list"]));
    const row = list.find((c: any) => c.id === oldC.id);
    expect(row.superseded_by).toBe(newC.id);
    // brief: counts exclude the replaced claim
    const brief = j(run(["agent", "brief"]));
    expect(brief.project.claims).toBe(1);
    // cross-project refusal names both ids
    const foreign = (() => {
      const r = run(["project", "use", "p241b"]);
      expect(r.rc).toBe(0);
      const c = j(run(["research", "claim", "add", "别项目断言", "--confidence", "A"]));
      run(["project", "use", "p241"]);
      return c;
    })();
    const cross = run(["rel", "add", "claim:" + oldC.id, "claim:" + foreign.id, "--rel", "superseded-by"]);
    expect(cross.rc).toBe(2);
    expect(cross.out).toContain(oldC.id);
    expect(cross.out).toContain(foreign.id);
    // cycle refusal: new→old would close old→new
    const cyc = run(["rel", "add", "claim:" + newC.id, "claim:" + oldC.id, "--rel", "superseded-by"]);
    expect(cyc.rc).toBe(2);
    expect(cyc.out).toMatch(/cycle/);
    expect(cyc.out).toContain(oldC.id);
  }, 180000);

  it("one replacement per claim — a second superseded-by from the same claim is refused (#241 review)", () => {
    const a = addClaim("甲断言");
    const b = addClaim("乙断言");
    const c2 = addClaim("丙断言");
    expect(run(["rel", "add", "claim:" + a.id, "claim:" + b.id, "--rel", "superseded-by"]).rc).toBe(0);
    const second = run(["rel", "add", "claim:" + a.id, "claim:" + c2.id, "--rel", "superseded-by"]);
    expect(second.rc).toBe(2);
    expect(second.out).toContain(a.id);
    expect(second.out).toContain(b.id);
  }, 120000);

  it("a cycle two hops away is refused through every branch (#241 review)", () => {
    const a = addClaim("链头断言");
    const x = addClaim("中间断言");
    const end = addClaim("尾端断言");
    // a→x, x→end (no cycle yet)
    expect(run(["rel", "add", "claim:" + a.id, "claim:" + x.id, "--rel", "superseded-by"]).rc).toBe(0);
    expect(run(["rel", "add", "claim:" + x.id, "claim:" + end.id, "--rel", "superseded-by"]).rc).toBe(0);
    // end→a closes the two-hop cycle
    const cyc = run(["rel", "add", "claim:" + end.id, "claim:" + a.id, "--rel", "superseded-by"]);
    expect(cyc.rc).toBe(2);
    expect(cyc.out).toMatch(/cycle/);
  }, 120000);

  it("an historic claim with TWO outgoing rels is refused at any branch (#241 review)", () => {
    // build history with an illegal double edge directly in the DB: a→x and a→y
    const a = addClaim("双出边断言");
    const x = addClaim("替代X");
    const y = addClaim("替代Y");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(home, "ygl-trees.db"));
    db.exec(
      "INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight,created) VALUES " +
      "('reldblx','claim','" + a.id + "','claim','" + x.id + "','superseded-by',1,'2026-11-09T00:00:00.000Z')"
    );
    db.exec(
      "INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight,created) VALUES " +
      "('reldbly','claim','" + a.id + "','claim','" + y.id + "','superseded-by',1,'2026-11-09T00:00:01.000Z')"
    );
    db.close();
    // every branch pointing back at a's chain must be refused, not
    // id-order-dependent: each of a's two successors returning to a walks a's
    // two outgoing rels and finds a on one branch (review round 3).
    for (const branch of [x, y]) {
      const back = run(["rel", "add", "claim:" + branch.id, "claim:" + a.id, "--rel", "superseded-by"]);
      expect(back.rc).toBe(2);
      expect(back.out).toMatch(/cycle/);
    }
  }, 120000);
});
