/**
 * Contract 1.3 part 2a through the CLI (#80): prepare accepts a whitelisted pragma source, checks its arg against
 * the probed schema and its columns against the pragma's fixed set, freezes the spec as 1.3, and the run counts the
 * pragma's rows. A pragma outside the whitelist, an unknown arg table and an unknown column are construction errors.
 */
import { spawnSync } from "node:child_process";
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

const CLAUSE = "S1 订单金额字段 amount 必须是 NOT NULL。";
function prepared(tag: string, predicate: Record<string, unknown>) {
  const mat = join(home, `m${tag}.md`);
  writeFileSync(mat, `验收对象：订单表结构\n${CLAUSE}\n`, "utf8");
  const anchor = { quote: CLAUSE, locator: `m${tag}.md#S1` };
  const cand = join(home, `c${tag}.json`);
  writeFileSync(cand, JSON.stringify({ candidates: [{ source_clause: CLAUSE, anchor, checker: { type: "sql", expect: "nonempty", fail_when: "rows==0", predicate } }] }), "utf8");
  const rev = join(home, `r${tag}.json`);
  writeFileSync(rev, JSON.stringify({ reviews: [{ source_clause: CLAUSE, findings: [
    { question: "faithful", verdict: "ok", reason: "查 orders 的列定义里 amount 是否 notnull=1，与条款一致。", anchor },
    { question: "decidable", verdict: "ok", reason: "有一行即通过，没有即 FAIL，机械可判。" },
    { question: "not-vacuous", verdict: "ok", reason: "列定义恒有行，判据是 notnull 标志，不会空真。" },
  ] }] }), "utf8");
  const dbp = join(home, `s${tag}.sqlite`);
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, sku TEXT UNIQUE, amount INTEGER NOT NULL); INSERT INTO orders(sku, amount) VALUES ('a', 10)");
  db.close();
  const sub = run(["verify", "submit", "--title", `pragma13-${tag}`, "--text", mat]).json;
  const prep = run(["verify", "prepare", sub.material_id, "--candidates", cand, "--reviews", rev, "--db", dbp,
    "--as-of", "2026-11-11T00:00:00Z", "--candidates-author", "a", "--reviews-author", "b"]);
  return { prep, dbp };
}
const notNullAmount = { op: "and", conditions: [{ col: "name", op: "=", value: "amount" }, { col: "notnull", op: "=", value: 1 }] };
const rejected = (p: { rc: number; json: any; text: string }) => JSON.stringify(p.json ?? p.text);

beforeAll(() => {
  if (!hasBundle) return;
  // verify judges the meta gate of the repo enclosing cwd: run in a neutral directory, like the other verify specs.
  home = mkdtempSync(join(tmpdir(), "ygl-pragma13-"));
  expect(run(["db", "init"]).rc).toBe(0);
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("contract 1.3 pragma sources through prepare and run", () => {
  it("a NOT NULL structural criterion freezes as 1.3 and passes with a real scan", () => {
    const { prep, dbp } = prepared("ok", { from: { pragma: "table_info", arg: "orders" }, select: ["name"], where: notNullAmount });
    expect(prep.rc, prep.text).toBe(0);
    const spec = JSON.parse(readFileSync(join(home, "verify", "specs", prep.json.spec_id, "spec.json"), "utf8"));
    expect(spec.contract_version).toBe("1.3");
    const r = run(["verify", "run", prep.json.spec_id, "--db", dbp, "--no-archive"]);
    expect(r.rc, r.text).toBe(0);
    const report = JSON.parse(readFileSync(join(home, "verify", "reports", `${r.json.run_id}.json`), "utf8"));
    expect(report).toMatchObject({ contract_version: "1.3", overall: "PASS" });
    expect(report.vu[0].witness).toMatchObject({ rows_scanned: 3, sources: [{ table: "pragma_table_info('orders')", rows: 3 }] });
  });

  it("refuses a pragma outside the whitelist", () => {
    const { prep } = prepared("wl", { from: { pragma: "writable_schema" }, select: ["writable_schema"] });
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("pragma_not_allowed");
  });

  it("refuses a pragma arg that is not a probed table", () => {
    const { prep } = prepared("arg", { from: { pragma: "table_info", arg: "missing_table" }, select: ["name"], where: notNullAmount });
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("is not in the probed schema");
  });

  it("refuses a column the pragma does not return", () => {
    const { prep } = prepared("col", { from: { pragma: "table_info", arg: "orders" }, select: ["bogus"], where: notNullAmount });
    expect(prep.rc).not.toBe(0);
    expect(rejected(prep)).toContain("is not in pragma_table_info");
  });
});
