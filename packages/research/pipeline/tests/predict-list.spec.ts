import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// 0.90 settlement projection (direct-ce7e561b ② + direct-ce9eaf7a channel):
// predict list must project outcome/channel machine-readably and parse the
// settlement note tail (`outcome=1|0, brier=…, settler=…`).
// Spawn-based like the other CLI specs: the contract under test is bin.cjs.

const REPO = resolve(__dirname, "../../../.."); // 4 ups: tests → pipeline → research → packages → repo
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = (() => {
  try {
    spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
})();

let HOME = "";
let sidShared = "";

function run(args: string[], envExtra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME, ...envExtra },
  });
  return { rc: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function jrun(args: string[]) {
  const r = run(args);
  try {
    return { rc: r.rc, j: JSON.parse(r.stdout) };
  } catch {
    return { rc: r.rc, j: null, raw: r.stdout };
  }
}

const db = () =>
  new DatabaseSync(resolve(HOME, "ygl-trees.db"));

describe.skipIf(!HAS_BIN)("0.90 predict list projection", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-predlist-"));
    run(["db", "init"]);
    run(["project", "new", "alpha"]);
    const s = jrun(["research", "source", "add", "--url", "https://ex.com/s", "-p", "alpha", "--json"]);
    sidShared = s.j?.id ?? s.j?.row?.id ?? "";
  });

  it("registers --channel and projects 未结算 outcome", () => {
    const add = jrun(["research", "claim", "add", "[预测·14天] 2027-01-01 前 spec——npm 版本 ≥3", "--json", "--channel", "npm-registry", "-p", "alpha"]);
    expect(add.rc).toBe(0);
    const id = add.j?.id ?? add.j?.row?.id;
    expect(id).toBeTruthy();
    const list = jrun(["research", "predict", "list", "--json", "-p", "alpha"]);
    expect(list.rc).toBe(0);
    const row = (list.j as any[]).find((x) => x.claim_id === id);
    expect(row).toBeTruthy();
    expect(row.channel).toBe("npm-registry");
    expect(row.outcome).toBe("未结算");
    expect(row.brier).toBeNull();
    expect(row.deadline).toBe("2027-01-01");
    expect(row.horizon).toBe("14天");
  });

  it("parses the settlement note tail into brier + settler (outcome 1)", () => {
    const e = jrun(["research", "evidence", "add", sidShared, "--quote", "spec settle quote", "--json", "--note", "outcome=1, brier=0.0225, settler=dsh/ae07421e", "-p", "alpha"]);
    const eid = e.j?.id ?? e.j?.row?.id;
    // link the first claim (alpha's prediction) — find it from list
    const list0 = jrun(["research", "predict", "list", "--json", "-p", "alpha"]);
    const cid = (list0.j as any[])[0].claim_id;
    run(["research", "claim", "link", cid, eid, "-p", "alpha"], { YGL_EVAL_OFFLINE: "1" });
    run(["research", "claim", "resolve", cid, "--as", "supported", "-p", "alpha"]);
    const list = jrun(["research", "predict", "list", "--json", "--all", "-p", "alpha"]);
    const row = (list.j as any[]).find((x) => x.claim_id === cid);
    expect(row.outcome).toBe("1");
    expect(row.brier).toBe("0.0225");
    expect(row.settler).toBe("dsh/ae07421e");
  });

  it("maps refuted → 0 and contested → ND", () => {
    const a = jrun(["research", "claim", "add", "[预测·1天] 2027-01-02 前 spec——refuted map", "--json", "-p", "alpha"]);
    const b = jrun(["research", "claim", "add", "[预测·1天] 2027-01-03 前 spec——contested map", "--json", "-p", "alpha"]);
    const aid = a.j?.id ?? a.j?.row?.id;
    const bid = b.j?.id ?? b.j?.row?.id;
    // arbitration follows evidence: link the shared source's quote to both
    const ev = jrun(["research", "evidence", "add", sidShared, "--quote", "map probe quote", "--json", "-p", "alpha"]);
    const evid = ev.j?.id ?? ev.j?.row?.id;
    run(["research", "claim", "link", aid, evid, "--stance", "refutes", "-p", "alpha"], { YGL_EVAL_OFFLINE: "1" });
    run(["research", "claim", "resolve", aid, "--as", "refuted", "-p", "alpha"]);
    const d = db();
    d.prepare("UPDATE claims SET status='contested' WHERE id=?").run(bid);
    d.close();
    const list = jrun(["research", "predict", "list", "--json", "--all", "-p", "alpha"]);
    const rows = list.j as any[];
    expect(rows.find((x) => x.claim_id === aid).outcome).toBe("0");
    expect(rows.find((x) => x.claim_id === bid).outcome).toBe("ND");
  });

  it("schema v11: claims.channel column + ledger row", () => {
    const d = db();
    const col = d.prepare("SELECT 1 FROM pragma_table_info('claims') WHERE name='channel'").get();
    expect(col).toBeTruthy();
    const ledger = d.prepare("SELECT version FROM schema_migrations WHERE backend='sqlite' ORDER BY version DESC LIMIT 1").get() as any;
    expect(ledger.version).toBeGreaterThanOrEqual(11);
    d.close();
  });

  afterAll(() => {
    if (HOME) rmSync(HOME, { recursive: true, force: true });
  });
});
