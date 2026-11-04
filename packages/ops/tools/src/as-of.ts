/**
 * Strict ISO-8601 parsing shared by `verify prepare --as-of` (r22/r23, 0.102.4) and `verify instance import-latest`
 * (#212 review). Moved out of verify-cmds.ts unchanged in behaviour; verify-cmds re-exports the as_of API.
 */
/** as_of 校验失败（r22 ②）。CLI 映射 rc=2，HTTP 映射 400——两侧共用同一个校验。 */
export class AsOfError extends Error {}

/** 严格 ISO：纯日期（按 UTC 00:00）或"带显式时区"的 datetime；其余一律拒（r23 P3①）。 */
const AS_OF_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AS_OF_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** 日历合法性按 UTC 逐字段回读——`2026-02-30` 会被 Date 静默滚成 03-02，不能信任 Date.parse。 */
function calendarOk(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * as_of 归一（r22 ②，0.102.4 收紧为严格 ISO）。R13 要求锚定冻结值：不可解析的时间锚会把
 * 报告变成不可对质，而"能解析但按本机时区解释"的锚在 CI(UTC) 与本机(+08) 会得到两个时刻。
 *
 * 接受：`2026-10-24`（纯日期，按 UTC 00:00）、`2026-10-24T10:00:00Z`、
 * `2026-10-24T10:00:00.123+08:00`、`+0800`（与引擎 `ISO_DATETIME_TZ` 的 `±hh` 口径一致）。
 * 拒绝：无时区 datetime、空格分隔、非 ISO（`Jan 1 2026`）、非法日历（`2026-02-30`）。
 * 未给（undefined/null/空串）才回落 `fallback`（调用方的本次时刻）。
 */
export function normalizeAsOf(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") throw new AsOfError(`as_of must be an ISO-8601 string, got ${typeof raw}`);
  return parseIso(raw, "as_of", true);
}

/**
 * 时间戳字段（不是锚定日期）：只收带显式时区的 ISO datetime，归一为 UTC。纯日期、无时区、非 ISO
 * （`0`、`11/04/2026`）与非法日历（`2026-02-30`）一律抛 AsOfError，绝不静默滚动或按本机时区解释
 * （#212 评审：`Date.parse` 非 NaN 不是 ISO 校验）。`field` 只用于报错点名。
 */
export function strictIsoTimestamp(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new AsOfError(`${field} must be an ISO-8601 timestamp string`);
  return parseIso(raw, field, false);
}

function parseIso(raw: string, field: string, allowDate: boolean): string {
  const t = raw.trim();
  let m = allowDate ? AS_OF_DATE.exec(t) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!calendarOk(y, mo, d)) throw new AsOfError(`${field} is not a valid calendar date: ${raw}`);
    return new Date(Date.UTC(y, mo - 1, d)).toISOString();
  }
  m = AS_OF_DATETIME.exec(t);
  if (!m) {
    throw new AsOfError(
      `${field} is not an ISO-8601 timestamp with an explicit zone (use 2026-10-24T00:00:00Z, 2026-10-24T08:00:00+08:00, +0800${allowDate ? ", or a bare date 2026-10-24" : ""}) — got: ${raw}`
    );
  }
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m;
  const [y, mo, d] = [Number(ys), Number(mos), Number(ds)];
  if (!calendarOk(y, mo, d)) throw new AsOfError(`${field} is not a valid calendar date: ${raw}`);
  const [h, mi, sec] = [Number(hs), Number(mis), Number(ss ?? "0")];
  if (h > 23 || mi > 59 || sec > 59) throw new AsOfError(`${field} has an out-of-range time: ${raw}`);
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const zh = Number(digits.slice(0, 2));
    const zm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (zh > 23 || zm > 59) throw new AsOfError(`${field} has an out-of-range zone offset: ${raw}`);
    offsetMin = sign * (zh * 60 + zm);
  }
  const ms = frac ? Number(`${frac}000`.slice(0, 3)) : 0;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60000).toISOString();
}
