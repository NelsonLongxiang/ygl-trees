/**
 * Contract 1.3 part 3 through the CLI (#80 items 6–8, #232): `verify collect archive` writes raw observations of a
 * tar.gz into a SQLite snapshot (no verdict columns, failures as `archive_errors` rows, deterministic bytes), and a
 * 1.3 spec judges them with the frozen AST. Every #232 case runs prepare → run → archive: hash differs, missing and
 * extra paths, duplicate, empty input, malformed path, malformed type, truncated, extraction bound. A snapshot with
 * error rows or no entries never yields PASS; the evidence carries the raw value next to the compared literal.
 *
 * The material, candidates, reviews and case archives are the ones in examples/verify-archive-collect/ — the
 * runnable example and this test exercise the same spec.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-ignore — plain ESM helper shared with the example
import { cases, GOOD, tar } from "../../../../examples/verify-archive-collect/make-archives.mjs";

const REPO = resolve(__dirname, "../../../..");
const EXAMPLE = join(REPO, "examples/verify-archive-collect");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
let home = "";
const CASES: Record<string, Buffer> = cases();

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" },
  });
  let json: any = null;
  try { json = JSON.parse((r.stdout || "").trim()); } catch { /* not json */ }
  return { rc: r.status ?? -1, json, text: (r.stdout || "") + (r.stderr || "") };
}

function collect(tag: string, bytes: Buffer, extra: string[] = []) {
  const input = join(home, `${tag}.tgz`);
  writeFileSync(input, bytes);
  const out = join(home, `${tag}.sqlite`);
  return { r: run(["verify", "collect", "archive", input, "--out", out, ...extra]), out };
}

let specId = "";
function verdicts(snapshot: string) {
  const r = run(["verify", "run", specId, "--db", snapshot]);
  expect(r.rc, r.text).toBe(0);
  const report = JSON.parse(readFileSync(join(home, "verify", "reports", `${r.json.run_id}.json`), "utf8"));
  const by = Object.fromEntries(report.vu.map((v: { verdict: string }, i: number) => [`S${i + 1}`, v.verdict])) as Record<string, string>;
  return { r, report, by };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(() => {
  if (!hasBundle) return;
  // verify judges the meta gate of the repo enclosing cwd: run in a neutral directory, like the other verify specs.
  home = mkdtempSync(join(tmpdir(), "ygl-collect13-"));
  expect(run(["db", "init"]).rc).toBe(0);
  const good = collect("good", CASES.good);
  expect(good.r.rc, good.r.text).toBe(0);
  const sub = run(["verify", "submit", "--title", "collect13", "--text", join(EXAMPLE, "material.md")]);
  expect(sub.rc, sub.text).toBe(0);
  const prep = run(["verify", "prepare", sub.json.material_id, "--candidates", join(EXAMPLE, "candidates.json"), "--reviews", join(EXAMPLE, "reviews.json"),
    "--db", good.out, "--as-of", "2026-11-11T00:00:00Z", "--candidates-author", "example-candidates", "--reviews-author", "example-reviews"]);
  expect(prep.rc, prep.text).toBe(0);
  specId = prep.json.spec_id;
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("verify collect archive → prepare → run → archive (#232 cases)", () => {
  it("collects deterministically and never overwrites; usage errors are rc 2", () => {
    // same input file (archive_meta records its name) → byte-identical snapshots
    const a = collect("det", CASES.good);
    const b = run(["verify", "collect", "archive", join(home, "det.tgz"), "--out", join(home, "det-again.sqlite")]);
    expect(a.r.json).toMatchObject({ entries: 3, errors: 0 });
    expect(b.json.sha256).toBe(a.r.json.sha256);
    expect(collect("det", CASES.good).r.rc).toBe(1);
    expect(run(["verify", "collect", "archive"]).rc).toBe(2);
    expect(run(["verify", "collect", "nope", "x", "--out", "y"]).rc).toBe(2);
    expect(run(["verify", "collect", "archive", "x", "--out", "y", "--max-entries", "0"]).rc).toBe(2);
  });

  it("the good package PASSes every clause as a 1.3 spec, and the run archives", () => {
    const { r, report } = verdicts(join(home, "good.sqlite"));
    expect(report.contract_version).toBe("1.3");
    expect(report.overall).toBe("PASS");
    expect(run(["verify", "archive", r.json.run_id]).rc).toBe(0);
  });

  it("hash differs → S1 FAIL; evidence shows the raw hash next to the compared literal", () => {
    const { r, report, by } = verdicts(collect("hash", CASES["hash-differs"]).out);
    expect(by).toEqual({ S1: "FAIL", S2: "PASS", S3: "PASS", S4: "PASS", S5: "PASS", S6: "PASS" });
    expect(report.vu[0].evidence.rows[0].payload_sha256).toBe(sha("evil();\n"));
    expect(report.vu[0].evidence.rendered.findSql).toContain(sha("module.exports = 1;\n"));
    expect(run(["verify", "archive", r.json.run_id]).rc).toBe(0);
  });

  it("missing path → S2 FAIL; extra path → S3 FAIL with the raw path; duplicate → S4 FAIL", () => {
    expect(verdicts(collect("missing", CASES["missing-path"]).out).by).toMatchObject({ S2: "FAIL", S3: "PASS" });
    const extra = verdicts(collect("extra", CASES["extra-path"]).out);
    expect(extra.by).toMatchObject({ S2: "PASS", S3: "FAIL" });
    expect(extra.report.vu[2].evidence.rows[0].path).toBe("package/.npmrc");
    const dup = verdicts(collect("dup", CASES.duplicate).out);
    expect(dup.by.S4).toBe("FAIL");
    expect(dup.report.vu[3].evidence.rows[0].path).toBe("package/index.js");
  });

  it("malformed paths → S5 FAIL naming the raw path; a symlink → S6 FAIL", () => {
    const paths: Record<string, string> = {
      "dotdot-path": "package/../evil.js", "absolute-path": "/etc/passwd", "backslash-path": "package\\win.js",
      "control-char-path": "package/a\u0007b", "outside-package": "other/x.js", "empty-segment": "package//x.js",
    };
    for (const [name, bad] of Object.entries(paths)) {
      const { by, report } = verdicts(collect(name, CASES[name]).out);
      expect(by.S5, name).toBe("FAIL");
      expect(report.vu[4].evidence.rows.map((x: { path: string }) => x.path), name).toContain(bad);
    }
    const typ = verdicts(collect("symlink", CASES.symlink).out);
    expect(typ.by.S6).toBe("FAIL");
    expect(typ.report.vu[5].evidence.rows[0]).toMatchObject({ path: "package/link", typeflag: "2" });
  });

  it("empty input never passes: an empty file is an error row, an empty archive is a zero scan", () => {
    const file = collect("empty-file", CASES["empty-file"]);
    expect(file.r.json).toMatchObject({ entries: 0, errors: 1 });
    for (const snap of [file.out, collect("empty-archive", CASES["empty-archive"]).out]) {
      const { by, report } = verdicts(snap);
      expect(Object.values(by)).not.toContain("PASS");
      expect(report.overall).not.toBe("PASS");
    }
  });

  it("truncated archive, bad header checksum and the extraction bound: error rows, and no clause PASSes", () => {
    const trunc = collect("trunc", CASES.truncated);
    const cksum = collect("cksum", CASES["bad-checksum"]);
    const bound = collect("bound", CASES.good, ["--max-entries", "2"]);
    expect(bound.r.json).toMatchObject({ entries: 2, errors: 1 });
    for (const c of [trunc, cksum, bound]) {
      expect(c.r.json.errors).toBeGreaterThan(0);
      const { r, by, report } = verdicts(c.out);
      expect(Object.values(by)).not.toContain("PASS");
      const err = report.vu.find((v: { verdict: string }) => v.verdict === "ERROR");
      expect(JSON.stringify(err.evidence)).toContain("input_errors");
      // #270: the summary agrees with the units, so the archive re-verifies
      expect(report.summary.pass).toBe(0);
      expect(report.summary.error).toBe(Object.values(by).filter((v) => v === "ERROR").length);
      expect(r.json.archive?.path, r.text).toBeTruthy();
      const av = run(["verify", "archive", "verify", r.json.archive.path]);
      expect(av.rc, av.text).toBe(0);
    }
  });

  it("the helper builds the same archives the example's README uses", () => {
    expect(tar(GOOD).length % 512).toBe(0);
    expect(Object.keys(CASES)).toEqual(expect.arrayContaining(["good", "hash-differs", "missing-path", "extra-path", "duplicate", "empty-file", "empty-archive", "truncated", "symlink"]));
  });
});
