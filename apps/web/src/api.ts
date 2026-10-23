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
  let probing = false;
  // Every fetch failure is reported, never swallowed: with data already on screen
  // the shell shows it as "实时更新中断" over the stale view (review of 66d10ab).
  const refresh = () => fetchDashboard().then(onData).catch((e) => onError?.(String(e?.message || e)));
  // degraded path: poll only until (and unless) SSE takes over
  const poll = window.setInterval(() => {
    if (live) return;
    refresh();
  }, 10000);
  // immediate first paint regardless of transport
  refresh();

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
      // browser auto-reconnects; fall back to polling until it does. Probe once
      // now rather than at the next 10s tick: server gone → onError at once;
      // server up without SSE (older server, stripping proxy) → data, no alarm.
      live = false;
      if (probing) return;
      probing = true;
      refresh().finally(() => {
        probing = false;
      });
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
  /** #27 Q3 / 方案 T6：报告的语义边界（structural | factual | semantic）；契约 ≤1.2 的报告没有该字段 → null，UI 按 structural 显示 */
  semantic_scope?: string | null;
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
    /** 语义边界（#27 Q3）：缺失即 structural——父 PASS 不代表子结论为真 */
    semantic_scope?: string;
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
      semantic_scope?: string;
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

export interface VerifyBlobRef {
  sha256: string;
  size: number;
  mime: string;
}

/** 附件字节上传：原始字节 PUT 到内容寻址仓（服务端算 sha256，客户端不报哈希）。 */
export async function uploadVerifyBlob(file: File): Promise<VerifyBlobRef> {
  const q = new URLSearchParams({ name: file.name });
  if (file.type) q.set("mime", file.type);
  const r = await fetch(`api/verify/blob?${q.toString()}`, { method: "PUT", body: file });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((body as any)?.error || `api/verify/blob ${r.status}`));
  return body as VerifyBlobRef;
}

export interface VerifyArchiveRow {
  run_id: string;
  archive_id: string;
  filename: string;
  archive_sha256: string;
  zip_sha256: string;
  created: string;
  with: string[];
}

export async function fetchVerifyArchives(): Promise<VerifyArchiveRow[]> {
  const r = await fetch("api/verify/archives");
  if (!r.ok) throw new Error(`api/verify/archives ${r.status}`);
  return r.json();
}

export interface VerifyAttachmentRef {
  sha256: string;
  name: string;
  mime?: string;
}

export async function submitVerifyMaterial(input: {
  title: string;
  text: string;
  attachments?: VerifyAttachmentRef[];
}): Promise<{ material_id: string; text_sha256: string; files?: Array<{ path: string; sha256: string; size: number }> }> {
  const r = await fetch("api/verify/material", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String((body as any)?.error || `api/verify/material ${r.status}`));
  return body as { material_id: string; text_sha256: string; files?: Array<{ path: string; sha256: string; size: number }> };
}

export type TaskStatus = "todo" | "doing" | "done";

/**
 * R12.2 勾销：move one task a step along todo → doing → done. The server takes
 * the status the client last saw and writes the next one (it does not re-read
 * the row), so callers must send the status currently on screen and never
 * resend while a request is in flight. Errors are plain text (404 = task not in
 * the authorized project, 400 = malformed) and surface verbatim.
 */
export async function advanceTask(id: string, status: TaskStatus): Promise<{ id: string; title: string; from: TaskStatus; to: TaskStatus }> {
  const r = await fetch("api/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.trim() || `api/task ${r.status}`);
  return JSON.parse(text);
}
