import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { DatabaseService, apply as applyDatabase } from "../../../core/database/src/plugin";
import { OpsService } from "../src/plugin";

/** 0.86 M7-1 (Cordis P0-1): model-eval via ctx.ops — the OpsService owns
 * the ops domain; research/knowledge call the service, never the source.
 * Boots the real Cordis composition (database → ops, bundle order) on a
 * scratch home; eval paths probed offline (YGL_EVAL_OFFLINE=1). */
describe("OpsService（ctx.ops）eval services", () => {
  process.env.YGL_EVAL_OFFLINE = "1"; // deterministic: no gateway calls
  process.env.YGL_TEST = "1";         // skip dir-lock in unit context

  const close = (app: Context) => {
    // #51 single native driver: an open better-sqlite3 handle keeps the file
    // (and therefore its tmp dir) locked on Windows.
    try { (app as any).database?.stop?.(); } catch { /* already stopped */ }
  };
  const boot = () => {
    const dir = path.join(process.cwd(), "tmp", `ops-svc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const app = new Context();
    new DatabaseService(app, path.join(dir, "t.db"));
    const svc = new OpsService(app);
    return { app, svc, dir };
  };

  it("服务面：evalClaim / assessEvidence / semanticRank 均经 ctx.ops 暴露", () => {
    const { svc, app, dir } = boot();
    try {
      expect(typeof svc.evalClaim).toBe("function");
      expect(typeof svc.assessEvidence).toBe("function");
      expect(typeof svc.semanticRank).toBe("function");
      expect(typeof (app as any).ops?.evalClaim).toBe("function"); // name registration (ctx.ops)
    } finally {
      close(app);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("evalClaim 离线安全：ok:false（判定链不因无凭证崩溃）", async () => {
    const { svc, app, dir } = boot();
    try {
      const r = await svc.evalClaim({ claim_text: "t", claim_status: "unverified", evidence: [] });
      expect(r.ok).toBe(false);
      expect(typeof r.reasoning).toBe("string");
    } finally {
      close(app);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("assessEvidence 离线安全 + semanticRank 离线透传（保序、null 分）", async () => {
    const { svc, app, dir } = boot();
    try {
      const a = await svc.assessEvidence({ quote: "q", locator: "", source_title: "s" });
      expect(a.ok === false || a.quality_score === null).toBe(true);
      const ranked = await svc.semanticRank("query", [
        { id: "k1", title: "a", excerpt: "x" },
        { id: "k2", title: "b", excerpt: "y" },
      ]);
      expect(ranked.map((r: any) => r.id)).toEqual(["k1", "k2"]);
      expect(ranked.every((r: any) => r.semantic_relevance == null)).toBe(true);
    } finally {
      close(app);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("组合面：ygl.bundle.json = database→ops→research→timer（P0-2 删壳后）", () => {
    const bundlePath = path.resolve(__dirname, "../../../../ygl.bundle.json");
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
    expect(bundle.plugins).toEqual(["database", "ops", "research", "timer"]);
    expect(bundle.plugins).not.toContain("techtree"); // 0.86 P0-2: shell deleted
    expect(bundle.plugins).not.toContain("web-app");  // 0.86 P0-2: shell deleted
  });

  it("ctx.on(\"ygl\") 公共通道（0.86 M7-3）：emitEvent → 桥 → ctx 事件（webui SSE 依赖链）", async () => {
    const dir = path.join(process.cwd(), "tmp", `ops-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    const app = new Context();
    applyDatabase(app, { file: path.join(dir, "t.db") }); // direct apply: service + eventbus→ctx.emit 桥
    try {
      const got: any[] = [];
      const off = (app as any).on("ygl", (evt: any) => got.push(evt));
      const { emitEvent } = await import("../../../core/text/src/eventbus");
      emitEvent({ kind: "probe.test", entity: "probe", entityId: "x", payload: "", ts: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 50));
      off();
      expect(got.some((e: any) => e.kind === "probe.test")).toBe(true);
    } finally {
      (app as any).database?.stop?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
