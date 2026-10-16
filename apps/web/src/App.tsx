import { useEffect, useState } from "react";
import { fetchDashboard, type DashboardData } from "./api";
import TreeFlow from "./TreeFlow";

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard().then(setData).catch((e) => setErr(String(e.message || e)));
    const t = setInterval(() => fetchDashboard().then(setData).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, []);

  if (err)
    return (
      <div style={{ padding: "var(--spacing-lg)" }}>
        <h1>🐵 ygl-trees workbench</h1>
        <p className="dim">api/data 不可达：{err}</p>
        <p className="mono">ygl-trees webui serve --port 8642</p>      </div>
    );
  if (!data) return <div style={{ padding: "var(--spacing-lg)" }}><h1>🐵 ygl-trees workbench</h1><p className="dim">加载中…</p></div>;

  const counts = data.brief.counts || {};
  const cards: Array<[string, string]> = [
    ["skills", "技能"], ["kb_notes", "知识笔记"], ["sources", "来源"],
    ["evidence", "证据"], ["claims", "断言"], ["tasks", "任务"],
    ["trees", "科技树"], ["nodes", "节点"],
  ];

  return (
    <div style={{ padding: "var(--spacing-lg)", maxWidth: 1280, margin: "0 auto" }}>
      <h1>🐵 ygl-trees workbench</h1>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "var(--spacing-sm)" }}>
        {cards.map(([k, label]) => (
          <div key={k} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)", textAlign: "center" }}>
            <div style={{ fontSize: "1.5em", fontWeight: 700, color: "var(--color-primary)" }}>{counts[k] ?? 0}</div>
            <div className="dim">{label}</div>
          </div>
        ))}
      </div>

      {data.brief.project && (
        <p style={{ marginTop: "var(--spacing-md)" }}>
          项目 <b>{data.brief.project.name}</b> · 来源 {data.brief.project.sources} · 证据{" "}
          {data.brief.project.evidence} · 断言 {data.brief.project.verified_claims}/{data.brief.project.claims} 已证实
        </p>
      )}
      {data.brief.next_actions?.length > 0 && (
        <>
          <h2>下一步操作</h2>
          {data.brief.next_actions.map((a) => (
            <div key={a} className="mono">→ {a}</div>
          ))}
        </>
      )}

      <h2>科技树 <span className="dim">(xyflow · 拖拽缩放 · 小地图)</span></h2>
      <TreeFlow tree={data.tree} />

      {data.tasks.length > 0 && (
        <>
          <h2>任务清单</h2>
          {(["todo", "doing", "done"] as const).map((s) => {
            const rows = data.tasks.filter((t) => t.status === s);
            if (!rows.length) return null;
            const color = s === "todo" ? "var(--color-secondary)" : s === "doing" ? "var(--color-warning)" : "var(--color-success)";
            const label = s === "todo" ? "待办" : s === "doing" ? "进行中" : "已完成";
            return (
              <div key={s}>
                <div className="dim" style={{ color, textTransform: "uppercase", letterSpacing: "0.05em", margin: "6px 0 2px" }}>
                  {label} · {rows.length}
                </div>
                {rows.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      background: "var(--color-surface)",
                      borderRadius: "var(--radius-sm)",
                      padding: "6px 12px",
                      margin: "4px 0",
                      textDecoration: s === "done" ? "line-through" : "none",
                      color: s === "done" ? "var(--color-secondary)" : "var(--color-text)",
                    }}
                  >
                    {t.title}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
