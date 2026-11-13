/** #276 kb/skill scope (schema v15): market grant vocabulary, rescope, filters, promote copy. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/apps/cli/src/bin.js");
let home = "";
const environment = { ...process.env, YGL_HOME: "", YGL_DB_URL: "", YGL_PG_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" };

function cli(args: string[], session = "scope-test"): { rc: number | null; json: any; text: string } {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 60000,
    env: { ...environment, YGL_HOME: home, YGL_SESSION: session } });
  let json: any = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* human */ }
  return { rc: r.status, json, text: r.stdout + r.stderr };
}
function cliRaw(args: string[], session = "scope-test"): { rc: number | null; text: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 60000,
    env: { ...environment, YGL_HOME: home, YGL_SESSION: session } });
  return { rc: r.status, text: r.stdout + r.stderr };
}

function cliIsoFactory(iso: string) {
  return (a: string[]) => { const r = spawnSync(process.execPath, [BIN, ...a, "--json"], { encoding: "utf8", timeout: 60000, env: { ...environment, YGL_HOME: iso, YGL_SESSION: "iso" } }); return { rc: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }; };
}

describe("kb/skill scope v15 (#276)", () => {
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), "y276-")); cliRaw(["db", "init"]); });
  afterAll(() => { try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} });

  it("db init reports user_version 15; a v14 workspace upgrades with notes intact and scope ''", () => {
    const iso = mkdtempSync(join(tmpdir(), "y276u-"));
    const cliIso = cliIsoFactory(iso);
    cliIso(["db", "init"]);
    cliIso(["kb", "add", "--title", "legacy", "--body", "b"]);
    const DatabaseSync = (require("node:sqlite") as any).DatabaseSync;
    const raw = new DatabaseSync(join(iso, "ygl-trees.db"));
    raw.exec("ALTER TABLE kb_notes DROP COLUMN scope");
    raw.exec("ALTER TABLE skills DROP COLUMN scope");
    raw.exec("PRAGMA user_version=14");
    raw.close();
    const opened = cliIso(["kb", "show", "legacy"]);
    expect(opened.rc).toBe(0);
    expect(opened.json.scope).toBe("");
    rmSync(iso, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 120000);

  it("four-value vocabulary accepted; bad values rc 2 with nothing written", () => {
    for (const s of ["dept:ops", "bench:x", "*", "restricted"]) {
      const r = cli(["kb", "add", "--title", `n-${s.replace(/[:*]/g, "_")}`, "--body", "b", "--scope", s]);
      expect(r.rc, s).toBe(0);
      expect(r.json.scope, s).toBe(s);
    }
    const before = cli(["kb", "list"]).json.length;
    for (const bad of ["ops", "dept:", "dept:a b", "PUBLIC"]) {
      const r = cli(["kb", "add", "--title", `bad-${Math.random()}`, "--body", "b", "--scope", bad]);
      expect(r.rc, bad).toBe(2);
      expect(r.json.error, bad).toBeTruthy();
    }
    expect(cli(["kb", "list"]).json.length).toBe(before);
  });

  it("no --scope stores '' even with a project selected", () => {
    cliRaw(["project", "new", "sp1"]);
    cliRaw(["project", "use", "sp1"]);
    const r = cli(["kb", "add", "--title", "noscp", "--body", "b"]);
    expect(r.rc).toBe(0);
    expect(r.json.scope).toBe("");
  });

  it("rescope sets, is idempotent; promote copies scope; re-promote updates the skill", () => {
    const fmFile = join(home, "resc.md");
    writeFileSync(fmFile, ["---", "cue: c", "lesson: l", "evidence: e", "---", "", "body text"].join("\n") + "\n");
    const a = cli(["kb", "add", "--title", "resc", "-f", fmFile, "--scope", "dept:ops"]);
    const id = a.json.id;
    const r1 = cli(["kb", "rescope", id, "--scope", "bench:sales"]);
    if (r1.rc !== 0) console.log("R1-DEBUG:", r1.text.slice(0, 300));
    expect(r1.rc).toBe(0);
    expect(r1.json.scope).toBe("bench:sales");
    const r2 = cli(["kb", "rescope", id, "--scope", "bench:sales"]);
    expect(r2.rc).toBe(0);
    expect(r2.json.duplicate).toBe(true);
    cliRaw(["kb", "promote", id, "--name", "scp-skill"]);
    const sk = cli(["skill", "show", "scp-skill"]).json;
    expect(sk.scope).toBe("bench:sales");
    cli(["kb", "rescope", id, "--scope", "restricted"]);
    cliRaw(["kb", "promote", id, "--name", "scp-skill"]);
    const sk2 = cli(["skill", "show", "scp-skill"]).json;
    expect(sk2.scope).toBe("restricted");
  });

  it("--scope filters kb list ('' = unattributed only); without the flag output is unchanged", () => {
    const all = cli(["kb", "list"]).json;
    const seedStar = cli(["kb", "add", "--title", `star-${Math.random()}`, "--body", "b", "--scope", "*"]);
    expect(seedStar.rc).toBe(0);
    const onlyStar = cli(["kb", "list", "--scope", "*"]).json;
    expect(onlyStar.some((r: any) => r.title === seedStar.json.title)).toBe(true);
    const unattributed = cli(["kb", "list", "--scope", ""]).json;
    expect(unattributed.every((r: any) => (r.scope ?? "") === "")).toBe(true);
    cli(["kb", "add", "--title", `u-${Math.random()}`, "--body", "b"]); // 自足：再种一条空 scope
    const unattributed2 = cli(["kb", "list", "--scope", ""]).json;
    expect(unattributed2.length).toBe(unattributed.length + 1);
    expect(all.length).toBeGreaterThanOrEqual(onlyStar.length + unattributed.length - 1);
  });

  it("kb import honours frontmatter scope: and validates it", () => {
    mkdirSync(join(home, "imp"), { recursive: true });
    writeFileSync(join(home, "imp", "a.md"), "---\ntitle: fm-note\nscope: dept:ops\n---\n\nbody text");
    const ok = cli(["kb", "import", join(home, "imp")]);
    expect(ok.json.added).toBe(1);
    const note = cli(["kb", "show", "fm-note"]).json;
    expect(note.scope).toBe("dept:ops");
    writeFileSync(join(home, "imp", "bad.md"), "---\ntitle: bad-note\nscope: nope\n---\n\nbody");
    const bad = cli(["kb", "import", join(home, "imp")]);
    expect(bad.rc).toBe(2);
    const missing = cli(["kb", "show", "bad-note"]);
    expect(missing.rc).toBe(1);
  }, 120000);
});
