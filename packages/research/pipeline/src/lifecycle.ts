/**
 * #220: task and job lifecycle — pure derivations shared by `task list|stale`, `job list|show` and doctor.
 *
 * Nothing here writes. A task's age is judged on `meta.status_at` (stamped on every status change since #220);
 * rows written before that fall back to `created`, and say so (`status_at_source: "created"`). A job's health is
 * derived from its row plus its own run history; nothing is stored, so the rule can change without a migration.
 */

export interface TaskView {
  id: string;
  project_id?: string;
  title: string;
  status: string;
  owner: string;
  status_at: string;
  status_at_source: "status_at" | "created";
  done_at: string;
  cancel_reason: string;
  created: string;
}

/** Open = still somebody's work: todo or doing. done and cancelled are closed. */
export const OPEN_TASK_STATUSES = ["todo", "doing"];

export function taskView(r: { id: string; title: string; meta?: string; created: string; project_id?: string }): TaskView {
  let meta: any = {};
  try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* malformed envelope → defaults */ }
  const stamped = typeof meta.status_at === "string" && meta.status_at !== "";
  return {
    id: r.id,
    ...(r.project_id !== undefined ? { project_id: r.project_id } : {}),
    title: r.title,
    status: meta.status || "todo",
    owner: meta.owner || "",
    status_at: stamped ? meta.status_at : r.created,
    status_at_source: stamped ? "status_at" : "created",
    done_at: meta.done_at || "",
    cancel_reason: meta.cancel_reason || "",
    created: r.created,
  };
}

const DAY_MS = 86_400_000;

/** Whole days since the task entered its current status (or since created, for legacy rows). */
export function taskAgeDays(t: TaskView, nowMs: number): number {
  const at = Date.parse(t.status_at);
  return Number.isFinite(at) ? Math.floor((nowMs - at) / DAY_MS) : 0;
}

export interface StaleTask extends TaskView { age_days: number; threshold_days: number }

/** Open tasks that sat in doing ≥ doingDays or in todo ≥ todoDays, oldest first. */
export function staleTasks(tasks: TaskView[], nowMs: number, doingDays: number, todoDays: number): StaleTask[] {
  const out: StaleTask[] = [];
  for (const t of tasks) {
    const limit = t.status === "doing" ? doingDays : t.status === "todo" ? todoDays : -1;
    if (limit < 0) continue;
    const age = taskAgeDays(t, nowMs);
    if (age >= limit) out.push({ ...t, age_days: age, threshold_days: limit });
  }
  return out.sort((a, b) => b.age_days - a.age_days || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- jobs

export type JobHealthState = "ok" | "failing" | "never-ran" | "overdue" | "manual" | "done" | "retired" | "disabled";

export interface JobRunRow { started: string; finished?: string; rc: number | null; output?: string }

export interface JobHealth {
  health: JobHealthState;
  consecutive_failures: number;
  last_ok: string;
  last_error: string;
  next_due: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const parseTime = (s: string) => Date.parse(String(s || "").replace(" ", "T"));

/**
 * Health of one job. `runs` is that job's finished runs, newest first. Order of precedence:
 * retired → done (a one-shot that ran) → disabled → failing (≥ failingRuns consecutive rc≠0) → never-ran → manual
 * (no every and no at) → overdue (now − last_run > 3 × every, the plan-D3 SLA) → ok. Only enabled jobs can be
 * failing, never-ran, manual or overdue: a disabled job is reported as disabled, with its last error still shown.
 */
export function jobHealth(job: any, runs: JobRunRow[], nowMs: number, failingRuns = 3): JobHealth {
  const finished = runs.filter((r) => r.rc !== null && r.rc !== undefined);
  let streak = 0;
  for (const r of finished) { if (r.rc === 0) break; streak++; }
  const ok = finished.find((r) => r.rc === 0);
  const err = finished.find((r) => r.rc !== 0);
  const every = Number(job.every_minutes ?? job.every ?? 0);
  const last = parseTime(job.last_run);
  let nextDue = "";
  if (every > 0) nextDue = Number.isFinite(last) ? iso(last + every * 60_000) : "now";
  else if (job.at && !job.last_run) nextDue = job.at;
  const base = {
    consecutive_failures: streak,
    last_ok: ok ? ok.finished || ok.started : "",
    last_error: err ? String(err.output || `rc=${err.rc}`).replace(/\s+/g, " ").trim().slice(0, 200) : "",
    next_due: nextDue,
  };
  const health = ((): JobHealthState => {
    if (job.status === "retired") return "retired";
    if (job.status === "done") return "done";
    if (!Number(job.enabled)) return "disabled";
    if (streak >= Math.max(1, failingRuns)) return "failing";
    if (!Number(job.runs) && !job.last_run) return every > 0 || job.at ? "never-ran" : "manual";
    if (every <= 0 && !job.at) return "manual";
    if (every > 0 && Number.isFinite(last) && nowMs - last > 3 * every * 60_000) return "overdue";
    return "ok";
  })();
  return { health, ...base };
}

/**
 * Stem shared by a "version family" (#220 J3): the same purpose registered again on each upgrade. Strips the
 * `--force` suffix (`-2`), a version marker and whatever follows it (`v2`, `(v9 全量)`, `v16:24判据`) and a
 * trailing "…版" word, then trims separators. Titles with no such marker stem to themselves.
 */
export function jobFamilyStem(title: string): string {
  let s = String(title).trim().toLowerCase();
  s = s.replace(/-\d+$/, "");
  // a version marker must not be glued to a latin word: "dev2" is a name, "序列v3" / "巡检 v2" are versions
  s = s.replace(/[\s(（·_-]*(?<![a-z0-9])v\d+(?:\.\d+)*\b.*$/u, "");
  s = s.replace(/\s+\S*版$/u, "");
  return s.replace(/[\s(（)）·:：_-]+$/u, "").trim();
}

/** Groups of ≥2 non-retired jobs that share a family stem. */
export function jobFamilies(jobs: Array<{ id: string; title: string; status?: string }>): Array<{ stem: string; ids: string[]; titles: string[] }> {
  const by = new Map<string, Array<{ id: string; title: string }>>();
  for (const j of jobs) {
    if (j.status === "retired") continue;
    const stem = jobFamilyStem(j.title);
    if (!stem) continue;
    const list = by.get(stem) ?? [];
    list.push(j);
    by.set(stem, list);
  }
  return [...by.entries()].filter(([, l]) => l.length > 1).map(([stem, l]) => ({ stem, ids: l.map((j) => j.id), titles: l.map((j) => j.title) }));
}
