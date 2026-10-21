/**
 * `verify meta` v1 (charter §4.1, 0.111.0): verifier-repo admission rules
 * R1 AGENTS.md, R2 verify/meta.json ↔ spec files, R3 no stray executables.
 * rc mirrors the report verdict (0 PASS / 1 FAIL / 2 usage).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(r.j.meta_version).toBe("1.0");
    expect(r.j.rules.map((x: any) => x.id)).toEqual(["R1", "R2", "R3"]);
    expect(r.j.rules.every((x: any) => x.verdict === "PASS")).toBe(true);
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
    expect(r.j.repo).toBe(dir);
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

    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 2, specs: [] }), "utf8");
    const badVer = jrun(["verify", "meta", dir, "--json"]).j.rules.find((x: any) => x.id === "R2");
    expect(badVer.verdict).toBe("FAIL");
    expect(String(badVer.evidence.reason)).toMatch(/unknown meta_index_version 2/);

    const noIndex = repoFixture("specs-no-index");
    mkdirSync(join(noIndex, "verify", "specs"), { recursive: true });
    writeFileSync(join(noIndex, "verify", "specs", "s1.json"), "{}\n", "utf8");
    expect(jrun(["verify", "meta", noIndex, "--json"]).j.rules.find((x: any) => x.id === "R2").verdict).toBe("FAIL");
  });
});
