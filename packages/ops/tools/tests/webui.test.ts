import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { getOrm } from "../../../core/database/src/orm";
import { gatherData, generateHTML, createDashboardServer } from "../src/webui";

let db: DB;
let store: Store;
let server: ReturnType<typeof createDashboardServer>;
let base: string;

beforeAll(async () => {
  const dir = path.join(process.cwd(), "tmp", `webui-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "unit.db"));
  store = new Store(db);
  // seed a small graph + research data for /api/node and claim expand
  const ds = await getOrm(path.join(dir, "unit.db"));
  const writes = await import("../../../research/pipeline/src/writes");
  const treeWrites = await import("../../../techtree/model/src/writes");
  const proj = await writes.projectCreate(ds, "webui-unit", "单测项目");
  const src = await writes.sourceAdd(ds, proj.id, { title: "来源A", url: "https://ex.com/a", abstract: "摘要", relevance: 4, confidence: "A" });
  const ev = await writes.evidenceAdd(ds, proj.id, src.row.id, "关键摘录原文", "", "§2");
  const cl = await writes.claimAdd(ds, proj.id, "单测断言：面板可用");
  await writes.claimLink(ds, cl.row.id, ev.row.id, "supports");
  const tree = await treeWrites.treeCreate(ds, "wt", proj.id, "");
  await treeWrites.nodeAdd(ds, tree.id, { key: "root" });
  await treeWrites.nodeAdd(ds, tree.id, { key: "leaf", tier: 1 });
  await treeWrites.link(ds, tree.id, "root", "leaf");
  db.metaSet("current_tree", "wt");
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  db?.close();
});

function env() {
  return { ctx: { json: true, color: false, quiet: true }, db, store } as any;
}

describe("webui gatherData", () => {
  it("brief 为 buildBrief 富载荷：next_actions/top_skills/进度齐备", () => {
    const d = gatherData(env());
    expect(d.brief.current_project).toBe("webui-unit");
    expect(Array.isArray(d.brief.next_actions)).toBe(true);
    expect(d.brief.next_actions.length).toBeGreaterThan(0);
    expect(d.brief.project).toMatchObject({ sources: 1, evidence: 1, claims: 1 });
    expect(Array.isArray(d.brief.top_skills)).toBe(true);
    expect(d.tree).toBeTruthy();
  });
  it("claim-evidence 关联与证据索引已填充", () => {
    const d = gatherData(env());
    expect(d.claims.length).toBe(1);
    expect(d.claim_evidence.length).toBe(1);
    expect(d.claim_evidence[0]).toMatchObject({ stance: "supports" });
    expect(d.evidence.length).toBe(1);
    expect(d.evidence[0].quote).toContain("关键摘录原文");
  });
  it("R11：树节点带 created/unlocked_at/state，timeline 日聚合成形", () => {
    const d = gatherData(env());
    const n = d.tree.nodes[0];
    expect(n.created).toBeTruthy();
    expect("state" in n && "unlocked_at" in n).toBe(true);
    expect(Array.isArray(d.timeline)).toBe(true);
    // our own seeding wrote events today → at least one bucketed day
    expect(d.timeline.length).toBeGreaterThanOrEqual(1);
    const t = d.timeline[d.timeline.length - 1];
    for (const k of ["day", "research", "tree", "eval", "other"]) expect(k in t).toBe(true);
  });
});

describe("webui generateHTML", () => {
  it("包含 dashboard 标记与内嵌数据", () => {
    const html = generateHTML(gatherData(env()), false);
    expect(html).toContain("ygl-trees dashboard");
    expect(html).toContain("const FALLBACK =");
    expect(html).toContain("data embedded at export time");
  });
  it("live 模式带 fetch 引导与 10s 轮询", () => {
    const html = generateHTML(gatherData(env()), true);
    expect(html).toContain("fetch('api/data')");
    expect(html).toContain("setInterval(refresh, 10000)");
    expect(html).toContain("live mode");
  });
  it("内嵌 JSON 转义 <，防 </script> 注入", () => {
    const data = gatherData(env());
    data.claims = [{ id: "x1", text: "evil </script><script>alert(1)</script>", status: "unverified", sup: 0, ref: 0 }];
    const html = generateHTML(data, false);
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script>");
  });
  it("内嵌 <script> 语法可编译（模板转义回归护栏）", () => {
    for (const live of [false, true]) {
      const html = generateHTML(gatherData(env()), live);
      const m = html.match(/<script>([\s\S]*)<\/script>/);
      expect(m).toBeTruthy();
      expect(() => new Function(m![1])).not.toThrow();
    }
  });
  it("claims 分组与节点点击处理函数存在", () => {
    const html = generateHTML(gatherData(env()), false);
    expect(html).toContain("function renderClaims");
    expect(html).toContain("function nodeClick");
    expect(html).toContain('id="node-panel"');
  });
});

describe("webui live server", () => {
  it("/", async () => {
    server = createDashboardServer(env());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ygl-trees dashboard");
  });
  it("/api/data 返回 JSON（live 收集，brief 含 next_actions）", async () => {
    const res = await fetch(base + "/api/data");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const d = await res.json();
    expect(d).toHaveProperty("brief.counts");
    expect(d.brief.next_actions.length).toBeGreaterThan(0);
    expect(d).toHaveProperty("claim_evidence");
    expect(d).toHaveProperty("evidence");
  });
  it("/api/node 命中：node/parents/can 齐备", async () => {
    const res = await fetch(`${base}/api/node?tree=wt&key=leaf`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.node.key).toBe("leaf");
    expect(d.parents.map((p: any) => p.key)).toEqual(["root"]);
    expect(d.children).toEqual([]);
    expect(d.can).toHaveProperty("ok");
  });
  it("/api/node 未命中 404，缺参 400", async () => {
    expect((await fetch(`${base}/api/node?tree=wt&key=nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/node`)).status).toBe(400);
  });
  it("未知路径 404", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });
});
