/**
 * R16 selection resolution — spawn-based contract spec.
 * Exercises the REAL bundle (dist/bundle/bin.cjs) against a scratch home:
 *   priority (flag > env > session > global), the strict fail-closed gate
 *   (multi-project + global/none source → rc=2 single {"error"} object),
 *   single-project exemption, and named not-found for stale selections.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const BIN = path.join(REPO, "dist/bundle/bin.cjs");

let home: string;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "spec-r16", ...env },
  });
  return { rc: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

function sql(stmt: string) {
  const r = run(["db", "sql", stmt]);
  if (r.rc !== 0) throw new Error(`db sql failed: ${stmt}\n${r.stdout}${r.stderr}`);
  return r;
}

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error("dist/bundle/bin.cjs missing — run pnpm build first");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-sel-"));
  run(["db", "init"]);
  run(["project", "new", "alpha"]);
  run(["project", "new", "beta"]); // two projects → ambiguous workspace
});

afterAll(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("R16.1 resolution priority", () => {
  it("project use writes the SESSION key and reports scope", () => {
    const r = run(["project", "use", "alpha"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toMatch(/session/);
    const g = run(["db", "sql", "SELECT value FROM meta WHERE key='current_project'"]);
    expect(g.stdout).not.toMatch(/alpha/); // global pointer untouched
    const s = run(["db", "sql", "SELECT value FROM meta WHERE key='current_project@spec-r16'"]);
    expect(s.stdout).toMatch(/alpha/);
  });

  it("project show --json annotates selection_source", () => {
    const r = run(["project", "show", "--json"]);
    expect(r.rc).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.selection_source).toBe("session");
    expect(j.project.name).toBe("alpha");
  });
});

describe("R16.3 strict gate (fail-closed)", () => {
  it("no selection + multi-project → rc=2 with single error object", () => {
    sql("DELETE FROM meta WHERE key LIKE 'current_project@%'");
    const r = run(["research", "claim", "list", "--json"]);
    expect(r.rc).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.error).toMatch(/ambiguous project: 2 projects/);
    expect(j.error).toMatch(/--project <name>/);
    expect(j.error).toMatch(/alpha/);
  });

  it("global pointer only (no session key) → still rc=2", () => {
    sql("INSERT INTO meta(key,value) VALUES('current_project','alpha') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    const r = run(["agent", "brief", "--json"]);
    expect(r.rc).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/ambiguous project/);
  });

  it("--project flag and YGL_PROJECT env both pass and annotate", () => {
    const byFlag = run(["research", "claim", "list", "--project", "beta", "--json"]);
    expect(byFlag.rc).toBe(0);
    const byEnv = run(["research", "claim", "list", "--json"], { YGL_PROJECT: "beta" });
    expect(byEnv.rc).toBe(0);
    const show = run(["project", "show", "--project", "beta", "--json"]);
    expect(JSON.parse(show.stdout).selection_source).toBe("flag");
  });

  it("session key pointing at a deleted project → rc=1 named", () => {
    sql("INSERT INTO meta(key,value) VALUES('current_project@spec-r16','ghost') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    const r = run(["research", "claim", "list", "--json"]);
    expect(r.rc).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/project not found: ghost/);
    sql("INSERT INTO meta(key,value) VALUES('current_project@spec-r16','alpha') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  });
});

describe("R16 exemptions", () => {
  it("workspace-level commands run unselected: doctor / project list / kb search", () => {
    sql("DELETE FROM meta WHERE key LIKE 'current_project@%'");
    expect(run(["doctor"]).rc).toBe(0);
    expect(run(["project", "list"]).rc).toBe(0);
    expect(run(["kb", "search", "anything"]).rc).toBe(0);
  });

  it("claim calibration --all is workspace-scoped: rc=0 unselected in multi-project (review P1)", () => {
    sql("DELETE FROM meta WHERE key LIKE 'current_project@%'");
    const r = run(["research", "claim", "calibration", "--all", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain("evaluated");
  });

  it("single-project workspace self-selects (source=only)", () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-sel-solo-"));
    const r1 = spawnSync(process.execPath, [BIN, "db", "init"], { encoding: "utf8", env: { ...process.env, YGL_HOME: solo } });
    expect(r1.status).toBe(0);
    const r2 = spawnSync(process.execPath, [BIN, "project", "new", "solo"], { encoding: "utf8", env: { ...process.env, YGL_HOME: solo } });
    expect(r2.status).toBe(0);
    const r3 = spawnSync(process.execPath, [BIN, "research", "claim", "list", "--json"], { encoding: "utf8", env: { ...process.env, YGL_HOME: solo } });
    expect(r3.status).toBe(0);
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it("0.87: bare shell (no session id) + multi-project → use prints explicit-pin hint; sessioned shell does not", () => {
    // bare shell: strip session identity from the spawn env (DSH hosts
    // inject DSH_SESSION_ID into this process — the "default" fallback only
    // fires when BOTH ids are absent)
    const bareEnv = { ...process.env, YGL_HOME: home };
    delete (bareEnv as any).YGL_SESSION;
    delete (bareEnv as any).DSH_SESSION_ID;
    const r1 = spawnSync(process.execPath, [BIN, "project", "use", "alpha"], { encoding: "utf8", env: bareEnv });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/share one "default" selection/);
    expect(r1.stdout).toMatch(/--project alpha/); // explicit pin is the FIRST recommendation
    // sessioned shell: no hint
    const r2 = run(["project", "use", "alpha"]);
    expect(r2.rc).toBe(0);
    expect(r2.stdout).not.toMatch(/share one "default" selection/);
    // JSON mode stays pure: no hint text leaks into the object stream
    const r3 = spawnSync(process.execPath, [BIN, "project", "use", "alpha", "--json"], { encoding: "utf8", env: bareEnv });
    expect(r3.status).toBe(0);
    expect(JSON.parse(r3.stdout).project).toBe("alpha");
  });
});

describe("R16.5 tree-side", () => {
  it("tree new --project <unknown> → rc=2 named", () => {
    const r = run(["tree", "new", "t16", "--project", "no-such"]);
    expect(r.rc).toBe(2);
    expect(r.stdout).toMatch(/project not found: no-such/);
  });

  it("tree show reports selection_source", () => {
    run(["tree", "new", "t16"]);
    const r = run(["tree", "show", "--json"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout).selection_source).toBe("session");
  });
});
describe("GitHub #7 会话链继承（worker sessions）", () => {
  it("子会话继承父会话的项目选择；自己的选择优先", () => {
    sql("DELETE FROM meta WHERE key LIKE 'current_project@%' OR key='current_project'");
    expect(run(["project", "use", "alpha"]).rc).toBe(0);
    const inherited = run(["project", "show", "--json"], { YGL_SESSION: "spec-r16/job-42" });
    expect(inherited.rc).toBe(0);
    const j = JSON.parse(inherited.stdout);
    expect(j.project.name).toBe("alpha");
    expect(j.selection_source).toBe("session");
    expect(run(["project", "use", "beta"], { YGL_SESSION: "spec-r16/job-42" }).rc).toBe(0);
    const own = JSON.parse(run(["project", "show", "--json"], { YGL_SESSION: "spec-r16/job-42" }).stdout);
    expect(own.project.name).toBe("beta");
  });

  it("树选择走同一条会话链", () => {
    sql("DELETE FROM meta WHERE key LIKE 'current_tree@%' OR key='current_tree'");
    expect(run(["tree", "new", "t-chain"]).rc).toBe(0);
    expect(run(["tree", "use", "t-chain"]).rc).toBe(0);
    const r = run(["tree", "show", "--json"], { YGL_SESSION: "spec-r16/job-42" });
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.stdout).selection_source).toBe("session");
    expect(r.stdout).toMatch(/t-chain/);
  });
});
