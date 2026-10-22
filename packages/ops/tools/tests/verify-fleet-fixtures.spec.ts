/**
 * GitHub #34 consumer fixtures through the published entry (dist/bundle/bin.cjs):
 * every frozen fleet material (packages/verify/core/tests/fixtures/fleet) must
 * `lint-candidates --text --reviews` ok and `prepare` to ready — including the
 * P4 empty-snapshot red team — on a snapshot whose schema is synthesized from
 * the candidates' own predicates. The negatives (dropped clause, bad locator,
 * orphan review, line-number exemption, pattern without id group) run on the
 * same real materials, so "fixed for the fleet" cannot mean "gate switched off".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const FIXTURES = resolve(REPO, "packages/verify/core/tests/fixtures/fleet");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: HOME, env: { ...process.env, YGL_HOME: HOME } });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

/** Tables/columns the candidates' predicates reference → an empty snapshot. */
function snapshotFor(candidates: any[], file: string) {
  const tables = new Map<string, Set<string>>();
  const cols = (n: unknown, acc: Set<string>) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => cols(x, acc));
    for (const [k, v] of Object.entries(n)) {
      if (k === "col" && typeof v === "string") acc.add(v.split(".").pop()!);
      else cols(v, acc);
    }
  };
  const table = (name: string) => tables.get(name) ?? tables.set(name, new Set()).get(name)!;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const p = n.predicate;
    if (p && typeof p.from === "string" && !p.from.startsWith("$vu:")) {
      const s = table(p.from);
      for (const c of p.select ?? []) s.add(String(c).split(".").pop()!);
      cols(p.where, s);
      cols(p.scan, s);
      cols(p.agg, s);
    }
    if (n.against?.from) table(n.against.from).add(n.against.col);
    for (const v of Object.values(n)) walk(v);
  };
  candidates.forEach((c) => walk(c.checker));
  const db = new DatabaseSync(file);
  for (const [t, cs] of tables) db.exec(`CREATE TABLE "${t}" (${[...cs].map((c) => `"${c}"`).join(", ") || "x"})`);
  db.close();
}

interface Fx {
  name: string;
  dir: string;
  db: string;
  material_id: string;
}
const fixtures: Fx[] = [];

describe.skipIf(!HAS_BIN)("#34 fleet consumer fixtures via the CLI (release gate)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-fleet-fx-"));
    jrun(["db", "init"]);
    for (const repo of readdirSync(FIXTURES)) {
      if (!statSync(join(FIXTURES, repo)).isDirectory()) continue;
      for (const spec of readdirSync(join(FIXTURES, repo))) {
        const dir = join(FIXTURES, repo, spec);
        const db = join(HOME, `${repo}-${spec}.sqlite`);
        snapshotFor(JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8")).candidates, db);
        const sub = jrun(["verify", "submit", "--title", `${repo}/${spec}`, "--text", join(dir, "material.md"), "--no-meta", "--json"]);
        expect(sub.rc, sub.raw).toBe(0);
        fixtures.push({ name: `${repo}/${spec}`, dir, db, material_id: sub.j.material_id });
      }
    }
  }, 60_000);

  afterAll(() => {
    if (HOME) rmSync(HOME, { recursive: true, force: true });
  });

  it("all 24 frozen fleet specs: lint --text --reviews ok and prepare ready", () => {
    expect(fixtures).toHaveLength(24);
    const bad: string[] = [];
    for (const fx of fixtures) {
      const lint = jrun(["verify", "lint-candidates", join(fx.dir, "candidates.json"), "--text", join(fx.dir, "material.md"), "--reviews", join(fx.dir, "reviews.json"), "--db", fx.db, "--json"]);
      if (lint.rc !== 0 || lint.j?.ok !== true || lint.j.coverage.uncovered.length) bad.push(`${fx.name} lint: ${lint.raw.slice(0, 300)}`);
      const prep = jrun(["verify", "prepare", fx.material_id, "--candidates", join(fx.dir, "candidates.json"), "--reviews", join(fx.dir, "reviews.json"), "--db", fx.db, "--no-meta", "--draft", "--json"]);
      if (prep.rc !== 0 || prep.j?.verdict !== "ready") bad.push(`${fx.name} prepare: ${prep.raw.slice(0, 300)}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  const fx = (name: string) => fixtures.find((f) => f.name === name)!;
  const write = (name: string, value: unknown) => {
    const p = join(HOME, name);
    writeFileSync(p, JSON.stringify(value), "utf8");
    return p;
  };

  it("dropped clause (review/sync S3): lint COVERAGE names S3; prepare rc=1 error P1c", () => {
    const f = fx("review/sync");
    const cands = JSON.parse(readFileSync(join(f.dir, "candidates.json"), "utf8")).candidates;
    const reviews = JSON.parse(readFileSync(join(f.dir, "reviews.json"), "utf8")).reviews;
    const c2 = write("sync-c2.json", { candidates: cands.slice(0, 2) });
    const r2 = write("sync-r2.json", { reviews: reviews.slice(0, 2) });
    const lint = jrun(["verify", "lint-candidates", c2, "--text", join(f.dir, "material.md"), "--json"]);
    expect(lint.j.ok).toBe(false);
    expect(lint.j.coverage.uncovered.map((u: any) => u.id)).toEqual(["S3"]);
    const prep = jrun(["verify", "prepare", f.material_id, "--candidates", c2, "--reviews", r2, "--db", f.db, "--no-meta", "--draft", "--json"]);
    expect(prep.rc).toBe(1);
    expect(prep.j.verdict).toBe("error");
    expect(prep.j.diagnostics.find((d: any) => d.stage === "P1c").message).toMatch(/clause S3 is not covered/);

    const ex = write("sync-ex.json", { exempt: [{ id: "S3", reason: "measured by the aggregate seat" }] });
    expect(jrun(["verify", "prepare", f.material_id, "--candidates", c2, "--reviews", r2, "--db", f.db, "--no-meta", "--draft", "--coverage-exempt", ex, "--json"]).j.verdict).toBe("ready");
    const byLine = write("sync-ex-line.json", [{ locator: "material.md#line=9", reason: "x" }]);
    const lineLint = jrun(["verify", "lint-candidates", c2, "--text", join(f.dir, "material.md"), "--coverage-exempt", byLine, "--json"]);
    expect(lineLint.j.coverage.problems[0]).toMatch(/line number/);
  });

  it("bad locator (review/ledger #L9): P1 names the clause and counts clauses", () => {
    const f = fx("review/ledger");
    const cands = JSON.parse(readFileSync(join(f.dir, "candidates.json"), "utf8")).candidates;
    cands[0].anchor.locator = "material.md#L9";
    const p = write("ledger-bad.json", { candidates: cands });
    const lint = jrun(["verify", "lint-candidates", p, "--text", join(f.dir, "material.md"), "--json"]);
    expect(lint.j.ok).toBe(false);
    expect(lint.j.issues[0]).toMatchObject({ index: 0, stage: "P1" });
    expect(lint.j.issues[0].reason).toMatch(/names clause "L9", which the frozen material does not declare \(3 clause\(s\): L1, L2, L3\)/);
  });

  it("orphan review (design/literals): lint REVIEW issue; prepare rc=1 error P3", () => {
    const f = fx("design/literals");
    const reviews = JSON.parse(readFileSync(join(f.dir, "reviews.json"), "utf8")).reviews;
    const extra = write("literals-r.json", { reviews: [...reviews, { ...reviews[0], source_clause: "L5 a criterion dropped after review." }] });
    const lint = jrun(["verify", "lint-candidates", join(f.dir, "candidates.json"), "--text", join(f.dir, "material.md"), "--reviews", extra, "--json"]);
    expect(lint.j.ok).toBe(false);
    expect(lint.j.issues).toEqual([expect.objectContaining({ stage: "REVIEW", source_clause: "L5 a criterion dropped after review." })]);
    const prep = jrun(["verify", "prepare", f.material_id, "--candidates", join(f.dir, "candidates.json"), "--reviews", extra, "--db", f.db, "--no-meta", "--draft", "--json"]);
    expect(prep.rc).toBe(1);
    expect(prep.j.diagnostics.find((d: any) => d.stage === "P3").message).toMatch(/orphan review/);
  });

  it("submit --clause-pattern freezes the pattern in material.json and prepare judges coverage by it", () => {
    const f = fx("review/sync");
    const nl = String.fromCharCode(10);
    const text = ["# 自定义编号的材料", "", "说明：判据用 R-<n>：编号。", "", "R-1：sync_state 中 fetched_ok 为 0 的行必须为 0。", "R-2：sync_state 的行数不得少于 1。"].join(nl) + nl;
    const mat = join(HOME, "custom.md");
    writeFileSync(mat, text, "utf8");
    const base = JSON.parse(readFileSync(join(f.dir, "candidates.json"), "utf8")).candidates[0];
    const reviews = JSON.parse(readFileSync(join(f.dir, "reviews.json"), "utf8")).reviews[0];
    const clause = "R-1：sync_state 中 fetched_ok 为 0 的行必须为 0。";
    const c = write("custom-c.json", { candidates: [{ ...base, source_clause: clause, anchor: { quote: clause, locator: "custom.md#R-1" } }] });
    const r = write("custom-r.json", {
      reviews: [{ source_clause: clause, findings: reviews.findings.map((x: any) => (x.anchor ? { ...x, anchor: { quote: clause, locator: "custom.md#R-1" } } : x)) }],
    });
    expect(jrun(["verify", "submit", "--title", "custom", "--text", mat, "--clause-pattern", "^R-[0-9]+：", "--no-meta", "--json"]).rc).toBe(2);
    const plain = jrun(["verify", "submit", "--title", "custom", "--text", mat, "--no-meta", "--json"]);
    const sub = jrun(["verify", "submit", "--title", "custom", "--text", mat, "--clause-pattern", "^(R-[0-9]+)：", "--no-meta", "--json"]);
    expect(sub.rc).toBe(0);
    expect(sub.j.clause_pattern).toBe("^(R-[0-9]+)：");
    expect(sub.j.material_id).not.toBe(plain.j.material_id);
    const declared = jrun(["verify", "prepare", sub.j.material_id, "--candidates", c, "--reviews", r, "--db", f.db, "--no-meta", "--draft", "--json"]);
    expect(declared.j.verdict).toBe("error");
    expect(declared.j.coverage).toMatchObject({ pattern: "^(R-[0-9]+)：", clauses: 2, covered: 1 });
    expect(declared.j.diagnostics.find((d: any) => d.stage === "P1c").message).toMatch(/clause R-2 is not covered/);
    // the same text under the default convention declares no clauses: a named skip
    const dflt = jrun(["verify", "prepare", plain.j.material_id, "--candidates", c, "--reviews", r, "--db", f.db, "--no-meta", "--draft", "--json"]);
    expect(dflt.j.verdict).toBe("ready");
    expect(dflt.j.coverage).toMatchObject({ enforced: false, clauses: 0 });
    expect(dflt.j.diagnostics.find((d: any) => d.stage === "P1c").message).toMatch(/^no clause lines matched pattern/);
  });

  it("an exemption without a reason (bare string) is a usage error", () => {
    const f = fx("review/sync");
    const ex = write("bare-ex.json", ["S3"]);
    const r = jrun(["verify", "lint-candidates", join(f.dir, "candidates.json"), "--text", join(f.dir, "material.md"), "--coverage-exempt", ex, "--json"]);
    expect(r.rc).toBe(2);
    expect(r.j.error).toMatch(/reason is mandatory/);
  });

  it("--clause-pattern without an id capture group is a usage error (rc=2, JSON error)", () => {
    const f = fx("webui/unit");
    copyFileSync(join(f.dir, "candidates.json"), join(HOME, "unit-c.json"));
    const r = jrun(["verify", "lint-candidates", join(HOME, "unit-c.json"), "--text", join(f.dir, "material.md"), "--clause-pattern", "^[A-Z][0-9]+ ", "--json"]);
    expect(r.rc).toBe(2);
    expect(r.j.error).toMatch(/capture group/);
  });
});
