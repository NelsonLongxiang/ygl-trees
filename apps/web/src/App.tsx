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
        <p className="mono">ygl-trees webui serve --port 8642</p>
      </div>
    );
  if (!data) return <div style={{ padding: "var(--spacing-lg)" }}><h1>🐵 ygl-trees workbench</h1><p className="dim">loading…</p></div>;

  const counts = data.brief.counts || {};
  const cards: Array<[string, string]> = [
    ["skills", "Skills"], ["kb_notes", "KB"], ["sources", "Sources"],
    ["evidence", "Evidence"], ["claims", "Claims"], ["tasks", "Tasks"],
    ["trees", "Trees"], ["nodes", "Nodes"],
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
          project <b>{data.brief.project.name}</b> · sources {data.brief.project.sources} · evidence{" "}
          {data.brief.project.evidence} · claims {data.brief.project.verified_claims}/{data.brief.project.claims} verified
        </p>
      )}
      {data.brief.next_actions?.length > 0 && (
        <>
          <h2>next actions</h2>
          {data.brief.next_actions.map((a) => (
            <div key={a} className="mono">→ {a}</div>
          ))}
        </>
      )}

      <h2>Tech Tree <span className="dim">(xyflow · pan/zoom · minimap)</span></h2>
      <TreeFlow tree={data.tree} />

      {data.tasks.length > 0 && (
        <>
          <h2>Tasks</h2>
          {(["todo", "doing", "done"] as const).map((s) => {
            const rows = data.tasks.filter((t) => t.status === s);
            if (!rows.length) return null;
            const color = s === "todo" ? "var(--color-secondary)" : s === "doing" ? "var(--color-warning)" : "var(--color-success)";
            return (
              <div key={s}>
                <div className="dim" style={{ color, textTransform: "uppercase", letterSpacing: "0.05em", margin: "6px 0 2px" }}>
                  {s} · {rows.length}
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
