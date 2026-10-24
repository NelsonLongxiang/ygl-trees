/**
 * Client live-channel tests (0.41): the SSE subscription and its polling
 * fallback had no coverage — this pins the contract both ways (live push wins,
 * degraded path still paints when EventSource is absent/broken).
 *
 * Runs in node: EventSource / window / fetch are stubbed, so these are unit
 * tests of the transport logic, not of a real browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { subscribeDashboard, fetchDashboard, advanceTask, type DashboardData } from "../src/api";

const PAYLOAD = (tag: string): DashboardData =>
  ({ brief: { current_project: null, counts: {}, next_actions: [], marker: tag } }) as any;

/** Minimal EventSource double: records instances and lets tests emit frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static throwOnConstruct = false;
  listeners: Record<string, Array<(ev: any) => void>> = {};
  closed = false;
  url: string;
  onerror: ((e: any) => void) | null = null;
  constructor(url: string) {
    if (FakeEventSource.throwOnConstruct) throw new Error("EventSource unsupported");
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type: string, ev: any) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  close() {
    this.closed = true;
  }
}

let fetched: string[] = [];
const fetchStub = vi.fn(async () => {
  fetched.push("poll");
  return { ok: true, status: 200, json: async () => PAYLOAD("fetch") } as any;
});

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeEventSource.throwOnConstruct = false;
  fetched = [];
  fetchStub.mockClear();
  vi.stubGlobal("EventSource", FakeEventSource as any);
  vi.stubGlobal("fetch", fetchStub as any);
  vi.stubGlobal("window", { setInterval: (fn: any, ms: number) => setInterval(fn, ms), clearInterval: (h: any) => clearInterval(h) } as any);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscribeDashboard（SSE 实时 + 轮询降级）", () => {
  it("首帧立刻拉取（不等 SSE），并订阅 api/events", async () => {
    const got: DashboardData[] = [];
    const dispose = subscribeDashboard((d) => got.push(d));
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0].url).toBe("api/events");
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect((got[0] as any).brief.marker).toBe("fetch");
    dispose();
  });

  it("SSE 帧被解析并投递；接管后轮询通道静默", async () => {
    const got: DashboardData[] = [];
    const dispose = subscribeDashboard((d) => got.push(d));
    await vi.waitFor(() => expect(got.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.emit("data", { data: JSON.stringify(PAYLOAD("sse")) });
    expect(got.length).toBe(2);
    expect((got[1] as any).brief.marker).toBe("sse");
    // live=true → the 10s polling path must not fire again
    const pollsBefore = fetched.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetched.length).toBe(pollsBefore);
    dispose();
  });

  it("SSE 未接管时，10s 轮询仍在工作（降级路径）", async () => {
    const got: DashboardData[] = [];
    const dispose = subscribeDashboard((d) => got.push(d));
    await vi.waitFor(() => expect(got.length).toBe(1));
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(2));
    dispose();
  });

  it("SSE 断线后回落轮询（onerror → 降级可恢复）", async () => {
    const got: DashboardData[] = [];
    const dispose = subscribeDashboard((d) => got.push(d));
    await vi.waitFor(() => expect(got.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.emit("data", { data: JSON.stringify(PAYLOAD("live")) });
    expect(got.length).toBe(2);
    es.onerror?.(new Error("dropped"));
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(3));
    expect((got[got.length - 1] as any).brief.marker).toBe("fetch");
    dispose();
  });

  it("坏帧只报错不炸（onError 收到 parse 失败）", async () => {
    const errs: string[] = [];
    const dispose = subscribeDashboard(() => {}, (e) => errs.push(e));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    FakeEventSource.instances[0].emit("data", { data: "{not json" });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/event parse/);
    dispose();
  });

  it("EventSource 构造抛错 → onError，且轮询兜底仍可用", async () => {
    FakeEventSource.throwOnConstruct = true;
    const errs: string[] = [];
    const got: DashboardData[] = [];
    const dispose = subscribeDashboard((d) => got.push(d), (e) => errs.push(e));
    expect(errs.some((e) => /eventsource unavailable/.test(e))).toBe(true);
    await vi.waitFor(() => expect(got.length).toBe(1));
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(2));
    dispose();
  });

  it("disposer 关闭 EventSource（不留悬挂连接）", async () => {
    const dispose = subscribeDashboard(() => {});
    const es = FakeEventSource.instances[0];
    dispose();
    expect(es.closed).toBe(true);
  });

  it("fetchDashboard 非 2xx 抛错（错误路径可观测）", async () => {
    fetchStub.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }) as any);
    await expect(fetchDashboard()).rejects.toThrow(/api\/data 500/);
  });
});

describe("subscribeDashboard 断线上报（66d10ab 复评：断线不得静默）", () => {
  const down = () => fetchStub.mockImplementation(async () => {
    throw new TypeError("Failed to fetch");
  });
  // mockClear (file-level beforeEach) keeps a swapped implementation — put the healthy server back
  afterEach(() => {
    fetchStub.mockImplementation(async () => {
      fetched.push("poll");
      return { ok: true, status: 200, json: async () => PAYLOAD("fetch") } as any;
    });
  });

  it("已有数据后服务被杀：SSE onerror 立即探测，失败即 onError（不等 10s 轮询）", async () => {
    const got: DashboardData[] = [];
    const errors: string[] = [];
    const dispose = subscribeDashboard((d) => got.push(d), (e) => errors.push(e));
    await vi.waitFor(() => expect(got.length).toBe(1));
    FakeEventSource.instances[0].emit("data", { data: JSON.stringify(PAYLOAD("sse")) });
    down();
    FakeEventSource.instances[0].onerror?.({});
    await vi.waitFor(() => expect(errors).toEqual(["Failed to fetch"]));
    expect(got.length).toBe(2); // stale data stays; the error rides on top of it
    dispose();
  });

  it("SSE 不可用但服务在（老服务端 / 剥离代理）：探测成功只投递数据，不误报", async () => {
    const got: DashboardData[] = [];
    const errors: string[] = [];
    const dispose = subscribeDashboard((d) => got.push(d), (e) => errors.push(e));
    await vi.waitFor(() => expect(got.length).toBe(1));
    FakeEventSource.instances[0].onerror?.({});
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(errors).toEqual([]);
    dispose();
  });

  it("重连风暴只并发一个探测（onerror 连发不叠请求）", async () => {
    const dispose = subscribeDashboard(() => {}, () => {});
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    let release!: () => void;
    fetchStub.mockImplementation(() => new Promise((r) => {
      release = () => r({ ok: true, status: 200, json: async () => PAYLOAD("late") } as any);
    }));
    const es = FakeEventSource.instances[0];
    es.onerror?.({});
    es.onerror?.({});
    es.onerror?.({});
    expect(fetchStub).toHaveBeenCalledTimes(2);
    release();
    dispose();
  });

  it("降级轮询失败也上报（原 .catch(() => {}) 吞错）", async () => {
    const errors: string[] = [];
    const dispose = subscribeDashboard(() => {}, (e) => errors.push(e));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    down();
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(() => expect(errors).toEqual(["Failed to fetch"]));
    dispose();
  });
});

describe("advanceTask (R12.2)", () => {
  it("posts the TARGET status (the step after the one on screen) and returns the step the server wrote (#70)", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "t1", title: "x", from: "todo", to: "doing" }) };
    }) as any);
    const r = await advanceTask("t1", "doing");
    expect(r.to).toBe("doing");
    expect(calls[0].url).toBe("api/task");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ id: "t1", status: "doing" });
  });

  it("surfaces the server's plain-text refusal verbatim", async () => {
    vi.stubGlobal("fetch", (async () => ({ ok: false, status: 404, text: async () => "task not accessible under current selection: t1" })) as any);
    await expect(advanceTask("t1", "done")).rejects.toThrow("task not accessible under current selection: t1");
  });

  it("a 409 from a stale page shows the server's error, not the raw JSON body (#66)", async () => {
    const body = { error: "task t1 is 'done'; only 'done' (or idempotent 'done') is allowed", current_status: "done", expected_next: "done" };
    vi.stubGlobal("fetch", (async () => ({ ok: false, status: 409, text: async () => JSON.stringify(body) })) as any);
    const err = await advanceTask("t1", "doing").catch((e) => e as Error);
    expect(err.message).toBe(body.error);
  });
});
