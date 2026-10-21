/**
 * charter §4.2 v2 gate (0.111.x): meta admission on the accept surface.
 * Default = warn; `--require-meta` refuses with ERROR + `meta_error`
 * (meta_failed | meta_unverified | meta_index_unknown). `spec_error` (report
 * layer) is deliberately untouched. `--meta-repo` selects the verifier repo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let base = "";
let matFile = "";

function jrun(args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
    ...(cwd ? { cwd } : {}),
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

function repo(name: string, agents: boolean, extra?: (dir: string) => void): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "AGENTS.md"), "# fixture\n", "utf8");
  extra?.(dir);
  return dir;
}

describe.skipIf(!HAS_BIN)("meta gate on submit/prepare (0.111.x)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-metagate-home-"));
    base = mkdtempSync(join(tmpdir(), "ygl-metagate-repos-"));
    jrun(["db", "init"]);
    matFile = join(base, "material.txt");
    writeFileSync(matFile, "退款金额不得超过原单金额。\n", "utf8");
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("--require-meta refuses an unverified repo (no AGENTS.md) with meta_unverified", () => {
    const dir = repo("no-agents", false);
    const r = jrun(["verify", "submit", "--title", "g1", "--text", matFile, "--require-meta", "--meta-repo", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_unverified");
    expect(String(r.j.error)).toMatch(/meta gate/);
  });

  it("--require-meta refuses a failing gate with meta_failed (R3 stray script)", () => {
    const dir = repo("bad-r3", true, (d) => writeFileSync(join(d, "run.sh"), "#!/bin/sh\n", "utf8"));
    const r = jrun(["verify", "submit", "--title", "g2", "--text", matFile, "--require-meta", "--meta-repo", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_failed");
    expect(r.j.meta.rules.find((x: any) => x.id === "R3").verdict).toBe("FAIL");
  });

  it("--require-meta distinguishes an unknown index format (meta_index_unknown)", () => {
    const dir = repo("bad-index", true, (d) => {
      mkdirSync(join(d, "verify", "specs"), { recursive: true });
      writeFileSync(join(d, "verify", "specs", "s.json"), "{}\n", "utf8");
      writeFileSync(join(d, "verify", "meta.json"), JSON.stringify({ meta_index_version: 2, specs: [] }), "utf8");
    });
    const r = jrun(["verify", "submit", "--title", "g3", "--text", matFile, "--require-meta", "--meta-repo", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_index_unknown");
  });

  it("ladder 3: git repo without verifier markers warns, points at R1, skips (rc0)", () => {
    const dir = join(base, "bare-git");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
    const r = jrun(["verify", "submit", "--title", "g4", "--text", matFile, "--json"], dir);
    expect(r.rc).toBe(0);
    expect(r.j.material_id).toBeTruthy();
    expect(String(r.j.meta_warning)).toMatch(/no verifier markers/);
    expect(String(r.j.meta_warning)).toMatch(/R1/);
    expect(r.j.meta_bypassed).toBeUndefined();
  });

  it("ladder 4: outside git is silent (no warning, no bypass)", () => {
    const dir = join(base, "plain-dir");
    mkdirSync(dir, { recursive: true });
    const r = jrun(["verify", "submit", "--title", "g4b", "--text", matFile, "--json"], dir);
    expect(r.rc).toBe(0);
    expect(r.j.meta_warning).toBeUndefined();
    expect(r.j.meta_bypassed).toBeUndefined();
  });

  it("--no-meta bypasses and persists a meta.bypass event (0.113.0)", () => {
    const dir = join(base, "bare-git2");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const r = jrun(["verify", "submit", "--title", "g7", "--text", matFile, "--no-meta", "--json"], dir);
    expect(r.rc).toBe(0);
    expect(r.j.meta_bypassed).toBe(true);
    const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
    try {
      const rows = db.prepare("SELECT kind, entity, entity_id, payload FROM events WHERE kind='meta.bypass' ORDER BY rowid DESC LIMIT 1").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].entity).toBe("meta");
      const payload = JSON.parse(String(rows[0].payload));
      expect(payload.command).toBe("submit");
      expect(String(payload.repo)).toBe(realpathSync(dir)); // #26 real-path normalization
      expect(String(payload.payload_sha256)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
    // #25a: provenance sidecar rides with the material (and later the archive)
    const sidecar = join(HOME, "verify", "materials", String(r.j.material_id), "meta-bypass.json");
    expect(existsSync(sidecar)).toBe(true);
    const prov = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(prov.command).toBe("submit");
    expect(prov.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("#25c: bypass from a repo subdir records the walk-up repo root", () => {
    const dir = join(base, "bare-git-sub");
    mkdirSync(join(dir, "deep"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const r = jrun(["verify", "submit", "--title", "g8", "--text", matFile, "--no-meta", "--json"], join(dir, "deep"));
    expect(r.rc).toBe(0);
    const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
    try {
      const rows = db.prepare("SELECT payload FROM events WHERE kind='meta.bypass' ORDER BY rowid DESC LIMIT 1").all() as any[];
      const payload = JSON.parse(String(rows[0].payload));
      expect(String(payload.repo)).toBe(realpathSync(dir));
      expect(String(payload.cwd)).toBe(realpathSync(join(dir, "deep")));
    } finally {
      db.close();
    }
  });

  it("zero-scan repo is meta_unverified under --require-meta (#22)", () => {
    const dir = repo("no-index-domain", true);
    const r = jrun(["verify", "submit", "--title", "g6", "--text", matFile, "--require-meta", "--meta-repo", dir, "--json"]);
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_unverified");
    expect(String(r.j.error)).toMatch(/meta gate failed/);
  });

  it("a clean repo leaves the receipt untouched", () => {
    const dir = repo("clean-meta", true, (d) => {
      mkdirSync(join(d, "verify"), { recursive: true });
      writeFileSync(join(d, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
    });
    const r = jrun(["verify", "submit", "--title", "g5", "--text", matFile, "--meta-repo", dir, "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.meta_warning).toBeUndefined();
  });
});
