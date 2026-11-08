import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-exempt243-")) : "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim() };
}
const j = (r: { out: string }) => JSON.parse(r.out);

beforeAll(() => { if (hasBundle) expect(run(["db", "init"]).rc).toBe(0); });
afterAll(() => { if (home && existsSync(home)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function fixture(tag: string, exemptEntry: Record<string, string> | null) {
  const mat = join(home, "m" + tag + ".md");
  writeFileSync(mat, "验收对象：订单总额核对\nS1 总额须等于申报额。\nS2 影子口径条款，冒烟窗口不适用。\n", "utf8");
  const cand = join(home, "c" + tag + ".json");
  writeFileSync(cand, JSON.stringify({ candidates: [{ source_clause: "S1 总额须等于申报额。", anchor: { quote: "S1 总额须等于申报额。", locator: "m" + tag + ".md#S1" }, checker: { type: "count", predicate: { from: "orders", select: ["id"], where: { op: "and", conditions: [{ col: "amount", op: ">=", value: 0 }] } }, op: ">=", value: 1 } }] }), "utf8");
  const rev = join(home, "r" + tag + ".json");
  writeFileSync(rev, JSON.stringify({ reviews: [{ source_clause: "S1 总额须等于申报额。", findings: [{ question: "faithful", verdict: "ok", reason: "过滤条件与材料条款一致。", anchor: { quote: "S1 总额须等于申报额。", locator: "m" + tag + ".md#S1" } }, { question: "decidable", verdict: "ok", reason: "计数与 1 机械可比。" }, { question: "not-vacuous", verdict: "ok", reason: "空表得 0 判 FAIL。" }] }] }), "utf8");
  const dbp = join(home, "s" + tag + ".sqlite");
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
  db.close();
  const args = ["verify", "prepare", "MID", "--candidates", cand, "--reviews", rev, "--db", dbp, "--as-of", "2026-11-01T00:00:00.000Z", "--candidates-author", "t", "--reviews-author", "t"];
  if (exemptEntry) {
    const exe = join(home, "exe" + tag + ".json");
    writeFileSync(exe, JSON.stringify({ exempt: [exemptEntry] }), "utf8");
    args.push("--coverage-exempt", exe);
  }
  return { mat, args };
}

describe.skipIf(!hasBundle)("coverage exemptions ride the frozen records (#243)", () => {
  it("ready prepare: list lands in prepare.json + trace.json + verify trace --json; spec.json untouched", () => {
    const { mat, args } = fixture("a", { id: "S2", reason: "影子版判据，冒烟窗口不适用" });
    const sub = j(run(["verify", "submit", "--title", "exempt243a", "--text", mat]));
    const prep = j(run(args.map((a) => (a === "MID" ? sub.material_id : a))));
    expect(prep.verdict).toBe("ready");
    const dir = join(home, "verify", "specs", prep.spec_id);
    const expected = [{ id: "S2", reason: "影子版判据，冒烟窗口不适用", clause_id: "S2", clause_text: "S2 影子口径条款，冒烟窗口不适用。" }];
    expect(JSON.parse(readFileSync(join(dir, "prepare.json"), "utf8")).coverage_exempt).toEqual(expected);
    expect(JSON.parse(readFileSync(join(dir, "trace.json"), "utf8")).coverage_exempt).toEqual(expected);
    const trace = j(run(["verify", "trace", prep.spec_id]));
    expect(trace.coverage_exempt).toEqual(expected);
    const sj = readFileSync(join(dir, "spec.json"), "utf8");
    expect(sj).not.toContain("coverage_exempt");
    expect(sj).not.toContain("冒烟窗口");
  }, 120000);

  it("not-ready attempt records the list; empty exemption set writes [] (draft face)", () => {
    const { mat } = fixture("b", null);
    const sub = j(run(["verify", "submit", "--title", "exempt243b", "--text", mat]));
    const candEmpty = join(home, "cEmpty.json");
    writeFileSync(candEmpty, JSON.stringify({ candidates: [] }), "utf8");
    const revEmpty = join(home, "rEmpty.json");
    writeFileSync(revEmpty, JSON.stringify({ reviews: [] }), "utf8");
    const dbp = join(home, "sB.sqlite");
    const db = new DatabaseSync(dbp); db.exec("CREATE TABLE t(x)"); db.close();
    const exe = join(home, "exeB.json");
    writeFileSync(exe, JSON.stringify({ exempt: [{ id: "S2", reason: "尝试性豁免，留档" }] }), "utf8");
    const prep = j(run(["verify", "prepare", sub.material_id, "--candidates", candEmpty, "--reviews", revEmpty, "--db", dbp, "--as-of", "2026-11-01T00:00:00.000Z", "--candidates-author", "t", "--reviews-author", "t", "--coverage-exempt", exe]));
    expect(prep.verdict).not.toBe("ready");
    const specIdFromRecord = String(prep.record).split("/")[1];
    const attemptsDir = join(home, "verify", "specs", specIdFromRecord, "attempts");
    const files = readdirSync(attemptsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const attempt = JSON.parse(readFileSync(join(attemptsDir, files[0]), "utf8"));
    expect(attempt.coverage_exempt).toEqual([{ id: "S2", reason: "尝试性豁免，留档", clause_id: "S2", clause_text: "S2 影子口径条款，冒烟窗口不适用。" }]);
    const draft = j(run(["verify", "prepare", sub.material_id, "--candidates", candEmpty, "--reviews", revEmpty, "--db", dbp, "--as-of", "2026-11-01T00:00:00.000Z", "--candidates-author", "t", "--reviews-author", "t", "--draft"]));
    expect(draft.coverage_exempt).toEqual([]);
  }, 120000);
});
