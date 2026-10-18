import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
import { getOrm, closeOrm } from "../../../core/database/src/orm";
import { gatherData, createDashboardServer, run } from "../src/webui";

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

describe("webui export（0.88 单3：服务形态快照，HTML 退役）", () => {
  it("export 落 snapshot.json：meta.generated + gatherData 全载荷可解析", async () => {
    const dest = path.join(dir, "snap.json");
    const rc = await run(env(), "export", [], { flags: { out: dest } });
    expect(rc).toBe(0);
    const raw = fs.readFileSync(dest, "utf8");
    const snap = JSON.parse(raw);
    expect(snap.meta.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.brief.current_project).toBe("webui-unit");
    expect(snap.claims.length).toBe(1);
    expect(snap.claim_evidence.length).toBe(1);
    expect(snap.tree).toBeTruthy();
  });
  it("默认文件名 snapshot.json + rc 0", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const rc = await run(env(), "export", [], { flags: {} });
      expect(rc).toBe(0);
      expect(fs.existsSync(path.join(dir, "snapshot.json"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("webui live server（0.88 单3：React 唯一前端）", () => {
  it("/ 出 React 客户端；/classic 已退役（404，不再内嵌回落）", async () => {
    server = createDashboardServer(env());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    // repo checkout ships apps/web/dist → resolveDistRoot finds the React build
    expect(html).toContain('id="root"');
    // the embedded pure-HTML dashboard is RETIRED (user ruling 0.88 单3):
    // /classic is no longer a special route — it falls through to the SPA
    // fallback like any client-side route, serving the React shell.
    const classic = await fetch(base + "/classic");
    expect(classic.status).toBe(200);
    expect(await classic.text()).toContain('id="root"');
  }, 20000);
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
    const res = await fetch(base + "/api/events", { headers: { accept: "text/event-stream" } });
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
      // R16: selection is session-scoped now; this home has exactly one project
      const projRow = db.get("SELECT id FROM projects LIMIT 1") as any;
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

describe("webui 0.90.1 P1/P2（review direct-a35d58ae）", () => {
  // SECOND project + task fixtures are created HERE (file order = execution
  // order): everything above already ran under the single-project home.
  const SID = "webui-0901";
  let betaId = "";
  let betaTaskId = "";
  let ownTaskId = "";

  beforeAll(async () => {
    const prevSession = process.env.YGL_SESSION;
    process.env.YGL_SESSION = SID;
    try {
      const writes = await import("../../../research/pipeline/src/writes");
      const ds = await getOrm(path.join(dir, "unit.db"));
      const beta = await writes.projectCreate(ds, "beta-x", "跨项目探针");
      betaId = (beta.row ?? beta).id;
      const t1 = await writes.taskAdd(ds, betaId, "beta 任务（不该被推进）");
      betaTaskId = (t1.row ?? t1).id;
      const own = db.get("SELECT id FROM projects WHERE name='webui-unit'") as any;
      const t2 = await writes.taskAdd(ds, own.id, "自有任务（可推进）");
      ownTaskId = (t2.row ?? t2).id;
    } finally {
      if (prevSession === undefined) delete process.env.YGL_SESSION;
      else process.env.YGL_SESSION = prevSession;
    }
  });

  it("P1-1：非法/缺失 status → 400（文本通道）", async () => {
    const r1 = await fetch(base + "/api/task", { method: "POST", body: JSON.stringify({ id: ownTaskId }) });
    expect(r1.status).toBe(400);
    expect(await r1.text()).toContain("usage");
    const r2 = await fetch(base + "/api/task", { method: "POST", body: JSON.stringify({ id: ownTaskId, status: "weird" }) });
    expect(r2.status).toBe(400);
  });

  it("P1-1：未选择与跨项目 POST → 404 fail-closed", async () => {
    const prevSession = process.env.YGL_SESSION;
    process.env.YGL_SESSION = SID;
    try {
      // unselected: two projects, no session key (projectCreate SELECTS the
      // new project via session key — clear it first), no global pointer
      db.metaSet(`current_project@${SID}`, "");
      const r1 = await fetch(base + "/api/task", { method: "POST", body: JSON.stringify({ id: betaTaskId, status: "todo" }) });
      expect(r1.status).toBe(404);
      // session selects webui-unit → beta's task is cross-project → 404
      db.metaSet(`current_project@${SID}`, "webui-unit");
      const r2 = await fetch(base + "/api/task", { method: "POST", body: JSON.stringify({ id: betaTaskId, status: "todo" }) });
      expect(r2.status).toBe(404);
      expect(await r2.text()).toContain("not accessible");
    } finally {
      db.metaSet(`current_project@${SID}`, "");
      if (prevSession === undefined) delete process.env.YGL_SESSION;
      else process.env.YGL_SESSION = prevSession;
    }
  });

  it("P1-1：授权选择内合法推进 → 200 todo→doing", async () => {
    const prevSession = process.env.YGL_SESSION;
    process.env.YGL_SESSION = SID;
    try {
      db.metaSet(`current_project@${SID}`, "webui-unit");
      const r = await fetch(base + "/api/task", { method: "POST", body: JSON.stringify({ id: ownTaskId, status: "todo" }) });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j).toMatchObject({ from: "todo", to: "doing" });
    } finally {
      db.metaSet(`current_project@${SID}`, "");
      if (prevSession === undefined) delete process.env.YGL_SESSION;
      else process.env.YGL_SESSION = prevSession;
    }
  });

  it("P2-1/P2-2：未选择态 brief.project 剥除 + knowledge_graph 空 + unselected 载荷", () => {
    const prevSession = process.env.YGL_SESSION;
    process.env.YGL_SESSION = SID;
    try {
      const d = gatherData(env());
      expect(d.unselected).toBeTruthy();
      expect(d.unselected!.projects.length).toBe(2);
      expect((d.brief as any).project).toBeUndefined();
      expect((d as any).knowledge_graph).toMatchObject({ nodes: [], edges: [] });
    } finally {
      if (prevSession === undefined) delete process.env.YGL_SESSION;
      else process.env.YGL_SESSION = prevSession;
    }
  });

  it("P1-2：外部进程持写锁期间 tick 不击毙 server（弃拍降级）", async () => {
    // hold the write lock from ANOTHER process for ~2.5s while an SSE client
    // is connected — the 1.5s tick must survive SQLITE_BUSY (dropped frame),
    // not crash the server (review direct-a35d58ae crash stack).
    const holder = await new Promise<number>((resolve) => {
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", `
        const { DB } = require(${JSON.stringify(path.resolve(__dirname, "../../../../dist/packages/core/database/src/db.js"))});
        const d = new DB(${JSON.stringify(path.join(dir, "unit.db"))});
        d.exec("BEGIN IMMEDIATE");
        setTimeout(() => { try { d.exec("COMMIT"); } catch (e) {} d.close(); }, 2500);
      `], { stdio: "ignore" });
      child.on("spawn", () => resolve(child.pid ?? 0));
      if (child.pid) resolve(child.pid);
    });
    const res = await fetch(base + "/api/events", { headers: { accept: "text/event-stream" } });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // connect snapshot
    // let ≥2 ticks fire under lock contention, then prove the server lives
    await new Promise((r) => setTimeout(r, 3500));
    await reader.cancel().catch(() => {});
    const alive = await fetch(base + "/api/data");
    expect(alive.status).toBe(200);
    const j = await alive.json();
    expect(j).toHaveProperty("brief.counts");
  }, 20000);
});
