/** Shared types for the dashboard API (mirrors ops/tools webui.ts gatherData). */
export interface TreeData {
  name: string;
  nodes: Array<{
    key: string; name: string; kind: string; tier: number; cost: number; tags: string;
    created: string; state?: string | null; unlocked_at?: string | null;
  }>;
  edges: Array<{ parent: string; child: string; rel: string; mode: string; required: number }>;
}

export interface NodeDetail {
  node: { key: string; name: string; kind: string; tier: number; cost: number };
  parents: Array<{ key: string; required?: number }>;
  children: Array<{ key: string; required?: number }>;
  conditions: Array<{ name: string; kind: string; op: string; value: string; required: number; effect: string }>;
  can: { ok: boolean; missing_required: string[]; missing_optional: string[]; blocked_by: string[]; cost_multiplier: number };
  related: Array<{ rel: string; type: string; id: string; dir: string; display: string }>;
}

export interface DashboardData {
  brief: {
    current_project: string | null;
    counts: Record<string, number>;
    next_actions: string[];
    project?: { name: string; question: string | null; sources: number; evidence: number; claims: number; verified_claims: number; artifacts: number };
    top_skills?: Array<{ name: string; description: string }>;
    selection_source?: string;
    session?: string;
  };
  tree: TreeData | null;
  tree_selection_source?: string;
  /** R16.4 (0.90.1): present when no authorized project selection resolves —
   * the dashboard renders the 未选择 pane instead of project content. */
  unselected?: { reason: string; projects: Array<{ name: string }> };
  claims: Array<{ id: string; text: string; status: string; sup: number; ref: number }>;
  /** 0.92 单A（管线视图）：claim↔evidence 链接与证据引文——服务端按授权域
   * 收集（R19：未选择时不填），此处类型化承载，渲染组件读这些键。 */
  claim_evidence?: Array<{ claim_id: string; evidence_id: string; stance: string }>;
  evidence?: Array<{ id: string; quote: string; locator?: string | null; source_id: string }>;
  sources?: Array<{ id: string; url: string; note?: string | null }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  artifacts: Array<{ id: string; kind: string; title: string; version: number; created: string }>;
  timeline: Array<{ day: string; research: number; tree: number; eval: number; other: number }>;
  knowledge_graph?: { nodes: Array<{ id: string; label: string; type: string; color: string }>; edges: Array<{ source: string; target: string; label: string }> };
}

export async function fetchDashboard(): Promise<DashboardData> {
  const r = await fetch("api/data");
  if (!r.ok) throw new Error(`api/data ${r.status}`);
  return r.json();
}

/**
 * Live dashboard subscription (0.39): the server pushes a fresh payload over
 * SSE whenever its table fingerprint moves, so the client does zero polling.
 * A 10s polling interval stays as the DEGRADED path: it only runs while no
 * live connection has been established (older servers, proxies that strip
 * event-stream, browser EventSource limits).
 *
 * Returns a disposer.
 */
export function subscribeDashboard(
  onData: (d: DashboardData) => void,
  onError?: (e: string) => void
): () => void {
  let live = false;
  // degraded path: poll only until (and unless) SSE takes over
  const poll = window.setInterval(() => {
    if (live) return;
    fetchDashboard().then(onData).catch(() => {});
  }, 10000);
  // immediate first paint regardless of transport
  fetchDashboard().then(onData).catch((e) => onError?.(String(e?.message || e)));

  let es: EventSource | null = null;
  try {
    es = new EventSource("api/events");
    es.addEventListener("data", (ev: MessageEvent) => {
      live = true;
      try {
        onData(JSON.parse(ev.data));
      } catch (e: any) {
        onError?.(`event parse: ${String(e?.message || e)}`);
      }
    });
    es.onerror = () => {
      // browser auto-reconnects; fall back to polling until it does
      live = false;
    };
  } catch (e: any) {
    onError?.(`eventsource unavailable: ${String(e?.message || e)}`);
  }

  return () => {
    window.clearInterval(poll);
    try { es?.close(); } catch { /* */ }
  };
}

export async function fetchNode(tree: string, key: string): Promise<NodeDetail | null> {
  const r = await fetch(`api/node?tree=${encodeURIComponent(tree)}&key=${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  return r.json();
}
