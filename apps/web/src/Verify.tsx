/** 验证器三视图（M13-2）：材料提交 / 构造追溯（只读审计）/ 报告看板。
 *
 * 设计口径（docs/spec-validator.md §9）：
 * - 材料提交是唯一的人工入口：标题 + 一段话。附件走 CLI `verify submit --attach`
 *   （WebUI 的 multipart 通道排在第二批），这里明说而不是假装支持。
 * - 构造追溯是**只读审计面**：没有 ✓/✗ 按钮，判定链上没有人工确认。
 * - 报告看板把 FAIL / NEEDS-MATERIAL 的例外项置顶——它们是工作清单，不是统计数字。
 */
import { useEffect, useState } from "react";
import {
  Alert, Button, Card, Descriptions, Empty, Form, Input, List, message, Space, Table, Tabs, Tag, Typography,
} from "antd";

import type {
  VerifyReportDetail, VerifyReportRow, VerifySpecDetail, VerifySpecRow,
} from "./api";
import {
  fetchVerifyMaterial, fetchVerifyReport, fetchVerifyReports, fetchVerifySpec, fetchVerifySpecs,
  submitVerifyMaterial,
} from "./api";
import { C } from "./tokens";

const { Text, Paragraph } = Typography;

const verdictColor: Record<string, string> = {
  PASS: C.success,
  FAIL: C.danger,
  "NEEDS-MATERIAL": C.warning,
  ERROR: C.tertiary,
};

function VerdictTag({ verdict }: { verdict: string }) {
  return <Tag color={verdictColor[verdict] ?? C.secondary}>{verdict || "—"}</Tag>;
}

function MaterialForm() {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ material_id: string; text_sha256: string } | null>(null);

  const submit = async (v: { title: string; text: string }) => {
    setBusy(true);
    try {
      const r = await submitVerifyMaterial(v);
      setSaved(r);
      message.success(`草稿已保存：${r.material_id}`);
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}>
      <Form.Item name="title" label="标题" rules={[{ required: true, message: "给这份材料一个标题" }]}>
        <Input placeholder="例：7 月运费对账材料" />
      </Form.Item>
      <Form.Item
        name="text"
        label="一段话"
        rules={[{ required: true, message: "材料是一段话，不是表单——写清楚业务事实即可" }]}
        extra="模糊输入是常态：数字、口径、批号、判断依据都写进来；结构化是 agent 构造的产物，不是你的义务。"
      >
        <Input.TextArea rows={8} placeholder="例：本期账单覆盖 7 月 1 日至 7 月 31 日，共 3 单，合计 4,412.50 元；报价基准见财务 6 月 30 日邮件。" />
      </Form.Item>
      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>提交材料</Button>
          <Text type="secondary">附件（xlsx/png/pdf/zip）暂走 CLI：ygl-trees verify submit --attach &lt;file&gt;</Text>
        </Space>
      </Form.Item>
      {saved && (
        <Alert
          type="success"
          showIcon
          message={`material_id = ${saved.material_id}`}
          description={<Text code>text_sha256 = {saved.text_sha256}</Text>}
        />
      )}
    </Form>
  );
}

function TraceView() {
  const [specs, setSpecs] = useState<VerifySpecRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VerifySpecDetail | null>(null);
  const [materialText, setMaterialText] = useState<string>("");

  useEffect(() => {
    fetchVerifySpecs().then(setSpecs).catch(() => setSpecs([]));
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchVerifySpec(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  useEffect(() => {
    const mid = detail?.prepare?.material_id;
    if (!mid) { setMaterialText(""); return; }
    fetchVerifyMaterial(mid).then((m) => setMaterialText(m?.text ?? "")).catch(() => setMaterialText(""));
  }, [detail]);

  const unitColumns = [
    { title: "判据", dataIndex: "id", width: 70 },
    { title: "角色", dataIndex: "role", width: 80, render: (v: string) => <Tag>{v || "assert"}</Tag> },
    { title: "等级", dataIndex: "severity", width: 70 },
    {
      title: "翻译出的检查器",
      render: (_: unknown, r: VerifySpecDetail["spec"]["vu"][number]) => (
        <Space direction="vertical" size={0}>
          <Text code>{r.checker?.type ?? "?"}</Text>
          {r.checker?.mode ? <Text type="secondary">compare: {String(r.checker.mode)}</Text> : null}
        </Space>
      ),
    },
    {
      title: "判据原文",
      render: (_: unknown, r: VerifySpecDetail["spec"]["vu"][number]) => (
        <Space direction="vertical" size={0}>
          <Paragraph style={{ margin: 0 }} ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>
            {r.source_clause ?? ""}
          </Paragraph>
          {r.expected_from?.anchor ? <Text type="secondary">锚点：{r.expected_from.anchor}</Text> : null}
        </Space>
      ),
    },
  ];

  return (
    <Space align="start" size={16} style={{ width: "100%", alignItems: "flex-start" }}>
      <Card size="small" title="规范" style={{ width: 280, flex: "0 0 280px" }}>
        {specs.length === 0 ? (
          <Empty description="还没有规范" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            size="small"
            dataSource={specs}
            renderItem={(s) => (
              <List.Item
                style={{ cursor: "pointer", background: s.spec_id === selected ? C["border-dim"] : undefined }}
                onClick={() => setSelected(s.spec_id)}
              >
                <Space direction="vertical" size={0}>
                  <Text strong>{s.title || s.spec_id}</Text>
                  <Text type="secondary">
                    v{s.spec_version} · {s.units} 判据 · {s.runs} 次运行
                  </Text>
                  <Text type="secondary">
                    {s.verdict ? `构造：${s.verdict}` : "构造：—"} {s.last_overall ? `· 最近：${s.last_overall}` : ""}
                  </Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!detail ? (
          <Card size="small"><Empty description="选择左侧规范查看构造追溯" image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message="只读审计面"
              description="这里展示 prepare 的产物（判据↔检查器↔自审结论），用于事后复核；判定链上没有人工确认按钮。"
            />
            <Card size="small" title="材料原文（专家提交的一段话）">
              <Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>{materialText || "（材料正文缺失）"}</Paragraph>
            </Card>
            <Card size="small" title="构造结论">
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="verdict"><VerdictTag verdict={detail.prepare?.verdict ?? ""} /></Descriptions.Item>
                <Descriptions.Item label="轮次">{detail.prepare?.rounds ?? 0}</Descriptions.Item>
                <Descriptions.Item label="候选">{detail.prepare?.units ?? detail.spec.vu.length}</Descriptions.Item>
                <Descriptions.Item label="被拒">{detail.prepare?.rejected?.length ?? 0}</Descriptions.Item>
              </Descriptions>
              {(detail.prepare?.rejected?.length ?? 0) > 0 && (
                <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
                  {detail.prepare!.rejected!.map((r, i) => (
                    <Text key={i} type="secondary">· [{r.stage}] {r.reason}</Text>
                  ))}
                </Space>
              )}
            </Card>
            <Card size="small" title={`判据 ↔ 检查器（${detail.spec.vu.length}）`}>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={detail.spec.vu}
                columns={unitColumns as any}
              />
            </Card>
          </Space>
        )}
      </div>
    </Space>
  );
}

function ReportBoard() {
  const [rows, setRows] = useState<VerifyReportRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VerifyReportDetail | null>(null);

  useEffect(() => {
    fetchVerifyReports().then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchVerifyReport(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  const exceptions = detail?.report.exceptions ?? [];
  const exceptionIds = new Set(exceptions.map((e) => e.vu));

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" title="运行记录">
        {rows.length === 0 ? (
          <Empty description="还没有运行记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            size="small"
            dataSource={rows}
            renderItem={(r) => (
              <List.Item
                style={{ cursor: "pointer", background: r.run_id === selected ? C["border-dim"] : undefined }}
                onClick={() => setSelected(r.run_id)}
                actions={[
                  <Text key="s" type="secondary">
                    {r.summary.pass}✓ {r.summary.fail}✗ {r.summary.needs_material}? {r.summary.error}! · 归档 {r.archived}
                  </Text>,
                  <VerdictTag key="v" verdict={r.overall} />,
                ]}
              >
                <List.Item.Meta
                  title={<Text strong>{r.run_id}</Text>}
                  description={<Text type="secondary">{r.spec_id} v{r.spec_version} · {r.mode} · {r.finished}</Text>}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
      {detail && (
        <Card size="small" title="报告">
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Space wrap>
              <VerdictTag verdict={detail.report.overall} />
              <Text>{detail.report.reason}</Text>
            </Space>
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="统计">
                {detail.report.summary.pass}✓ / {detail.report.summary.fail}✗ /{" "}
                {detail.report.summary.needs_material}? / {detail.report.summary.error}!
              </Descriptions.Item>
              <Descriptions.Item label="引擎">{detail.report.verifier?.mode ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="签名">
                {detail.report.verifier?.signing_scheme
                  ? `${detail.report.verifier.signing_scheme} · ${(detail.report.verifier.public_key_fingerprint ?? "").slice(0, 12)}…`
                  : "unsig"}
              </Descriptions.Item>
              <Descriptions.Item label="快照" span={2}>
                <Text code style={{ fontSize: 12 }}>{detail.report.data_source?.sha256 ?? "—"}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="归档">{detail.archives.length}</Descriptions.Item>
            </Descriptions>
            {exceptions.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`处置清单：${exceptions.length} 项`}
                description={exceptions.map((e) => `${e.vu}（${e.severity ?? "?"}，${e.row_count ?? 0} 行）`).join(" · ")}
              />
            )}
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={[...detail.report.vu].sort((a, b) => Number(exceptionIds.has(b.id)) - Number(exceptionIds.has(a.id)))}
              columns={[
                { title: "判据", dataIndex: "id", width: 70 },
                { title: "结论", dataIndex: "verdict", width: 130, render: (v: string) => <VerdictTag verdict={v} /> },
                { title: "检查器", dataIndex: "checker_type", width: 110 },
                {
                  title: "证据 / trace",
                  render: (_: unknown, r: VerifyReportDetail["report"]["vu"][number]) => (
                    <Space direction="vertical" size={0}>
                      {r.evidence ? (
                        <Text code style={{ fontSize: 12 }}>
                          {JSON.stringify(r.evidence).slice(0, 160)}
                        </Text>
                      ) : null}
                      {(r.trace ?? []).map((t, i) => (
                        <Text key={i} type="secondary">· {t}</Text>
                      ))}
                    </Space>
                  ),
                },
              ] as any}
            />
          </Space>
        </Card>
      )}
    </Space>
  );
}

export default function Verify() {
  return (
    <Tabs
      size="small"
      items={[
        { key: "material", label: "材料提交", children: <MaterialForm /> },
        { key: "trace", label: "构造追溯", children: <TraceView /> },
        { key: "report", label: "报告看板", children: <ReportBoard /> },
      ]}
    />
  );
}
