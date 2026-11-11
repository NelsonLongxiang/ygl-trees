/**
 * #232 draft-run entry: `verify prepare … --draft --run` runs criteria that are not frozen yet, so a consumer can see
 * its draft verdicts before freezing. The run happens on a working copy of the snapshot and writes nothing to the
 * workspace: no specs/, reports/, archives/ or retained snapshots, and no spec version is consumed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
let home = "";

function run(args: string[], json = true) {
  const r = spawnSync(process.execPath, [BIN, ...args, ...(json ? ["--json"] : [])], {
    cwd: home, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1", NO_COLOR: "1" },
  });
  let out: any = null;
  try { out = JSON.parse((r.stdout || "").trim()); } catch { /* human face */ }
  return { rc: r.status ?? -1, json: out, text: (r.stdout || "") + (r.stderr || "") };
}

/** Every path, size and content hash under a directory: equal digests mean nothing was written there. */
function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(relative(dir, p) + "\0" + (st.isDirectory() ? "dir" : st.size) + "\0");
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
const fileSha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const CLAUSE = "S1 至少有一张订单。";
function fixture(tag: string, rows: number, opts: { reviewed?: boolean } = {}) {
  const mat = join(home, `m${tag}.md`);
  writeFileSync(mat, `验收对象：订单\n${CLAUSE}\n`, "utf8");
  const cand = join(home, `c${tag}.json`);
  writeFileSync(cand, JSON.stringify({ candidates: [{ source_clause: CLAUSE, anchor: { quote: CLAUSE, locator: `m${tag}.md#S1` },
    checker: { type: "count", predicate: { from: "orders", select: ["id"], where: { op: "and", conditions: [{ col: "amount", op: ">=", value: 0 }] } }, op: ">=", value: 1 } }] }), "utf8");
  const rev = join(home, `r${tag}.json`);
  const findings = [
    { question: "faithful", verdict: "ok", reason: "计数口径与条款一致。", anchor: { quote: CLAUSE, locator: `m${tag}.md#S1` } },
    { question: "decidable", verdict: "ok", reason: "计数与 1 机械可比。" },
    { question: "not-vacuous", verdict: "ok", reason: "空表时判 FAIL，不会空真。" },
  ];
  writeFileSync(rev, JSON.stringify({ reviews: opts.reviewed === false ? [] : [{ source_clause: CLAUSE, findings }] }), "utf8");
  const dbp = join(home, `s${tag}.sqlite`);
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
  for (let i = 1; i <= rows; i++) db.exec(`INSERT INTO orders(amount) VALUES (${i * 10})`);
  db.close();
  const sub = run(["verify", "submit", "--title", `draftrun-${tag}`, "--text", mat]).json;
  const base = ["verify", "prepare", sub.material_id, "--candidates", cand, "--reviews", rev, "--db", dbp, "--candidates-author", "a", "--reviews-author", "b"];
  return { base, dbp, materialId: sub.material_id as string };
}

beforeAll(() => {
  if (!hasBundle) return;
  // verify judges the meta gate of the repo that encloses cwd, so a home inside this checkout would be judged as the
  // ygl-trees repo; like the other verify specs, run in a neutral directory outside any repo.
  home = mkdtempSync(join(tmpdir(), "ygl-draftrun-"));
  expect(run(["db", "init"]).rc).toBe(0);
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("verify prepare --draft --run (#232)", () => {
  it("usage: --run needs --draft, --submission needs --run; rc 2 before any I/O", () => {
    const { base } = fixture("u", 1);
    const noDraft = run([...base, "--as-of", "2026-11-01T00:00:00Z", "--run"]);
    expect(noDraft.rc).toBe(2);
    expect(noDraft.json.error).toContain("--run needs --draft");
    const subOnly = run([...base, "--draft", "--submission", home]);
    expect(subOnly.rc).toBe(2);
    expect(subOnly.json.error).toContain("--submission only applies to --draft --run");
  });

  it("a ready draft runs on a copy and prints the report; the verify root and the snapshot stay byte-identical", () => {
    const { base, dbp } = fixture("p", 3);
    const verifyRoot = join(home, "verify");
    const before = treeDigest(verifyRoot);
    const snapBefore = fileSha(dbp);

    const r = run([...base, "--draft", "--run"]);
    expect(r.rc).toBe(0);
    expect(r.json).toMatchObject({ draft: true, verdict: "ready", record: null });
    const rep = r.json.run.report;
    expect(rep).toMatchObject({ draft: true, overall: "PASS", summary: { pass: 1, fail: 0 } });
    expect(rep.data_source).toMatchObject({ kind: "sqlite-snapshot", sha256: `sha256:${snapBefore}` });
    expect(rep.vu[0].witness.rows_scanned).toBe(3);

    expect(treeDigest(verifyRoot)).toBe(before);
    expect(fileSha(dbp)).toBe(snapBefore);
    expect(existsSync(join(verifyRoot, "specs", r.json.spec_id))).toBe(false);
  });

  it("a FAIL verdict is still rc 0 (rc only reports the process), and still writes nothing", () => {
    const { base } = fixture("f", 0);
    const before = treeDigest(join(home, "verify"));
    const r = run([...base, "--draft", "--run"]);
    expect(r.rc).toBe(0);
    expect(r.json.run.report).toMatchObject({ overall: "FAIL", summary: { fail: 1 } });
    expect(treeDigest(join(home, "verify"))).toBe(before);
  });

  it("a draft that is not ready runs nothing: rc 1 and run.report null", () => {
    const { base } = fixture("n", 1, { reviewed: false });
    const r = run([...base, "--draft", "--run"]);
    expect(r.rc).toBe(1);
    expect(r.json.verdict).not.toBe("ready");
    expect(r.json.run).toEqual({ report: null });
  });

  it("the draft run does not consume a spec version: a later real prepare still freezes v1", () => {
    const { base } = fixture("v", 2);
    expect(run([...base, "--draft", "--run"]).rc).toBe(0);
    const real = run([...base, "--as-of", "2026-11-01T00:00:00Z"]);
    expect(real.rc).toBe(0);
    expect(real.json.spec_version).toBe(1);
  });

  it("the meta gate applies as for prepare: --require-meta outside a verifier repo refuses the draft run too", () => {
    const { base } = fixture("m", 1);
    const plain = run([...base, "--draft", "--require-meta"]);
    const withRun = run([...base, "--draft", "--run", "--require-meta"]);
    expect(plain.rc).not.toBe(0);
    expect(withRun.rc).toBe(plain.rc);
    expect(withRun.json?.run).toBeUndefined();
  });

  it("the human face says the run is not frozen and lists the verdicts", () => {
    const { base } = fixture("h", 1);
    const r = run([...base, "--draft", "--run"], false);
    expect(r.rc).toBe(0);
    expect(r.text).toContain("draft run PASS");
    expect(r.text).toContain("not frozen, nothing written");
  });
});
