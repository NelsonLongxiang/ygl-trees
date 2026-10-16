/**
 * 0.35: artifacts view — kind-grouped roster, click renders the full markdown
 * body via react-markdown (reports / specs / designs readable in place).
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";

export interface ArtifactMeta {
  id: string;
  kind: string;
  title: string;
  version: number;
  created: string;
}

const KIND_ZH: Record<string, string> = {
  report: "报告",
  spec: "规格",
  design: "设计",
  outline: "大纲",
  section: "章节",
  note: "笔记",
};

async function fetchArtifact(id: string): Promise<{ title: string; content: string } | null> {
  const r = await fetch(`api/artifact?id=${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return r.json();
}

export default function Artifacts({ artifacts }: { artifacts: ArtifactMeta[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<{ title: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);

  if (!artifacts.length) return <p className="dim">暂无产出（produce outline/section/report/spec/design）</p>;

  const kinds = [...new Set(artifacts.map((a) => a.kind))];
  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null);
      setBody(null);
      return;
    }
    setOpen(id);
    setBody(null);
    setLoading(true);
    setBody(await fetchArtifact(id));
    setLoading(false);
  };

  return (
    <div>
      {kinds.map((k) => {
        const rows = artifacts.filter((a) => a.kind === k);
        return (
          <div key={k}>
            <div className="dim" style={{ textTransform: "uppercase", letterSpacing: "0.05em", margin: "6px 0 2px" }}>
              {KIND_ZH[k] || k} · {rows.length}
            </div>
            {rows.map((a) => (
              <div key={a.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(a.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(a.id);
                    }
                  }}
                  style={{
                    background: "var(--color-surface)",
                    borderLeft: open === a.id ? "3px solid var(--color-primary)" : "3px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "6px 12px",
                    margin: "4px 0",
                    cursor: "pointer",
                  }}
                >
                  {a.title} <span className="dim">v{a.version}</span>
                </div>
                {open === a.id && (
                  <div
                    style={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border-dim)",
                      borderRadius: "var(--radius-sm)",
                      padding: "var(--spacing-md)",
                      margin: "2px 0 8px",
                      fontSize: "0.85em",
                      lineHeight: 1.6,
                    }}
                  >
                    {loading && <p className="dim">加载中…</p>}
                    {body && (
                      <ReactMarkdown
                        components={{
                          h1: (p) => <h2 style={{ color: "var(--color-tertiary)", fontSize: "1.05em", margin: "8px 0 4px" }} {...p} />,
                          h2: (p) => <h3 style={{ color: "var(--color-tertiary)", fontSize: "0.95em", margin: "8px 0 3px" }} {...p} />,
                          a: (p) => <a style={{ color: "var(--color-primary)" }} {...p} />,
                          code: (p) => <code style={{ background: "var(--color-neutral)", padding: "1px 5px", borderRadius: "3px", fontSize: "0.85em" }} {...p} />,
                          pre: (p) => <pre style={{ background: "var(--color-neutral)", padding: "8px", borderRadius: "var(--radius-sm)", overflowX: "auto" }} {...p} />,
                          blockquote: (p) => <blockquote style={{ borderLeft: "3px solid var(--color-border)", margin: "6px 0", paddingLeft: "10px", color: "var(--color-secondary)" }} {...p} />,
                          table: (p) => <table style={{ borderCollapse: "collapse", fontSize: "0.9em" }} {...p} />,
                          th: (p) => <th style={{ border: "1px solid var(--color-border-dim)", padding: "3px 7px", textAlign: "left" }} {...p} />,
                          td: (p) => <td style={{ border: "1px solid var(--color-border-dim)", padding: "3px 7px" }} {...p} />,
                        }}
                      >
                        {body.content}
                      </ReactMarkdown>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
