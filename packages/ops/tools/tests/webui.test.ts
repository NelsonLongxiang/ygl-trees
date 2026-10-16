import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { gatherData, generateHTML, createDashboardServer } from "../src/webui";

let db: DB;
let dir: string;
let store: Store;
let server: ReturnType<typeof createDashboardServer>;
let base: string;

beforeAll(async () => {
  dir = path.join(process.cwd(), "tmp", `webui-unit-${Date.now()}`);
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
  await writes.artifactAdd(ds, proj.id, "outline", "单测大纲", "# 单测项目\n结论要点"); // 0.35 artifacts
  const tree = await treeWrites.treeCreate(ds, "wt", proj.id, "");
  await treeWrites.nodeAdd(ds, tree.id, { key: "root" });
  await treeWrites.nodeAdd(ds, tree.id, { key: "leaf", tier: 1 });
  await treeWrites.link(ds, tree.id, "root", "leaf");
  db.metaSet("current_tree", "wt");
});

afterAll(async () => {
  await closeOrm();
  if (server) await new Promise((r) => server.close(r));
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
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
    expect(html).toContain("数据内嵌于导出时");
  });
  it("中文友好化：统计卡/区头/空态/面板文案全中文", () => {
    const html = generateHTML(gatherData(env()), false);
    for (const label of ["📊 总览", "科技树", "研究断言", "技能", "知识笔记", "下一步操作", "常用技能",
      "解锁状态", "必检未满足", "父节点", "子节点", "关联", "暂无任务", "已证实", "['research', '研究']", "加载中"]) {
      expect(html).toContain(label);
    }
  });
  it("水平布局（用户裁定）：tier 沿 X 左→右、兄弟纵向扇开", () => {
    const html = generateHTML(gatherData(env()), false);
    expect(html).toContain("colGap = 180");
    expect(html).toContain("tierKeys.length * colGap");
    expect(html).toContain("y: 40 + ni * rowGap");
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
  it("/ 与 /classic（R13.5 分流：dist 在则 React 挂 /，内嵌永远在 /classic）", async () => {
    server = createDashboardServer(env());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    // either the React shell (dist built) or the embedded dashboard — both html
    expect(html).toMatch(/id="root"|ygl-trees dashboard/);
    // the embedded zero-dep dashboard is always reachable at /classic
    const classic = await fetch(base + "/classic");
    expect(classic.status).toBe(200);
    expect(await classic.text()).toContain("ygl-trees dashboard");
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
  it("未知 /api 路径 404（React 分流下 SPA 路径回落 200 属预期）", async () => {
    const res = await fetch(base + "/api/nope");
    expect(res.status).toBe(404);
  });
  it("0.35：artifacts 清单（非 task 工件）+ /api/artifact 全文", async () => {
    const d = gatherData(env());
    expect(d.artifacts.length).toBe(1);
    expect(d.artifacts[0].kind).toBe("outline");
    const res = await fetch(`${base}/api/artifact?id=${d.artifacts[0].id}`);
    expect(res.status).toBe(200);
    const full = await res.json();
    expect(full.content).toContain("单测项目");
    expect((await fetch(`${base}/api/artifact?id=nope`)).status).toBe(404);
  });

  it("0.39 SSE：/api/events 推送到连接（首帧快照 + 变更帧）", async () => {
    const res = await fetch(`${base}/api/events`, { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames: Array<{ ev: string; data: string }> = [];
    // read() blocks until data arrives — race it against a deadline, or the
    // collector hangs forever waiting for a frame the test has yet to cause.
    const race = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    const drain = () => {
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /event: (\w+)\ndata: (.*)/s.exec(raw);
        if (m) frames.push({ ev: m[1], data: m[2] });
      }
    };
    const collect = async (want: number, budgetMs: number) => {
      const until = Date.now() + budgetMs;
      while (frames.length < want && Date.now() < until) {
        const chunk = await race(reader.read(), Math.max(50, until - Date.now()));
        if (!chunk || chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        drain();
      }
    };
    try {
      await collect(1, 3000); // connect snapshot
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames[0].ev).toBe("data");
      const snap = JSON.parse(frames[0].data);
      expect(Array.isArray(snap.tasks)).toBe(true);
      const before = snap.tasks.length;
      // mutate the workspace: the 1.5s fingerprint tick must push a fresh frame
      const writes = await import("../../../research/pipeline/src/writes");
      const ds = await getOrm(path.join(dir, "unit.db"));
      const cur = db.metaGet("current_project");
      const projRow = db.get("SELECT id FROM projects WHERE name=?", [cur]) as any;
      await writes.taskAdd(ds, projRow.id, "SSE 单测新任务");
      await collect(2, 8000);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const latest = JSON.parse(frames[frames.length - 1].data);
      expect(latest.tasks.length).toBe(before + 1);
      expect(latest.tasks.some((t: any) => t.title === "SSE 单测新任务")).toBe(true);
    } finally {
      // release the socket or afterAll's server.close() waits forever
      await reader.cancel().catch(() => {});
    }
  }, 20000);
});
