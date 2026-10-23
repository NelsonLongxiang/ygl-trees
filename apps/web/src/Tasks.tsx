/**
 * 任务清单 (R12.2：status 分组 + 勾销)。The one place the overview writes: a
 * task moves a single step along todo → doing → done, the same state machine
 * as `ygl-trees task doing|done` (forward only, every step logged as a
 * task.status event). Open work sorts first so the expert sees what is live.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, message as antdMessage, Popconfirm, Table, Typography } from "antd";
import { CheckOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { advanceTask, type TaskStatus } from "./api";
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

/** doing, then todo, then done; the server's newest-first order holds inside each group. */
export function groupTasks<T extends { status: string }>(tasks: T[]): T[] {
  return tasks
    .map((t, i) => [t, i] as const)
    .sort(([a, i], [b, j]) => RANK[asStatus(a.status)] - RANK[asStatus(b.status)] || i - j)
    .map(([t]) => t);
}

/**
 * Status shown for a task: a step this page just wrote wins until the live push
 * reaches it, so the row never flips back while the server catches up.
 */
export function shownStatus(server: string, moved?: TaskStatus): TaskStatus {
  const s = asStatus(server);
  return moved && ORDER.indexOf(moved) > ORDER.indexOf(s) ? moved : s;
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [message, messageHolder] = antdMessage.useMessage();
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [moved, setMoved] = useState<Record<string, TaskStatus>>({});

  // forget a written step once the pushed data shows it (or something later)
  useEffect(() => {
    setMoved((m) => {
      const next = { ...m };
      for (const t of tasks) if (next[t.id] && shownStatus(t.status, next[t.id]) === asStatus(t.status)) delete next[t.id];
      return Object.keys(next).length === Object.keys(m).length ? m : next;
    });
  }, [tasks]);

  const rows = groupTasks(tasks.map((t) => ({ ...t, status: shownStatus(t.status, moved[t.id]) })));
  const counts = ORDER.map((s) => `${TASK_STATUS[s].label} ${rows.filter((t) => t.status === s).length}`).join(" · ");

  const step = async (t: Task) => {
    const from = asStatus(t.status);
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      const r = await advanceTask(t.id, from);
      setMoved((m) => ({ ...m, [t.id]: r.to }));
      message.success(`「${t.title}」${TASK_STATUS[from].label} → ${TASK_STATUS[r.to].label}`);
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
              // done is final (no way back, here or in the CLI), so it asks first
              return s.to === "done" ? (
                <Popconfirm
                  title="标记为已完成？"
                  description="完成后不能退回待办或进行中。"
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
