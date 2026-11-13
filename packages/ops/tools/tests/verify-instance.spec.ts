/**
 * #206 (verifier scale S0): `verify instance` is the registry entry point. An instance is a binding kept as a
 * row; its identity is content-addressed (pack@version + target + rev + params), so the same binding twice is a
 * duplicate whatever order the params come in, and owner/schedule stay outside the identity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GLOBAL_PACKS, instanceIdentity, instancePreflight, legacyTarget, parseCreate, parseLatest, scopeOf } from "../src/verify-instance";
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
    expect(instancePreflight(["create"], { pack: "@x/ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["k=1", "k=1"] })).toBeNull();
    // Keys that name Object.prototype members are ordinary params (review on 5a365f8).
    expect(parseCreate({ pack: "@x/ygl-v-x@1.0.0", target: "git:x", owner: "o", param: ["constructor=value", "tostring=1"] })).toMatchObject({ binding: { params: { constructor: "value", tostring: "1" } } });
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

/** #207 (S1): one `ygl-verifier-latest/1` document as fleet repos write it today. */
const latest = (over: Record<string, any> = {}) => ({
  contract: "ygl-verifier-latest/1", verifier: "ygl-webui-verifier", repo: "/w/ygl-webui-verifier",
  target: { repo: "/w/ygl-trees", rev: "origin/master", sha: "2e53f79678674811b3022595a69eec25ae3b9c45" },
  overall: "PASS", root_run_id: "run_a285616ca1443ea2", judged_at: "2026-11-04T17:03:54+08:00",
  archive: "ledger/run_a285616ca1443ea2/x.yglverify.zip", result_file: "work/results/x.json", ...over,
});

describe("legacy latest.json bridge (#207)", () => {
  it("maps every target spelling onto <kind>:<ref>, preferring a GitHub upstream over a path", () => {
    // Compare without the drive and with forward slashes: on Windows resolve("/w/x", "../ygl-trees") is D:\w\ygl-trees.
    const origin = (dir: string) => (dir.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "") === "/w/ygl-trees" ? "git@github.com:NelsonLongxiang/ygl-trees.git" : "");
    expect(legacyTarget({ repo: "/w/ygl-trees" }, "", origin)).toBe("git:NelsonLongxiang/ygl-trees");
    expect(legacyTarget({ repo: "../ygl-trees" }, "/w/ygl-design-verifier", origin)).toBe("git:NelsonLongxiang/ygl-trees");
    expect(legacyTarget({ repo: "../ygl-trees", repo_url: "https://github.com/O/R.git" })).toBe("git:O/R");
    expect(legacyTarget({ repo: "NelsonLongxiang/workbench-market" })).toBe("git:NelsonLongxiang/workbench-market");
    expect(legacyTarget({ repo: "https://github.com/O/R/" })).toBe("git:O/R");
    expect(legacyTarget({ repo: "/srv/no-remote" }, "", origin)).toBe("path:/srv/no-remote");
    expect(legacyTarget({ repo: "C:\\work\\ygl-trees" })).toBe("path:C:/work/ygl-trees");
    expect(legacyTarget({ repo: "some-label" })).toBe("ref:some-label");
  });

  it("parseLatest names every problem and normalizes the rest", () => {
    const p = parseLatest(latest(), "/elsewhere") as any;
    expect(p).toMatchObject({ verifier: "ygl-webui-verifier", binding: { target: "path:/w/ygl-trees", rev: "origin/master", params: {} },
      run: { id: "run_a285616ca1443ea2", verdict: "PASS", judged_at: "2026-11-04T09:03:54.000Z", target_sha: "2e53f79678674811b3022595a69eec25ae3b9c45" } });
    expect(p.archive).toBe(resolve("/w/ygl-webui-verifier", "ledger/run_a285616ca1443ea2/x.yglverify.zip"));
    expect((parseLatest(latest({ repo: "" }), "/latest/dir") as any).result_file).toBe(resolve("/latest/dir", "work/results/x.json"));
    const bad = parseLatest({ contract: "x", target: { rev: "m" }, overall: "OK", root_run_id: "r1", judged_at: "yesterday" }) as string[];
    expect(bad).toHaveLength(7);
    for (const re of [/contract/, /verifier missing/, /target\.repo/, /target\.sha/, /overall must be one of/, /root_run_id/, /judged_at/]) expect(bad.some((x) => re.test(x)), String(re)).toBe(true);
    // judged_at is strict ISO with an explicit zone: nothing Date.parse would guess at or roll over (#212 review).
    for (const judged_at of ["0", "11/04/2026", "11-04-2026", "2026-11-04", "2026-11-04T10:00:00", "2026-02-30T00:00:00Z", "2026-11-04T25:00:00Z", "", 1793796415721])
      expect(parseLatest(latest({ judged_at })), String(judged_at)).toEqual([expect.stringMatching(/^judged_at /)]);
    expect((parseLatest(latest({ judged_at: "2026-11-04T17:03:54.5+0800" })) as any).run.judged_at).toBe("2026-11-04T09:03:54.500Z");
    expect(parseLatest([])).toEqual(["document is not a JSON object"]);
    expect(instancePreflight(["import-latest", "f.json"], {})).toMatch(/--owner/);
    expect(instancePreflight(["import-latest"], { owner: "o" })).toMatch(/<latest\.json>/);
    expect(instancePreflight(["import-latest", "f.json"], { owner: "o" })).toBeNull();
    expect(instancePreflight(["import-latest", "f.json"], { owner: "o", schedule: "on-push" })).toMatch(/--schedule does not apply to verify instance import-latest/);
  });
});

describe("scope tiers (#213)", () => {
  it("unscoped names are reserved for the global packs; a project pack verifies only its own project", () => {
    const base = { target: "git:o/acme", owner: "o" };
    expect(parseCreate({ ...base, pack: "ygl-v-foo@1.0.0" })).toMatch(/unscoped ygl-v-\* names are reserved for the global packs/);
    for (const g of GLOBAL_PACKS) expect(parseCreate({ ...base, pack: `${g}@1.0.0`, target: "git:any/repo" })).toMatchObject({ pack: g });
    expect(parseCreate({ ...base, pack: "@acme/ygl-v-x@1.0.0", target: "git:owner/other" })).toMatch(/scope @acme does not match the target repository other/);
    for (const target of ["git:o/acme", "git:Owner/Acme.git", "git:acme", "sqlite:/tmp/snap.db"])
      expect(parseCreate({ ...base, pack: "@acme/ygl-v-x@1.0.0", target }), target).toMatchObject({ pack: "@acme/ygl-v-x" });
    expect(scopeOf("pack", "ygl-v-core-aggregate", "git:o/r")).toBe("global");
    expect(scopeOf("pack", "@acme/ygl-v-x", "sqlite:/x")).toBe("acme");
    expect(scopeOf("legacy-repo", "ygl-webui-verifier", "git:NelsonLongxiang/ygl-trees")).toBe("ygl-trees");
    expect(scopeOf("legacy-repo", "v", "path:/srv/x")).toBe("(none)");
    // a repository may really be called "unscoped": it is a project like any other (review of 0f9b818)
    expect(scopeOf("legacy-repo", "v", legacyTarget({ repo: "owner/unscoped" }))).toBe("unscoped");
    // owner/. and owner/.. normalize to git: targets that name no repository: no scope, so import-latest refuses them.
    for (const repo of ["owner/.", "owner/..", "https://github.com/o/.."]) expect(scopeOf("legacy-repo", "v", legacyTarget({ repo })), repo).toBe("(none)");
    expect(instancePreflight(["list"], { scope: true })).toMatch(/--scope needs a value/);
    // A git target that names no repository is refused for every pack, never treated as "no scope to check" (review on 273f140).
    for (const target of ["git:/", "git:////", "git:o/..", "git:./"])
      for (const pack of ["@acme/ygl-v-x@1.0.0", "ygl-v-core-aggregate@1.0.0"])
        expect(parseCreate({ ...base, pack, target }), `${pack} ${target}`).toMatch(/names no repository/);
    expect(parseCreate({ ...base, pack: "@acme/ygl-v-x@1.0.0", target: "git:o/acme/" })).toMatchObject({ pack: "@acme/ygl-v-x" });
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
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14); // v14 bumped jobs attribution (#258); re-pin when v15 lands
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
    const odd = cli(["verify", "instance", "create", "--pack", "@review/ygl-v-review@1.0.0", "--target", "git:review", "--owner", "review", "--param", "constructor=value"]);
    expect(odd.rc, odd.text).toBe(0);
    expect(odd.json.binding.params).toEqual({ constructor: "value" });
    const first = cli(["verify", "instance", "create", ...PACK, "--param", "a=1", "--param", "b=2", "--owner", "supervisor"]);
    expect(first.rc, first.text).toBe(0);
    expect(first.json).toMatchObject({ kind: "pack", scope: "global", pack: "ygl-v-core-aggregate", pack_version: "1.0.0", owner: "supervisor", schedule: "manual", state: "active",
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
    expect(cli(["verify", "instance", "list", "--scope", "review"]).json.map((r: any) => [r.pack, r.scope])).toEqual([["@review/ygl-v-review", "review"]]);
    expect(cli(["verify", "instance", "list", "--scope", "global"]).json.every((r: any) => r.scope === "global" && r.pack === "ygl-v-core-aggregate")).toBe(true);
    expect(cli(["verify", "instance", "list", "--scope", "nobody"]).json).toEqual([]);
    expect(cli(["verify", "instance", "show", draft.json.id]).json).toMatchObject({ id: draft.json.id, state: "draft", runs: [] });
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
      for (const args of [["create", "--target", "git:x", "--owner", "o"], ["create", ...PACK, "--owner", "o", "--bogus", "1"], ["list", "--state", "bogus"], ["retire", "vi_x"], ["create", ...PACK, "--owner", "o", "--state", "retired"], ["import-latest", "latest.json"],
        ["create", "--pack", "ygl-v-foo@1.0.0", "--target", "git:x", "--owner", "o"], ["create", "--pack", "@acme/ygl-v-x@1.0.0", "--target", "git:o/other", "--owner", "o"],
        ["create", "--pack", "@acme/ygl-v-x@1.0.0", "--target", "git:/", "--owner", "o"]]) {
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

  it("import-latest registers a legacy-repo instance, records the run once, and refuses a run id another instance owns", () => {
    const dir = join(home, "legacy");
    mkdirSync(join(dir, "work/results"), { recursive: true });
    writeFileSync(join(dir, "work/results/x.json"), "{\"overall\":\"PASS\"}");
    const file = join(dir, "work/results/latest.json");
    writeFileSync(file, JSON.stringify(latest({ repo: dir, target: { repo: "NelsonLongxiang/ygl-trees", rev: "origin/master", sha: "abc123" } })));
    const first = cli(["verify", "instance", "import-latest", file, "--owner", "webui-seat"]);
    expect(first.rc, first.text).toBe(0);
    expect(first.json).toMatchObject({ instance_created: true, archive_ok: false,
      instance: { kind: "legacy-repo", scope: "ygl-trees", pack: "ygl-webui-verifier", pack_version: "legacy", owner: "webui-seat", state: "active",
        binding: { target: "git:NelsonLongxiang/ygl-trees", rev: "origin/master", params: {} }, last_run_id: "run_a285616ca1443ea2", last_verdict: "PASS" },
      run: { id: "run_a285616ca1443ea2", verdict: "PASS", target_sha: "abc123", archive_sha256: "", executor: `legacy-repo:${dir}` } });
    expect(first.json.run.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.json.duplicate).toBeUndefined();
    const again = cli(["verify", "instance", "import-latest", file, "--owner", "webui-seat"]);
    expect(again.json).toMatchObject({ instance_created: false, duplicate: true, instance: { id: first.json.instance.id } });
    const next = join(dir, "next.json");
    writeFileSync(next, JSON.stringify(latest({ repo: dir, root_run_id: "run_bbbbbbbbbbbbbbbb", overall: "FAIL", judged_at: "2026-11-05T00:00:00Z",
      target: { repo: "NelsonLongxiang/ygl-trees", rev: "origin/master", sha: "def456" } })));
    expect(cli(["verify", "instance", "import-latest", next, "--owner", "webui-seat"]).json).toMatchObject({ instance_created: false, instance: { last_run_id: "run_bbbbbbbbbbbbbbbb", last_verdict: "FAIL" } });
    expect(cli(["verify", "instance", "show", first.json.instance.id]).json.runs.map((r: any) => [r.id, r.verdict])).toEqual([["run_bbbbbbbbbbbbbbbb", "FAIL"], ["run_a285616ca1443ea2", "PASS"]]);
    const stolen = join(dir, "stolen.json");
    writeFileSync(stolen, JSON.stringify(latest({ verifier: "other-verifier", target: { repo: "NelsonLongxiang/ygl-trees", rev: "origin/master", sha: "abc123" } })));
    const clash = cli(["verify", "instance", "import-latest", stolen, "--owner", "x"]);
    expect(clash.rc).toBe(1);
    expect(clash.json.error).toMatch(/already recorded for verifier instance vi_/);
    const badFile = join(dir, "bad.json");
    writeFileSync(badFile, JSON.stringify({ contract: "ygl-verifier-latest/1" }));
    const before = cli(["db", "stats"]).json;
    const bad = cli(["verify", "instance", "import-latest", badFile, "--owner", "x"]);
    expect(bad.rc).toBe(1);
    expect(bad.json.error).toMatch(/verifier missing; target missing/);
    expect(cli(["verify", "instance", "import-latest", join(dir, "nope.json"), "--owner", "x"]).rc).toBe(1);
    // #213 P3: a target with no GitHub upstream cannot be attributed to a project.
    const local = join(dir, "local.json");
    writeFileSync(local, JSON.stringify(latest({ repo: dir, root_run_id: "run_cccccccccccccccc", target: { repo: join(dir, "no-remote"), rev: "main", sha: "abc" } })));
    const orphan = cli(["verify", "instance", "import-latest", local, "--owner", "x"]);
    expect(orphan.rc).toBe(1);
    expect(orphan.json.error).toMatch(/names no GitHub project, so it cannot be attributed to one/);
    for (const repo of ["owner/.", "owner/.."]) {
      const dotted = join(dir, `dotted-${repo.length}.json`);
      writeFileSync(dotted, JSON.stringify(latest({ repo: dir, root_run_id: `run_dddddddddddddd${repo.length}0`, target: { repo, rev: "main", sha: "abc" } })));
      const r = cli(["verify", "instance", "import-latest", dotted, "--owner", "x"]);
      expect(r.rc, repo).toBe(1);
      expect(r.json.error).toMatch(/names no GitHub project/);
    }
    expect(cli(["db", "stats"]).json).toMatchObject({ verifier_instances: before.verifier_instances, verifier_runs: before.verifier_runs });
    expect(before.verifier_runs).toBe(2);
    // positive control (review of 0f9b818): a repository really named "unscoped" is a project and imports
    const named = join(dir, "named-unscoped.json");
    writeFileSync(named, JSON.stringify(latest({ repo: dir, root_run_id: "run_eeeeeeeeeeeeeeee", target: { repo: "owner/unscoped", rev: "main", sha: "abc" } })));
    const ok = cli(["verify", "instance", "import-latest", named, "--owner", "x"]);
    expect(ok.rc, ok.text).toBe(0);
    expect(ok.json.instance).toMatchObject({ scope: "unscoped", binding: { target: "git:owner/unscoped" } });
  });
});
