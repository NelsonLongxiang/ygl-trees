/**
 * 0.110.0 (可发现性): `verify lint-candidates` is the prepare gate as a
 * read-only projection — no spec file, no spec_version bump, no events. The
 * shared-fixture test is the fdc757f6 condition: for the same candidates,
 * lint's rejection set must equal prepare's P1/P2 rejection set (one gate, not
 * two lookalikes).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let candFile = "";
let matFile = "";
let snap = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function jrun(args: string[]) {
  const r = run(args);
  let j: any = null;
  try {
    j = JSON.parse(r.out);
  } catch {
    j = null;
  }
  return { rc: r.rc, j, raw: r.out };
}

const ANCHOR = (quote: string, n: number) => ({ quote, locator: `material.txt#L${n}` });

function sqlCandidate(clause: string, col: string, n: number) {
  return {
    source_clause: clause,
    anchor: ANCHOR(clause, n),
    checker: {
      type: "sql",
      fail_when: "rows>0",
      predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col, op: "<", value: 0 }] } },
    },
  };
}

describe.skipIf(!HAS_BIN)("verify lint-candidates (0.110.0)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-lint-"));
    run(["db", "init"]);
    run(["project", "new", "alpha"]);
    matFile = join(HOME, "material.txt");
    writeFileSync(matFile, "账单金额不得为负。\n未知列不得参与判据。\n", "utf8");
    snap = join(HOME, "snap.sqlite");
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE bills (id TEXT PRIMARY KEY, amount_cents INTEGER)");
    db.close();
    candFile = join(HOME, "candidates.json");
    writeFileSync(
      candFile,
      JSON.stringify({
        candidates: [
          sqlCandidate("账单金额不得为负。", "amount_cents", 1),
          sqlCandidate("未知列不得参与判据。", "no_such_col", 2),
        ],
      }),
      "utf8",
    );
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reports P2 shapes without writing a spec or consuming spec_version", () => {
    const before = existsSync(join(HOME, "verify", "specs")) ? readdirSync(join(HOME, "verify", "specs")).length : 0;
    const r = jrun(["verify", "lint-candidates", candFile, "--text", matFile, "--db", snap, "--json"]);
    expect(r.rc).toBe(0); // process semantics: verdict lives in the payload
    expect(r.j.checked).toBe(2);
    expect(r.j.p1_skipped).toBe(false);
    expect(r.j.schema_skipped).toBe(false);
    expect(r.j.ok).toBe(false);
    expect(r.j.issues).toHaveLength(1);
    expect(r.j.issues[0]).toMatchObject({ index: 1, stage: "P2", source_clause: "未知列不得参与判据。" });
    expect(String(r.j.issues[0].reason)).toMatch(/column|schema/i);
    const after = existsSync(join(HOME, "verify", "specs")) ? readdirSync(join(HOME, "verify", "specs")).length : 0;
    expect(after).toBe(before); // nothing frozen, nothing bumped
    expect(existsSync(join(HOME, "verify", "prepares"))).toBe(false);
  });

  it("declares P1 skipped instead of silently passing when --text is absent", () => {
    const r = jrun(["verify", "lint-candidates", candFile, "--db", snap, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.p1_skipped).toBe(true);
    // second clause is still rejected on P2 shape (schema is supplied)
    expect(r.j.ok).toBe(false);
  });

  it("declares P2 schema skipped without --db (rejection set == prepare only with schema)", () => {
    const r = jrun(["verify", "lint-candidates", candFile, "--text", matFile, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.schema_skipped).toBe(true);
    // the bad-column candidate cannot be judged without a probed snapshot
    expect(r.j.ok).toBe(true);
  });

  it("unknown flags are usage errors (rc=2, single object)", () => {
    const r = jrun(["verify", "lint-candidates", candFile, "--bogus", "--json"]);
    expect(r.rc).toBe(2);
    expect(String(r.j?.error)).toMatch(/unknown flag/);
  });

  it("file candidate gets an actionable P4 diagnostic (no attachment staging)", () => {
    const clause = "附件清单必须包含验收记录。";
    const mat2 = join(HOME, "file-material.txt");
    writeFileSync(mat2, clause + "\n", "utf8");
    const sub = jrun(["verify", "submit", "--title", "file-candidate", "--text", mat2, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = sub.j.material_id as string;
    const fileCand = join(HOME, "file-cand.json");
    writeFileSync(
      fileCand,
      JSON.stringify({
        candidates: [
          {
            source_clause: clause,
            anchor: ANCHOR(clause, 1),
            checker: { type: "file", glob: "*.md", min: 1 },
          },
        ],
      }),
      "utf8",
    );
    const reviews = join(HOME, "file-reviews.json");
    writeFileSync(
      reviews,
      JSON.stringify({
        reviews: [
          {
            source_clause: clause,
            findings: [
              { question: "faithful", verdict: "ok", reason: "逐字对应", anchor: ANCHOR(clause, 1) },
              { question: "decidable", verdict: "ok", reason: "有机械判据", anchor: ANCHOR(clause, 1) },
              { question: "not-vacuous", verdict: "ok", reason: "附件为空应 NM/ERROR", anchor: ANCHOR(clause, 1) },
            ],
          },
        ],
      }),
      "utf8",
    );
    const r = jrun(["verify", "prepare", materialId, "--candidates", fileCand, "--reviews", reviews, "--db", snap, "--draft", "--json"]);
    expect(r.rc).toBe(1); // no frozen spec
    expect(r.j.verdict).toBe("error");
    const diag = (r.j.diagnostics as any[]).map((d) => String(d.message)).join("\n");
    expect(diag).toMatch(/file checker: no attachments were staged/);
    expect(diag).toMatch(/verify submit --attach/);
  });

  it("file candidate with a submitted attachment freezes (P4 runs on staged attachments)", () => {
    const clause = "附件清单必须包含验收记录。";
    const mat3 = join(HOME, "file-material2.txt");
    writeFileSync(mat3, clause + "\n", "utf8");
    const att = join(HOME, "evidence.md");
    writeFileSync(att, "# evidence\n", "utf8");
    const sub = jrun(["verify", "submit", "--title", "file-with-attach", "--text", mat3, "--attach", att, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = sub.j.material_id as string;
    const fileCand = join(HOME, "file-cand2.json");
    writeFileSync(
      fileCand,
      JSON.stringify({
        candidates: [
          {
            source_clause: clause,
            anchor: ANCHOR(clause, 1),
            checker: { type: "file", glob: "*.md", min: 1 },
          },
        ],
      }),
      "utf8",
    );
    const reviews = join(HOME, "file-reviews2.json");
    writeFileSync(
      reviews,
      JSON.stringify({
        reviews: [
          {
            source_clause: clause,
            findings: [
              { question: "faithful", verdict: "ok", reason: "逐字对应", anchor: ANCHOR(clause, 1) },
              { question: "decidable", verdict: "ok", reason: "有机械判据", anchor: ANCHOR(clause, 1) },
              { question: "not-vacuous", verdict: "ok", reason: "附件为空应 NM", anchor: ANCHOR(clause, 1) },
            ],
          },
        ],
      }),
      "utf8",
    );
    const r = jrun(["verify", "prepare", materialId, "--candidates", fileCand, "--reviews", reviews, "--db", snap, "--draft", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("ready");
    expect(r.j.units).toBe(1);
    // P0 may note a known-material hash; the P4 red-team gate must be clean
    expect((r.j.diagnostics as any[]).every((d) => d.stage !== "P4")).toBe(true);
  });

  it("same candidates → lint rejection set == prepare rejected set (shared gate)", () => {
    const lint = jrun(["verify", "lint-candidates", candFile, "--text", matFile, "--db", snap, "--json"]);
    expect(lint.rc).toBe(0);
    expect(lint.j.ok).toBe(false);

    const sub = jrun(["verify", "submit", "--title", "lint-equivalence", "--text", matFile, "--json"]);
    expect(sub.rc).toBe(0);
    const materialId = sub.j.material_id as string;
    // P3 reviews keyed by source_clause (fileReviewer shape); candidate 1 must
    // pass P3 so both sides hold exactly one deterministic P2 rejection.
    const reviews = join(HOME, "reviews.json");
    writeFileSync(
      reviews,
      JSON.stringify({
        reviews: [
          {
            source_clause: "账单金额不得为负。",
            findings: [
              { question: "faithful", verdict: "ok", reason: "逐字对应", anchor: ANCHOR("账单金额不得为负。", 1) },
              { question: "decidable", verdict: "ok", reason: "有机械判据", anchor: ANCHOR("账单金额不得为负。", 1) },
              { question: "not-vacuous", verdict: "ok", reason: "空表会被判 NM", anchor: ANCHOR("账单金额不得为负。", 1) },
            ],
          },
        ],
      }),
      "utf8",
    );
    const prep = jrun(["verify", "prepare", materialId, "--candidates", candFile, "--reviews", reviews, "--db", snap, "--draft", "--json"]);
    expect([0, 1]).toContain(prep.rc);
    const prepareRejected = (prep.j.rejected_detail as any[]).map((x) => ({ index: x.index ?? null, stage: x.stage, reason: x.reason, source_clause: x.source_clause }));
    // #21: deterministic rejections are no longer replayed across rounds, so
    // the two lists must be EQUAL (same order, same content) — not just sets.
    const prepList = prepareRejected.map((x) => `${x.stage}\\u0000${x.reason}\\u0000${x.source_clause}`);
    const lintList = (lint.j.issues as any[]).map((x) => `${x.stage}\\u0000${x.reason}\\u0000${x.source_clause}`);
    expect(lintList.length).toBeGreaterThan(0);
    expect(prepList).toEqual(lintList);
  });
});
