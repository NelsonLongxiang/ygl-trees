/**
 * Route pages (react-router, hash history — api paths stay relative, so the
 * build still serves from any sub-path). Each page is one view of the old
 * single scroll column; heavy views stay lazy-loaded.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Alert, Button, Card, Empty, Space, Statistic, Table, Tag, Typography } from "antd";
import {
  ApartmentOutlined, BookOutlined, CheckCircleOutlined, ClockCircleOutlined, CopyOutlined, DatabaseOutlined,
  ExperimentOutlined, FileTextOutlined, LineChartOutlined, NodeIndexOutlined, PartitionOutlined, SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useDashboard } from "./data";
import { C, statColors } from "./tokens";
import { ToneTag } from "./ToneTag";
import ActivityTimeline from "./ActivityTimeline";

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

const TASK_STATUS: Record<string, { color: string; label: string }> = {
  todo: { color: C.secondary, label: "待办" },
  doing: { color: C.primary, label: "进行中" },
  done: { color: C.success, label: "已完成" },
};

/**
 * One agent-proposed command: shown in the executable voice (mono tertiary) and
 * copyable with one click. The page never runs it — writes stay in the CLI.
 */
function ActionRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      // insecure context / older browser: select-and-copy fallback
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        ta.remove();
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="yt-action-row">
      <Text code>→ {cmd}</Text>
      <Button size="small" type="text" icon={<CopyOutlined />} autoInsertSpace={false} aria-label={`复制命令：${cmd}`} onClick={copy}>
        {copied ? "已复制" : "复制"}
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

      <Card
        className="yt-ov-timeline"
        size="small"
        title={<><LineChartOutlined /> 最近 30 天活动</>}
        extra={<Text type="secondary">每天事件数</Text>}
      >
        <ActivityTimeline timeline={data.timeline ?? []} />
      </Card>

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
          <Table
            dataSource={data.tasks}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[
              {
                title: "状态",
                dataIndex: "status",
                width: 100,
                filters: Object.entries(TASK_STATUS).map(([value, c]) => ({ text: c.label, value })),
                onFilter: (value, record) => record.status === value,
                render: (s: string) => {
                  const c = TASK_STATUS[s] || TASK_STATUS.todo;
                  return <ToneTag color={c.color}>{c.label}</ToneTag>;
                },
              },
              {
                title: "任务",
                dataIndex: "title",
                render: (t: string, record) => (
                  <Text delete={record.status === "done"} type={record.status === "done" ? "secondary" : undefined}>
                    {t}
                  </Text>
                ),
              },
            ]}
          />
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
        <Pipeline claims={data.claims} claimEvidence={data.claim_evidence ?? []} evidence={data.evidence ?? []} />
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

export function TreePage() {
  const { data } = useDashboard();
  if (!data) return null;
  return (
    <Section icon={<ApartmentOutlined />} title="科技树" extra={data.tree ? `${data.tree.name} · ${data.tree.nodes.length} 节点` : "xyflow · 拖拽缩放 · 小地图"}>
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
        <KnowledgeGraph graph={g} />
      </Suspense>
    </Section>
  );
}

export function ArtifactsPage() {
  const { data } = useDashboard();
  if (!data) return null;
  if (!data.artifacts.length && data.unselected) return <UnselectedNotice />;
  return (
    <Section icon={<FileTextOutlined />} title="产出工件" extra={`${data.artifacts.length} 工件 · react-markdown 全文渲染`}>
      <Suspense fallback={<Card loading />}>
        <Artifacts artifacts={data.artifacts} />
      </Suspense>
    </Section>
  );
}
