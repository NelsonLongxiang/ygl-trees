/**
 * Contract 1.3 part 2b through the CLI (#80): spec views ride in the candidates envelope `{ views, candidates }`.
 * prepare registers them (P2), freezes them into a 1.3 spec, and run creates them in memory; the snapshot is
 * unchanged. A candidate reading a view stored in the snapshot, or naming the snapshot's path, is refused at P2;
 * lint-candidates sees the same views.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
let home = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" },
  });
  let json: any = null;
  try { json = JSON.parse((r.stdout || "").trim()); } catch { /* not json */ }
  return { rc: r.status ?? -1, json, text: (r.stdout || "") + (r.stderr || "") };
}

const CLAUSE = "S1 金额超过 10 的订单都必须有明细。";
const and = (...conditions: unknown[]) => ({ op: "and", conditions });
const VIEWS = [
  { name: "big_orders", predicate: { from: "orders", select: ["id", "amount"], where: and({ col: "amount", op: ">", value: 10 }) } },
  { name: "lonely_big", predicate: { from: "big_orders", select: ["id"], where: and({ col: "id", op: "not-glob", value: "*" }) } },
];
function prepared(tag: string, predicate: Record<string, unknown>, views: unknown = VIEWS) {
  const mat = join(home, `m${tag}.md`);
  writeFileSync(mat, `验收对象：订单与明细\n${CLAUSE}\n`, "utf8");
  const anchor = { quote: CLAUSE, locator: `m${tag}.md#S1` };
  const cand = join(home, `c${tag}.json`);
  const candidates = [{ source_clause: CLAUSE, anchor, checker: { type: "sql", expect: "empty", fail_when: "rows>0", predicate } }];
  writeFileSync(cand, JSON.stringify(views === undefined ? { candidates } : { views, candidates }), "utf8");
  const rev = join(home, `r${tag}.json`);
  writeFileSync(rev, JSON.stringify({ reviews: [{ source_clause: CLAUSE, findings: [
    { question: "faithful", verdict: "ok", reason: "big_orders 是金额超过 10 的订单，与条款的对象一致。", anchor },
    { question: "decidable", verdict: "ok", reason: "有违规行即 FAIL，没有即 PASS，机械可判。" },
    { question: "not-vacuous", verdict: "ok", reason: "快照里有金额超过 10 的订单，扫描面非空。" },
  ] }] }), "utf8");
  const dbp = join(home, `s${tag}.sqlite`);
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER); CREATE TABLE items(id INTEGER PRIMARY KEY, order_id INTEGER);"
    + "INSERT INTO orders VALUES (1, 5), (2, 50), (3, 500); INSERT INTO items VALUES (1, 2), (2, 3);"
    + "CREATE VIEW stored_view AS SELECT id FROM orders");
  db.close();
  const sub = run(["verify", "submit", "--title", `views13-${tag}`, "--text", mat]).json;
  const prep = run(["verify", "prepare", sub.material_id, "--candidates", cand, "--reviews", rev, "--db", dbp,
    "--as-of", "2026-11-11T00:00:00Z", "--candidates-author", "a", "--reviews-author", "b"]);
  return { prep, dbp, cand };
}
const rejected = (p: { rc: number; json: any; text: string }) => JSON.stringify(p.json ?? p.text);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

beforeAll(() => {
  if (!hasBundle) return;
  // verify judges the meta gate of the repo enclosing cwd: run in a neutral directory, like the other verify specs.
  home = mkdtempSync(join(tmpdir(), "ygl-views13-"));
  expect(run(["db", "init"]).rc).toBe(0);
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("contract 1.3 views and derived tables through prepare and run", () => {
  it("views freeze into a 1.3 spec and run in memory: a real FAIL over a derived view read, snapshot unchanged", () => {
    // big_orders = orders 2 (50) and 3 (500); the criterion flags big orders above 400 → order 3 → FAIL, scanned 2
    const { prep, dbp } = prepared("ok", { from: { derived: { from: "big_orders", select: ["id", "amount"] } }, select: ["id"], where: and({ col: "amount", op: ">", value: 400 }) });
    expect(prep.rc, prep.text).toBe(0);
    const spec = JSON.parse(readFileSync(join(home, "verify", "specs", prep.json.spec_id, "spec.json"), "utf8"));
    expect(spec.contract_version).toBe("1.3");
    expect(spec.views.map((v: { name: string }) => v.name)).toEqual(["big_orders", "lonely_big"]);
    const before = sha(dbp);
    const r = run(["verify", "run", prep.json.spec_id, "--db", dbp, "--no-archive"]);
    expect(r.rc, r.text).toBe(0);
    const report = JSON.parse(readFileSync(join(home, "verify", "reports", `${r.json.run_id}.json`), "utf8"));
    expect(report).toMatchObject({ contract_version: "1.3", overall: "FAIL" });
    expect(report.vu[0].witness).toMatchObject({ rows_scanned: 2 });
    expect(sha(dbp)).toBe(before);
  });

  it("a candidate may not read a view stored in the snapshot", () => {
    const { prep } = prepared("stored", { from: "stored_view", select: ["id"] });
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("is a view stored in the snapshot");
  });

  it("a view that shadows a snapshot table blocks the whole spec at P2", () => {
    const { prep } = prepared("shadow", { from: "orders", select: ["id"], where: and({ col: "amount", op: "<", value: 0 }) }, [{ name: "items", predicate: VIEWS[0].predicate }]);
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("is already an object in the snapshot");
  });

  it("a candidate naming the snapshot's own path is refused (red team)", () => {
    const dbp = join(home, "spath.sqlite");
    const { prep } = prepared("path", { from: "big_orders", select: ["id"], where: and({ col: "id", op: "=", value: `file:${dbp}?mode=ro` }) });
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("snapshot_reference");
  });

  it("lint-candidates reads the same envelope views", () => {
    const { cand, dbp } = prepared("lint", { from: "lonely_big", select: ["id"] });
    const ok = run(["verify", "lint-candidates", cand, "--db", dbp]);
    expect(ok.rc, ok.text).toBe(0);
    expect(ok.json.issues.filter((i: { stage: string }) => i.stage === "P2")).toEqual([]);
    writeFileSync(cand, JSON.stringify({ views: "nope", candidates: [] }), "utf8");
    expect(run(["verify", "lint-candidates", cand]).rc).toBe(2);
  });
});
