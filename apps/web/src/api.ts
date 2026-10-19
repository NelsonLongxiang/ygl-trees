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

/** ── 验证器服务面（M13-2）──────────────────────────────────────────────
 * 三视图的数据形状：规范清单 / 构造追溯 / 报告看板。服务端只读文件工件，
 * 唯一写入面是 POST api/verify/material（材料草稿）。 */
export interface VerifySpecRow {
  spec_id: string;
  spec_version: number;
  title: string;
  domain: string;
  created: string;
  units: number;
  verdict: string;
  rounds: number;
  material: string;
  runs: number;
  last_overall: string;
  last_run: string;
}

export interface VerifyReportRow {
  run_id: string;
  spec_id: string;
  spec_version: number;
  overall: string;
  reason: string;
  summary: { pass: number; fail: number; needs_material: number; error: number };
  started: string;
  finished: string;
  mode: string;
  binary_sha256: string;
  archived: number;
}

export interface VerifyMaterialRow {
  material_id: string;
  title: string;
  created: string;
  text_sha256: string;
  files: number;
}

export async function fetchVerifySpecs(): Promise<VerifySpecRow[]> {
  const r = await fetch("api/verify/specs");
  if (!r.ok) throw new Error(`api/verify/specs ${r.status}`);
  return r.json();
}

export async function fetchVerifyReports(): Promise<VerifyReportRow[]> {
  const r = await fetch("api/verify/reports");
  if (!r.ok) throw new Error(`api/verify/reports ${r.status}`);
  return r.json();
}

export async function fetchVerifyMaterials(): Promise<VerifyMaterialRow[]> {
  const r = await fetch("api/verify/materials");
  if (!r.ok) throw new Error(`api/verify/materials ${r.status}`);
  return r.json();
}

export interface VerifySpecDetail {
  spec: {
    spec_id: string;
    spec_version: number;
    title?: string;
    domain?: string;
    sealed?: { review?: boolean };
    vu: Array<{
      id: string;
      role?: string;
      title?: string;
      severity?: string;
      source_clause?: string;
      checker?: { type?: string; mode?: string; expect?: unknown };
      expected_from?: { quote?: string; anchor?: string };
    }>;
  };
  prepare: {
    verdict?: string;
    rounds?: number;
    material_id?: string;
    units?: number;
    rejected?: Array<{ source_clause?: string; stage?: string; reason?: string }>;
  } | null;
  trace: unknown;
}

export async function fetchVerifySpec(id: string): Promise<VerifySpecDetail | null> {
  const r = await fetch(`api/verify/spec?id=${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return r.json();
}

export async function fetchVerifyMaterial(id: string): Promise<{ record: VerifyMaterialRow; text: string } | null> {
  const r = await fetch(`api/verify/material?id=${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return r.json();
}

export interface VerifyReportDetail {
  report: {
    run_id: string;
    overall: string;
    reason: string;
    summary: { pass: number; fail: number; needs_material: number; error: number };
    started: string;
    finished: string;
    data_source?: { kind: string; sha256: string; source?: string; captured_at?: string };
    verifier?: {
      mode?: string;
      spec_version?: number;
      engine_version?: string;
      corpus_version?: string;
      binary_sha256?: string;
      signing_scheme?: string;
      public_key_fingerprint?: string;
    };
    vu: Array<{
      id: string;
      verdict: string;
      severity?: string;
      checker_type?: string;
      source_clause?: string;
      evidence?: Record<string, unknown>;
      trace?: string[];
    }>;
    exceptions?: Array<{ vu: string; severity?: string; row_count?: number }>;
  };
  archives: Array<{ archive_id: string; filename: string; with?: string[] }>;
}

export async function fetchVerifyReport(run: string): Promise<VerifyReportDetail | null> {
  const r = await fetch(`api/verify/report?run=${encodeURIComponent(run)}`);
  if (!r.ok) return null;
  return r.json();
}

export async function submitVerifyMaterial(input: { title: string; text: string }): Promise<{ material_id: string; text_sha256: string }> {
  const r = await fetch("api/verify/material", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((body as any)?.error || `api/verify/material ${r.status}`));
  return body as { material_id: string; text_sha256: string };
}
