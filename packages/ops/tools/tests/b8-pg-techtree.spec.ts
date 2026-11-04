/**
 * #176 W1 real PG: the techtree faces opened in T1–T3 give the same JSON on PG as on SQLite.
 * Supply an isolated admin URL: the suite creates/drops its own random database (run by G7).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { assertNoPgPassword } from "./fixtures/pg-output-guard";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import { migrateToPg } from "../src/pgsync";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const adminUrl = process.env.B8_TEST_PG_ADMIN_URL || "";
let dir = "", dbName = "", target = "", pgHome = "", sqliteHome = "";
let admin: any;

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["YGL_DB_URL", "YGL_PG_URL", "YGL_PROJECT", "YGL_TREE", "YGL_SESSION", "DSH_SESSION_ID", "NODE_OPTIONS"]) delete env[key];
  return env;
};
function cli(backend: "pg" | "sqlite", args: string[]) {
  const env = backend === "pg"
    ? { ...cleanEnv(), YGL_HOME: pgHome, YGL_DB_URL: target, YGL_SESSION: "b8-tree", YGL_NO_UPDATE_CHECK: "1" }
    : { ...cleanEnv(), YGL_HOME: sqliteHome, YGL_DB_URL: "", YGL_SESSION: "b8-tree", YGL_NO_UPDATE_CHECK: "1" };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: "utf8", timeout: 30000, env });
  const text = (r.stdout || "") + (r.stderr || "");
  // A killed child means the CLI printed its answer but never exited: an open PG handle, not a slow machine.
  expect(r.signal, `${backend} ${args.join(" ")}: process did not exit (open connection?) — ${text.slice(0, 200)}`).toBeNull();
  if (backend === "pg") assertNoPgPassword(text, adminUrl);
  return { rc: r.status, out: r.stdout || "", text };
}
/** Timestamps and generated ids differ between runs — shortId() mixes in Date.now() and Math.random(), so two
 *  SQLite runs differ too. Everything else (keys, names, numbers and their types, order, flags) must match exactly. */
const TIME_KEYS = new Set(["created", "updated", "built_at", "unlocked_at", "ts"]);
const ID_KEYS = new Set(["id", "tree_id", "node_id", "parent_id", "child_id", "project_id"]);
function normalise(v: any): any {
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, TIME_KEYS.has(k) && x ? "<time>" : ID_KEYS.has(k) && x ? "<id>" : normalise(x)]));
  }
  return v;
}
function both(args: string[]): { rc: number | null; json: any } {
  const s = cli("sqlite", [...args, "--json"]);
  const p = cli("pg", [...args, "--json"]);
  expect(p.rc, "pg: " + p.text).toBe(s.rc);
  const sj = s.out.trim() ? normalise(JSON.parse(s.out)) : null;
  const pj = p.out.trim() ? normalise(JSON.parse(p.out)) : null;
  expect(pj, args.join(" ")).toEqual(sj);
  return { rc: p.rc, json: pj };
}

describe.skipIf(!adminUrl)("#176 W1-T1 techtree on PG (golden vs SQLite)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-pg-techtree-"));
    pgHome = join(dir, "pg-home"); sqliteHome = join(dir, "sqlite-home");
    dbName = "b8_tree_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    admin = new Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query('CREATE DATABASE "' + dbName + '"');
    const u = new URL(adminUrl); u.pathname = "/" + dbName; target = u.toString();
    const seed = new DB(join(dir, "seed.sqlite"), { lock: false });
    try { await migrateToPg(seed, target); } finally { seed.close(); }
    expect(spawnSync(process.execPath, [BIN, "db", "init", "--json"], { cwd: ROOT, encoding: "utf8", env: { ...cleanEnv(), YGL_HOME: sqliteHome, YGL_NO_UPDATE_CHECK: "1" } }).status).toBe(0);
  }, 90000);
  afterAll(async () => {
    if (admin) { if (dbName) await admin.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await admin.end(); }
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("tree new / duplicate / list / show / use match SQLite", () => {
    expect(both(["tree", "new", "w1-tree"]).rc).toBe(0);
    expect(both(["tree", "new", "w1-tree"]).json).toMatchObject({ duplicate: true });
    both(["tree", "list"]);
    expect(both(["tree", "show"]).json).toMatchObject({ selection_source: "session" });
    both(["tree", "use", "w1-tree"]);
  }, 120000);

  it("node add / duplicate / list / show match SQLite, including key order and numeric types", () => {
    both(["node", "add", "a", "--name", "Alpha", "--tier", "1", "--cost", "2.5", "--tags", "x y"]);
    expect(both(["node", "add", "a"]).json).toMatchObject({ duplicate: true });
    both(["node", "add", "B", "--tier", "1"]);
    both(["node", "add", "_c", "--kind", "skill"]);
    both(["node", "add", "a2", "--tier", "0"]);
    const list = both(["node", "list"]).json;
    expect(list.map((n: any) => n.key)).toEqual(["_c", "a2", "B", "a"]);
    expect(typeof list[0].req_parents).toBe("number");
    both(["node", "show", "a"]);
    expect(both(["node", "show", "missing"]).rc).toBe(1);
  }, 180000);

  it("T2 structure: link / duplicate link / cycle refusal / index / validate / unlink / move / rm match SQLite", () => {
    both(["tree", "new", "w1-other"]);
    both(["tree", "use", "w1-tree"]);
    expect(both(["node", "link", "a", "B"]).rc).toBe(0);
    expect(both(["node", "link", "a", "B", "--mode", "OR"]).json).toMatchObject({ duplicate: true, mode: "OR" });
    both(["node", "link", "B", "_c"]);
    expect(both(["node", "link", "_c", "a"]).rc).toBe(1);
    expect(both(["node", "index"]).json).toMatchObject({ nodes: 4 });
    expect(both(["node", "validate"]).json).toEqual({ issues: [] });
    both(["node", "list"]);
    both(["node", "show", "B"]);
    both(["node", "unlink", "a", "B"]);
    expect(both(["node", "move", "a2", "--to", "w1-other"]).json).toMatchObject({ moved: true, to_tree: "w1-other" });
    expect(both(["node", "move", "a2", "--to", "w1-other"]).json).toMatchObject({ moved: false, duplicate: true });
    both(["node", "rm", "_c"]);
    both(["node", "list"]);
  }, 240000);

  it("T3 state and queries: cond / can / unlock / lock / ready / path / graph reads match SQLite", () => {
    both(["tree", "use", "w1-tree"]);
    both(["node", "link", "a", "B"]);
    both(["node", "cond", "add", "B", "--name", "lvl", "--op", ">=", "--value", "2"]);
    both(["node", "cond", "add", "B", "--name", "promo", "--op", ">=", "--value", "1", "--optional", "--effect", "cost_mul", "--weight", "0.5"]);
    expect(both(["node", "can", "B"]).json).toMatchObject({ ok: false });
    both(["node", "unlock", "a"]);
    expect(both(["node", "show", "a"]).json.node).toMatchObject({ state: "unlocked", unlocked_at: "<time>" });
    expect(both(["node", "can", "B", "--state", "lvl=2"]).json).toMatchObject({ ok: true, cost_multiplier: 1 });
    expect(both(["node", "can", "B", "--state", "lvl=2,promo=1"]).json).toMatchObject({ ok: true, cost_multiplier: 0.5 });
    both(["node", "ready"]);
    both(["node", "ready", "--state", "lvl=2"]);
    both(["node", "path", "B"]);
    both(["node", "ancestors", "B"]);
    both(["node", "descendants", "a"]);
    both(["node", "parents", "B"]);
    both(["node", "children", "a"]);
    both(["node", "cond", "B"]);
    both(["node", "cond", "rm", "B", "--name", "promo"]);
    both(["node", "lock", "a"]);
    expect(both(["node", "show", "a"]).json.node).toMatchObject({ state: "locked", unlocked_at: null });
    expect(both(["node", "list"]).json.find((n: any) => n.key === "a")).toMatchObject({ state: "locked", unlocked_at: null });
    both(["node", "ready", "--all"]);
  }, 300000);

  it("faces outside T1–T3 stay refused on PG with rc 2: --eval, cond --due, unopened commands, --global", () => {
    const evalR = cli("pg", ["node", "can", "B", "--eval", "--json"]);
    expect(evalR.rc).toBe(2);
    expect(JSON.parse(evalR.out).error).toMatch(/--eval \(decision model\) needs the SQLite workspace face/);
    const due = cli("pg", ["node", "cond", "--due", "--json"]);
    expect(due.rc).toBe(2);
    expect(JSON.parse(due.out).error).toMatch(/cond --due needs the SQLite workspace face/);
    const other = cli("pg", ["node", "export", "--json"]);
    expect(other.rc).toBe(2);
    expect(JSON.parse(other.out).error).toMatch(/node add\/list\/show\/link\/unlink\/rm\/move\/index\/validate\/cond\/unlock\/lock\/can\/ready\/path\/parents\/children\/ancestors\/descendants \(no --eval, no cond --due\)/);
    expect(cli("pg", ["tree", "use", "w1-tree", "--global", "--json"]).rc).toBe(2);
  });

  it("concurrent links into one tree serialise on the tree lock: no errors, closure stays valid", async () => {
    for (const k of ["p0", "p1", "p2", "p3", "p4", "p5"]) expect(cli("pg", ["node", "add", k, "--json"]).rc).toBe(0);
    const run = (a: string, b: string) => new Promise<number | null>((ok) => {
      const p = spawn(process.execPath, [BIN, "node", "link", a, b, "--json"], { cwd: ROOT, env: { ...cleanEnv(), YGL_HOME: pgHome, YGL_DB_URL: target, YGL_SESSION: "b8-tree", YGL_NO_UPDATE_CHECK: "1" } });
      p.on("close", ok);
    });
    const rcs = await Promise.all([run("p0", "p1"), run("p1", "p2"), run("p2", "p3"), run("p3", "p4"), run("p4", "p5")]);
    expect(rcs).toEqual([0, 0, 0, 0, 0]);
    const v = cli("pg", ["node", "validate", "--json"]);
    expect(v.rc, v.text).toBe(0);
    expect(JSON.parse(v.out)).toEqual({ issues: [] });
    const { Client } = require("pg");
    const c = new Client({ connectionString: target }); await c.connect();
    try {
      const n = await c.query("SELECT count(*)::int AS n FROM node_closure cl JOIN nodes a ON a.id=cl.ancestor WHERE a.key='p0' AND cl.depth>0");
      expect(n.rows[0].n).toBe(5); // p0 reaches p1..p5 once the chain is complete
    } finally { await c.end(); }
  }, 180000);

  it("concurrent node add of one key yields exactly one row", async () => {
    const run = () => new Promise<number | null>((ok) => {
      const p = spawn(process.execPath, [BIN, "node", "add", "racer", "--json"], { cwd: ROOT, env: { ...cleanEnv(), YGL_HOME: pgHome, YGL_DB_URL: target, YGL_SESSION: "b8-tree", YGL_NO_UPDATE_CHECK: "1" } });
      p.on("close", ok);
    });
    const rcs = await Promise.all([run(), run(), run(), run(), run()]);
    expect(rcs).toEqual([0, 0, 0, 0, 0]);
    const { Client } = require("pg");
    const c = new Client({ connectionString: target }); await c.connect();
    try {
      const n = await c.query("SELECT count(*)::int AS n FROM nodes WHERE key='racer'");
      expect(n.rows[0].n).toBe(1);
    } finally { await c.end(); }
  }, 120000);
});
