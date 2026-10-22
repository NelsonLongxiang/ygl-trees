/** 作业式验证面（M13-2 第三批）：HTTP prepare/run 的契约与守卫。
 *
 * 这里只钉「服务面自己的语义」——判定语义在 engine/prepare 的语料与单测里，
 * 引擎回归不重复跑一遍。重点是不变量：默认关闭、执行面只收 JSON、快照只按内容
 * 寻址、请求体不能夹带 argv/目录、command 白名单由 serve 注入。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { closeOrm } from "../../../core/database/src/orm";
import { createDashboardServer } from "../src/webui";
import { createMaterialDraft, verifyPaths } from "../src/verify-web";
import { putBlob } from "../src/blob-store";

const REPO = path.resolve(__dirname, "../../../..");

let dir: string;
let home: string;
let server: ReturnType<typeof createDashboardServer>;
let lockedServer: ReturnType<typeof createDashboardServer>;
let base = "";
let lockedBase = "";
let snapshotSha = "";
let materialId = "";
let specId = "";
let testEnv: any;

function listen(s: ReturnType<typeof createDashboardServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function post(url: string, body: unknown, contentType = "application/json"): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** 业务库快照 → blob 仓（内容寻址）。HTTP 面只认这个 sha，不认路径。 */
function uploadSnapshot(sql: string): string {
  const file = path.join(dir, `snap-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  const ref = putBlob(verifyPaths({ home } as any).root, fs.readFileSync(file), "snapshot.sqlite", "application/vnd.sqlite3");
  return ref.sha256;
}

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `verify-jobs-${Date.now()}`);
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const db = new DB(path.join(dir, "unit.db"));
  const store = new Store(db);
  const env = { home, db, store } as any;
  testEnv = env;

  const draft = createMaterialDraft(env, { title: "作业面材料", text: "账单金额不得为负。\n" });
  expect(draft.ok).toBe(true);
  materialId = (draft as any).material_id;

  snapshotSha = uploadSnapshot("CREATE TABLE bills (id TEXT PRIMARY KEY, amount_cents INTEGER); INSERT INTO bills VALUES ('b1', -5);");

  server = createDashboardServer(env, { allowUpload: false, enableVerifyJobs: true });
  lockedServer = createDashboardServer(env, { allowUpload: false, enableVerifyJobs: false });
  base = await listen(server);
  lockedBase = await listen(lockedServer);
}, 60_000);

afterAll(async () => {
  for (const s of [server, lockedServer]) {
    await new Promise<void>((resolve) => {
      try {
        (s as any).closeLive?.();
      } catch {
        /* */
      }
      s.close(() => resolve());
    });
  }
  await closeOrm();
  testEnv.db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const clause = "账单金额不得为负。";
const anchor = { quote: clause, locator: "material.txt#L1" };
// 候选：空快照上必须判 FAIL（rows==0 才算违规），否则 P4 红队会把"空洞 PASS"打回。
const candidates = [
  {
    source_clause: clause,
    anchor,
    checker: { type: "sql", fail_when: "rows==0", predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] } } },
  },
];
// 盲审文件形态：按 source_clause 对齐，vu_id 由 prepare 生成后回填（fileReviewer 契约）。
const reviews = [
  {
    source_clause: clause,
    findings: [
      { question: "faithful", verdict: "ok", reason: "逐字对应", anchor },
      { question: "decidable", verdict: "ok", reason: "有机械判据", anchor },
      { question: "not-vacuous", verdict: "ok", reason: "空表判 FAIL", anchor },
    ],
  },
];

describe("verify jobs — 开关", () => {
  it("默认关闭：serve 没给 --enable-verify-jobs 时 POST → 403（嵌入方不该默默获得执行面）", async () => {
    const r = await post(`${lockedBase}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toContain("--enable-verify-jobs");
  });

  it("GET → 405（执行面只收 POST）", async () => {
    const res = await fetch(`${base}/api/verify/run`);
    expect(res.status).toBe(405);
  });

  it("非 JSON content-type → 415", async () => {
    const r = await post(`${base}/api/verify/prepare`, "material_id=x", "text/plain");
    expect(r.status).toBe(415);
  });

  it("坏 JSON → 400", async () => {
    const r = await post(`${base}/api/verify/prepare`, "{not json");
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("invalid JSON");
  });
});

describe("verify jobs — prepare", () => {
  it("材料 + 快照 blob + agent 构造产物 → 200 ready，spec/prepare/trace 落盘", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(200);
    expect(r.json.verdict).toBe("ready");
    expect(r.json.written).toBe(true);
    specId = r.json.spec_id as string;
    // spec_id 是确定性派生（spec_<sha12(material_id)>）
    expect(specId).toBe(`spec_${createHash("sha256").update(materialId).digest("hex").slice(0, 12)}`);
    const specDir = path.join(home, "verify", "specs", specId);
    for (const f of ["spec.json", "prepare.json", "trace.json"]) {
      expect(fs.existsSync(path.join(specDir, f))).toBe(true);
    }
  }, 60_000);

  it("draft=true → 200 但绝不落盘", async () => {
    const fresh = createMaterialDraft({ home } as any, { title: "草稿", text: "另一条材料的原文。\n" });
    const freshId = String((fresh as any).material_id);
    const r = await post(`${base}/api/verify/prepare`, {
      material_id: freshId,
      candidates: [{ source_clause: "另一条材料的原文。", anchor: { quote: "另一条材料的原文。", locator: "material.txt#L1" }, checker: candidates[0].checker }],
      reviews: [{ source_clause: "另一条材料的原文。", findings: reviews[0].findings }],
      snapshot_sha256: snapshotSha,
      draft: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.draft).toBe(true);
    expect(r.json.written).toBe(false);
    const drafted = `spec_${createHash("sha256").update(freshId).digest("hex").slice(0, 12)}`;
    expect(fs.existsSync(path.join(home, "verify", "specs", drafted))).toBe(false);
  }, 60_000);

  it("未 ready 的构造只追加 attempts/，不覆盖已冻结的 prepare.json（P2-2，0.102.2）", async () => {
    const specDir = path.join(home, "verify", "specs", specId);
    const record = path.join(specDir, "prepare.json");
    const before = createHash("sha256").update(fs.readFileSync(record)).digest("hex");
    // 同材料、同快照，但把 where 指向 schema 里不存在的列 → P2 列校验打回，不 ready
    const bad = JSON.parse(JSON.stringify(candidates));
    bad[0].checker.predicate.where.conditions[0].col = "amount_cents_missing";
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates: bad, reviews, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(200);
    expect(r.json.verdict).not.toBe("ready");
    expect(r.json.written).toBe(false);
    expect(String(r.json.record)).toMatch(/^attempts\//);
    // 成功记录逐字节不变
    const after = createHash("sha256").update(fs.readFileSync(record)).digest("hex");
    expect(after).toBe(before);
    expect(fs.readdirSync(path.join(specDir, "attempts")).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("as_of 由调用方钉（P5 责任在构造方），缺省用请求时刻", async () => {
    const asOf = "2026-01-02T03:04:05.000Z";
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha, as_of: asOf });
    expect(r.status).toBe(200);
    expect(r.json.verdict).toBe("ready");
    const spec = JSON.parse(fs.readFileSync(path.join(home, "verify", "specs", specId, "spec.json"), "utf8"));
    expect(spec.as_of.value).toBe(asOf);
  }, 60_000);

  it("as_of 不可解析 → 400 且不落盘（r22 ②：CLI rc=2 / HTTP 400 同一校验）", async () => {
    const specDir = path.join(home, "verify", "specs", specId);
    const attemptsDir = path.join(specDir, "attempts");
    const attemptsBefore = fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir).length : 0;
    const before = createHash("sha256").update(fs.readFileSync(path.join(specDir, "spec.json"))).digest("hex");
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha, as_of: "not-a-time" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("as_of");
    // 不落盘：spec.json 不变、attempts 不增
    const after = createHash("sha256").update(fs.readFileSync(path.join(specDir, "spec.json"))).digest("hex");
    expect(after).toBe(before);
    expect(fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir).length : 0).toBe(attemptsBefore);
  }, 60_000);

  it("as_of 带 +08 偏移 → 归一 UTC 存盘（可解析即归一，r22 ②）", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha, as_of: "2026-10-20T09:00:00+08:00" });
    expect(r.status).toBe(200);
    expect(r.json.verdict).toBe("ready");
    const spec = JSON.parse(fs.readFileSync(path.join(home, "verify", "specs", specId, "spec.json"), "utf8"));
    expect(spec.as_of.value).toBe("2026-10-20T01:00:00.000Z");
  }, 60_000);

  it("as_of 严格 ISO：无时区 / 空格 / 非法日历 → 400（r23 P3⑤：不猜服务端时区，也不让 02-30 静默滚成 03-02）", async () => {
    for (const bad of ["2026-10-20T10:00:00", "2026-10-20 10:00:00Z", "Jan 1 2026", "2026-02-30"]) {
      const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: snapshotSha, as_of: bad });
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toContain("as_of");
      expect(String(r.json.error)).toMatch(/explicit zone|valid calendar date/);
    }
  }, 60_000);

  it("as_of 校验先于 material/blob 读取（缺材料 + 非法 as_of → 400 而非 404，r23 P3①）", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: "mat_missing0000", candidates, reviews, snapshot_sha256: snapshotSha, as_of: "not-a-time" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("as_of");
  }, 60_000);

  it("快照只能按内容寻址：不存在的 sha → 404 且错误里点名上传入口", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: "a".repeat(64) });
    expect(r.status).toBe(404);
    expect(String(r.json.error)).toContain("/api/verify/blob");
  });

  it("sha 不是 64 位小写 hex → 400", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, candidates, reviews, snapshot_sha256: "../etc/passwd" });
    expect(r.status).toBe(400);
  });

  it("材料不存在 → 404", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: "mat_missing", candidates, reviews, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(404);
  });

  it("缺构造产物 → 400（服务端不发明候选）", async () => {
    const r = await post(`${base}/api/verify/prepare`, { material_id: materialId, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("candidates");
  });
});

describe("verify jobs — run", () => {
  it("HTTP prepare 出来的 spec + 快照 blob → 200 PASS，报告与归档都落盘", async () => {
    expect(specId).not.toBe("");
    const r = await post(`${base}/api/verify/run`, { spec_id: specId, snapshot_sha256: snapshotSha });
    expect(r.status).toBe(200);
    expect(r.json.overall).toBe("PASS");
    expect(fs.existsSync(r.json.report_path)).toBe(true);
    const report = JSON.parse(fs.readFileSync(r.json.report_path, "utf8"));
    expect(report.data_source.kind).toBe("sqlite-snapshot");
    expect(String(report.data_source.source)).toMatch(/^blob:[0-9a-f]{12}$/);
    // 归档默认必做：侧车在 archives/<run_id>.json
    expect(r.json.archive).not.toBeNull();
    expect(fs.existsSync(path.join(home, "verify", "archives", `${r.json.run_id}.json`))).toBe(true);
  }, 60_000);

  it("no_archive=true → 不产归档", async () => {
    const before = fs.readdirSync(path.join(home, "verify", "archives")).length;
    const r = await post(`${base}/api/verify/run`, { spec_id: specId, snapshot_sha256: snapshotSha, no_archive: true });
    expect(r.status).toBe(200);
    expect(r.json.archive).toBeNull();
    expect(fs.readdirSync(path.join(home, "verify", "archives")).length).toBe(before);
  }, 60_000);

  it("语料 spec 缺 prepare.json → 报告照落，归档失败在 archive_error 里（HTTP 200，过程错误不冒充判定）", async () => {
    const caseDir = path.join(REPO, "packages", "verify", "core", "corpus", "cases", "sql-find-violation");
    const spec = JSON.parse(fs.readFileSync(path.join(caseDir, "spec.json"), "utf8")) as { spec_id: string };
    const specDir = path.join(home, "verify", "specs", spec.spec_id);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.json"), fs.readFileSync(path.join(caseDir, "spec.json")));
    const caseSha = uploadSnapshot(fs.readFileSync(path.join(caseDir, "db.sql"), "utf8"));
    const r = await post(`${base}/api/verify/run`, { spec_id: spec.spec_id, snapshot_sha256: caseSha });
    expect(r.status).toBe(200);
    expect(r.json.overall).toBe("FAIL");
    expect(fs.existsSync(r.json.report_path)).toBe(true);
    expect(r.json.archive).toBeNull();
    expect(String(r.json.archive_error)).toContain("prepare.json");
  }, 60_000);

  it("请求体夹带 submission_dir → 400（目录树没有安全的 HTTP 来源）", async () => {
    const r = await post(`${base}/api/verify/run`, { spec_id: "spec_x", snapshot_sha256: snapshotSha, submission_dir: "C:/tmp/whatever" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("submission_dir");
  });

  it("spec 不存在 → 404", async () => {
    const r = await post(`${base}/api/verify/run`, { spec_id: "spec_nope", snapshot_sha256: snapshotSha });
    expect(r.status).toBe(404);
  });

  it("command 型白名单由 serve 注入：不在白名单里的 argv[0] → VU ERROR，而不是执行", async () => {
    const caseDir = path.join(REPO, "packages", "verify", "core", "corpus", "cases", "command-exit-code");
    const raw = JSON.parse(fs.readFileSync(path.join(caseDir, "spec.json"), "utf8"));
    const guardId = "spec_cmdguard";
    raw.spec_id = guardId;
    raw.vu[0].checker.argv = ["definitely-not-on-the-allowlist", "--version"];
    const specDir = path.join(home, "verify", "specs", guardId);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify(raw, null, 2));
    const r = await post(`${base}/api/verify/run`, { spec_id: guardId, snapshot_sha256: snapshotSha, no_archive: true });
    expect(r.status).toBe(200);
    expect(r.json.summary.error).toBe(1);
    const report = JSON.parse(fs.readFileSync(r.json.report_path, "utf8"));
    expect(report.vu[0].verdict).toBe("ERROR");
    expect(String(report.vu[0].evidence.reason)).toContain("allowlist");
  }, 60_000);

  it("YGL_VERIFY_ALLOW_CMD 空串 = 显式空表（全禁 command，fail-closed），不静默回落 node", async () => {
    const caseDir = path.join(REPO, "packages", "verify", "core", "corpus", "cases", "command-exit-code");
    const raw = JSON.parse(fs.readFileSync(path.join(caseDir, "spec.json"), "utf8"));
    const emptyId = "spec_empty_allowlist";
    raw.spec_id = emptyId;
    const specDir = path.join(home, "verify", "specs", emptyId);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify(raw, null, 2));
    const previous = process.env.YGL_VERIFY_ALLOW_CMD;
    process.env.YGL_VERIFY_ALLOW_CMD = "";
    const stricter = createDashboardServer(testEnv, { allowUpload: false, enableVerifyJobs: true });
    const stricterBase = await listen(stricter);
    try {
      const r = await post(`${stricterBase}/api/verify/run`, { spec_id: emptyId, snapshot_sha256: snapshotSha, no_archive: true });
      expect(r.status).toBe(200);
      expect(r.json.summary.error).toBe(1);
      const report = JSON.parse(fs.readFileSync(r.json.report_path, "utf8"));
      expect(report.vu[0].verdict).toBe("ERROR");
      expect(String(report.vu[0].evidence.reason)).toContain("allowlist");
    } finally {
      await new Promise<void>((resolve) => stricter.close(() => resolve()));
      if (previous === undefined) delete process.env.YGL_VERIFY_ALLOW_CMD;
      else process.env.YGL_VERIFY_ALLOW_CMD = previous;
    }
  }, 60_000);
});
