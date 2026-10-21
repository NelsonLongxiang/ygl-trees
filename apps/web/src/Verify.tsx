/** 验证器三视图（M13-2）：材料提交 / 构造追溯（只读审计）/ 报告看板。
 *
 * 设计口径（docs/spec-validator.md §9）：
 * - 材料提交是唯一的人工入口：标题 + 一段话 + 附件。附件先以原始字节 PUT 到
 *   `api/verify/blob`（服务端算 sha256、全局去重），提交时只带 sha256 引用——
 *   客户端永远不报哈希，也不传路径。
 * - 构造追溯是**只读审计面**：没有 ✓/✗ 按钮，判定链上没有人工确认。
 * - 报告看板把 FAIL / NEEDS-MATERIAL 的例外项置顶——它们是工作清单，不是统计数字。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  Alert, Button, Card, Descriptions, Empty, Form, Input, Listy, message as antdMessage, Space, Table, Tabs, Tag, Tooltip, Typography, Upload,
} from "antd";

import type {
  VerifyAttachmentRef, VerifyReportDetail, VerifyReportRow, VerifySpecDetail, VerifySpecRow,
} from "./api";
import {
  fetchVerifyMaterial, fetchVerifyReport, fetchVerifyReports, fetchVerifySpec, fetchVerifySpecs,
  submitVerifyMaterial, uploadVerifyBlob,
} from "./api";
import { C } from "./tokens";
import { ToneTag } from "./ToneTag";

const { Text, Paragraph } = Typography;

const verdictColor: Record<string, string> = {
  PASS: C.success,
  FAIL: C.danger,
  "NEEDS-MATERIAL": C.warning,
  ERROR: C.tertiary,
};

function VerdictTag({ verdict }: { verdict: string }) {
  // outlined word + color (DESIGN.md: color is reinforcement, never a filled chip with white text)
  return <ToneTag color={verdictColor[verdict] ?? C.secondary}>{verdict || "—"}</ToneTag>;
}

/**
 * 语义边界（#27 Q3 / 方案 T6）：一份 PASS 只在它声明的层面上成立。契约 ≤1.2 的报告没有
 * `semantic_scope` 字段，按**最保守**的 structural 读（fail-closed）——父验证器对子归档的 PASS
 * 只说明「子归档在场、可验」，不说明子结论为真。渲染面必须首屏透出，不能只在 JSON 里。
 */
export const SCOPE_DEFAULT = "structural";
const SCOPE_LABEL: Record<string, string> = { structural: "仅结构", factual: "事实", semantic: "语义" };
/** 声明值的说明：描述该层断言了什么。 */
const SCOPE_HINT: Record<string, string> = {
  structural: "声明为仅结构：只断言结构在场（文件 / 行 / 归档可验），不断言其内容或子结论为真",
  factual: "声明为事实：断言快照里可重放的事实（sql / sql-pair / count / exists 对数据的判定）",
  semantic: "声明为语义：断言经人工认定或 review 层的语义结论",
};
/** 缺省的说明只讲「怎么读」，不描述检查器实际做了什么——一个按缺省读的 sql 判据确实判了数据，
 *  把它说成「文件 / 归档在场」会误描述（监督席评审 ③）。 */
const SCOPE_HINT_DEFAULT = "报告未声明边界（契约 ≤1.2 没有 semantic_scope 字段），按最保守的 structural 读：PASS 只按「结构在场」理解，不据此断言子结论为真；这不描述检查器实际做了什么";
/** 闭集之内才算声明；缺失与闭集之外（拼错、未来的新值）都按最保守的 structural 读——可见面不得失败开放
 *  （评审 P3：此前未知值原样显示，只有隐藏说明在说「按 structural 读」）。 */
export function scopeKnown(scope?: string | null): scope is string {
  return typeof scope === "string" && Object.prototype.hasOwnProperty.call(SCOPE_LABEL, scope);
}
export function scopeLabel(scope?: string | null): string {
  return scopeKnown(scope) ? SCOPE_LABEL[scope] : SCOPE_LABEL[SCOPE_DEFAULT];
}
export function scopeHint(scope?: string | null): string {
  if (scope == null) return SCOPE_HINT_DEFAULT;
  if (scopeKnown(scope)) return SCOPE_HINT[scope];
  return `未知边界值 ${JSON.stringify(scope)}：不在闭集 structural | factual | semantic 内，按最保守的 structural 读——不据此断言子结论为真`;
}
/** 视觉隐藏但读屏可读（WAI 推荐的 clip 法）：不用 aria-label 给无 role 的 span 命名——ARIA 1.2 禁止给
 *  generic 元素命名，读屏可能跳过它只读可见文字（监督席评审 ② 残留）。 */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
/** 说明必须对键盘 / 触屏 / 读屏可达（监督席评审 ②）：Tooltip 在悬停与聚焦时都出现，span 可聚焦；
 *  整句说明以视觉隐藏文本放在标签内，读屏按 DOM 顺序读到「边界 仅结构·缺省」+ 说明——不靠 ARIA 命名。 */
export function ScopeTag({ scope }: { scope?: string | null }) {
  const suffix = scope == null ? "·缺省" : scopeKnown(scope) ? "" : "·未知值";
  const label = `边界 ${scopeLabel(scope)}${suffix}`;
  const hint = scopeHint(scope);
  return (
    <Tooltip title={hint}>
      <span tabIndex={0} style={{ display: "inline-flex", position: "relative", borderRadius: "var(--radius-sm)", cursor: "help" }}>
        <ToneTag color={C.secondary}>{label}</ToneTag>
        <span style={VISUALLY_HIDDEN}>：{hint}</span>
      </span>
    </Tooltip>
  );
}

/** A selectable row in the verifier's lists: click or Enter/Space picks it, aria-current marks the pick. */
function SelectRow({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        cursor: "pointer",
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        borderBottom: `1px solid ${C["border-dim"]}`,
        // DESIGN.md states: selected = primary stroke; hover tint carries the row
        background: selected ? C["surface-hover"] : undefined,
        boxShadow: selected ? `inset 0 0 0 1px ${C.primary}` : undefined,
      }}
    >
      {children}
    </div>
  );
}

function MaterialForm() {
  // hook API, not the static one: the holder renders under ConfigProvider, so
  // toasts follow the theme switch (antd App wrapper would add ~27 kB of Modal)
  const [message, messageHolder] = antdMessage.useMessage();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refs, setRefs] = useState<VerifyAttachmentRef[]>([]);
  const [saved, setSaved] = useState<{ material_id: string; text_sha256: string; files?: Array<{ path: string; sha256: string; size: number }> } | null>(null);

  const submit = async (v: { title: string; text: string }) => {
    setBusy(true);
    try {
      const r = await submitVerifyMaterial({ ...v, attachments: refs });
      setSaved(r);
      message.success(`草稿已保存：${r.material_id}`);
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {messageHolder}
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
        <Form.Item label="附件" extra="xlsx / png / pdf / zip 等原始文件；服务端按内容算 sha256 并全局去重，同一份文件重复上传不占第二份磁盘。">
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            <Upload
              multiple
              showUploadList
              disabled={uploading}
              customRequest={async ({ file, onSuccess, onError }) => {
                const f = file as File;
                setUploading(true);
                try {
                  const ref = await uploadVerifyBlob(f);
                  setRefs((prev) => [...prev, { sha256: ref.sha256, name: f.name, mime: ref.mime }]);
                  onSuccess?.(ref as any);
                  message.success(`${f.name} 已入仓 ${ref.sha256.slice(0, 12)}… (${ref.size} B)`);
                } catch (e: any) {
                  message.error(String(e?.message || e));
                  onError?.(e);
                } finally {
                  setUploading(false);
                }
              }}
            >
              <Button loading={uploading}>选择文件并上传</Button>
            </Upload>
            {refs.length > 0 && (
              <Space orientation="vertical" size={0}>
                {refs.map((r) => (
                  <Text key={r.sha256} type="secondary">
                    · {r.name} — <Text code>{r.sha256.slice(0, 12)}…</Text>
                  </Text>
                ))}
              </Space>
            )}
          </Space>
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>提交材料</Button>
        </Form.Item>
        {saved && (
          <Alert
            type="success"
            showIcon
            title={`material_id = ${saved.material_id}`}
            description={
              <Space orientation="vertical" size={0}>
                <Text code>text_sha256 = {saved.text_sha256}</Text>
                <Text type="secondary">附件 {saved.files?.length ?? 0} 个（已入内容寻址仓）</Text>
              </Space>
            }
          />
        )}
      </Form>
    </>
  );
}

function TraceView() {
  const [specs, setSpecs] = useState<VerifySpecRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VerifySpecDetail | null>(null);
  const [materialText, setMaterialText] = useState<string>("");
  const [loadErr, setLoadErr] = useState<string>("");

  useEffect(() => {
    fetchVerifySpecs()
      .then((rows) => { setSpecs(rows); setLoadErr(""); })
      .catch((e) => { setSpecs([]); setLoadErr(String(e?.message || e)); });
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
        <Space orientation="vertical" size={0}>
          <Text code>{r.checker?.type ?? "?"}</Text>
          {r.checker?.mode ? <Text type="secondary">compare: {String(r.checker.mode)}</Text> : null}
        </Space>
      ),
    },
    {
      title: "判据原文",
      render: (_: unknown, r: VerifySpecDetail["spec"]["vu"][number]) => (
        <Space orientation="vertical" size={0}>
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
        {loadErr ? (
          <Alert type="error" showIcon title="规范清单加载失败" description={<Text code>{loadErr}</Text>} />
        ) : specs.length === 0 ? (
          <Empty description="还没有规范" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Listy
            items={specs}
            rowKey="spec_id"
            itemRender={(s) => (
              <SelectRow selected={s.spec_id === selected} onSelect={() => setSelected(s.spec_id)}>
                <Space orientation="vertical" size={0}>
                  <Text strong>{s.title || s.spec_id}</Text>
                  <Text type="secondary">
                    v{s.spec_version} · {s.units} 判据 · {s.runs} 次运行
                  </Text>
                  <Text type="secondary">
                    {s.verdict ? `构造：${s.verdict}` : "构造：—"} {s.last_overall ? `· 最近：${s.last_overall}` : ""}
                  </Text>
                </Space>
              </SelectRow>
            )}
          />
        )}
      </Card>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!detail ? (
          <Card size="small"><Empty description="选择左侧规范查看构造追溯" image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card>
        ) : (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              title="只读审计面"
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
                <Space orientation="vertical" size={4} style={{ marginTop: 8 }}>
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
  const [loadErr, setLoadErr] = useState<string>("");

  useEffect(() => {
    fetchVerifyReports()
      .then((r) => { setRows(r); setLoadErr(""); })
      .catch((e) => { setRows([]); setLoadErr(String(e?.message || e)); });
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchVerifyReport(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" title="运行记录">
        {loadErr ? (
          <Alert type="error" showIcon title="运行记录加载失败" description={<Text code>{loadErr}</Text>} />
        ) : rows.length === 0 ? (
          <Empty description="还没有运行记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Listy
            items={rows}
            rowKey="run_id"
            itemRender={(r) => (
              <SelectRow selected={r.run_id === selected} onSelect={() => setSelected(r.run_id)}>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <Space orientation="vertical" size={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text strong>{r.run_id}</Text>
                    <Text type="secondary">{r.spec_id} v{r.spec_version} · {r.mode} · {r.finished}</Text>
                  </Space>
                  <Text type="secondary">
                    {r.summary.pass}✓ {r.summary.fail}✗ {r.summary.needs_material}? {r.summary.error}! · 归档 {r.archived}
                  </Text>
                  <ScopeTag scope={r.semantic_scope} />
                  <VerdictTag verdict={r.overall} />
                </div>
              </SelectRow>
            )}
          />
        )}
      </Card>
      {detail && <ReportDetail detail={detail} />}
    </Space>
  );
}

/**
 * 报告详情（纯展示，可用夹具静态渲染测试——种子库没有报告，运行时验证器画不到这里）。
 * 边界只在首屏出现一次（标签 + ≤1.2 报告的一行缺省说明）；VU 表只在报告真带
 * `semantic_scope`（契约 1.3 起）时才加「边界」列——缺省不逐行重复（监督席评审 ①③）。
 */
export function ReportDetail({ detail }: { detail: VerifyReportDetail }) {
  const exceptions = detail.report.exceptions ?? [];
  const exceptionIds = new Set(exceptions.map((e) => e.vu));
  const declaredPerVu = detail.report.vu.some((v) => v.semantic_scope != null);
  const columns = [
    { title: "判据", dataIndex: "id", width: 70 },
    { title: "结论", dataIndex: "verdict", width: 130, render: (v: string) => <VerdictTag verdict={v} /> },
    ...(declaredPerVu ? [{ title: "边界", dataIndex: "semantic_scope", width: 120, render: (v: string | undefined) => <ScopeTag scope={v} /> }] : []),
    { title: "检查器", dataIndex: "checker_type", width: 110 },
    {
      title: "证据 / trace",
      render: (_: unknown, r: VerifyReportDetail["report"]["vu"][number]) => (
        <Space orientation="vertical" size={0}>
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
  ];
  return (
    <Card size="small" title="报告">
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        <Space wrap>
          <VerdictTag verdict={detail.report.overall} />
          <ScopeTag scope={detail.report.semantic_scope} />
          <Text>{detail.report.reason}</Text>
        </Space>
        {detail.report.semantic_scope == null ? (
          <Text type="secondary">
            边界缺省为「仅结构」：这份报告没有 semantic_scope 字段（契约 ≤1.2），PASS 只按「结构在场」理解——父验证器的 PASS 不代表子结论为真。
          </Text>
        ) : !scopeKnown(detail.report.semantic_scope) ? (
          <Text type="secondary">
            边界值 {JSON.stringify(detail.report.semantic_scope)} 不在闭集内，按最保守的「仅结构」读——父验证器的 PASS 不代表子结论为真。
          </Text>
        ) : null}
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
            title={`处置清单：${exceptions.length} 项`}
            description={exceptions.map((e) => `${e.vu}（${e.severity ?? "?"}，${e.row_count ?? 0} 行）`).join(" · ")}
          />
        )}
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={[...detail.report.vu].sort((a, b) => Number(exceptionIds.has(b.id)) - Number(exceptionIds.has(a.id)))}
          columns={columns as any}
        />
      </Space>
    </Card>
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
