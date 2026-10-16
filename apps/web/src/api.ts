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
  };
  tree: TreeData | null;
  claims: Array<{ id: string; text: string; status: string; sup: number; ref: number }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  artifacts: Array<{ id: string; kind: string; title: string; version: number; created: string }>;
  timeline: Array<{ day: string; research: number; tree: number; eval: number; other: number }>;
}

export async function fetchDashboard(): Promise<DashboardData> {
  const r = await fetch("api/data");
  if (!r.ok) throw new Error(`api/data ${r.status}`);
  return r.json();
}

export async function fetchNode(tree: string, key: string): Promise<NodeDetail | null> {
  const r = await fetch(`api/node?tree=${encodeURIComponent(tree)}&key=${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  return r.json();
}
