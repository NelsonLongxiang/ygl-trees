/**
 * GitHub #34 consumer fixtures: real fleet materials (title + prose + `## 判据`
 * + `<id> <text>` clauses + `## 纪律`) with their committed candidates/reviews,
 * frozen under tests/fixtures/fleet (sources and commits in manifest.json).
 * 0.114.1/0.114.2 failed every one of them (prose counted as clauses, `#S1`/`#L2`
 * read as line numbers). The release gate now asserts lint ok + prepare ready on
 * all of them, and that a dropped clause / bad locator / orphan review on the
 * same real material is still refused.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ReviewFinding, ReviewRunner } from "../src/contract";
import { lintCandidates, prepareSpec, type PrepareCandidate } from "../src/prepare";

const ROOT = resolve(__dirname, "fixtures/fleet");
const AS_OF = { kind: "snapshot" as const, value: "2026-10-22T00:00:00.000Z" };

type Review = { source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> };
interface Fixture {
  name: string;
  material: string;
  candidates: PrepareCandidate[];
  reviews: Review[];
}

function load(dir: string, name: string): Fixture {
  const json = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const c = json("candidates.json");
  const r = json("reviews.json");
  return {
    name,
    material: readFileSync(join(dir, "material.md"), "utf8"),
    candidates: Array.isArray(c) ? c : c.candidates,
    reviews: Array.isArray(r) ? r : r.reviews,
  };
}

const FIXTURES: Fixture[] = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((repo) =>
    readdirSync(join(ROOT, repo.name), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((spec) => load(join(ROOT, repo.name, spec.name), `${repo.name}/${spec.name}`)),
  );

/** Same pairing rule as the CLI's file reviewer: by source_clause, VU id stamped. */
function fileReviewer(reviews: Review[]): ReviewRunner {
  return {
    async review(req) {
      const hit = reviews.find((r) => r.source_clause === req.vu.source_clause);
      return (hit?.findings ?? []).map((f) => ({ ...f, vu_id: req.vu.id }) as ReviewFinding);
    },
  };
}

const prepare = (fx: Fixture, candidates = fx.candidates, reviews = fx.reviews) =>
  prepareSpec(fx.material, {
    runner: { prepare: async () => candidates },
    reviewer: fileReviewer(reviews),
    reviewedClauses: reviews.map((r) => r.source_clause),
    redteam: () => [],
    asOf: AS_OF,
  });

const byName = (n: string) => FIXTURES.find((f) => f.name === n)!;

describe("#34 fleet consumer fixtures (release gate)", () => {
  it("fixture set is the frozen fleet snapshot (4 repos, 24 specs)", () => {
    expect(new Set(FIXTURES.map((f) => f.name.split("/")[0]))).toEqual(new Set(["review", "webui", "fleet", "design"]));
    expect(FIXTURES).toHaveLength(24);
  });

  for (const fx of FIXTURES) {
    it(`${fx.name}: lint --text ok, clauses ↔ candidates ↔ reviews 1:1`, () => {
      const res = lintCandidates(fx.candidates, { materialText: fx.material, reviewedClauses: fx.reviews.map((r) => r.source_clause) });
      expect(res.issues).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.coverage?.clauses).toBe(fx.candidates.length);
      expect(res.coverage?.covered).toBe(fx.candidates.length);
    });

    it(`${fx.name}: prepare reaches ready`, async () => {
      const res = await prepare(fx);
      expect(res.rejected).toEqual([]);
      expect(res.verdict).toBe("ready");
      expect(res.spec?.vu).toHaveLength(fx.candidates.length);
    });
  }

  // Negatives on real materials whose ids start with S / L (the 0.114.1 collision).
  for (const name of ["review/sync", "review/ledger", "design/literals"]) {
    it(`${name}: a dropped clause is named and blocks ready`, async () => {
      const fx = byName(name);
      const dropped = fx.candidates[fx.candidates.length - 1];
      const id = dropped.source_clause.split(" ")[0];
      const lint = lintCandidates(fx.candidates.slice(0, -1), { materialText: fx.material });
      expect(lint.ok).toBe(false);
      expect(lint.coverage?.uncovered.map((u) => u.id)).toEqual([id]);
      const res = await prepare(fx, fx.candidates.slice(0, -1), fx.reviews.slice(0, -1));
      expect(res.verdict).toBe("error");
      expect(res.spec).toBeUndefined();
      expect(res.diagnostics.map((d) => d.message).join("\n")).toContain(`clause ${id} is not covered`);
    });

    it(`${name}: a bad locator is a P1 rejection`, async () => {
      const fx = byName(name);
      const bad = { ...fx.candidates[0], anchor: { ...fx.candidates[0].anchor, locator: "material.md#S99" } };
      const lint = lintCandidates([bad, ...fx.candidates.slice(1)], { materialText: fx.material });
      expect(lint.issues[0]).toMatchObject({ index: 0, stage: "P1" });
      expect(lint.issues[0].reason).toMatch(/names clause "S99", which the frozen material does not declare/);
      const res = await prepare(fx, [bad, ...fx.candidates.slice(1)]);
      expect(res.verdict).not.toBe("ready");
      expect(res.rejected[0]).toMatchObject({ stage: "P1" });
    });

    it(`${name}: an orphan review blocks ready`, async () => {
      const fx = byName(name);
      const orphan: Review = { ...fx.reviews[0], source_clause: "X9 a criterion that was dropped after review." };
      const reviews = [...fx.reviews, orphan];
      const lint = lintCandidates(fx.candidates, { materialText: fx.material, reviewedClauses: reviews.map((r) => r.source_clause) });
      expect(lint.issues).toEqual([expect.objectContaining({ stage: "REVIEW", source_clause: orphan.source_clause })]);
      const res = await prepare(fx, fx.candidates, reviews);
      expect(res.verdict).toBe("error");
      expect(res.diagnostics.find((d) => d.stage === "P3")?.message).toMatch(/orphan review/);
    });
  }
});
