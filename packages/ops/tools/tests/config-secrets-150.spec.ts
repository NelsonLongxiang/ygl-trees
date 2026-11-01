/**
 * #150 secret config keys (decision_model_llm_token): the value is never
 * written to events, never echoed back in full, never leaves the workspace in
 * `db export`; pre-fix plaintext history is reported by doctor and redacted by
 * `doctor --fix` (and by any later set/reset of the key).
 * Unit half on the store, CLI half on the REAL bundle.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import {
  REDACTED, configAll, configGet, configReset, configSet, countSecretEvents, exportableRows, maskSecret,
} from "../src/config";

const TOKEN = "test-only-not-a-real-token-1234567890wxyz";
const REPO = path.resolve(__dirname, "../../../..");
const BIN = path.join(REPO, "dist/bundle/bin.cjs");

const leaked = (db: DB, v: string) =>
  Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?", [`%${v}%`])?.n ?? 0);

describe("#150 store: secret config keys", () => {
  let db: DB;
  beforeAll(() => {
    db = new DB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ygl-150-unit-")), "unit.db"));
  });

  it("set: event payload redacted, receipt masked, raw value still readable internally", () => {
    const r = configSet(db, "decision_model_llm_token", TOKEN);
    expect(r.value).toBe(maskSecret(TOKEN));
    expect(r.value).not.toContain(TOKEN.slice(0, 8));
    expect(leaked(db, TOKEN)).toBe(0);
    expect(db.get<any>("SELECT payload FROM events WHERE kind='config.set' AND entity_id='decision_model_llm_token'")?.payload).toBe(REDACTED);
    expect(configGet(db, "decision_model_llm_token")).toBe(TOKEN); // evaluator still gets it
  });

  it("configAll masks the secret, leaves other keys alone", () => {
    configSet(db, "search.limit", "33");
    const rows = configAll(db);
    expect(rows.find((r) => r.key === "decision_model_llm_token")!.value).toBe(maskSecret(TOKEN));
    expect(rows.find((r) => r.key === "search.limit")!.value).toBe("33");
    configReset(db, "search.limit");
  });

  it("exportableRows drops secret config rows and redacts legacy events", () => {
    // simulate a pre-fix plaintext event
    db.run("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES('legacy-150','2026-10-01T00:00:00Z','cli','config.set','config','decision_model_llm_token',?)", [TOKEN]);
    expect(countSecretEvents(db)).toBe(1);
    expect(exportableRows(db, "config").some((r) => r.key === "decision_model_llm_token")).toBe(false);
    expect(exportableRows(db, "config", true).some((r) => r.key === "decision_model_llm_token")).toBe(true);
    expect(JSON.stringify(exportableRows(db, "events"))).not.toContain(TOKEN);
  });

  it("reset scrubs plaintext history too", () => {
    configReset(db, "decision_model_llm_token");
    expect(countSecretEvents(db)).toBe(0);
    expect(leaked(db, TOKEN)).toBe(0);
    expect(db.get<any>("SELECT payload FROM events WHERE id='legacy-150'")?.payload).toBe(REDACTED);
  });

  it("maskSecret: empty stays empty, short values fully hidden", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("short")).toBe("••••");
    expect(maskSecret(TOKEN)).toBe("••••wxyz");
  });
});

describe("#150 CLI: get/list/export/doctor never print the secret", () => {
  let home: string;
  let work: string;
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8", cwd: work,
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "spec-150", YGL_TEST: "1", NO_COLOR: "1", YGL_NO_UPDATE_CHECK: "1" },
    });
    return { rc: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
  };
  beforeAll(() => {
    if (!fs.existsSync(BIN)) throw new Error("dist/bundle/bin.cjs missing — run pnpm build first");
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-150-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "ygl-150-cwd-"));
    expect(run(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => {
    for (const d of [home, work]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("set / get / list (human + json) mask the value", () => {
    for (const r of [
      run(["config", "set", "decision_model_llm_token", TOKEN]),
      run(["config", "set", "decision_model_llm_token", TOKEN, "--json"]),
      run(["config", "get", "decision_model_llm_token"]),
      run(["config", "get", "decision_model_llm_token", "--json"]),
      run(["config", "list"]),
      run(["config", "list", "--json"]),
    ]) {
      expect(r.rc).toBe(0);
      expect(r.out).not.toContain(TOKEN.slice(0, 12));
    }
    expect(run(["config", "get", "decision_model_llm_token"]).out).toContain("••••wxyz");
  });

  it("db export carries neither the config value nor an event payload with it", () => {
    const dump = path.join(work, "dump.sql");
    expect(run(["db", "export", dump]).rc).toBe(0);
    expect(fs.readFileSync(dump, "utf8")).not.toContain(TOKEN);
  });

  it("doctor warns on legacy plaintext events; --fix redacts them", () => {
    expect(run(["db", "sql", `INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES('legacy-cli','2026-10-01T00:00:00Z','cli','config.set','config','decision_model_llm_token','${TOKEN}')`]).rc).toBe(0);
    const before = JSON.parse(run(["doctor", "--json"]).out.slice(run(["doctor", "--json"]).out.indexOf("[")));
    expect(before.find((c: any) => c.name === "config").status).toBe("warn");
    expect(run(["doctor", "--fix"]).out).toMatch(/secret value\(s\) in config\.set events redacted/);
    const after = run(["db", "sql", "SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%test-only-not-a-real%'", "--json"]);
    expect(JSON.parse(after.out)[0].n).toBe(0);
  });
});
