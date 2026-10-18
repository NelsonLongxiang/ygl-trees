import { useEffect, useState, lazy, Suspense } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  Layout, Card, Row, Col, Statistic, Table, Tag, Typography, Space, Alert,
} from "antd";
import {
  ExperimentOutlined, BookOutlined, DatabaseOutlined, FileTextOutlined,
  ApartmentOutlined, PartitionOutlined, CheckCircleOutlined, ClockCircleOutlined,
  NodeIndexOutlined,
} from "@ant-design/icons";
import { subscribeDashboard, type DashboardData } from "./api";

// Lazy-load below-the-fold components — reduces initial bundle by ~40%
const TreeFlow = lazy(() => import("./TreeFlow"));
const Artifacts = lazy(() => import("./Artifacts"));
const KnowledgeGraph = lazy(() => import("./KnowledgeGraph"));

const { Header, Content } = Layout;
const { Title, Text } = Typography;

/** DESIGN.md token mapping → antd ConfigProvider */
function AppTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: "#7c9885",       // --color-primary (sage green)
          colorSuccess: "#6a994e",       // --color-success
          colorWarning: "#daa520",       // --color-warning
          colorInfo: "#5b8db8",          // --color-accent
          borderRadius: 8,              // --radius-md
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

const statIcons: Record<string, React.ReactNode> = {
  skills: <BookOutlined />,
  kb_notes: <BookOutlined />,
  sources: <DatabaseOutlined />,
  evidence: <FileTextOutlined />,
  claims: <CheckCircleOutlined />,
  trees: <ApartmentOutlined />,
  nodes: <PartitionOutlined />,
};

const statColors: Record<string, string> = {
  skills: "#7c9885",
  kb_notes: "#8b7355",
  sources: "#5b8db8",
  evidence: "#daa520",
  claims: "#6a994e",
  trees: "#9b7cb8",
  nodes: "#b87c7c",
};

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    return subscribeDashboard(setData, (e) => setErr((prev) => prev ?? e));
  }, []);

  return (
    <AppTheme>
      <Layout style={{ minHeight: "100vh" }}>
        <Header style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 24px" }}>
          <Text style={{ fontSize: 20, color: "#e8e4dc" }}>🐵 ygl-trees</Text>
          <Text type="secondary" style={{ fontSize: 14 }}>
            AI Agent 研究工作台
          </Text>
          {data?.brief?.project && (
            <Tag color="green" style={{ marginLeft: "auto" }}>
              {data.brief.project.name}
              {data.brief.selection_source && (
                <span style={{ opacity: 0.65, marginLeft: 6 }}>· {data.brief.selection_source}</span>
              )}
            </Tag>
          )}
          {!data?.brief?.project && data?.unselected && (
            <Tag color="orange" style={{ marginLeft: "auto" }}>未选择项目</Tag>
          )}
        </Header>

        <Content style={{ padding: 24, maxWidth: 1360, margin: "0 auto", width: "100%" }}>
          {err && (
            <Alert
              type="error"
              message="API 不可达"
              description={<Text code>ygl-trees webui serve --port 8642</Text>}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {!data && !err && (
            <Card loading style={{ marginBottom: 16 }} />
          )}
          {data && (
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
                        valueStyle={{ color: statColors[key], fontWeight: 700 }}
                      />
                    </Card>
                  </Col>
                ))}
              </Row>

              {/* ── R16.4 未选择态（0.90.1 P1-3）：无授权项目选择时的明确指引 ── */}
              {data.unselected && (
                <Card
                  title={<><NodeIndexOutlined /> 未选择项目</>}
                  size="small"
                  style={{ marginBottom: 16 }}
                >
                  <Alert
                    type="info"
                    showIcon
                    message="当前会话未选择研究项目"
                    description={
                      <>
                        <Text>项目内容（断言 / 任务 / 工件）在选择项目前不展示——不会回退到全局指针。选择方式（在运行 serve 的终端会话内）：</Text>
                        <div style={{ marginTop: 8 }}>
                          <Text code>ygl-trees project use &lt;name&gt;</Text>
                          <Text type="secondary" style={{ marginLeft: 12 }}>选择后刷新本页</Text>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <Text type="secondary">可选项目（{data.unselected.projects.length}）：</Text>
                          {data.unselected.projects.map((p: { name: string }, i: number) => (
                            <Tag key={p.name} style={{ marginTop: 4 }}>{p.name}</Tag>
                          ))}
                        </div>
                      </>
                    }
                  />
                </Card>
              )}

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
                      valueStyle={{ color: "#6a994e" }}
                    />
                  </Space>
                </Card>
              )}

              {/* ── 下一步操作 ── */}
              {data.brief.next_actions?.length > 0 && (
                <Card
                  title={<><ClockCircleOutlined /> 下一步操作</>}
                  size="small"
                  style={{ marginBottom: 16 }}
                >
                  {data.brief.next_actions.map((a: string, i: number) => (
                    <div key={i}>
                      <Text code>→ {a}</Text>
                    </div>
                  ))}
                </Card>
              )}

              {/* ── 科技树 ── */}
              <Card
                title={<><ApartmentOutlined /> 科技树</>}
                extra={<Text type="secondary">xyflow · 拖拽缩放 · 小地图</Text>}
                style={{ marginBottom: 16 }}
              >
                <Suspense fallback={<Card loading style={{ height: 300 }} />}>
                  <TreeFlow tree={data.tree} />
                </Suspense>
              </Card>

              {/* ── 知识图谱 ── */}
              {data.knowledge_graph && data.knowledge_graph.nodes.length > 0 && (
                <Card
                  title={<><NodeIndexOutlined /> 知识图谱</>}
                  extra={<Text type="secondary">{data.knowledge_graph.nodes.length} 实体 · {data.knowledge_graph.edges.length} 关系</Text>}
                  style={{ marginBottom: 16 }}
                >
                  <Suspense fallback={<Card loading style={{ height: 300 }} />}>
                    <KnowledgeGraph graph={data.knowledge_graph} />
                  </Suspense>
                </Card>
              )}

              {/* ── 任务清单 ── */}
              {data.tasks.length > 0 && (
                <Card
                  title={<><ExperimentOutlined /> 任务清单</>}
                  size="small"
                  style={{ marginBottom: 16 }}
                >
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
                        filters: [
                          { text: "待办", value: "todo" },
                          { text: "进行中", value: "doing" },
                          { text: "已完成", value: "done" },
                        ],
                        onFilter: (value, record) => record.status === value,
                        render: (s: string) => {
                          const cfg: Record<string, { color: string; label: string }> = {
                            todo: { color: "default", label: "待办" },
                            doing: { color: "processing", label: "进行中" },
                            done: { color: "success", label: "已完成" },
                          };
                          const c = cfg[s] || cfg.todo;
                          return <Tag color={c.color}>{c.label}</Tag>;
                        },
                      },
                      {
                        title: "任务",
                        dataIndex: "title",
                        render: (t: string, record: any) => (
                          <Text delete={record.status === "done"} type={record.status === "done" ? "secondary" : undefined}>
                            {t}
                          </Text>
                        ),
                      },
                    ]}
                  />
                </Card>
              )}

              {/* ── 产出工件 ── */}
              {data.artifacts.length > 0 && (
                <Card
                  title={<><FileTextOutlined /> 产出工件</>}
                  extra={<Text type="secondary">react-markdown 全文渲染</Text>}
                >
                  <Suspense fallback={<Card loading />}>
                    <Artifacts artifacts={data.artifacts} />
                  </Suspense>
                </Card>
              )}
            </>
          )}
        </Content>
      </Layout>
    </AppTheme>
  );
}
