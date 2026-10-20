/**
 * Route pages (react-router, hash history — api paths stay relative, so the
 * build still serves from any sub-path). Each page is one view of the old
 * single scroll column; heavy views stay lazy-loaded.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import {
  ApartmentOutlined, BookOutlined, CheckCircleOutlined, ClockCircleOutlined, DatabaseOutlined,
  ExperimentOutlined, FileTextOutlined, NodeIndexOutlined, PartitionOutlined, SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useDashboard } from "./data";
import { C, statColors } from "./tokens";
import { ToneTag } from "./ToneTag";

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
function UnselectedNotice() {
  const { data } = useDashboard();
  if (!data?.unselected) return null;
  return (
    <Card title={<><NodeIndexOutlined /> 未选择项目</>} size="small" style={{ marginBottom: 16 }}>
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

export function OverviewPage() {
  const { data } = useDashboard();
  if (!data) return null;
  return (
    <>
      {/* ── 统计卡片 ── */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {Object.entries(statIcons).map(([key, icon]) => (
          <Col key={key} xs={12} sm={8} md={6} lg={3}>
            <Card size="small" hoverable>
              <Statistic
                title={key.replace("_", " ")}
                value={data.brief.counts?.[key] ?? 0}
                prefix={icon}
                styles={{ content: { color: statColors[key], fontWeight: 700 } }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <UnselectedNotice />

      {/* ── 项目进度 ── */}
      {data.brief.project && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Space size="middle" wrap>
            <Statistic title="来源" value={data.brief.project.sources} />
            <Statistic title="证据" value={data.brief.project.evidence} />
            <Statistic
              title="已证实断言"
              value={data.brief.project.verified_claims}
              suffix={`/ ${data.brief.project.claims}`}
              styles={{ content: { color: C.success } }}
            />
          </Space>
        </Card>
      )}

      {/* ── 下一步操作 ── */}
      {data.brief.next_actions?.length > 0 && (
        <Card title={<><ClockCircleOutlined /> 下一步操作</>} size="small" style={{ marginBottom: 16 }}>
          {data.brief.next_actions.map((a, i) => (
            <div key={i}>
              <Text code>→ {a}</Text>
            </div>
          ))}
        </Card>
      )}

      {/* ── 任务清单 ── */}
      {data.tasks.length > 0 && (
        <Card title={<><ExperimentOutlined /> 任务清单</>} size="small" style={{ marginBottom: 16 }}>
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
    </>
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
