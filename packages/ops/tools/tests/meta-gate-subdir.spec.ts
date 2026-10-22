/**
 * GitHub #25 ③: the submit/prepare meta gate judges the same repo as
 * `verify meta` — walk up from the real path of cwd (or of --meta-repo) to the
 * nearest marker dir / git root. Before the fix the hard branch judged
 * `process.cwd()`, so from `<repo>/sub` `verify meta` said PASS while
 * `verify submit` refused with `no AGENTS.md under …/sub`.
 */
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
let base = "";
let matFile = "";
let snap = "";
let empty = "";

function jrun(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", cwd, env: { ...process.env, YGL_HOME: HOME } });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

/** A git repo with a `sub/deep` directory; `compliant` = AGENTS.md + v1 index. */
function gitRepo(name: string, opts: { agents: boolean; index: boolean; stray?: boolean }): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  if (opts.agents) writeFileSync(join(dir, "AGENTS.md"), "# fixture\n", "utf8");
  if (opts.index) {
    mkdirSync(join(dir, "verify"), { recursive: true });
    writeFileSync(join(dir, "verify", "meta.json"), JSON.stringify({ meta_index_version: 1, specs: [] }), "utf8");
  }
  if (opts.stray) writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", "utf8");
  return dir;
}

const submit = (cwd: string, title: string, extra: string[] = []) => jrun(["verify", "submit", "--title", title, "--text", matFile, ...extra], cwd);

describe.skipIf(!HAS_BIN)("#25 ③ meta gate walks up like verify meta", () => {
  let good = "";
  let failing = "";
  let unmarked = "";

  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-gate25-home-"));
    base = mkdtempSync(join(tmpdir(), "ygl-gate25-repos-"));
    jrun(["db", "init"], HOME);
    matFile = join(base, "material.md");
    writeFileSync(matFile, "S1 退款金额不得超过原单金额。\n", "utf8");
    snap = join(base, "snap.sqlite");
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE refunds (id INTEGER, amount INTEGER)");
    db.close();
    empty = join(base, "empty.json");
    writeFileSync(empty, "[]", "utf8");
    good = gitRepo("good", { agents: true, index: true });
    failing = gitRepo("failing", { agents: true, index: true, stray: true });
    unmarked = gitRepo("index-only", { agents: false, index: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("compliant repo: submit from sub/ and sub/deep/ passes, exactly like verify meta and like the root", () => {
    for (const cwd of [good, join(good, "sub"), join(good, "sub", "deep")]) {
      const meta = jrun(["verify", "meta"], cwd);
      expect(meta.rc, meta.raw).toBe(0);
      const r = submit(cwd, `good-${cwd.length}`);
      expect(r.rc, r.raw).toBe(0);
      expect(r.j.material_id).toBeTruthy();
      expect(r.j.meta_warning).toBeUndefined();
      expect(r.j.meta_bypassed).toBeUndefined();
    }
  });

  it("compliant repo: prepare from sub/ passes the gate (reaches the construction verdict, no meta_error)", () => {
    const mat = submit(good, "good-prepare").j.material_id;
    const r = jrun(["verify", "prepare", mat, "--candidates", empty, "--reviews", empty, "--db", snap, "--draft"], join(good, "sub"));
    expect(r.j.meta_error).toBeUndefined();
    expect(r.j.verdict).toBe("needs-material");
  });

  it("non-compliant repo is still refused from a subdir, with the same verdict verify meta gives", () => {
    const sub = join(failing, "sub");
    expect(jrun(["verify", "meta"], sub).rc).toBe(1);
    const r = submit(sub, "failing-sub");
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_failed");
    expect(r.j.meta.rules.find((x: any) => x.id === "R3").verdict).toBe("FAIL");
    const mat = submit(good, "failing-prepare").j.material_id;
    const p = jrun(["verify", "prepare", mat, "--candidates", empty, "--reviews", empty, "--db", snap, "--draft"], sub);
    expect(p.rc).toBe(1);
    expect(p.j.meta_error).toBe("meta_failed");
  });

  it("marker without AGENTS.md: refused as meta_unverified naming the repo root, not the subdir", () => {
    const r = submit(join(unmarked, "sub", "deep"), "index-only-sub");
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_unverified");
    expect(String(r.j.error)).toContain(`no AGENTS.md under ${realpathSync(unmarked)} `);
  });

  it("explicit --meta-repo wins over cwd (and walks up from the given dir like verify meta <dir>)", () => {
    // cwd in a failing repo, explicit compliant repo → pass
    expect(submit(join(failing, "sub"), "explicit-good", ["--meta-repo", good]).rc).toBe(0);
    expect(submit(join(failing, "sub"), "explicit-good-sub", ["--meta-repo", join(good, "sub")]).rc).toBe(0);
    // cwd in a compliant repo, explicit failing repo → refused
    const r = submit(join(good, "sub"), "explicit-failing", ["--meta-repo", failing]);
    expect(r.rc).toBe(1);
    expect(r.j.meta_error).toBe("meta_failed");
  });

  it.skipIf(process.platform === "win32")("realpath: a symlinked start dir is judged as its real repo (cf. #26 /var → /private/var)", () => {
    const link = join(base, "link-to-good-sub");
    symlinkSync(join(good, "sub"), link);
    // tmpdir() itself is a symlink on macOS (/var → /private/var): the given paths here are not real paths
    const r = submit(link, "link-cwd", ["--meta-repo", link]);
    expect(r.rc, r.raw).toBe(0);
    const bypass = submit(link, "link-bypass", ["--no-meta"]);
    expect(bypass.rc).toBe(0);
    const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
    try {
      const row = db.prepare("SELECT payload FROM events WHERE kind='meta.bypass' ORDER BY rowid DESC LIMIT 1").get() as any;
      expect(JSON.parse(String(row.payload)).repo).toBe(realpathSync(good));
    } finally {
      db.close();
    }
  });

  it("outside any git repo the gate still skips by design (ladder 4)", () => {
    const plain = join(base, "plain", "sub");
    mkdirSync(plain, { recursive: true });
    const r = submit(plain, "plain");
    expect(r.rc).toBe(0);
    expect(r.j.meta_warning).toBeUndefined();
  });
});
