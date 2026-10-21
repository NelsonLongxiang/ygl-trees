#!/usr/bin/env node
/**
 * 0.110.0: derive `verify example` data from the FROZEN corpus.
 *
 * The corpus is the single source of truth (digest-frozen, TS/Rust parity
 * tested). A separate examples directory would be a second shape truth and
 * would drift; instead this script emits a checked-in TS module and
 * `verify-example.spec.ts` re-runs it with `--check` (golden drift guard).
 *
 * The checker → case mapping is an EXPLICIT constant: readdir order is not a
 * contract, and a case reorder must not silently change the published example.
 *
 * Usage: node scripts/gen-examples.mjs [--check]
 *   --check  exit 1 if the committed file differs (CI / unit test)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const CASES = join(root, "packages/verify/core/corpus/cases");
const MANIFEST = join(root, "packages/verify/core/corpus/manifest.json");
const OUT = join(root, "packages/verify/core/src/examples.generated.ts");

/** Explicit, frozen mapping — changing it is a reviewable act, not a side effect. */
const CHECKER_TO_CASE = {
  sql: "sql-find-violation",
  "sql-pair": "sql-pair-tolerance",
  count: "count-batch-coverage",
  exists: "exists-attachment-registered",
  file: "file-attachment-glob",
  command: "command-exit-code",
  agent: "agent-sealed-rejected",
};

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const derivedFrom = `corpus ${manifest.corpus_version} (${manifest.entries.length} files, digest ${manifest.digest.slice(0, 16)}…)`;

const examples = [];
for (const [checker, caseId] of Object.entries(CHECKER_TO_CASE)) {
  const dir = join(CASES, caseId);
  const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
  if (meta.checker !== checker) {
    throw new Error(`explicit map mismatch: ${caseId} is '${meta.checker}', mapped as '${checker}'`);
  }
  examples.push({
    checker,
    case_id: caseId,
    spec_id: spec.spec_id,
    tags: meta.tags ?? [],
    expects: meta.expects ?? "",
    contract_version: spec.contract_version,
    spec_version: spec.spec_version,
    vu: spec.vu,
  });
}

const NULL_OPS_NOTE = {
  ops: ["is null", "is not null"],
  note:
    "NULL 谓词写法：条件 {" + '"col":"<column>","op":"is null"' + "}（is not null 同理）。" +
    "COUNT 口径注意：agg:\"count\" 是 count(col)，跳过 NULL；空表/全 NULL 时 count=0，而 max/min/sum 产 NULL（count.against 右值为 NULL → ERROR）。",
  example: {
    source_clause: "关闭时间未记录的工单不得计入本期完成。",
    anchor: { quote: "关闭时间未记录的工单不得计入本期完成。", locator: "material.txt#L1" },
    checker: {
      type: "sql",
      fail_when: "rows>0",
      predicate: {
        from: "tickets",
        select: ["id"],
        where: { op: "and", conditions: [{ col: "closed_at", op: "is null" }] },
      },
    },
  },
  _derived_from: "verify-contract.md §1.5 (syntax note, not a corpus case)",
};

const body = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: ${derivedFrom}
 * Regenerate: node scripts/gen-examples.mjs --write   (golden check: --check)
 * The checker→case map is explicit in the generator (readdir order is not a contract).
 */
export interface CornerExample {
  checker: string;
  case_id: string;
  spec_id: string;
  tags: string[];
  expects: string;
  contract_version: string;
  spec_version: number;
  vu: unknown[];
}

export const EXAMPLES_DERIVED_FROM = ${JSON.stringify(derivedFrom)};

export const CHECKER_EXAMPLES: CornerExample[] = ${JSON.stringify(examples)};

export const NULL_OPS_NOTE = ${JSON.stringify(NULL_OPS_NOTE)};
`;

const check = process.argv.includes("--check");
const existing = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return "";
  }
})();

if (check) {
  if (existing !== body) {
    console.error("examples.generated.ts is stale — run: node scripts/gen-examples.mjs --write");
    process.exit(1);
  }
  console.log("examples.generated.ts is in sync with the corpus");
  process.exit(0);
}

writeFileSync(OUT, body, "utf8");
console.log(`wrote ${OUT.slice(root.length + 1)} (${examples.length} examples, ${derivedFrom})`);
