/**
 * `verify meta` v1 (charter §4.1, 0.111.0): verifier-repo admission rules
 * R1 AGENTS.md, R2 verify/meta.json ↔ spec files, R3 no stray executables.
 * rc mirrors the report verdict (0 PASS / 1 FAIL / 2 usage).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let HOME = "";
let base = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

function repoFixture(name: string, agents = true): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "AGENTS.md"), "# fixture\n", "utf8");
  return dir;
}

describe.skipIf(!HAS_BIN)("verify meta R1-R3 (0.111.0)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-meta-home-"));
    jrun(["db", "init"]);
    base = mkdtempSync(join(tmpdir(), "ygl-meta-repos-"));
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("PASS: AGENTS.md present, empty but valid meta index, no stray scripts", () => {
    const dir = repoFixture("good");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "verify"), { recursive: true });
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
    writeFileSync(join(dir, "scripts", "release.sh"), "#!/bin/sh\n", "utf8"); // intentional home, not loose
    const r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("PASS");
    expect(r.j.meta_version).toBe("1.2");
    // a v1 index keeps the v1 report shape: R1–R3 only, registrations not read
    expect(r.j.meta_index_version).toBe(1);
    expect(r.j.rules.map((x: any) => x.id)).toEqual(["R1", "R2", "R3"]);
    expect(r.j.rules.every((x: any) => x.verdict === "PASS")).toBe(true);
  });

  // ── meta_index_version 2 (charter v1.1 §4.4 registrations, v1.2 R5a; #27 plan T7a)
  const v2 = (extra: Record<string, unknown> = {}) => JSON.stringify({ meta_index_version: 2, specs: [], orchestration: [], tooling: [], ...extra });
  const rule = (r: any, id: string) => r.j.rules.find((x: any) => x.id === id);

  it("v2: explicit empty registrations judge PASS and add R5a to the report", () => {
    const dir = repoFixture("v2-empty");
    mkdirSync(join(dir, "verify"), { recursive: true });
    writeFileSync(join(dir, "verify", "meta.json"), v2(), "utf8");
    const r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("PASS");
    expect(r.j.meta_index_version).toBe(2);
    expect(r.j.rules.map((x: any) => x.id)).toEqual(["R1", "R2", "R3", "R5a"]);
    expect(rule(r, "R5a").evidence).toMatchObject({ entries: 0 });
    expect(String(rule(r, "R5a").evidence.clock)).toMatch(/not compared/);
  });

  it("v2 source_roots: declared product root exempts .ts; a root-level .ts still needs registration", () => {
    const dir = repoFixture("v2-roots");
    mkdirSync(join(dir, "verify"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(join(dir, "vitest.config.ts"), "export default {};\n", "utf8");
    writeFileSync(join(dir, "verify", "meta.json"), v2({ source_roots: ["src"] }), "utf8");
    // src/app.ts is exempt by declaration; vitest.config.ts is root-level → scanned
    let r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(JSON.stringify(rule(r, "R3").evidence)).toMatch(/vitest\.config\.ts/);
    expect(JSON.stringify(rule(r, "R3").evidence)).not.toMatch(/src\/app\.ts/);
    writeFileSync(join(dir, "verify", "meta.json"), v2({ source_roots: ["src"], tooling: [{ path: "vitest.config.ts", sha256: sha("export default {};\n"), role: "test" }] }), "utf8");
    r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("PASS");
  });

  it("v2 source_roots: '.', '..' or absolute entries are R2 shape failures", () => {
    const dir = repoFixture("v2-roots-bad");
    mkdirSync(join(dir, "verify"), { recursive: true });
    for (const bad of [".", "../x", "/abs", "src/"]) {
      writeFileSync(join(dir, "verify", "meta.json"), v2({ source_roots: [bad] }), "utf8");
      const r = jrun(["verify", "meta", dir, "--json"]);
      expect(r.rc, bad).toBe(1);
      expect(rule(r, "R2").verdict, bad).toBe("FAIL");
      expect(JSON.stringify(rule(r, "R2").evidence), bad).toMatch(/source_roots/);
    }
  });

  it("v2 .ts closure: without source_roots every tracked .ts is an unregistered executable", () => {
    const dir = repoFixture("v2-ts-strict");
    mkdirSync(join(dir, "verify"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "run.ts"), "console.log(1);\n", "utf8");
    writeFileSync(join(dir, "verify", "meta.json"), v2(), "utf8");
    const r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(JSON.stringify(rule(r, "R3").evidence)).toMatch(/lib\/run\.ts/);
  });

  it("v2 R3: a root script is admissible only when registered in tooling[] with a matching sha256", () => {
    const dir = repoFixture("v2-tooling");
    mkdirSync(join(dir, "verify"), { recursive: true });
    const body = "#!/usr/bin/env node\nconsole.log('build');\n";
    writeFileSync(join(dir, "build.mjs"), body, "utf8");
    // unregistered → stray (same as v1)
    writeFileSync(join(dir, "verify", "meta.json"), v2(), "utf8");
    expect(rule(jrun(["verify", "meta", dir, "--json"]), "R3").verdict).toBe("FAIL");
    // registered with the right sha → admissible
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "build.mjs", sha256: sha(body), role: "build" }] }), "utf8");
    const ok = jrun(["verify", "meta", dir, "--json"]);
    expect(ok.rc).toBe(0);
    expect(rule(ok, "R3")).toMatchObject({ verdict: "PASS", evidence: { registered: { orchestration: 0, tooling: 1 } } });
    // registered but the file changed → not admissible, named
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "build.mjs", sha256: sha("other"), role: "build" }] }), "utf8");
    const drift = rule(jrun(["verify", "meta", dir, "--json"]), "R3");
    expect(drift.verdict).toBe("FAIL");
    expect(drift.evidence.problems.join(" ")).toMatch(/registered tooling sha256 mismatch: build\.mjs/);
    // registration shape is R2's: unknown role / bad sha hex / duplicate path
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "build.mjs", sha256: sha(body), role: "orchestrate" }] }), "utf8");
    const badRole = rule(jrun(["verify", "meta", dir, "--json"]), "R2");
    expect(badRole.verdict).toBe("FAIL");
    expect(badRole.evidence.problems.join(" ")).toMatch(/role "orchestrate" not in build\|test\|release\|gate/);
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "build.mjs", sha256: "abc", role: "build" }, { path: "build.mjs", sha256: sha(body), role: "gate" }] }), "utf8");
    const dup = rule(jrun(["verify", "meta", dir, "--json"]), "R2");
    expect(dup.evidence.problems.join(" ")).toMatch(/sha256 must be 64 lowercase hex/);
    expect(dup.evidence.problems.join(" ")).toMatch(/registered twice/);
    // v2 also scans .py (charter R3 list); v1 keeps its original scan set
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "build.mjs", sha256: sha(body), role: "build" }] }), "utf8");
    writeFileSync(join(dir, "probe.py"), "print(1)\n", "utf8");
    expect(rule(jrun(["verify", "meta", dir, "--json"]), "R3").evidence.problems.join(" ")).toMatch(/loose script at repo root: probe\.py/);
  });

  it("v2 R3 (#22, reviewer P2): a scripts/ file is no longer exempt by directory name — registration is the only exemption", () => {
    const dir = repoFixture("v2-scripts-dir");
    mkdirSync(join(dir, "verify", "specs"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const specRel = "verify/specs/s1.json";
    const specBody = '{"spec_id":"spec_meta_3"}\n';
    writeFileSync(join(dir, specRel), specBody, "utf8");
    const runner = "#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nspawnSync('ygl-trees', ['verify', 'run', 'spec_x', '--db', 'snap.sqlite']);\n";
    writeFileSync(join(dir, "scripts", "run.mjs"), runner, "utf8");
    const specs = [{ file: specRel, sha256: sha(specBody) }];
    // unregistered → stray, even under scripts/ (v1 would have waved it through by directory)
    writeFileSync(join(dir, "verify", "meta.json"), v2({ specs }), "utf8");
    const stray = jrun(["verify", "meta", dir, "--json"]);
    expect(stray.rc).toBe(1);
    expect(rule(stray, "R3").evidence.problems.join(" ")).toMatch(/unregistered executable: scripts\/run\.mjs/);
    // registered as tooling → still refused: it drives verification in a repo that lists specs
    writeFileSync(join(dir, "verify", "meta.json"), v2({ specs, tooling: [{ path: "scripts/run.mjs", sha256: sha(runner), role: "test" }] }), "utf8");
    const drives = rule(jrun(["verify", "meta", dir, "--json"]), "R3");
    expect(drives.verdict).toBe("FAIL");
    expect(drives.evidence.problems.join(" ")).toMatch(/tooling must not drive verification.*scripts\/run\.mjs/);
    expect(drives.evidence.problems.join(" ")).not.toMatch(/unregistered executable/); // judged once, not twice
    // the v1 index keeps the 0.112.0 directory allowlist (read-compat): same file, no finding
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs }), "utf8");
    expect(rule(jrun(["verify", "meta", dir, "--json"]), "R3").verdict).toBe("PASS");
  });

  it("v2 R3: the argv-array idiom ygl([\"verify\", \"run\", …]) counts as driving verification", () => {
    const dir = repoFixture("v2-argv-form");
    mkdirSync(join(dir, "verify", "specs"), { recursive: true });
    const specRel = "verify/specs/s1.json";
    const specBody = '{"spec_id":"spec_meta_4"}\n';
    writeFileSync(join(dir, specRel), specBody, "utf8");
    const body = 'import { ygl } from "./lib/common.mjs";\nconst r = ygl(["verify", "run", specId, "--db", file]);\n';
    writeFileSync(join(dir, "judge.mjs"), body, "utf8");
    writeFileSync(join(dir, "verify", "meta.json"), v2({ specs: [{ file: specRel, sha256: sha(specBody) }], tooling: [{ path: "judge.mjs", sha256: sha(body), role: "gate" }] }), "utf8");
    const r3 = rule(jrun(["verify", "meta", dir, "--json"]), "R3");
    expect(r3.verdict).toBe("FAIL");
    expect(r3.evidence.problems.join(" ")).toMatch(/tooling must not drive verification.*judge\.mjs/);
  });

  it("v2 R3 in a git checkout: gitignored build output is out of scope, an untracked script is in", () => {
    const dir = repoFixture("v2-git");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "verify"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, "tmp"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "dist/\ntmp/\n", "utf8");
    writeFileSync(join(dir, "dist", "bin.cjs"), "module.exports = 1;\n", "utf8"); // ignored → never a candidate
    writeFileSync(join(dir, "tmp", "scratch.sh"), "#!/bin/sh\n", "utf8"); // tmp/ exempt and gitignored
    const hack = "#!/bin/sh\necho hack\n";
    writeFileSync(join(dir, "hack.sh"), hack, "utf8"); // untracked, not ignored → a stray
    writeFileSync(join(dir, "verify", "meta.json"), v2(), "utf8");
    const r = jrun(["verify", "meta", dir, "--json"]);
    const problems = rule(r, "R3").evidence.problems.join(" ");
    expect(problems).toMatch(/loose script at repo root: hack\.sh/);
    expect(problems).not.toMatch(/dist\/bin\.cjs/);
    expect(problems).not.toMatch(/tmp\/scratch\.sh/);
    writeFileSync(join(dir, "verify", "meta.json"), v2({ tooling: [{ path: "hack.sh", sha256: sha(hack), role: "build" }] }), "utf8");
    const ok = jrun(["verify", "meta", dir, "--json"]);
    expect(ok.rc).toBe(0);
    expect(rule(ok, "R3")).toMatchObject({ verdict: "PASS", evidence: { registered: { tooling: 1 } } });
  });

  it("v2 R3: tooling must not drive verification in a repo that lists specs", () => {
    const dir = repoFixture("v2-tooling-drives");
    mkdirSync(join(dir, "verify", "specs"), { recursive: true });
    const specRel = "verify/specs/s1.json";
    const specBody = '{"spec_id":"spec_meta_2"}\n';
    writeFileSync(join(dir, specRel), specBody, "utf8");
    const gate = "#!/bin/sh\nygl-trees verify run spec_x --db snap.sqlite\n";
    writeFileSync(join(dir, "gate.sh"), gate, "utf8");
    const index = (specs: unknown[]) => v2({ specs, tooling: [{ path: "gate.sh", sha256: sha(gate), role: "gate" }] });
    // no specs listed → a tooling script may call verify (e.g. a product's own smoke test)
    writeFileSync(join(dir, specRel), specBody, "utf8");
    rmSync(join(dir, "verify", "specs"), { recursive: true, force: true });
    writeFileSync(join(dir, "verify", "meta.json"), index([]), "utf8");
    expect(rule(jrun(["verify", "meta", dir, "--json"]), "R3").verdict).toBe("PASS");
    // specs listed → the same script must be orchestration (with a sunset), not tooling
    mkdirSync(join(dir, "verify", "specs"), { recursive: true });
    writeFileSync(join(dir, specRel), specBody, "utf8");
    writeFileSync(join(dir, "verify", "meta.json"), index([{ file: specRel, sha256: sha(specBody) }]), "utf8");
    const r3 = rule(jrun(["verify", "meta", dir, "--json"]), "R3");
    expect(r3.verdict).toBe("FAIL");
    expect(r3.evidence.problems.join(" ")).toMatch(/tooling must not drive verification.*gate\.sh/);
  });

  it("v2 R5a: declared orchestration must sit under verify/orchestration/ with sha, §4.7 replaced_by and a full semver sunset — no clock", () => {
    const dir = repoFixture("v2-orchestration");
    mkdirSync(join(dir, "verify", "orchestration"), { recursive: true });
    const body = "export const run = () => 0;\n";
    writeFileSync(join(dir, "verify", "orchestration", "run.mjs"), body, "utf8");
    const entry = (over: Record<string, unknown> = {}) => ({ path: "verify/orchestration/run.mjs", sha256: sha(body), role: "invoke", replaced_by: "verify tree run", sunset: "0.120.0", ...over });
    const judge = (e: Record<string, unknown>) => {
      writeFileSync(join(dir, "verify", "meta.json"), v2({ orchestration: [e] }), "utf8");
      return jrun(["verify", "meta", dir, "--json"]);
    };
    // valid entry: R3 exempts the file by registration, R5a PASS, and a far
    // sunset on an old engine is NOT compared (R5b is audit-side)
    const ok = judge(entry());
    expect(ok.rc).toBe(0);
    expect(rule(ok, "R3").verdict).toBe("PASS");
    expect(rule(ok, "R5a")).toMatchObject({ verdict: "PASS", evidence: { entries: 1 } });
    const past = judge(entry({ sunset: "0.1.0" }));
    expect(rule(past, "R5a").verdict).toBe("PASS"); // static rule: no clock comparison
    // each R5a defect is named
    expect(rule(judge(entry({ replaced_by: "verify tree-run" })), "R5a").evidence.problems.join(" ")).toMatch(/replaced_by "verify tree-run" is not a §4\.7 primitive/);
    expect(rule(judge(entry({ sunset: "0.120" })), "R5a").evidence.problems.join(" ")).toMatch(/sunset must be a full MAJOR\.MINOR\.PATCH/);
    expect(rule(judge(entry({ sha256: sha("drift") })), "R5a").evidence.problems.join(" ")).toMatch(/orchestration sha256 mismatch/);
    // outside verify/orchestration/: R5a names the location AND R3 still sees a stray file
    writeFileSync(join(dir, "run.mjs"), body, "utf8");
    const outside = judge(entry({ path: "run.mjs" }));
    expect(rule(outside, "R5a").evidence.problems.join(" ")).toMatch(/must be under verify\/orchestration\//);
    expect(rule(outside, "R3").evidence.problems.join(" ")).toMatch(/verify\/orchestration\/run\.mjs/);
    rmSync(join(dir, "run.mjs"));
    // a v1 index never reads registrations: the same file is stray under v1
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [], orchestration: [entry()] }), "utf8");
    const v1 = jrun(["verify", "meta", dir, "--json"]);
    expect(v1.j.rules.map((x: any) => x.id)).toEqual(["R1", "R2", "R3"]);
    expect(rule(v1, "R3").evidence.problems.join(" ")).toMatch(/stray executable outside tooling dirs: verify\/orchestration\/run\.mjs/);
  });

  it("FAIL R1: missing AGENTS.md at repo root", () => {
    const dir = repoFixture("no-agents", false);
    const r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.verdict).toBe("FAIL");
    expect(r.j.rules.find((x: any) => x.id === "R1").verdict).toBe("FAIL");
  });

  it("FAIL R3: stray root script / docs executable / unignored tmp", () => {
    const stray = repoFixture("stray-root");
    writeFileSync(join(stray, "run.sh"), "#!/bin/sh\n", "utf8");
    expect(jrun(["verify", "meta", stray, "--json"]).j.rules.find((x: any) => x.id === "R3").verdict).toBe("FAIL");

    const docsExec = repoFixture("docs-exec");
    mkdirSync(join(docsExec, "docs"), { recursive: true });
    writeFileSync(join(docsExec, "docs", "probe.mjs"), "export {}\n", "utf8");
    expect(jrun(["verify", "meta", docsExec, "--json"]).j.rules.find((x: any) => x.id === "R3").verdict).toBe("FAIL");

    const unignoredTmp = repoFixture("tmp-unignored");
    mkdirSync(join(unignoredTmp, "tmp"), { recursive: true });
    expect(jrun(["verify", "meta", unignoredTmp, "--json"]).j.rules.find((x: any) => x.id === "R3").verdict).toBe("FAIL");
    writeFileSync(join(unignoredTmp, ".gitignore"), "tmp/\n", "utf8");
    expect(jrun(["verify", "meta", unignoredTmp, "--json"]).j.rules.find((x: any) => x.id === "R3").verdict).toBe("PASS");
  });

  it("#22 zero-scan is NEEDS-MATERIAL, not PASS (no index domain)", () => {
    const dir = repoFixture("no-index-domain");
    const r = jrun(["verify", "meta", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.verdict).toBe("NEEDS-MATERIAL");
    const r2 = r.j.rules.find((x: any) => x.id === "R2");
    expect(r2.verdict).toBe("NEEDS-MATERIAL");
    expect(r2.evidence.skipped).toBe(true);
  });

  it("#22 R3 scans the whole tree (lib/probe.mjs rejected; tooling dirs allowed)", () => {
    const dir = repoFixture("stray-lib");
    mkdirSync(join(dir, "verify"), { recursive: true });
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "probe.mjs"), "export {}\n", "utf8");
    const r3 = jrun(["verify", "meta", dir, "--json"]).j.rules.find((x: any) => x.id === "R3");
    expect(r3.verdict).toBe("FAIL");
    expect(JSON.stringify(r3.evidence)).toMatch(/stray executable outside tooling dirs: lib\/probe\.mjs/);
  });

  it("#25c: a subdir of a verifier repo resolves to the repo root (walk-up)", () => {
    const dir = repoFixture("walkup-repo");
    mkdirSync(join(dir, "verify"), { recursive: true });
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
    mkdirSync(join(dir, "deep", "nested"), { recursive: true });
    const r = jrun(["verify", "meta", join(dir, "deep", "nested"), "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.verdict).toBe("PASS");
    // #26: the CLI reports the real path (macOS tmpdir is /var → /private/var)
    expect(r.j.repo).toBe(realpathSync(dir));
  });

  it("R2: index ↔ spec files consistency (both directions + sha)", () => {
    const dir = repoFixture("indexed");
    mkdirSync(join(dir, "verify", "specs"), { recursive: true });
    const specRel = "verify/specs/s1.json";
    const specBody = '{"spec_id":"spec_meta_1"}\n';
    writeFileSync(join(dir, specRel), specBody, "utf8");
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [{ file: specRel, sha256: sha(specBody) }] }), "utf8");
    const ok = jrun(["verify", "meta", dir, "--json"]);
    expect(ok.j.rules.find((x: any) => x.id === "R2")).toMatchObject({ verdict: "PASS", evidence: { listed: 1 } });

    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [{ file: specRel, sha256: sha("other") }] }), "utf8");
    expect(jrun(["verify", "meta", dir, "--json"]).j.rules.find((x: any) => x.id === "R2").verdict).toBe("FAIL");

    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
    expect(jrun(["verify", "meta", dir, "--json"]).j.rules.find((x: any) => x.id === "R2").evidence.problems.join(" ")).toMatch(/unlisted spec file/);

    // 2 is known since the v2 registrations landed; 3 is the unknown-by-name case
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 3, specs: [] }), "utf8");
    const badVer = jrun(["verify", "meta", dir, "--json"]).j.rules.find((x: any) => x.id === "R2");
    expect(badVer.verdict).toBe("FAIL");
    expect(String(badVer.evidence.reason)).toMatch(/unknown meta_index_version 3 \(supported: 1, 2\)/);

    const noIndex = repoFixture("specs-no-index");
    mkdirSync(join(noIndex, "verify", "specs"), { recursive: true });
    writeFileSync(join(noIndex, "verify", "specs", "s1.json"), "{}\n", "utf8");
    expect(jrun(["verify", "meta", noIndex, "--json"]).j.rules.find((x: any) => x.id === "R2").verdict).toBe("FAIL");
  });
});
