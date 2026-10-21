/**
 * 0.110.0 (可发现性): the seven-checker selection table is a single source
 * (`CHECKER_SELECTION` in bin.ts) rendered on BOTH faces — `--help` and the
 * llms manifest. These literals are the test lock: if either face drifts, the
 * type is easy to pick wrong again (count=存在断言 vs sql=违例扫描的反向坑).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { rc: r.status ?? -1, out: (r.stdout || "") + (r.stderr || "") };
}

const TYPES = ["count", "sql", "sql-pair", "exists", "file", "command", "agent"];
const PITFALLS = [
  "count>0 才是违规，PASS 含义相反",
  "空表/错表会假 PASS",
  "列对列只许同表",
];

describe.skipIf(!HAS_BIN)("0.110.0 checker selection table (help + llms, same source)", () => {
  it("--help renders all seven types with the count/sql pitfall", () => {
    const r = run(["--help"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("checker 选型");
    for (const t of TYPES) expect(r.out).toContain(`${t} `);
    for (const p of PITFALLS) expect(r.out).toContain(p);
  });

  it("llms manifest renders the same table (双面同源)", () => {
    const r = run(["llms"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("## Checker Selection (prepare candidates)");
    for (const t of TYPES) expect(r.out).toContain(`| ${t} |`);
    for (const p of PITFALLS) expect(r.out).toContain(p);
  });

  it("llms advertises the new discoverability commands", () => {
    const r = run(["llms"]);
    expect(r.out).toContain("verify example [--checker <type>]");
    expect(r.out).toContain("verify lint-candidates <file>");
  });
});
