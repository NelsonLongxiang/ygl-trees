import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #242: a second ready prepare must not silently eat the old version — it says
 * what it replaces, keeps v1 byte for byte under versions/v1/, and both run and
 * trace can read the kept version via --version.
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-v242-")) : "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const j = (r: { out: string }) => JSON.parse(r.out);

beforeAll(() => { if (hasBundle) expect(run(["db", "init"]).rc).toBe(0); });
afterAll(() => {
  if (home && existsSync(home)) {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch { /* Windows handle lag; the suite's tmpdir root sweeps the rest */ }
  }
});

function fixture(tag: string, amountWhere: number, reuse?: { dbp: string }) {
  const mat = join(home, "m" + tag + ".md");
  writeFileSync(mat, "验收对象：订单总额核对\nS1 总额须等于申报额。\n", "utf8");
  const cand = join(home, "c" + tag + ".json");
  writeFileSync(cand, JSON.stringify({ candidates: [{ source_clause: "S1 总额须等于申报额。", anchor: { quote: "S1 总额须等于申报额。", locator: "m" + tag + ".md#S1" }, checker: { type: "count", predicate: { from: "orders", select: ["id"], where: { op: "and", conditions: [{ col: "amount", op: ">=", value: amountWhere }] } }, op: ">=", value: 1 } }] }), "utf8");
  const rev = join(home, "r" + tag + ".json");
  writeFileSync(rev, JSON.stringify({ reviews: [{ source_clause: "S1 总额须等于申报额。", findings: [{ question: "faithful", verdict: "ok", reason: "与条款一致。", anchor: { quote: "S1 总额须等于申报额。", locator: "m" + tag + ".md#S1" } }, { question: "decidable", verdict: "ok", reason: "计数可比。" }, { question: "not-vacuous", verdict: "ok", reason: "空表 FAIL。" }] }] }), "utf8");
  const dbp = reuse?.dbp ?? join(home, "s" + tag + ".sqlite");
  if (!reuse) {
    const db = new DatabaseSync(dbp);
    db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); INSERT INTO orders(id,amount) VALUES (1,100)");
    db.close();
  }
  return { mat, cand, rev, dbp };
}

describe.skipIf(!hasBundle)("second ready prepare keeps the old version (#242)", () => {
  it("v2 announces the replacement, v1 survives byte for byte, run/trace read it via --version", () => {
    const f1 = fixture("a", 0);
    const sub = j(run(["verify", "submit", "--title", "v242", "--text", f1.mat]));
    const mid = sub.material_id;
    const base = ["verify", "prepare", mid, "--as-of", "2026-11-01T00:00:00.000Z", "--candidates-author", "t", "--reviews-author", "t"];
    const p1 = j(run([...base, "--candidates", f1.cand, "--reviews", f1.rev, "--db", f1.dbp]));
    expect(p1.verdict).toBe("ready");
    expect(p1.replaced).toBeUndefined(); // first prepare replaces nothing
    const specDirHome = join(home, "verify", "specs", p1.spec_id);
    const v1SpecBytes = readFileSync(join(specDirHome, "spec.json"));
    const v1TraceBytes = readFileSync(join(specDirHome, "trace.json"));
    const v1PrepBytes = readFileSync(join(specDirHome, "prepare.json"));

    // second prepare with a stricter candidate → v2 (same material + db, new candidates)
    const f2 = fixture("b", 50, { dbp: f1.dbp });
    const p2 = j(run([...base, "--candidates", f2.cand, "--reviews", f2.rev, "--db", f2.dbp]));
    expect(p2.verdict).toBe("ready");
    expect(p2.spec_version).toBe(2);
    expect(p2.replaced).toBeDefined();
    expect(p2.replaced.spec_version).toBe(1);
    expect(p2.replaced.spec_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // v1 kept byte for byte
    const keep = join(specDirHome, "versions", "v1");
    expect(existsSync(join(keep, "spec.json"))).toBe(true);
    expect(readFileSync(join(keep, "spec.json")).equals(v1SpecBytes)).toBe(true);
    expect(readFileSync(join(keep, "trace.json")).equals(v1TraceBytes)).toBe(true);
    expect(readFileSync(join(keep, "prepare.json")).equals(v1PrepBytes)).toBe(true);
    // run --version 1 works (old criteria still executable)
    const r1 = run(["verify", "run", p1.spec_id, "--db", f1.dbp, "--spec-version", "1"]);
    expect(r1.rc).toBe(0);
    // trace --version 1 returns the old trace
    const t1 = j(run(["verify", "trace", p1.spec_id, "--spec-version", "1"]));
    expect(t1.spec_version).toBe(1);
    // draft says which version a real prepare would replace
    const d = j(run([...base, "--candidates", f1.cand, "--reviews", f1.rev, "--db", f1.dbp, "--draft"]));
    expect(d.draft).toBe(true);
    expect(d.would_replace).toEqual({ spec_version: 2 });
    // bad --version shape is usage error
    expect(run(["verify", "run", p1.spec_id, "--db", f1.dbp, "--spec-version", "0"]).rc).toBe(2);
  }, 180000);
});
