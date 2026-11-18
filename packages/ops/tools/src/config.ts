/**
 * Config layer (schema v6): user-tunable settings, distinct from `meta`
 * (runtime state the tool writes itself). The REGISTRY is the single
 * source of truth for known keys — defaults, types, notes; reads fall
 * back to defaults, so an empty config table is a valid state.
 *
 * Resolution order at call sites: environment override (if any) >
 * config table value > registry default.
 */
import type { DB } from "../../../core/database/src/db";
import { CONFIG_REGISTRY, specOf, isSecretKey } from "../../../core/database/src/config";
import type { ConfigSpec } from "../../../core/database/src/config";

// Compatibility for existing ops imports; domain readers use core/database directly.
export { CONFIG_REGISTRY, specOf, isSecretKey, configGet, configGetNumber, configGetBool } from "../../../core/database/src/config";
export type { ConfigSpec } from "../../../core/database/src/config";
import { nowIso } from "../../../core/text/src/text";

export const REDACTED = "[redacted]";

// Only the last 4 chars of a long secret survive.
export function maskSecret(v: string): string {
  if (!v) return "";
  return v.length > 12 ? `••••${v.slice(-4)}` : "••••";
}

export function displayValue(key: string, v: string): string {
  return isSecretKey(key) ? maskSecret(v) : v;
}

const SECRET_KEYS = CONFIG_REGISTRY.filter((c) => c.secret).map((c) => c.key);
const SECRET_WHERE = `kind='config.set' AND payload != ? AND entity_id IN (${SECRET_KEYS.map(() => "?").join(",")})`;

export function countSecretEvents(db: DB): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${SECRET_WHERE}`, [REDACTED, ...SECRET_KEYS])?.n ?? 0);
}

// Keep the audit row (who/when/which key), drop the value.
export function redactSecretEvents(db: DB): number {
  const n = countSecretEvents(db);
  if (n) db.run(`UPDATE events SET payload=? WHERE ${SECRET_WHERE}`, [REDACTED, REDACTED, ...SECRET_KEYS]);
  return n;
}

// Rows leaving the workspace: secret config dropped (migrate keeps it), events redacted.
export function exportableRows(db: DB, table: string, keepSecretConfig = false): any[] {
  const rows = db.all(`SELECT * FROM ${table}`) as any[];
  if (table === "config" && !keepSecretConfig) return rows.filter((r) => !isSecretKey(String(r.key)));
  if (table === "events") {
    return rows.map((r) => (r.kind === "config.set" && isSecretKey(String(r.entity_id)) && r.payload !== REDACTED
      ? { ...r, payload: REDACTED } : r));
  }
  return rows;
}

/** All keys resolved (list rendering / audit). */
export function configAll(db: DB): Array<ConfigSpec & { value: string; is_default: boolean }> {
  return CONFIG_REGISTRY.map((c) => {
    const row = db.get<{ value: string }>("SELECT value FROM config WHERE key=?", [c.key]);
    const raw = row ? row.value : "";
    return { ...c, value: displayValue(c.key, raw === "" ? c.def : raw), is_default: raw === "" };
  });
}

/** Validate + persist. Type-checked against the registry; unknown keys and
 *  bad values throw (caller maps to rc=2). */
export function configSet(db: DB, key: string, value: string): { key: string; value: string } {
  const spec = specOf(key);
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
  const spec = specOf(key);
  if (!spec) throw new Error(`unknown config key: ${key}`);
  db.run("DELETE FROM config WHERE key=?", [key]);
  if (spec.secret) redactSecretEvents(db);
  return { key, value: spec.def };
}
