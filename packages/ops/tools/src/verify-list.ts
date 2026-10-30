/** Async, bounded HTTP projections of immutable verifier reports. Details remain on the detail endpoints. */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../../../core/database/src/types";
import type { ArchiveRow, ReportRow, SpecRow } from "./verify-web";

export interface VerifyPage<T> { items: T[]; total: number; next_cursor: string | null }
type Index = { reports: ReportRow[]; archives: ArchiveRow[]; bySpec: Map<string, ReportRow[]>; bad: Map<string, ReportRow[]>; stats: Map<string, { runs: number; last?: ReportRow }> };
type FileRecord = { stamp: string; value: any };
type Cache = { stamp: string; built: number; files: Map<string, FileRecord>; index?: Index; pending?: Promise<Index> };
const caches = new WeakMap<Env, Cache>();
const id = /^[A-Za-z0-9_-]{1,128}$/;
const text = (v: unknown, n = 1024) => String(v ?? "").slice(0, n);
async function json(path: string): Promise<any> { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function names(path: string) { try { return (await readdir(path)).filter(f => f.endsWith(".json") && id.test(f.slice(0, -5))); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; } }
async function stamp(path: string) { try { const s = await stat(path); return s.mtimeMs + ":" + s.ctimeMs; } catch (e: any) { if (e.code === "ENOENT") return "missing"; throw e; } }
async function mapFiles<T>(files: string[], fn: (file: string) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(files.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => { while (next < files.length) { const i = next++; out[i] = await fn(files[i]); } }));
  return out;
}
const reportKey = (r: ReportRow): [string, string] => [r.finished, r.run_id];
const archiveKey = (r: ArchiveRow): [string, string] => [r.created, r.run_id + ":" + r.archive_id + ":" + r.filename];
const compare = (a: [string, string], b: [string, string]) => b[0].localeCompare(a[0]) || b[1].localeCompare(a[1]);

async function build(root: string, files: Map<string, FileRecord>): Promise<Index> {
  const seen = new Set<string>();
  const cachedJson = async (path: string, project: (value: any) => any) => {
    seen.add(path);
    const current = await stamp(path), prior = files.get(path);
    if (prior?.stamp === current) return prior.value;
    const raw = await json(path), value = raw ? project(raw) : null;
    files.set(path, { stamp: current, value }); return value;
  };
  const archives = (await mapFiles(await names(join(root, "archives")), async f => {
    return await cachedJson(join(root, "archives", f), side => (Array.isArray(side?.archives) ? side.archives : []).map((a: any): ArchiveRow => ({
      run_id: f.slice(0, -5), archive_id: text(a?.archive_id, 128), filename: text(a?.filename, 512),
      archive_sha256: text(a?.archive_sha256, 128), zip_sha256: text(a?.zip_sha256, 128), created: text(a?.created, 64),
      with: Array.isArray(a?.with) ? a.with.slice(0, 32).map((v: unknown) => text(v, 128)) : [],
    }))) || [];
  })).flat().sort((a, b) => compare(archiveKey(a), archiveKey(b)));
  const counts = new Map<string, number>();
  for (const a of archives) counts.set(a.run_id, (counts.get(a.run_id) || 0) + 1);
  const reports = (await mapFiles(await names(join(root, "reports")), async f => {
    const row = await cachedJson(join(root, "reports", f), r => {
    if (typeof r.run_id !== "string" || !id.test(r.run_id)) return null;
    return {
      run_id: r.run_id, spec_id: text(r.spec_id, 128), spec_version: Number(r.verifier?.spec_version ?? r.spec_version ?? 0),
      overall: text(r.overall, 64), reason: text(r.reason),
      summary: { pass: Number(r.summary?.pass ?? 0), fail: Number(r.summary?.fail ?? 0), needs_material: Number(r.summary?.needs_material ?? 0), error: Number(r.summary?.error ?? 0) },
      started: text(r.started, 64), finished: text(r.finished, 64), mode: text(r.verifier?.mode, 64), binary_sha256: text(r.verifier?.binary_sha256, 128),
      archived: 0, semantic_scope: typeof r.semantic_scope === "string" ? text(r.semantic_scope, 64) : null,
    } satisfies ReportRow;
    });
    return row ? { ...row, archived: counts.get(row.run_id) || 0 } as ReportRow : null;
  })).filter((r): r is ReportRow => r !== null).sort((a, b) => compare(reportKey(a), reportKey(b)));
  const bySpec = new Map<string, ReportRow[]>(), bad = new Map<string, ReportRow[]>(), stats = new Map<string, { runs: number; last?: ReportRow }>();
  for (const r of reports) {
    if (!bySpec.has(r.spec_id)) bySpec.set(r.spec_id, []);
    bySpec.get(r.spec_id)!.push(r);
    if (r.overall !== "PASS") { if (!bad.has(r.spec_id)) bad.set(r.spec_id, []); bad.get(r.spec_id)!.push(r); }
    const s = stats.get(r.spec_id); if (s) s.runs++; else stats.set(r.spec_id, { runs: 1, last: r });
  }
  for (const path of files.keys()) if (!seen.has(path)) files.delete(path);
  return { reports, archives, bySpec, bad, stats };
}
async function index(env: Env): Promise<Index> {
  const root = join(env.home, "verify");
  let c = caches.get(env); if (!c) { c = { stamp: "", built: 0, files: new Map() }; caches.set(env, c); }
  if (c.pending) return c.pending;
  const signature = (await Promise.all([stamp(join(root, "reports")), stamp(join(root, "archives"))])).join("|");
  if (c.index && c.stamp === signature && Date.now() - c.built < 5000) return c.index;
  if (c.pending) return c.pending;
  const current = c;
  current.pending = build(root, current.files).then(value => { current.index = value; current.stamp = signature; current.built = Date.now(); return value; }).finally(() => { current.pending = undefined; });
  return current.pending;
}
export class VerifyListUsageError extends Error {}
function page<T>(rows: T[], q: URLSearchParams, key: (row: T) => [string, string], scope: string): VerifyPage<T> {
  const raw = q.get("limit") ?? "200";
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 500) throw new VerifyListUsageError("limit must be an integer from 1 to 500");
  let start = 0;
  const cursor = q.get("cursor");
  if (cursor) {
    let k: any;
    if (cursor.length > 4096) throw new VerifyListUsageError("invalid cursor for this list");
    try { k = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* invalid below */ }
    if (!Array.isArray(k) || k.length !== 3 || k[0] !== scope || typeof k[1] !== "string" || typeof k[2] !== "string" || cursor.length > 4096) throw new VerifyListUsageError("invalid cursor for this list");
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(key(rows[mid]), [k[1], k[2]]) <= 0) lo = mid + 1; else hi = mid; }
    start = lo;
  }
  const items = rows.slice(start, start + Number(raw));
  const last = items.at(-1);
  return { items, total: rows.length, next_cursor: last && start + items.length < rows.length ? Buffer.from(JSON.stringify([scope, ...key(last)])).toString("base64url") : null };
}
export async function reportPage(env: Env, q: URLSearchParams): Promise<VerifyPage<ReportRow>> {
  const spec = q.get("spec") || "", onlyBad = q.get("only_bad") === "1";
  page([], q, reportKey, "reports:" + spec + ":" + onlyBad);
  const i = await index(env);
  const rows = spec ? (onlyBad ? i.bad : i.bySpec).get(spec) || [] : onlyBad ? i.reports.filter(r => r.overall !== "PASS") : i.reports;
  return page(rows, q, reportKey, "reports:" + spec + ":" + onlyBad);
}
export async function archivePage(env: Env, q: URLSearchParams): Promise<VerifyPage<ArchiveRow>> {
  page([], q, archiveKey, "archives");
  return page((await index(env)).archives, q, archiveKey, "archives");
}
export async function specRows(env: Env): Promise<SpecRow[]> {
  const i = await index(env), root = join(env.home, "verify", "specs");
  let dirs; try { dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && id.test(d.name)); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  return (await mapFiles(dirs.map(d => d.name).sort(), async d => {
    const [s, prep] = await Promise.all([json(join(root, d, "spec.json")), json(join(root, d, "prepare.json"))]); if (!s) return null;
    const stats = i.stats.get(s.spec_id);
    return { spec_id: String(s.spec_id), spec_version: Number(s.spec_version ?? 0), title: String(s.title ?? ""), domain: String(s.domain ?? ""), created: String(s.created ?? ""), units: Array.isArray(s.vu) ? s.vu.length : 0, verdict: String(prep?.verdict ?? ""), rounds: Number(prep?.rounds ?? 0), material: String(prep?.material_id ?? ""), runs: stats?.runs || 0, last_overall: stats?.last?.overall || "", last_run: stats?.last?.run_id || "" } satisfies SpecRow;
  })).filter((r): r is SpecRow => r !== null);
}
