import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { Store } from "../../../research/pipeline/src/reads";
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
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  db?.close();
});

function env() {
  return { ctx: { json: true, color: false, quiet: true }, db, store } as any;
}

describe("webui gatherData", () => {
  it("brief 带 counts，tree/claims/sources 默认空", () => {
    const d = gatherData(env());
    expect(d.brief.current_project).toBeNull();
    expect(typeof d.brief.counts).toBe("object");
    expect(d.tree).toBeNull();
    expect(d.claims).toEqual([]);
    expect(d.sources).toEqual([]);
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
    data.claims = [{ id: 1, text: "evil </script><script>alert(1)</script>", status: "unverified", sup: 0, ref: 0 }];
    const html = generateHTML(data, false);
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script>");
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
  it("/api/data 返回 JSON（live 收集）", async () => {
    const res = await fetch(base + "/api/data");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const d = await res.json();
    expect(d).toHaveProperty("brief.counts");
    expect(d).toHaveProperty("tree");
    expect(d).toHaveProperty("claims");
  });
  it("未知路径 404", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
  });
});
