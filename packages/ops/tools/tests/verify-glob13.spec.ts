/**
 * Contract 1.3 through the CLI (#80/#232): prepare accepts glob / not-glob, stamps 1.3 only when a spec uses them, and
 * keeps stamping 1.2 otherwise (frozen bytes unchanged for specs without 1.3 shapes). The frozen 1.3 spec then runs.
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

const CLAUSE = "S1 发布包里的每个文件都在 package/ 目录下。";
function prepared(tag: string, cond: Record<string, unknown>) {
  const mat = join(home, `m${tag}.md`);
  writeFileSync(mat, `验收对象：发布包清单\n${CLAUSE}\n`, "utf8");
  const anchor = { quote: CLAUSE, locator: `m${tag}.md#S1` };
  const cand = join(home, `c${tag}.json`);
  writeFileSync(cand, JSON.stringify({ candidates: [{ source_clause: CLAUSE, anchor,
    checker: { type: "sql", fail_when: "rows>0", predicate: { from: "entries", select: ["path"], where: { op: "and", conditions: [cond] } } } }] }), "utf8");
  const rev = join(home, `r${tag}.json`);
  writeFileSync(rev, JSON.stringify({ reviews: [{ source_clause: CLAUSE, findings: [
    { question: "faithful", verdict: "ok", reason: "找出不在 package/ 下的条目，与条款一致。", anchor },
    { question: "decidable", verdict: "ok", reason: "有违规行即 FAIL，机械可判。" },
    { question: "not-vacuous", verdict: "ok", reason: "扫描面是全部条目，空表降级 NEEDS-MATERIAL。" },
  ] }] }), "utf8");
  const dbp = join(home, `s${tag}.sqlite`);
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE entries(path TEXT); INSERT INTO entries(path) VALUES ('package/a.js'), ('package/lib/b.js')");
  db.close();
  const sub = run(["verify", "submit", "--title", `glob13-${tag}`, "--text", mat]).json;
  const prep = run(["verify", "prepare", sub.material_id, "--candidates", cand, "--reviews", rev, "--db", dbp,
    "--as-of", "2026-11-11T00:00:00Z", "--candidates-author", "a", "--reviews-author", "b"]);
  return { prep, dbp };
}
const specOf = (specId: string) => JSON.parse(readFileSync(join(home, "verify", "specs", specId, "spec.json"), "utf8"));

beforeAll(() => {
  if (!hasBundle) return;
  // verify judges the meta gate of the repo enclosing cwd: run in a neutral directory, like the other verify specs.
  home = mkdtempSync(join(tmpdir(), "ygl-glob13-"));
  expect(run(["db", "init"]).rc).toBe(0);
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("contract 1.3 glob through prepare and run", () => {
  it("a not-glob criterion freezes as contract 1.3 and runs: nothing outside package/ → PASS", () => {
    const { prep, dbp } = prepared("g", { col: "path", op: "not-glob", value: "package/*" });
    expect(prep.rc, prep.text).toBe(0);
    expect(specOf(prep.json.spec_id).contract_version).toBe("1.3");
    const r = run(["verify", "run", prep.json.spec_id, "--db", dbp, "--no-archive"]);
    expect(r.rc, r.text).toBe(0);
    const report = JSON.parse(readFileSync(join(home, "verify", "reports", `${r.json.run_id}.json`), "utf8"));
    expect(report).toMatchObject({ contract_version: "1.3", overall: "PASS" });
  });

  it("a criterion without 1.3 shapes still freezes as 1.2 (bytes a 1.2 engine would freeze)", () => {
    const { prep } = prepared("p", { col: "path", op: "=", value: "outside/x.js" });
    expect(prep.rc, prep.text).toBe(0);
    expect(specOf(prep.json.spec_id).contract_version).toBe("1.2");
  });
});
