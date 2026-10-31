/**
 * Config layer (schema v6): user-tunable settings, distinct from `meta`
 * (runtime state the tool writes itself). The REGISTRY is the single
 * source of truth for known keys — defaults, types, notes; reads fall
 * back to defaults, so an empty config table is a valid state.
 *
 * Resolution order at call sites: environment override (if any) >
 * config table value > registry default.
 */
import { DB } from "../../../core/database/src/db";
import { nowIso } from "../../../core/text/src/text";

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
  { key: "decision_model_llm_token", def: "", type: "string", secret: true, note: "决策模型凭证（机密：只显示末 4 位、不进事件/导出）——优先于 AI_GATEWAY_API_KEY 与 ~/.vercel.ai-gateway.env；推荐用环境变量；空=回落" },
  { key: "decision_model_llm_api_base", def: "", type: "string", note: "决策模型端点——优先于默认 Vercel Gateway；给主机名自动补 /v4/ai/evaluation-model，空=默认" },
  { key: "fetch.timeout_ms", def: "15000", type: "number", note: "source fetch 超时（毫秒）" },
  { key: "fetch.user_agent", def: "ygl-trees/0.15 (+local research cli)", type: "string", note: "source fetch 的 User-Agent" },
  { key: "search.limit", def: "20", type: "number", note: "kb/skill 检索默认返回条数（--limit 覆盖）" },
  { key: "default_confidence", def: "B", type: "string", note: "claim/kb 写入的默认置信度（A|B|C）" },
  { key: "job.stale_minutes", def: "30", type: "number", note: "悬空 run 回收阈值（分钟）" },
  { key: "update_check", def: "true", type: "boolean", note: "CLI 版本更新提示（信息性 nag；false 或 YGL_NO_UPDATE_CHECK=1 关闭，不影响任何 rc）" },
];

const BY_KEY = new Map(CONFIG_REGISTRY.map((c) => [c.key, c]));

export function specOf(key: string): ConfigSpec | undefined {
  return BY_KEY.get(key);
}

export const REDACTED = "[redacted]";

export function isSecretKey(key: string): boolean {
  return BY_KEY.get(key)?.secret === true;
}

/** Only the last 4 chars of a long secret survive. */
export function maskSecret(v: string): string {
  if (!v) return "";
  return v.length > 12 ? `••••${v.slice(-4)}` : "••••";
}

export function displayValue(key: string, v: string): string {
  return isSecretKey(key) ? maskSecret(v) : v;
}

function secretEventWhere(): { where: string; params: string[] } {
  const keys = CONFIG_REGISTRY.filter((c) => c.secret).map((c) => c.key);
  return {
    where: `kind='config.set' AND entity_id IN (${keys.map(() => "?").join(",")}) AND payload != ?`,
    params: [...keys, REDACTED],
  };
}

export function countSecretEvents(db: DB): number {
  const { where, params } = secretEventWhere();
  return Number((db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, params))?.n ?? 0);
}

/** Keep the audit row (who/when/which key), drop the value. */
export function redactSecretEvents(db: DB): number {
  const n = countSecretEvents(db);
  if (n) {
    const { where, params } = secretEventWhere();
    db.run(`UPDATE events SET payload=? WHERE ${where}`, [REDACTED, ...params]);
  }
  return n;
}

/** Rows leaving the workspace: secret config dropped (migrate keeps it), events redacted. */
export function exportableRows(db: DB, table: string, keepSecretConfig = false): any[] {
  const rows = db.all(`SELECT * FROM ${table}`) as any[];
  if (table === "config" && !keepSecretConfig) return rows.filter((r) => !isSecretKey(String(r.key)));
  if (table === "events") {
    return rows.map((r) => (r.kind === "config.set" && isSecretKey(String(r.entity_id)) && r.payload !== REDACTED
      ? { ...r, payload: REDACTED } : r));
  }
  return rows;
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

/** All keys resolved (list rendering / audit). */
export function configAll(db: DB): Array<ConfigSpec & { value: string; is_default: boolean }> {
  return CONFIG_REGISTRY.map((c) => {
    const raw = rawValue(db, c.key);
    return { ...c, value: displayValue(c.key, raw === "" ? c.def : raw), is_default: raw === "" };
  });
}

/** Validate + persist. Type-checked against the registry; unknown keys and
 *  bad values throw (caller maps to rc=2). */
export function configSet(db: DB, key: string, value: string): { key: string; value: string } {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown config key: ${key} (config list 查看全部)`);
  const v = String(value);
  if (spec.type === "number" && !/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`${key} 需要数值，收到: ${v}`);
  if (spec.type === "boolean" && !/^(true|false|1|0|yes|no)$/i.test(v)) throw new Error(`${key} 需要布尔（true/false），收到: ${v}`);
  if (key === "default_confidence" && !/^[ABC]$/.test(v)) throw new Error(`default_confidence 取值 A|B|C，收到: ${v}`);
  if (key === "eval.pass_threshold" || key === "eval.fail_threshold") {
    const n = Number(v);
    if (n < 0 || n > 1) throw new Error(`${key} 取值范围 [0,1]，收到: ${v}`);
  }
  db.run(
    `INSERT INTO config(key,value,note,updated) VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated`,
    [key, v, spec.note, nowIso()]
  );
  db.run(
    "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES(?,?,?,?,?,?,?)",
    [`${key}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, nowIso(), "cli", "config.set", "config", key, spec.secret ? REDACTED : v]
  );
  if (spec.secret) redactSecretEvents(db);
  return { key, value: displayValue(key, v) };
}

/** Drop the override — back to the registry default. */
export function configReset(db: DB, key: string): { key: string; value: string } {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown config key: ${key}`);
  db.run("DELETE FROM config WHERE key=?", [key]);
  if (spec.secret) redactSecretEvents(db);
  return { key, value: spec.def };
}
