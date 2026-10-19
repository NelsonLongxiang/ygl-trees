import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { closeOrm } from "../../../core/database/src/orm";
import { createDashboardServer } from "../src/webui";
import {
  createMaterialDraft,
  getMaterial,
  handleVerifyApi,
  listMaterials,
  listReports,
  listSpecs,
  reportDetail,
  specDetail,
  verifyPaths,
} from "../src/verify-web";

let dir: string;
let home: string;
let db: DB;
let store: Store;
let server: ReturnType<typeof createDashboardServer>;
let base = "";

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex");

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `verify-web-${Date.now()}`);
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  db = new DB(path.join(dir, "unit.db"));
  store = new Store(db);

  const p = verifyPaths({ home } as any);
  fs.mkdirSync(path.join(p.materials, "mat_aaaaaaaaaaaa"), { recursive: true });
  fs.writeFileSync(path.join(p.materials, "mat_aaaaaaaaaaaa", "material.txt"), "本期运费账单见附件，共 3 单。", "utf8");
  writeJson(path.join(p.materials, "mat_aaaaaaaaaaaa", "material.json"), {
    material_id: "mat_aaaaaaaaaaaa",
    title: "运费对账材料",
    created: "2026-10-20T01:00:00.000Z",
    text_sha256: sha("本期运费账单见附件，共 3 单。"),
    files: [{ path: "bills.xlsx", sha256: "b".repeat(64), mime: "application/vnd.ms-excel", size: 12 }],
  });

  writeJson(path.join(p.specs, "spec_111111111111", "spec.json"), {
    contract_version: "1.1",
    spec_id: "spec_111111111111",
    spec_version: 3,
    title: "运费对账",
    domain: "cordis",
    created: "2026-10-20T01:05:00.000Z",
    vu: [{ id: "V1" }, { id: "V2" }],
  });
  writeJson(path.join(p.specs, "spec_111111111111", "prepare.json"), {
    verdict: "ready",
    rounds: 1,
    material_id: "mat_aaaaaaaaaaaa",
  });
  writeJson(path.join(p.specs, "spec_111111111111", "trace.json"), { stages: [{ stage: "P1", ok: true }] });

  const mkReport = (run: string, overall: string, finished: string) => ({
    run_id: run,
    spec_id: "spec_111111111111",
    spec_version: 3,
    overall,
    reason: overall === "PASS" ? "all 2 assert units passed" : "1 of 2 assert unit(s) need material",
    summary: overall === "PASS"
      ? { pass: 2, fail: 0, needs_material: 0, error: 0 }
      : { pass: 1, fail: 0, needs_material: 1, error: 0 },
    started: finished,
    finished,
    verifier: { mode: "sealed", spec_version: 3, binary_sha256: "sha256:" + "c".repeat(64) },
  });
  writeJson(path.join(p.reports, "run_a.json"), mkReport("run_a", "PASS", "2026-10-20T02:00:00.000Z"));
  writeJson(path.join(p.reports, "run_b.json"), mkReport("run_b", "NEEDS-MATERIAL", "2026-10-20T03:00:00.000Z"));
  writeJson(path.join(p.archives, "run_a.json"), {
    run_id: "run_a",
    archives: [{ archive_id: "arc_1", filename: "a.yglverify.zip" }],
  });

  server = createDashboardServer({ ctx: { json: true, color: false, quiet: true }, db, store, home } as any);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr: any = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await closeOrm();
  if (server) await new Promise((r) => server.close(r));
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("verify 服务面：读投影", () => {
  it("规范清单带 prepare 结论与 run 聚合（last_overall 取最近一次）", () => {
    const rows = listSpecs({ home } as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      spec_id: "spec_111111111111",
      spec_version: 3,
      units: 2,
      verdict: "ready",
      material: "mat_aaaaaaaaaaaa",
      runs: 2,
      last_overall: "NEEDS-MATERIAL",
      last_run: "run_b",
    });
  });

  it("构造追溯载荷 = spec + prepare + trace，未知 id 返回 null", () => {
    const d = specDetail({ home } as any, "spec_111111111111");
    expect(d?.spec).toMatchObject({ title: "运费对账" });
    expect(d?.prepare).toMatchObject({ verdict: "ready" });
    expect(d?.trace).toMatchObject({ stages: [{ stage: "P1", ok: true }] });
    expect(specDetail({ home } as any, "spec_missing")).toBeNull();
  });

  it("报告清单按 finished 倒序，归档数来自侧车而非猜测", () => {
    const rows = listReports({ home } as any);
    expect(rows.map((r) => r.run_id)).toEqual(["run_b", "run_a"]);
    expect(rows.find((r) => r.run_id === "run_a")).toMatchObject({ overall: "PASS", archived: 1, mode: "sealed" });
    expect(rows.find((r) => r.run_id === "run_b")).toMatchObject({ overall: "NEEDS-MATERIAL", archived: 0 });
  });

  it("报告详情 = 报告原文 + 归档侧车；未知 run 返回 null", () => {
    const d = reportDetail({ home } as any, "run_a");
    expect((d?.report as any).overall).toBe("PASS");
    expect(d?.archives).toHaveLength(1);
    expect(reportDetail({ home } as any, "run_missing")).toBeNull();
  });

  it("材料清单只回投影、正文单独取（构造追溯左列的事实源）", () => {
    const rows = listMaterials({ home } as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ material_id: "mat_aaaaaaaaaaaa", files: 1, title: "运费对账材料" });
    const m = getMaterial({ home } as any, "mat_aaaaaaaaaaaa");
    expect(m?.text).toContain("共 3 单");
    expect(getMaterial({ home } as any, "mat_missing")).toBeNull();
  });
});

describe("verify 服务面：材料草稿写入", () => {
  it("同正文重复提交返回同一 material_id（幂等），空正文拒绝", () => {
    const a = createMaterialDraft({ home } as any, { title: "草稿", text: "再提交一次同一段话。" });
    const b = createMaterialDraft({ home } as any, { title: "草稿2", text: "再提交一次同一段话。" });
    expect(a.ok && b.ok && (a as any).material_id === (b as any).material_id).toBe(true);
    const bad = createMaterialDraft({ home } as any, { title: "空", text: "   " });
    expect(bad.ok).toBe(false);
    expect((bad as any).error).toContain("empty");
  });
});

describe("verify 服务面：HTTP 契约", () => {
  it("GET /api/verify/specs 返回数组；未知端点 404；非 GET 405", async () => {
    const r = await fetch(`${base}/api/verify/specs`);
    expect(r.status).toBe(200);
    const rows = (await r.json()) as any[];
    expect(rows[0].spec_id).toBe("spec_111111111111");

    const miss = await fetch(`${base}/api/verify/spec?id=spec_missing`);
    expect(miss.status).toBe(404);

    const deny = await fetch(`${base}/api/verify/specs`, { method: "PUT" });
    expect(deny.status).toBe(405);

    const unknown = await fetch(`${base}/api/verify/nope`);
    expect(unknown.status).toBe(404);
  });

  it("POST /api/verify/material 收草稿；attachments 显式拒收（不静默丢弃）", async () => {
    const ok = await fetch(`${base}/api/verify/material`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "网页草稿", text: "从三视图提交的一段话材料。" }),
    });
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as any;
    expect(j.material_id).toMatch(/^mat_[0-9a-f]{12}$/);

    const att = await fetch(`${base}/api/verify/material`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "带附件", text: "附件还没实现。", attachments: ["bills.xlsx"] }),
    });
    expect(att.status).toBe(400);
    expect(((await att.json()) as any).error).toContain("verify submit --attach");

    const empty = await fetch(`${base}/api/verify/material`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "空", text: "" }),
    });
    expect(empty.status).toBe(400);
  });
});
