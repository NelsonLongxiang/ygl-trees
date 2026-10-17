/**
 * 0.84.0 — claim.eval persistence + calibration readout.
 *
 * The 0.84.0 defect class was process-exit truncation (fire-and-forget async in
 * a short-lived CLI): it can only regress end-to-end, so these tests spawn the
 * built bundle against a scratch home instead of calling internals.
 * All model calls run with YGL_EVAL_OFFLINE=1 — deterministic, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
// 依赖构建产物：干净克隆先 `pnpm build`（`pnpm test` 已按 build → test:unit 排序）。
const HAS_BIN = existsSync(BIN);
if (!HAS_BIN) console.warn(`[claimeval.spec] skip: ${BIN} 不存在 — 先 pnpm build`);
let home = "";

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_EVAL_OFFLINE: "1", ...extraEnv },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "claimeval-840-"));
  const init = run(["db", "init"]);
  expect(init.rc, `db init output: ${init.stdout.slice(0, 400)} ${init.stderr.slice(0, 200)}`).toBe(0);
  expect(run(["project", "new", "cal"]).rc).toBe(0);
});

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* windows race */ }
});

describe.skipIf(!HAS_BIN)("claim evaluate persistence (0.84.0)", () => {
  it("offline evaluate: rc=0, 离线 marked, NO claim.eval event", () => {
    const add = run(["research", "claim", "add", "校准测试断言", "-p", "cal", "--json"]);
    expect(add.rc).toBe(0);
    const id = JSON.parse(add.stdout).id ?? JSON.parse(add.stdout).row?.id;
    const r = run(["research", "claim", "evaluate", String(id), "-p", "cal"]);
    expect(r.rc).toBe(0);
    expect(r.stdout + r.stderr).toContain("离线");
    const q = run(["db", "sql", "SELECT COUNT(*) AS n FROM events WHERE kind='claim.eval'", "--json"]);
    expect(JSON.parse(q.stdout)[0].n).toBe(0);
  });

  it("offline link: rc=0, no event, link still lands", () => {
    const c = run(["research", "claim", "add", "离线链接断言", "-p", "cal", "--json"]);
    const cid = JSON.parse(c.stdout).id ?? JSON.parse(c.stdout).row?.id;
    const s = run(["research", "source", "add", "--url", "https://x.test/a", "--title", "src", "-p", "cal", "--json"]);
    expect(s.rc).toBe(0);
    const sid = (JSON.parse(s.stdout).row ?? JSON.parse(s.stdout)).id;
    const e = run(["research", "evidence", "add", String(sid), "--quote", "离线链接证据", "-p", "cal", "--json"]);
    const eid = JSON.parse(e.stdout).id ?? JSON.parse(e.stdout).row?.id;
    const r = run(["research", "claim", "link", String(cid), String(eid), "-p", "cal"]);
    expect(r.rc).toBe(0);
    const q = run(["db", "sql", `SELECT COUNT(*) AS n FROM events WHERE kind='claim.eval' AND entity_id='${cid}'`, "--json"]);
    expect(JSON.parse(q.stdout)[0].n).toBe(0);
  });
});

describe.skipIf(!HAS_BIN)("claim calibration readout (0.84.0)", () => {
  it("empty history: share null + hint, rc=0", () => {
    const r = run(["research", "claim", "calibration", "-p", "cal", "--json"]);
    expect(r.rc).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.evaluated).toBe(0);
    expect(j.share_pct).toBeNull();
  });

  it("seeded events: latest-per-claim wins, gap math, share", () => {
    // claim A: supported (human grade 4), model C → gap 2 (lower1)
    // claim B: refuted  (human grade 1), model C → gap -2 (model higher, NOT lower1)
    // claim A gets a second, STALE event (label D) — latest must win.
    const mk = (text: string) => {
      const c = run(["research", "claim", "add", text, "-p", "cal", "--json"]);
      return String(JSON.parse(c.stdout).id ?? JSON.parse(c.stdout).row?.id);
    };
    const a = mk("校准甲：应被评估为低两档");
    const b = mk("校准乙：模型高于人工");
    const ins = (cid: string, label: string, score: number, ts: string) => run([
      "db", "sql",
      `INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('t${Math.random().toString(36).slice(2,8)}','${ts}','test','claim.eval','claim','${cid}','{\"model_confidence\":${score},\"label\":\"${label}\",\"mode\":\"manual\"}','info')`,
    ]);
    ins(a, "D", 1.0, "2026-10-17T10:00:00.000Z"); // stale
    ins(a, "C", 2.5, "2026-10-17T11:00:00.000Z"); // latest → C
    ins(b, "C", 2.5, "2026-10-17T11:30:00.000Z");
    expect(run(["research", "claim", "resolve", a, "--as", "supported", "-p", "cal"]).rc).toBe(0);
    expect(run(["research", "claim", "resolve", b, "--as", "refuted", "-p", "cal"]).rc).toBe(0);
    const r = run(["research", "claim", "calibration", "--all", "--json"]);
    expect(r.rc).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.comparable).toBeGreaterThanOrEqual(2);
    const rowA = j.rows.find((x: any) => x.claim === a);
    const rowB = j.rows.find((x: any) => x.claim === b);
    expect(rowA.gap).toBe("模型低2档");
    expect(rowB.gap).toBe("模型高1档");
    // only seeded rows count for lower1 within this test's claims
    expect(j.model_lower_1plus).toBeGreaterThanOrEqual(1);
    // P1-1（REVIEW-0.84.0）：项目过滤口径下 evaluated 必须等于 rows.length
    const rp = run(["research", "claim", "calibration", "-p", "cal", "--json"]);
    expect(rp.rc).toBe(0);
    const jp = JSON.parse(rp.stdout);
    expect(jp.rows.length).toBe(2);
    expect(jp.evaluated).toBe(jp.rows.length);
  }, 30_000);
});
