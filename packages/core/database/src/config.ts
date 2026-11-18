/** Shared configuration registry and pure readers; mutation and secret-display policy stay in ops. */
import type { DB } from "./db";

export interface ConfigSpec {
  key: string;
  def: string;
  type: "string" | "number" | "boolean";
  note: string;
  secret?: boolean; // #150: never echoed, logged or exported
}

export const CONFIG_REGISTRY: ConfigSpec[] = [
  { key: "eval.pass_threshold", def: "0.7", type: "number", note: "P(true) ≥ 此值判定通过（决策模型门槛）" },
  { key: "eval.fail_threshold", def: "0.4", type: "number", note: "P(true) ≤ 此值判定未通过；两值之间为灰带 pending" },
  { key: "eval.offline", def: "false", type: "boolean", note: "强制决策模型离线（等价 YGL_EVAL_OFFLINE=1，环境变量优先）" },
  { key: "decision_model_llm_token", def: "", type: "string", secret: true, note: "决策模型凭证（机密）——优先于 AI_GATEWAY_API_KEY 与 ~/.vercel.ai-gateway.env；空=回落" },
  { key: "decision_model_llm_api_base", def: "", type: "string", note: "决策模型端点——优先于默认 Vercel Gateway；给主机名自动补 /v4/ai/evaluation-model，空=默认" },
  { key: "fetch.timeout_ms", def: "15000", type: "number", note: "source fetch 超时（毫秒）" },
  { key: "fetch.user_agent", def: "ygl-trees/0.15 (+local research cli)", type: "string", note: "source fetch 的 User-Agent" },
  { key: "search.limit", def: "20", type: "number", note: "kb/skill 检索默认返回条数（--limit 覆盖）" },
  { key: "default_confidence", def: "B", type: "string", note: "claim/kb 写入的默认置信度（A|B|C）" },
  { key: "job.stale_minutes", def: "30", type: "number", note: "悬空 run 回收阈值（分钟）" },
  { key: "job.failing_runs", def: "3", type: "number", note: "连续失败多少次判 failing（#220；doctor job_health 对启用中的 failing job 判 fail）" },
  { key: "job.min_every_minutes", def: "60", type: "number", note: "job add --every 下限（分钟）；更密需 --allow-frequent，0 = 不设下限（#220）" },
  { key: "job.keep_runs", def: "50", type: "number", note: "job prune-runs 每个 job 默认保留的最近运行条数（#220）" },
  { key: "task.stale_doing_days", def: "14", type: "number", note: "doing 停留超过此天数算停滞（task stale / doctor task_hygiene，#220）" },
  { key: "task.stale_todo_days", def: "30", type: "number", note: "todo 停留超过此天数算挂账（task stale / doctor task_hygiene，#220）" },
  { key: "update_check", def: "true", type: "boolean", note: "CLI 版本更新提示（信息性 nag；false 或 YGL_NO_UPDATE_CHECK=1 关闭，不影响任何 rc）" },
];

const BY_KEY = new Map(CONFIG_REGISTRY.map((c) => [c.key, c]));

export function specOf(key: string): ConfigSpec | undefined {
  return BY_KEY.get(key);
}

export function isSecretKey(key: string): boolean {
  return BY_KEY.get(key)?.secret === true;
}

/** Raw row from the config table ('' when unset). */
function rawValue(db: DB, key: string): string {
  const r = db.get<{ value: string }>("SELECT value FROM config WHERE key=?", [key]);
  return r ? r.value : "";
}

/** Resolved value: config table > registry default (never empty). */
export function configGet(db: DB, key: string): string {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown config key: ${key} (config list 查看全部)`);
  const v = rawValue(db, key);
  return v === "" ? spec.def : v;
}

export function configGetNumber(db: DB, key: string): number {
  const n = Number(configGet(db, key));
  return Number.isFinite(n) ? n : Number(BY_KEY.get(key)!.def);
}

export function configGetBool(db: DB, key: string): boolean {
  const v = configGet(db, key).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
