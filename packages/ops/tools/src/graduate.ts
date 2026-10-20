/** 毕业通道（M13-3）：把「一次性验证」升级为「常驻检查」。
 *
 * 三段拆（设计裁定 2026-10-20，docs/spec-validator.md §9）：
 * 1. **资格**：同一 `spec_version`、最近 N 份 `overall=PASS` 报告、跨度 ≥ M 天。
 *    任一不满足即点名拒绝（rc=1、不落盘）——毕业不是"跑过一次成功"，是"跨时间稳定"。
 * 2. **毕业记录**：`$YGL_HOME/verify/graduations/<spec_id>.json` 冻结（spec_version、
 *    run_id 清单、阈值、created）。幂等：同核心内容重跑回 `duplicate:true`；不同则拒绝覆盖。
 * 3. **常驻执行**：给出 `verify run <spec_id> --db <source> --no-archive` 命令串；
 *    `--schedule` 才真的登记作业（默认只打印，让操作员先看清要跑什么）。
 *
 * 边界（有意不做）：
 * - **patrol 化** 只对「被验库 == 工作区库」的规范成立（`patrol run` 在工作区库上跑 SQL，
 *   而 VU 判的是被验快照）；库不对源时明确拒绝并点名，不生成半对的检查。
 * - 报告必须同 spec_version：跨版本"历史最好成绩"不算连续，因为判据本身变了。
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Env } from "../../../core/database/src/types";
import { verifyPaths } from "./verify-web";
import { readJson, writeJson } from "./verify-cmds";

export interface GraduationThresholds {
  min_runs: number;
  min_span_days: number;
}

export interface GraduationHistory {
  /** 同 spec_version 的报告总数（含未进入最近 N 份窗口的历史）。 */
  reports_same_version: number;
  /** 其中非 PASS 的条数——窗口外失败也要能看见，否则审计者会误以为从未失败。 */
  non_pass: number;
  /** 最近一条非 PASS（含窗口外），没有则 null。 */
  last_non_pass: { run_id: string; finished: string; overall: string } | null;
}

export interface GraduationRecord {
  spec_id: string;
  spec_version: number;
  run_ids: string[];
  thresholds: GraduationThresholds;
  history: GraduationHistory;
  /** 最早一份与最新一份 PASS 报告之间的实际跨度（天，保留 2 位）。 */
  span_days: number;
  /** 最近一份报告的 `data_source`（常驻执行据此挑 --db）。 */
  data_source: { kind: string; source: string; sha256?: string } | null;
  created: string;
}

export interface Eligibility {
  ok: boolean;
  spec_id: string;
  spec_version: number;
  /** 参与判定的报告（同 spec_version，按 finished 从新到旧，最多 min_runs 条）。 */
  runs: Array<{ run_id: string; finished: string; overall: string }>;
  /** 拒绝原因（ok=false 时非空，逐条点名）。 */
  reasons: string[];
  /** 同版本历史摘要（窗口外失败也计数，Q1①）。 */
  history: GraduationHistory;
  span_days: number;
  data_source: GraduationRecord["data_source"];
}

export class GraduationError extends Error {}

export function graduationsDir(env: Env): string {
  const dir = join(verifyPaths(env).root, "graduations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function graduationPath(env: Env, specId: string): string {
  return join(graduationsDir(env), `${specId}.json`);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round(((b - a) / 86_400_000) * 100) / 100;
}

/** 读 spec + 报告，判定资格。不写任何东西；拒绝原因逐条给人话。 */
export function checkEligibility(env: Env, specId: string, thresholds: GraduationThresholds): Eligibility {
  const paths = verifyPaths(env);
  const specFile = join(paths.specs, specId, "spec.json");
  if (!existsSync(specFile)) throw new GraduationError(`spec not found: ${specId} (no specs/${specId}/spec.json)`);
  const spec = readJson<{ spec_version?: number }>(specFile);
  const specVersion = Number(spec.spec_version ?? 0);
  if (!specVersion) throw new GraduationError(`spec has no spec_version: ${specFile}`);

  const runs: Array<{ run_id: string; finished: string; overall: string; data_source: any }> = [];
  const files = existsSync(paths.reports) ? readdirSync(paths.reports).filter((f) => f.endsWith(".json")) : [];
  for (const f of files) {
    let r: any;
    try {
      r = readJson<any>(join(paths.reports, f));
    } catch {
      continue; // 单条损坏不拖垮判定（与看板 N2 WONTFIX 同口径）
    }
    if (!r || r.spec_id !== specId) continue;
    if (Number(r.verifier?.spec_version) !== specVersion) continue; // 跨版本不算连续
    if (typeof r.run_id !== "string" || typeof r.finished !== "string") continue;
    runs.push({ run_id: r.run_id, finished: r.finished, overall: String(r.overall), data_source: r.data_source ?? null });
  }
  runs.sort((a, b) => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : 0));

  const reasons: string[] = [];
  const history: GraduationHistory = {
    reports_same_version: runs.length,
    non_pass: runs.filter((r) => r.overall !== "PASS").length,
    last_non_pass: runs.find((r) => r.overall !== "PASS")
      ? {
          run_id: runs.find((r) => r.overall !== "PASS")!.run_id,
          finished: runs.find((r) => r.overall !== "PASS")!.finished,
          overall: runs.find((r) => r.overall !== "PASS")!.overall,
        }
      : null,
  };
  const picked = runs.slice(0, Math.max(1, thresholds.min_runs));
  if (picked.length < thresholds.min_runs) {
    reasons.push(`need ${thresholds.min_runs} report(s) at spec_version ${specVersion}, found ${picked.length}`);
  }
  // 跨度闸门需要两份报告才有定义：min_span_days>0 却只取到 1 份时，"跨时间稳定"没有证据，
  // 不能让单份 PASS 以 span=0 混过闸门（r25 P2-1）。
  if (thresholds.min_span_days > 0 && picked.length < 2) {
    reasons.push(
      `span threshold ${thresholds.min_span_days} day(s) needs at least 2 reports at spec_version ${specVersion} (found ${picked.length})`,
    );
  }
  const failing = picked.filter((r) => r.overall !== "PASS");
  if (failing.length) {
    reasons.push(
      `not all recent runs PASS at spec_version ${specVersion}: ${failing.map((r) => `${r.run_id}=${r.overall}`).join(", ")}`,
    );
  }
  const span = picked.length >= 2 ? daysBetween(picked[picked.length - 1].finished, picked[0].finished) : 0;
  if (picked.length >= 2 && span < thresholds.min_span_days) {
    reasons.push(
      `span ${span} day(s) < ${thresholds.min_span_days} day(s): ${picked[picked.length - 1].finished} → ${picked[0].finished}`,
    );
  }

  return {
    ok: reasons.length === 0,
    spec_id: specId,
    spec_version: specVersion,
    runs: picked.map(({ run_id, finished, overall }) => ({ run_id, finished, overall })),
    reasons,
    history,
    span_days: span,
    data_source: picked[0]?.data_source ?? null,
  };
}

/** 毕业记录（幂等）：同核心内容 → duplicate；已存在不同内容 → 拒绝覆盖（冻结记录不可改）。 */
export function writeGraduation(
  env: Env,
  el: Eligibility,
  thresholds: GraduationThresholds,
  now = new Date().toISOString(),
): { record: GraduationRecord; path: string; duplicate: boolean } {
  const path = graduationPath(env, el.spec_id);
  const record: GraduationRecord = {
    spec_id: el.spec_id,
    spec_version: el.spec_version,
    run_ids: el.runs.map((r) => r.run_id),
    thresholds,
    history: el.history,
    span_days: el.span_days,
    data_source: el.data_source,
    created: now,
  };
  if (existsSync(path)) {
    const prev = readJson<GraduationRecord>(path);
    const sameCore =
      prev.spec_id === record.spec_id &&
      prev.spec_version === record.spec_version &&
      prev.run_ids.length === record.run_ids.length &&
      prev.run_ids.every((id) => record.run_ids.includes(id));
    if (sameCore) return { record: prev, path, duplicate: true };
    const superseded = prev.spec_version !== record.spec_version;
    throw new GraduationError(
      superseded
        ? `graduation frozen for an older spec_version: ${el.spec_id} was v${prev.spec_version} (${prev.run_ids.length} run(s)), ` +
            `the current spec is v${record.spec_version}; re-run the new version through verify run, then delete ${path} deliberately to re-graduate`
        : `graduation already frozen for ${el.spec_id} (spec_version ${prev.spec_version}, ${prev.run_ids.length} run(s)); ` +
            `refusing to overwrite with a different shape — delete ${path} deliberately if the frozen record was wrong`,
    );
  }
  writeJson(path, record);
  return { record, path, duplicate: false };
}

/**
 * 交给 `job add` 的命令串（--every 是 job 的调度参数，不属于 verify）。
 *
 * 报告里的 `data_source.source` **不一定能当 `--db` 用**：
 * - HTTP 作业面的来源是 `blob:<sha12>`（内容寻址引用，不是文件路径），照抄进命令串
 *   只会让作业每分钟 ENOENT 失败（r25 P2-2）。
 * - 报告是**数据**，`job tick` 走 shell（`job-cmds.ts` 的 execSync）。r26 P1 实证：
 *   伪造报告把 `" & echo PWNED & rem "` 塞进 source，经 `verify report import`
 *   （只校验 payload 自洽）→ `--schedule` → `job tick` 即执行。因此路径必须过
 *   白名单：不安全时 `usable:false`、命令串打占位符、原文不回显（`rejected`
 *   是消毒后的摘要），CLI 拒绝 --schedule。
 *
 * 返回值因此带四个事实：可执行与否、最终命令串、不安全标记、消毒摘要。
 */
export interface JobCommand {
  command: string;
  db: string;
  usable: boolean;
  /** candidate 命中 shell 白名单失败 —— CLI 必须拒绝 --schedule，且不要回显原串。 */
  unsafe: boolean;
  /** 消毒后的摘要（控制字符替换、截断 40 字符）；没有不安全来源时为 null。 */
  rejected: string | null;
}

/** 路径白名单：字母数字、点、下划线、斜杠、反斜杠、冒号、连字符、空格、波浪号。
 *  波浪号是 Windows 8.3 短路径（`C:\Users\ADMINI~1\...`）的合法字符，且命令串
 *  始终双引号包裹——`~` 在双引号内不展开，放进命令串不构成注入面。 */
const SHELL_PATH_SAFE = /^[A-Za-z0-9._/\\:\- ~]+$/;
/** spec_id 同为命令串的一部分，用与 HTTP 层一致的 id 白名单。 */
const SPEC_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

export function shellSafePath(raw: string): boolean {
  return raw.length > 0 && raw.length <= 4096 && SHELL_PATH_SAFE.test(raw);
}

function printable(raw: string): string {
  const clean = raw.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
}

export function jobCommand(specId: string, source: string | null, override?: string | null): JobCommand {
  const explicit = override && override.trim() ? override.trim() : null;
  const candidate = explicit ?? source;
  const blob = !!candidate && candidate.startsWith("blob:");
  const unsafe = !!candidate && !blob && !shellSafePath(candidate);
  const idUnsafe = !SPEC_ID_SAFE.test(specId);
  const usable = !!candidate && !blob && !unsafe && !idUnsafe;
  const db = usable ? (candidate as string) : "<snapshot.sqlite>";
  const rejected = unsafe ? printable(candidate as string) : null;
  const id = idUnsafe ? "<spec-id>" : specId;
  return { command: `ygl-trees verify run ${id} --db "${db}" --no-archive`, db, usable, unsafe: unsafe || idUnsafe, rejected };
}

/**
 * patrol 化只对「被验库 == 工作区库」成立：`patrol run` 在工作区库上执行 SQL，
 * 而被验快照是另一份文件。库不对源时点名拒绝——生成半对检查比没有检查更危险。
 */
export function patrolEligibility(env: Env, dataSource: GraduationRecord["data_source"]): { ok: boolean; reason?: string } {
  const source = dataSource?.source;
  if (!source) return { ok: false, reason: "no data_source in reports (run once with --db before graduating to patrol)" };
  if (resolve(source) !== resolve(env.db.path)) {
    return {
      ok: false,
      reason:
        `patrol graduation needs the verified database to be the workspace database, ` +
        `but reports were produced from ${source} and the workspace database is ${env.db.path}`,
    };
  }
  return { ok: true };
}
