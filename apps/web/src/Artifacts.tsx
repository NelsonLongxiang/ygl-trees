/**
 * 0.35: artifacts view — kind-grouped roster, click renders the full markdown
 * body via react-markdown (reports / specs / designs readable in place).
 *
 * On real data a report is regenerated as claims move (`produce report` → v1…v5,
 * same title), so the roster shows one row per document — its latest version,
 * with the date — and keeps the older versions one click away. Bodies run to
 * 50 KB; they render in a reading column (.yt-doc), not the full page width.
 */
import { useRef, useState } from "react";
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
/** Finished deliverables first, working parts after. */
const KIND_ORDER = ["report", "design", "spec", "outline", "section", "note"];

export interface ArtifactDoc {
  latest: ArtifactMeta;
  /** Older versions of the same document, newest first. */
  older: ArtifactMeta[];
}

/** Kind → documents (same kind + title = one document), newest version on top. */
export function groupArtifacts(rows: ArtifactMeta[]): Array<{ kind: string; docs: ArtifactDoc[] }> {
  const kinds = [...new Set(rows.map((a) => a.kind))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return kinds.map((kind) => {
    const byTitle = new Map<string, ArtifactMeta[]>();
    for (const a of rows.filter((r) => r.kind === kind)) byTitle.set(a.title, [...(byTitle.get(a.title) ?? []), a]);
    const docs = [...byTitle.values()].map((vs) => {
      const [latest, ...older] = vs.sort((a, b) => b.version - a.version || b.created.localeCompare(a.created));
      return { latest, older };
    });
    docs.sort((a, b) => b.latest.created.localeCompare(a.latest.created));
    return { kind, docs };
  });
}
const rank = (k: string) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);

/** UTC day, the same day boundary as the activity timeline. */
export const day = (iso: string) => (iso || "").slice(0, 10) || "—";

async function fetchArtifact(id: string): Promise<{ title: string; content: string } | null> {
  const r = await fetch(`api/artifact?id=${encodeURIComponent(id)}`);
  if (!r.ok) return null;
  return r.json();
}

type Body = { state: "loading" } | { state: "error" } | { state: "ok"; content: string };

export default function Artifacts({ artifacts }: { artifacts: ArtifactMeta[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<Body>({ state: "loading" });
  const [history, setHistory] = useState<Set<string>>(new Set());
  // the latest click wins: a slow first body must not land under the second row
  const pending = useRef<string | null>(null);

  if (!artifacts.length) return <p className="dim">暂无产出（produce outline/section/report/spec/design）</p>;

  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null);
      pending.current = null;
      return;
    }
    setOpen(id);
    setBody({ state: "loading" });
    pending.current = id;
    const got = await fetchArtifact(id).catch(() => null);
    if (pending.current !== id) return;
    setBody(got ? { state: "ok", content: got.content } : { state: "error" });
  };
  const flip = (id: string) =>
    setHistory((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const row = (a: ArtifactMeta, label?: string) => (
    <div key={a.id}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open === a.id}
        onClick={() => toggle(a.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(a.id);
          }
        }}
        className="yt-doc-row"
        style={{ borderLeftColor: open === a.id ? "var(--color-primary)" : undefined }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{label ?? a.title}</span>
        <span className="dim">v{a.version} · {day(a.created)}</span>
      </div>
      {open === a.id && (
        <div className="yt-doc">
          {body.state === "loading" && <p className="dim" role="status">加载中…</p>}
          {body.state === "error" && <p className="dim" role="alert">正文读不到（工件可能已被删除），再点一次重试</p>}
          {body.state === "ok" && <ReactMarkdown>{body.content}</ReactMarkdown>}
        </div>
      )}
    </div>
  );

  return (
    <div>
      {groupArtifacts(artifacts).map(({ kind, docs }) => (
        <div key={kind}>
          <div className="dim" style={{ letterSpacing: "0.05em", margin: "10px 0 2px" }}>
            {KIND_ZH[kind] || kind} · {docs.length}
          </div>
          {docs.map(({ latest, older }) => (
            <div key={latest.id}>
              {row(latest)}
              {older.length > 0 && (
                <button type="button" className="yt-link dim" aria-expanded={history.has(latest.id)} onClick={() => flip(latest.id)}>
                  {history.has(latest.id) ? "收起旧版本" : `另有 ${older.length} 个旧版本`}
                </button>
              )}
              {history.has(latest.id) && (
                <div style={{ marginLeft: 16 }}>{older.map((a) => row(a, `${a.title}（旧版）`))}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
