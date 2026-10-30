/** 验证器三视图（M13-2）：材料提交 / 构造追溯（只读审计）/ 报告看板。
 *
 * 设计口径（docs/spec-validator.md §9）：
 * - 材料提交是唯一的人工入口：标题 + 一段话 + 附件。附件先以原始字节 PUT 到
 *   `api/verify/blob`（服务端算 sha256、全局去重），提交时只带 sha256 引用——
 *   客户端永远不报哈希，也不传路径。
 * - 构造追溯是**只读审计面**：没有 ✓/✗ 按钮，判定链上没有人工确认。
 * - 报告看板把 FAIL / NEEDS-MATERIAL 的例外项置顶——它们是工作清单，不是统计数字。
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Alert, Button, Card, Descriptions, Empty, Input, Listy, message as antdMessage, Space, Table, Tag, Tooltip, Typography,
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

/** Plain controlled fields, not antd Form + Upload: one two-field draft and a file
 *  picker did not need Form's store, async-validator or Upload's list/progress
 *  machinery (~90 kB of the web_dist ratchet). Same rules, same messages. */
export function validateMaterial(v: { title: string; text: string }): { title?: string; text?: string } {
  const e: { title?: string; text?: string } = {};
  if (!v.title.trim()) e.title = "给这份材料一个标题";
  if (!v.text.trim()) e.text = "材料是一段话，不是表单——写清楚业务事实即可";
  return e;
}

function Field({ label, htmlFor, error, extra, children }: { label: string; htmlFor?: string; error?: string; extra?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={htmlFor} style={{ display: "block", marginBottom: 6 }}>{label}</label>
      {children}
      {error && <div role="alert" style={{ color: C.danger, fontSize: 12, marginTop: 4 }}>{error}</div>}
      {extra && <Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 4 }}>{extra}</Text>}
    </div>
  );
}

function MaterialForm() {
  // hook API, not the static one: the holder renders under ConfigProvider, so
  // toasts follow the theme switch (antd App wrapper would add ~27 kB of Modal)
  const [message, messageHolder] = antdMessage.useMessage();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<{ title?: string; text?: string }>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refs, setRefs] = useState<VerifyAttachmentRef[]>([]);
  const [saved, setSaved] = useState<{ material_id: string; text_sha256: string; files?: Array<{ path: string; sha256: string; size: number }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateMaterial({ title, text });
    setErrors(e);
    if (e.title || e.text) return;
    setBusy(true);
    try {
      const r = await submitVerifyMaterial({ title, text, attachments: refs });
      setSaved(r);
      message.success(`草稿已保存：${r.material_id}`);
    } catch (err: any) {
      message.error(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // one file at a time, in the order picked: each gets its own receipt or error
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        try {
          const ref = await uploadVerifyBlob(f);
          setRefs((prev) => [...prev, { sha256: ref.sha256, name: f.name, mime: ref.mime }]);
          message.success(`${f.name} 已入仓 ${ref.sha256.slice(0, 12)}… (${ref.size} B)`);
        } catch (err: any) {
          message.error(`${f.name}：${String(err?.message || err)}`);
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = ""; // the same file can be picked again
    }
  };

  return (
    <>
      {messageHolder}
      <form onSubmit={submit} noValidate style={{ maxWidth: 720 }}>
        <Field label="标题" htmlFor="vm-title" error={errors.title}>
          <Input id="vm-title" value={title} onChange={(e) => setTitle(e.target.value)} status={errors.title ? "error" : undefined} aria-invalid={!!errors.title} aria-required placeholder="例：7 月运费对账材料" />
        </Field>
        <Field
          label="一段话"
          htmlFor="vm-text"
          error={errors.text}
          extra="模糊输入是常态：数字、口径、批号、判断依据都写进来；结构化是 agent 构造的产物，不是你的义务。"
        >
          <Input.TextArea id="vm-text" rows={8} value={text} onChange={(e) => setText(e.target.value)} status={errors.text ? "error" : undefined} aria-invalid={!!errors.text} aria-required placeholder="例：本期账单覆盖 7 月 1 日至 7 月 31 日，共 3 单，合计 4,412.50 元；报价基准见财务 6 月 30 日邮件。" />
        </Field>
        <Field label="附件" extra="xlsx / png / pdf / zip 等原始文件；服务端按内容算 sha256 并全局去重，同一份文件重复上传不占第二份磁盘。">
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            <Button loading={uploading} onClick={() => fileRef.current?.click()}>选择文件并上传</Button>
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
        </Field>
        <Button type="primary" htmlType="submit" loading={busy}>提交材料</Button>
        {saved && (
          <Alert
            style={{ marginTop: 16 }}
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
      </form>
    </>
  );
}

function TraceView() {
  const specs = useLoad(fetchVerifySpecs);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VerifySpecDetail | null>(null);
  const [materialText, setMaterialText] = useState<string>("");

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
    <Split
      side={
        <Card size="small" title="规范">
          <ListState load={specs} empty="还没有规范">
            {(all) => (
              <Listy
                items={all}
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
          </ListState>
        </Card>
      }
    >
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
    </Split>
  );
}

/**
 * A spec is re-prepared as a new spec_id with a higher spec_version in the same
 * domain; only the highest one still runs. Current specs come first ordered as a
 * work queue — last run not passing, then never run, then passing — and the
 * superseded ones apart, so a retired v3 that last FAILed is not on top.
 */
export function specLineup(rows: VerifySpecRow[]): { current: VerifySpecRow[]; superseded: VerifySpecRow[] } {
  const line = (s: VerifySpecRow) => s.domain || s.spec_id;
  const top = new Map<string, number>();
  for (const s of rows) top.set(line(s), Math.max(top.get(line(s)) ?? -Infinity, s.spec_version));
  const rank = (s: VerifySpecRow) => (!s.runs ? 1 : s.last_overall === "PASS" ? 2 : 0);
  const byTitle = (a: VerifySpecRow, b: VerifySpecRow) => (a.title || a.spec_id).localeCompare(b.title || b.spec_id);
  const isCurrent = (s: VerifySpecRow) => s.spec_version === top.get(line(s));
  return {
    current: rows.filter(isCurrent).sort((a, b) => rank(a) - rank(b) || byTitle(a, b)),
    superseded: rows.filter((s) => !isCurrent(s)).sort((a, b) => byTitle(a, b) || b.spec_version - a.spec_version),
  };
}

/** How a spec's runs came out, most common first: "5170 PASS · 3 FAIL". */
export function runTally(rows: VerifyReportRow[]): string {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.overall || "—", (n.get(r.overall || "—") ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(" · ");
}

/** Runs render a page at a time: one spec on a real verifier has thousands. */
export const RUN_PAGE = 30;

/**
 * Report board on real data (a verifier home holds tens of thousands of runs):
 * pick a spec, see its latest report at once, and page back through its runs.
 * The old board fetched and listed every run of every spec — 74k rows crashed
 * the tab.
 */
function ReportBoard() {
  const specs = useLoad(fetchVerifySpecs);
  const [spec, setSpec] = useState<VerifySpecRow | null>(null);
  const [runs, setRuns] = useState<{ spec: string; onlyBad: boolean; rows: VerifyReportRow[]; total: number; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [runsError, setRunsError] = useState("");
  const [reloadRuns, setReloadRuns] = useState(0);
  const requestVersion = useRef(0);
  const [onlyBad, setOnlyBad] = useState(false);
  const [run, setRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: string; d: VerifyReportDetail | null } | null>(null);
  // a run picked far down the list shows its report above it: bring it into view
  const top = useRef<HTMLDivElement | null>(null);
  const reveal = useRef(false);
  const open = (id: string) => {
    reveal.current = true;
    setRun(id);
  };
  useEffect(() => {
    if (!reveal.current || detail?.run !== run) return;
    reveal.current = false;
    top.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [detail, run]);

  const pick = (s: VerifySpecRow) => {
    setSpec(s);
    setRun(s.last_run || null);
    requestVersion.current++;
    setRuns(null);
    setRunsError("");
    setOnlyBad(false);
  };

  useEffect(() => {
    if (!spec) return;
    let live = true;
    setRunsError("");
    fetchVerifyReports(spec.spec_id, undefined, onlyBad)
      .then((page) => live && setRuns({ spec: spec.spec_id, onlyBad, rows: page.items, total: page.total, next: page.next_cursor }))
      .catch((e) => live && setRunsError(String(e?.message || e)));
    return () => { live = false; };
  }, [spec, onlyBad, reloadRuns]);

  useEffect(() => {
    if (!run) return;
    let live = true;
    fetchVerifyReport(run)
      .then((d) => live && setDetail({ run, d }))
      .catch(() => live && setDetail({ run, d: null }));
    return () => { live = false; };
  }, [run]);

  const activeRuns = runs?.spec === spec?.spec_id && runs?.onlyBad === onlyBad ? runs : null;
  const rows = activeRuns?.rows ?? null;
  const loadMore = async () => {
    if (!spec || !activeRuns?.next || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true); setRunsError("");
    try {
      const page = await fetchVerifyReports(spec.spec_id, activeRuns.next, onlyBad);
      if (version === requestVersion.current) setRuns({ ...activeRuns, rows: [...activeRuns.rows, ...page.items], total: page.total, next: page.next_cursor });
    } catch (e: any) { if (version === requestVersion.current) setRunsError(String(e?.message || e)); }
    finally { setLoadingMore(false); }
  };

  return (
    <Split
      side={
        <Card size="small" title="规范">
          <ListState load={specs} empty="还没有规范">
            {(all) => {
              const { current, superseded } = specLineup(all);
              const item = (s: VerifySpecRow) => (
                <SelectRow selected={s.spec_id === spec?.spec_id} onSelect={() => pick(s)}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <Space orientation="vertical" size={0} style={{ flex: 1, minWidth: 0 }}>
                      <Text strong>{s.title || s.spec_id}</Text>
                      <Text type="secondary">v{s.spec_version} · {s.runs ? `${s.runs} 次运行` : "还没运行过"}</Text>
                    </Space>
                    {s.runs ? <VerdictTag verdict={s.last_overall} /> : null}
                  </div>
                </SelectRow>
              );
              return (
                <>
                  <Listy items={current} rowKey="spec_id" itemRender={item} />
                  {superseded.length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer", color: C.secondary, padding: "4px 0" }}>
                        已被新版本取代（{superseded.length}）
                      </summary>
                      <Listy items={superseded} rowKey="spec_id" itemRender={item} />
                    </details>
                  )}
                </>
              );
            }}
          </ListState>
        </Card>
      }
    >
      {!spec ? (
        <Card size="small"><Empty description="选择左侧规范：先看它最近一次报告，再往回翻运行记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card>
      ) : (
        <Space orientation="vertical" size={12} style={{ width: "100%", scrollMarginTop: 72 }} ref={top}>
          {!run ? null : detail?.run !== run ? (
            <Card size="small"><Text type="secondary">报告加载中…</Text></Card>
          ) : detail.d ? (
            <ReportDetail detail={detail.d} latest={run === spec.last_run} />
          ) : (
            <Alert type="error" showIcon title={`报告读不到：${run}`} />
          )}
          <Card
            size="small"
            title={`运行记录${activeRuns ? `（已载 ${activeRuns.rows.length} / ${activeRuns.total}）` : ""}`}
            extra={rows && rows.length > 0 ? <Text type="secondary">已载：{runTally(rows)}</Text> : null}
          >
            {runsError && <Alert type="error" showIcon title="运行记录加载失败" description={runsError} action={<Button size="small" onClick={() => { requestVersion.current++; setRuns(null); setRunsError(""); setReloadRuns(v => v + 1); }}>重新加载</Button>} />}
            {!rows ? (
              runsError ? null : <Text type="secondary">运行记录加载中…</Text>
            ) : (
              <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                <Button size="small" aria-pressed={onlyBad} type={onlyBad ? "primary" : "default"} ghost={onlyBad} onClick={() => { requestVersion.current++; setRuns(null); setRunsError(""); setOnlyBad(!onlyBad); }}>
                  只看未通过
                </Button>
                {rows.length === 0 ? (
                  <Text type="secondary">{onlyBad ? "没有未通过的运行" : "没有运行记录"}</Text>
                ) : (
                  <Listy
                    items={rows}
                    rowKey="run_id"
                    itemRender={(r) => (
                      <SelectRow selected={r.run_id === run} onSelect={() => open(r.run_id)}>
                        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                          <Text style={{ flex: 1, minWidth: 0 }}>{r.finished || r.started || "—"}</Text>
                          <Text type="secondary">
                            {r.summary.pass}✓ {r.summary.fail}✗ {r.summary.needs_material}? {r.summary.error}!
                          </Text>
                          <Text type="secondary" code>{r.run_id}</Text>
                          <VerdictTag verdict={r.overall} />
                        </div>
                      </SelectRow>
                    )}
                  />
                )}
                {activeRuns?.next && (
                  <Button size="small" loading={loadingMore} onClick={loadMore}>
                    加载更多（还有 {activeRuns.total - activeRuns.rows.length}）
                  </Button>
                )}
              </Space>
            )}
          </Card>
        </Space>
      )}
    </Split>
  );
}

/** A fetch's three states. Lists used to say "还没有规范" for the 17 s a real
 *  verifier home takes to answer — an empty list while loading is a lie. */
type Load<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; value: T };
function useLoad<T>(fn: () => Promise<T>): Load<T> {
  const [v, setV] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fn()
      .then((value) => live && setV({ state: "ok", value }))
      .catch((e) => live && setV({ state: "error", error: String(e?.message || e) }));
    return () => { live = false; };
  }, [fn]);
  return v;
}

export function ListState<T>({ load, empty, children }: { load: Load<T[]>; empty: string; children: (rows: T[]) => ReactNode }) {
  if (load.state === "loading") return <Text type="secondary" role="status">加载中…</Text>;
  if (load.state === "error") return <Alert type="error" showIcon title="加载失败" description={<Text code>{load.error}</Text>} />;
  if (!load.value.length) return <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  return <>{children(load.value)}</>;
}

/** List on the left, detail filling the rest. antd Space wraps each child in
 *  an item box, so the detail's flex:1 never applied and it stayed narrow. */
function Split({ side, children }: { side: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "0 0 280px", maxWidth: "100%" }}>{side}</div>
      <div style={{ flex: "1 1 360px", minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * 报告详情（纯展示，可用夹具静态渲染测试——种子库没有报告，运行时验证器画不到这里）。
 * 边界只在首屏出现一次（标签 + ≤1.2 报告的一行缺省说明）；VU 表只在报告真带
 * `semantic_scope`（契约 1.3 起）时才加「边界」列——缺省不逐行重复（监督席评审 ①③）。
 */
export function ReportDetail({ detail, latest }: { detail: VerifyReportDetail; latest?: boolean }) {
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
    <Card size="small" title={latest ? "最近一次报告" : "报告"} extra={<Text type="secondary">{detail.report.finished || detail.report.started}</Text>}>
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
    <VerifyTabs
      items={[
        { key: "material", label: "材料提交", render: () => <MaterialForm /> },
        { key: "trace", label: "构造追溯", render: () => <TraceView /> },
        { key: "report", label: "报告看板", render: () => <ReportBoard /> },
      ]}
    />
  );
}

/**
 * Three fixed views need no overflow menu, ink-bar motion or lazy panes — the
 * ARIA tabs pattern by hand (tablist / tab / tabpanel, arrow keys, roving
 * tabindex) instead of antd Tabs and its rc-tabs + dropdown tail.
 */
export function VerifyTabs({ items }: { items: Array<{ key: string; label: string; render: () => ReactNode }> }) {
  const [active, setActive] = useState(items[0].key);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (delta: number) => {
    const i = items.findIndex((t) => t.key === active);
    const next = items[(i + delta + items.length) % items.length].key;
    setActive(next);
    refs.current[next]?.focus();
  };
  const current = items.find((t) => t.key === active)!;
  return (
    <div>
      <div
        role="tablist"
        aria-label="验证器视图"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
        }}
        style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}
      >
        {items.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => { refs.current[t.key] = el; }}
              type="button"
              role="tab"
              id={`vt-${t.key}`}
              aria-selected={on}
              aria-controls={`vp-${t.key}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(t.key)}
              className="yt-tab"
              style={{
                background: "none",
                border: "none",
                borderBottom: `2px solid ${on ? C.primary : "transparent"}`,
                color: on ? C.primary : C.text,
                padding: "8px 12px",
                marginBottom: -1,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`vp-${current.key}`} aria-labelledby={`vt-${current.key}`}>
        {current.render()}
      </div>
    </div>
  );
}
