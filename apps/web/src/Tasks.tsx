/**
 * 任务清单 (R12.2：status 分组 + 勾销)。The one place the overview writes: a
 * task moves a single step along todo → doing → done through the same writes
 * as `ygl-trees task doing|done` (every step logged as a task.status event).
 * The page only moves forward; stepping back is the CLI's `task todo|doing`.
 * Open work sorts first so the expert sees what is live.
 */
import { useState, type ReactNode } from "react";
import { Button, message as antdMessage, Popconfirm, Table, Typography } from "antd";
import { CheckOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { advanceTask, type TaskStatus, type TaskStepReceipt } from "./api";
import { C } from "./tokens";
import { ToneTag } from "./ToneTag";

const { Text } = Typography;

export const TASK_STATUS: Record<TaskStatus, { color: string; label: string }> = {
  todo: { color: C.secondary, label: "待办" },
  doing: { color: C.primary, label: "进行中" },
  done: { color: C.success, label: "已完成" },
};

const RANK: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };
const ORDER: TaskStatus[] = ["todo", "doing", "done"];
const asStatus = (s: string): TaskStatus => (s in TASK_STATUS ? (s as TaskStatus) : "todo");

const STEP: Partial<Record<TaskStatus, { to: TaskStatus; label: string; icon: ReactNode }>> = {
  todo: { to: "doing", label: "开始", icon: <PlayCircleOutlined /> },
  doing: { to: "done", label: "完成", icon: <CheckOutlined /> },
};

type Task = { id: string; title: string; status: string };

/** The status a row's button asks the server for (the request body's `status`, #70); null when there is no step. */
export function stepTarget(status: string): TaskStatus | null {
  return STEP[asStatus(status)]?.to ?? null;
}

/**
 * What the toast says about a receipt. A receipt that moved nothing — the
 * server's `idempotent: true`, or from === to — is not a success: the page was
 * behind the server, and saying 「待办 → 待办」 would hide it (0.114.29 #70).
 */
export function stepOutcome(title: string, r: TaskStepReceipt): { changed: boolean; text: string } {
  const from = TASK_STATUS[asStatus(r.from)].label;
  const to = TASK_STATUS[asStatus(r.to)].label;
  return r.idempotent || r.from === r.to
    ? { changed: false, text: `「${title}」已经是${to}，没有改动——页面落后于服务端，已按服务端状态显示` }
    : { changed: true, text: `「${title}」${from} → ${to}` };
}

/** 完成 asks first: the page has no step back; the CLI does (`task todo|doing`). */
export const DONE_CONFIRM = { title: "标记为已完成？", description: "总览里不能退回；需要时在 CLI 用 task todo 退回。" };

/** doing, then todo, then done; the server's newest-first order holds inside each group. */
export function groupTasks<T extends { status: string }>(tasks: T[]): T[] {
  return tasks
    .map((t, i) => [t, i] as const)
    .sort(([a, i], [b, j]) => RANK[asStatus(a.status)] - RANK[asStatus(b.status)] || i - j)
    .map(([t]) => t);
}

/** A step this page wrote, tied to the payload that was on screen when it landed. */
export type Written = { to: TaskStatus; seen: readonly Task[] };

/**
 * Status shown for a task: a step this page just wrote shows only over the
 * payload it was written against. Any newer payload — push or poll — is the
 * server's word and wins, even when it moved the task back (CLI `task todo`)
 * or names the very status we sent: the next click must send what the server
 * holds now (#66).
 */
export function shownStatus(server: string, tasks: readonly Task[], written?: Written): TaskStatus {
  return written && written.seen === tasks ? written.to : asStatus(server);
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [message, messageHolder] = antdMessage.useMessage();
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [written, setWritten] = useState<Record<string, Written>>({});

  const rows = groupTasks(tasks.map((t) => ({ ...t, status: shownStatus(t.status, tasks, written[t.id]) })));
  const counts = ORDER.map((s) => `${TASK_STATUS[s].label} ${rows.filter((t) => t.status === s).length}`).join(" · ");

  const step = async (t: Task) => {
    const to = stepTarget(t.status);
    if (!to) return;
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      const r = await advanceTask(t.id, to);
      // either way r.to is what the server holds now
      setWritten((w) => ({ ...w, [t.id]: { to: asStatus(r.to), seen: tasks } }));
      const o = stepOutcome(t.title, r);
      if (o.changed) message.success(o.text);
      else message.info(o.text);
    } catch (e: any) {
      message.error(`没能更新「${t.title}」：${String(e?.message || e)}`);
    } finally {
      setBusy(({ [t.id]: _, ...rest }) => rest);
    }
  };

  return (
    <>
      {messageHolder}
      <Table
        dataSource={rows}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        title={() => <Text type="secondary">{counts}</Text>}
        columns={[
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            filters: ORDER.map((value) => ({ text: TASK_STATUS[value].label, value })),
            onFilter: (value, record) => record.status === value,
            render: (s: TaskStatus) => <ToneTag color={TASK_STATUS[s].color}>{TASK_STATUS[s].label}</ToneTag>,
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
          {
            title: "推进",
            key: "step",
            width: 96,
            render: (_, record) => {
              const s = STEP[record.status as TaskStatus];
              if (!s) return null;
              const button = (
                <Button
                  size="small"
                  icon={s.icon}
                  loading={!!busy[record.id]}
                  aria-label={`${s.label}：${record.title}`}
                  onClick={s.to === "done" ? undefined : () => step(record)}
                >
                  {s.label}
                </Button>
              );
              return s.to === "done" ? (
                <Popconfirm
                  title={DONE_CONFIRM.title}
                  description={DONE_CONFIRM.description}
                  okText="完成"
                  cancelText="取消"
                  okButtonProps={{ autoInsertSpace: false }}
                  cancelButtonProps={{ autoInsertSpace: false }}
                  onConfirm={() => step(record)}
                >
                  {button}
                </Popconfirm>
              ) : (
                button
              );
            },
          },
        ]}
      />
    </>
  );
}
