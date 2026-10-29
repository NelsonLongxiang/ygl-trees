/**
 * Route pages (react-router, hash history — api paths stay relative, so the
 * build still serves from any sub-path). Each page is one view of the old
 * single scroll column; heavy views stay lazy-loaded.
 */
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Alert, Button, Card, Empty, Space, Statistic, Tag, Typography } from "antd";
import {
  ApartmentOutlined, BookOutlined, CheckCircleOutlined, ClockCircleOutlined, CopyOutlined, DatabaseOutlined,
  ExperimentOutlined, FileTextOutlined, LineChartOutlined, NodeIndexOutlined, PartitionOutlined, SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useDashboard } from "./data";
import { C, statColors } from "./tokens";
import { TaskList } from "./Tasks";
import ActivityTimeline from "./ActivityTimeline";
import { copyText } from "./clipboard";

const TreeFlow = lazy(() => import("./TreeFlow"));
const Artifacts = lazy(() => import("./Artifacts"));
const KnowledgeGraph = lazy(() => import("./KnowledgeGraph"));
const Pipeline = lazy(() => import("./Pipeline"));
const Verify = lazy(() => import("./Verify"));

const { Text } = Typography;

const statIcons: Record<string, ReactNode> = {
  skills: <BookOutlined />,
  kb_notes: <BookOutlined />,
  sources: <DatabaseOutlined />,
  evidence: <FileTextOutlined />,
  claims: <CheckCircleOutlined />,
  trees: <ApartmentOutlined />,
  nodes: <PartitionOutlined />,
};

/** Each stat tile opens the view that holds those things. */
const STAT_VIEW: Record<string, { to: string; label: string }> = {
  skills: { to: "/graph", label: "知识图谱" },
  kb_notes: { to: "/graph", label: "知识图谱" },
  sources: { to: "/pipeline", label: "研究管线" },
  evidence: { to: "/pipeline", label: "研究管线" },
  claims: { to: "/pipeline", label: "研究管线" },
  trees: { to: "/tree", label: "科技树" },
  nodes: { to: "/tree", label: "科技树" },
};

const CANVAS_FALLBACK = <Card loading style={{ height: 300 }} />;

/** Section card: outlined icon + terse noun title, secondary caption on the right. */
function Section({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <Card title={<>{icon} {title}</>} extra={extra && <Text type="secondary">{extra}</Text>} style={{ marginBottom: 16 }}>
      {children}
    </Card>
  );
}

/** R16.4 未选择态：project content stays hidden until an authorized selection. */
function UnselectedNotice({ flush = false }: { flush?: boolean }) {
  const { data } = useDashboard();
  if (!data?.unselected) return null;
  return (
    <Card title={<><NodeIndexOutlined /> 未选择项目</>} size="small" style={flush ? undefined : { marginBottom: 16 }}>
      <Alert
        type="info"
        showIcon
        title="当前会话未选择研究项目"
        description={
          <>
            <Text>项目内容（断言 / 任务 / 工件）在选择项目前不展示——不会回退到全局指针。选择方式（在运行 serve 的终端会话内）：</Text>
            <div style={{ marginTop: 8 }}>
              <Text code>ygl-trees project use &lt;name&gt;</Text>
              <Text type="secondary" style={{ marginLeft: 12 }}>选择后刷新本页</Text>
            </div>
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">可选项目（{data.unselected.projects.length}）：</Text>
              {data.unselected.projects.map((p) => (
                <Tag key={p.name} style={{ marginTop: 4 }}>{p.name}</Tag>
              ))}
            </div>
          </>
        }
      />
    </Card>
  );
}

/**
 * One agent-proposed command: shown in the executable voice (mono tertiary) and
 * copyable with one click. The page never runs it — commands stay in the CLI
 * (the overview's one write is the task step, Tasks.tsx). The label only says
 * 已复制 when the clipboard really took it; on failure the command text is
 * selected so a manual Ctrl/Cmd+C still works.
 */
function ActionRow({ cmd }: { cmd: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const codeRef = useRef<HTMLElement>(null);
  const copy = async () => {
    const ok = await copyText(cmd);
    setState(ok ? "copied" : "failed");
    if (!ok && codeRef.current) {
      const range = document.createRange();
      range.selectNodeContents(codeRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    window.setTimeout(() => setState("idle"), ok ? 1500 : 4000);
  };
  return (
    <div className="yt-action-row">
      <Text code ref={codeRef}>→ {cmd}</Text>
      <Button
        size="small"
        type="text"
        icon={<CopyOutlined />}
        autoInsertSpace={false}
        aria-label={`复制命令：${cmd}`}
        danger={state === "failed"}
        onClick={copy}
      >
        {state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动复制" : "复制"}
      </Button>
    </div>
  );
}

/**
 * 概览 = 专家 ↔ agent 的协同驾驶舱（user direction 2026-10-20）：what there is
 * (stats, each a link into its view), how the project stands, what the agent
 * proposes next (copyable), what is tracked, and the last 30 days of activity.
 * Fixed CSS grid (user ruling: no drag-reorder library) — app.css .yt-overview.
 */
export function OverviewPage() {
  const { data } = useDashboard();
  if (!data) return null;
  const project = data.brief.project;
  return (
    <div className="yt-overview">
      <section className="yt-ov-stats" aria-label="统计">
        {Object.entries(statIcons).map(([key, icon]) => {
          const view = STAT_VIEW[key];
          const label = key.replace("_", " ");
          return (
            <Link key={key} to={view.to} aria-label={`${label}：${data.brief.counts?.[key] ?? 0}，打开${view.label}`}>
              <Card size="small" hoverable>
                <Statistic
                  title={label}
                  value={data.brief.counts?.[key] ?? 0}
                  prefix={icon}
                  styles={{ content: { color: statColors[key], fontWeight: 700 } }}
                />
              </Card>
            </Link>
          );
        })}
      </section>

      <UnselectedNotice flush />

      {project && (
        <Card className="yt-ov-progress" size="small" title="项目进度" extra={<Text type="secondary">{project.name}</Text>}>
          <Space size="middle" wrap>
            <Statistic title="来源" value={project.sources} />
            <Statistic title="证据" value={project.evidence} />
            <Statistic
              title="已证实断言"
              value={project.verified_claims}
              suffix={`/ ${project.claims}`}
              styles={{ content: { color: C.success } }}
            />
            <Statistic title="工件" value={project.artifacts} />
          </Space>
        </Card>
      )}

      {/* events carry no project: the strip is workspace-wide, so it is labelled so and,
          like every other pane (R16.4 / R19), stays hidden until a project is selected */}
      {!data.unselected && (
        <Card
          className="yt-ov-timeline"
          size="small"
          title={<><LineChartOutlined /> 活动时间线</>}
          extra={<Text type="secondary">今天 + 前 30 天 · 每天事件数 · 全工作区 · UTC 日</Text>}
        >
          <ActivityTimeline timeline={data.timeline ?? []} />
        </Card>
      )}

      {data.brief.next_actions?.length > 0 && (
        <Card
          className="yt-ov-next"
          size="small"
          title={<><ClockCircleOutlined /> 下一步操作</>}
          extra={<Text type="secondary">agent 建议的命令，复制到终端执行</Text>}
        >
          <Space orientation="vertical" size={4} style={{ width: "100%" }}>
            {data.brief.next_actions.map((a, i) => (
              <ActionRow key={i} cmd={a} />
            ))}
          </Space>
        </Card>
      )}

      {data.tasks.length > 0 && (
        <Card className="yt-ov-tasks" size="small" title={<><ExperimentOutlined /> 任务清单</>} extra={<Text type="secondary">{data.tasks.length} 项</Text>}>
          <TaskList tasks={data.tasks} />
        </Card>
      )}
    </div>
  );
}

/* R19 同口径：claims/claim_evidence/evidence are collected server-side per the
   authorized scope; unselected → keys absent → empty state, never a fallback. */
export function PipelinePage() {
  const { data } = useDashboard();
  if (!data) return null;
  if (!data.claims?.length) {
    return (
      <>
        <UnselectedNotice />
        {!data.unselected && <Section icon={<CheckCircleOutlined />} title="研究管线"><Empty description="暂无断言" /></Section>}
      </>
    );
  }
  return (
    <Section icon={<CheckCircleOutlined />} title="研究管线" extra={`${data.claims.length} 断言 · ${data.evidence?.length ?? 0} 证据引文`}>
      <Suspense fallback={CANVAS_FALLBACK}>
        <Pipeline
          claims={data.claims}
          claimEvidence={data.claim_evidence ?? []}
          evidence={data.evidence ?? []}
          sources={data.sources ?? []}
          project={data.brief.project?.name}
        />
      </Suspense>
    </Section>
  );
}

export function VerifyPage() {
  return (
    <Section icon={<SafetyCertificateOutlined />} title="验证器" extra="spec-validator · 构造追溯只读 · 报告看板">
      <Suspense fallback={CANVAS_FALLBACK}>
        <Verify />
      </Suspense>
    </Section>
  );
}

/** The header line: which tree, how far along. Unlocked count is computed here so the lazy canvas chunk stays lazy. */
export function treeExtra(tree: { name: string; nodes: Array<{ unlocked_at?: string | null }> }): string {
  const unlocked = tree.nodes.filter((n) => !!n.unlocked_at).length;
  return `${tree.name} · 已解锁 ${unlocked} / ${tree.nodes.length} 节点`;
}

export function TreePage() {
  const { data } = useDashboard();
  if (!data) return null;
  return (
    <Section icon={<ApartmentOutlined />} title="科技树" extra={data.tree ? treeExtra(data.tree) : "xyflow · 拖拽缩放 · 小地图"}>
      <Suspense fallback={CANVAS_FALLBACK}>
        <TreeFlow tree={data.tree} />
      </Suspense>
    </Section>
  );
}

export function GraphPage() {
  const { data } = useDashboard();
  if (!data) return null;
  const g = data.knowledge_graph;
  if (!g || !g.nodes.length) {
    return (
      <>
        <UnselectedNotice />
        {!data.unselected && <Section icon={<NodeIndexOutlined />} title="知识图谱"><Empty description="暂无实体" /></Section>}
      </>
    );
  }
  return (
    <Section icon={<NodeIndexOutlined />} title="知识图谱" extra={`${g.nodes.length} 实体 · ${g.edges.length} 关系`}>
      <Suspense fallback={CANVAS_FALLBACK}>
        <KnowledgeGraph graph={g} tasks={data.tasks} sources={data.sources} />
      </Suspense>
    </Section>
  );
}

/** "5 份文档 · 9 个版本": a regenerated report is one document, not five (same
 *  kind + title = one document, as the roster groups them). Counted here, not
 *  imported from Artifacts, which is lazy — it carries react-markdown. */
export function artifactsExtra(rows: Array<{ kind: string; title: string }>): string {
  const docs = new Set(rows.map((a) => `${a.kind}\u0000${a.title}`)).size;
  return docs === rows.length ? `${docs} 份文档` : `${docs} 份文档 · ${rows.length} 个版本`;
}

export function ArtifactsPage() {
  const { data } = useDashboard();
  if (!data) return null;
  if (!data.artifacts.length && data.unselected) return <UnselectedNotice />;
  return (
    <Section icon={<FileTextOutlined />} title="产出工件" extra={artifactsExtra(data.artifacts)}>
      <Suspense fallback={<Card loading />}>
        <Artifacts artifacts={data.artifacts} />
      </Suspense>
    </Section>
  );
}
