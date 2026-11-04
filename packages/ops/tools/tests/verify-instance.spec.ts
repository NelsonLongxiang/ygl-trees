/**
 * #206 (verifier scale S0): `verify instance` is the registry entry point. An instance is a binding kept as a
 * row; its identity is content-addressed (pack@version + target + rev + params), so the same binding twice is a
 * duplicate whatever order the params come in, and owner/schedule stay outside the identity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { instanceIdentity, instancePreflight, parseCreate } from "../src/verify-instance";
import { DB, SCHEMA_VERSION } from "../../../core/database/src/db";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const PACK = ["--pack", "ygl-v-core-aggregate@1.0.0", "--target", "git:NelsonLongxiang/ygl-trees", "--rev", "origin/master"];

describe("instance identity and flag parsing", () => {
  it("identity is content-addressed and independent of param order", () => {
    const a = instanceIdentity("ygl-v-x", "1.0.0", { target: "git:o/r", rev: "main", params: { a: "1", b: "2" } });
    const b = instanceIdentity("ygl-v-x", "1.0.0", { target: "git:o/r", rev: "main", params: { b: "2", a: "1" } });
    expect(a).toEqual(b);
    expect(a.id).toBe("vi_" + a.identity_sha256.slice(0, 24));
    expect(a.identity_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      instanceIdentity("ygl-v-x", "1.0.1", { target: "git:o/r", rev: "main", params: { a: "1", b: "2" } }),
      instanceIdentity("ygl-v-x", "1.0.0", { target: "git:o/r2", rev: "main", params: { a: "1", b: "2" } }),
      instanceIdentity("ygl-v-x", "1.0.0", { target: "git:o/r", rev: "dev", params: { a: "1", b: "2" } }),
      instanceIdentity("ygl-v-x", "1.0.0", { target: "git:o/r", rev: "main", params: { a: "1" } }),
    ]) expect(changed.id).not.toBe(a.id);
  });

  it("parseCreate keeps owner/schedule out of the binding and maps --draft to state", () => {
    const p = parseCreate({ pack: "@acme/ygl-v-x@2.3.4", target: "sqlite:/tmp/snap.db", owner: "o", param: ["k=v"], schedule: "every:30m", draft: true });
    expect(p).toEqual({ pack: "@acme/ygl-v-x", version: "2.3.4", binding: { target: "sqlite:/tmp/snap.db", rev: "", params: { k: "v" } }, owner: "o", schedule: "every:30m", state: "draft" });
  });

  it("usage problems are named without any I/O", () => {
    const cases: Array<[Record<string, any>, RegExp]> = [
      [{ target: "git:x", owner: "o" }, /--pack, --target and --owner are required/],
      [{ pack: "ygl-v-x", target: "git:x", owner: "o" }, /<name>@<version>/],
      [{ pack: "ygl-v-x@1.0", target: "git:x", owner: "o" }, /MAJOR\.MINOR\.PATCH/],
      [{ pack: "foo@1.0.0", target: "git:x", owner: "o" }, /must start with ygl-v-/],
      [{ pack: "ygl-v-x@1.0.0", target: "nope", owner: "o" }, /<kind>:<ref>/],
      [{ pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["k=1", "k=2"] }, /given twice/],
      [{ pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["noeq"] }, /k=v/],
      [{ pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", schedule: "hourly" }, /manual \| on-push \| every/],
    ];
    for (const [flags, re] of cases) expect(parseCreate(flags), JSON.stringify(flags)).toMatch(re);
    expect(instancePreflight(["create"], { pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["k=1", "k=1"] })).toBeNull();
    // Keys that name Object.prototype members are ordinary params (review on 5a365f8).
    expect(parseCreate({ pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["constructor=value", "tostring=1"] })).toMatchObject({ binding: { params: { constructor: "value", tostring: "1" } } });
    expect(parseCreate({ pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["constructor=a", "constructor=b"] })).toMatch(/constructor given twice/);
    // A flag another subcommand reads is refused, never silently dropped (create --state retired used to write active).
    expect(instancePreflight(["create"], { pack: "ygl-v-x@1.0.0", target: "git:x", owner: "o", state: "retired" })).toMatch(/--state does not apply to verify instance create/);
    expect(instancePreflight(["show", "vi_x"], { reason: "r", owner: "o" })).toMatch(/--reason --owner do not apply/);
    expect(instancePreflight(["list"], { draft: true })).toMatch(/--draft does not apply/);
    expect(instancePreflight(["list"], { state: "bogus" })).toMatch(/--state must be one of/);
    expect(instancePreflight(["show"], {})).toMatch(/usage: verify instance/);
    expect(instancePreflight(["retire", "vi_x"], {})).toMatch(/--reason/);
    expect(instancePreflight(["nope"], {})).toMatch(/usage: verify instance/);
  });
});

describe("schema v13", () => {
  it("a v12 workspace gains the registry tables on open", () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const dir = mkdtempSync(join(ROOT, "tmp/instance-v13-"));
    try {
      const file = join(dir, "w.db");
      const db = new DB(file);
      db.db.exec("DROP TABLE verifier_runs; DROP TABLE verifier_instances; PRAGMA user_version=12");
      db.close();
      const reopened = new DB(file);
      expect((reopened.get("PRAGMA user_version") as any).user_version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(13);
      for (const t of ["verifier_instances", "verifier_runs"]) expect(reopened.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t])).toBeTruthy();
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});

describe.skipIf(!existsSync(BIN))("verify instance CLI (real bundle)", () => {
  let home = "";
  const cli = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_SESSION: "instance-test", YGL_NO_UPDATE_CHECK: "1", ...extra } });
    expect(r.error, r.stderr).toBeUndefined();
    return { rc: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, text: r.stdout + r.stderr };
  };
  beforeAll(() => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/instance-cli-"));
    expect(cli(["db", "init"]).rc).toBe(0);
  }, 60000);
  afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("create → same binding is a duplicate (param order ignored); owner/schedule change updates in place", () => {
    const odd = cli(["verify", "instance", "create", "--pack", "ygl-v-review@1.0.0", "--target", "git:review", "--owner", "review", "--param", "constructor=value"]);
    expect(odd.rc, odd.text).toBe(0);
    expect(odd.json.binding.params).toEqual({ constructor: "value" });
    const first = cli(["verify", "instance", "create", ...PACK, "--param", "a=1", "--param", "b=2", "--owner", "supervisor"]);
    expect(first.rc, first.text).toBe(0);
    expect(first.json).toMatchObject({ kind: "pack", pack: "ygl-v-core-aggregate", pack_version: "1.0.0", owner: "supervisor", schedule: "manual", state: "active",
      binding: { target: "git:NelsonLongxiang/ygl-trees", rev: "origin/master", params: { a: "1", b: "2" } }, last_run_id: null, last_verdict: null, last_judged_at: null });
    expect(first.json.duplicate).toBeUndefined();
    for (const k of Object.keys(first.json)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    const again = cli(["verify", "instance", "create", ...PACK, "--param", "b=2", "--param", "a=1", "--owner", "supervisor"]);
    expect(again.json).toMatchObject({ id: first.json.id, duplicate: true, updated: [] });
    const moved = cli(["verify", "instance", "create", ...PACK, "--param", "a=1", "--param", "b=2", "--owner", "design", "--schedule", "on-push"]);
    expect(moved.json).toMatchObject({ id: first.json.id, duplicate: true, updated: ["owner", "schedule"], owner: "design", schedule: "on-push" });
    const list = cli(["verify", "instance", "list"]);
    expect(list.json.filter((r: any) => r.id === first.json.id)).toHaveLength(1);
  });

  it("list filters, show, retire (and its duplicate), unknown ids", () => {
    const draft = cli(["verify", "instance", "create", ...PACK, "--owner", "lab", "--draft"]);
    expect(draft.json.state).toBe("draft");
    expect(cli(["verify", "instance", "list", "--state", "draft"]).json.map((r: any) => r.id)).toEqual([draft.json.id]);
    expect(cli(["verify", "instance", "list", "--owner", "lab"]).json).toHaveLength(1);
    expect(cli(["verify", "instance", "show", draft.json.id]).json).toMatchObject({ id: draft.json.id, state: "draft" });
    expect(cli(["verify", "instance", "show", "vi_nope"]).rc).toBe(1);
    const retired = cli(["verify", "instance", "retire", draft.json.id, "--reason", "superseded"]);
    expect(retired.json).toMatchObject({ state: "retired", note: "superseded" });
    expect(retired.json.duplicate).toBeUndefined();
    expect(cli(["verify", "instance", "retire", draft.json.id, "--reason", "again"]).json).toMatchObject({ state: "retired", note: "superseded", duplicate: true });
    expect(cli(["verify", "instance", "retire", "vi_nope", "--reason", "x"]).rc).toBe(1);
  });

  it("usage errors are rc 2 with one JSON error, before the workspace DB is touched", () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const empty = mkdtempSync(join(ROOT, "tmp/instance-empty-"));
    try {
      for (const args of [["create", "--target", "git:x", "--owner", "o"], ["create", ...PACK, "--owner", "o", "--bogus", "1"], ["list", "--state", "bogus"], ["retire", "vi_x"], ["create", ...PACK, "--owner", "o", "--state", "retired"]]) {
        const r = spawnSync(process.execPath, [BIN, "verify", "instance", ...args, "--json"], { encoding: "utf8", timeout: 60000,
          env: { ...process.env, YGL_HOME: empty, YGL_DB_URL: "", YGL_PG_URL: "", YGL_NO_UPDATE_CHECK: "1" } });
        expect(r.status, args.join(" ") + r.stdout).toBe(2);
        expect(Object.keys(JSON.parse(r.stdout))).toEqual(["error"]);
      }
      expect(readdirSync(empty)).toEqual([]);
    } finally { rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });

  it("is refused in PG mode with rc 2 (S0 runs on SQLite workspaces; PG arrives with S2)", () => {
    const r = cli(["verify", "instance", "list"], { YGL_DB_URL: "postgres://u@127.0.0.1:1/none" });
    expect(r.rc).toBe(2);
    expect(r.json.error).toMatch(/PG mode/);
  });

  it("db stats counts the registry and db export carries its rows", () => {
    const stats = cli(["db", "stats"]).json;
    expect(stats.verifier_instances).toBeGreaterThanOrEqual(2);
    expect(stats.verifier_runs).toBe(0);
    const dump = join(home, "dump.sql");
    expect(cli(["db", "export", dump]).rc).toBe(0);
    const text = require("node:fs").readFileSync(dump, "utf8");
    expect(text.match(/^INSERT OR REPLACE INTO verifier_instances\(/gm)?.length).toBe(stats.verifier_instances);
  });
});
