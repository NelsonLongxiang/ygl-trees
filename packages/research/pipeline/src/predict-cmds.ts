import type { Env } from "../../../core/database/src/types";
import { out, head, table, paint, C, bad } from "../../../core/text/src/fmt";
import { parsePrediction, auditPredictions, loadStateSource } from "./predict";
import { predictionScore, summarizePredictions } from "./predict-score";

/** Prediction projections are read-only; audit never arbitrates. */
export async function run(env: Env, project: any, args: any, action: string): Promise<number> {
  const { ctx, store } = env, flags = args.flags;
  const allowed = action === "list" ? ["all", "due"] : action === "score" ? ["all", "channel"] : action === "audit" ? ["all", "due", "offline", "state"] : null;
  if (!allowed) {
    bad(ctx, "usage: research predict list [--all] [--due] · research predict score [--all] [--channel <c>] · research predict audit [--offline] [--state <file|url>] [--all] [--due]");
    return 2;
  }
  const global = ["json", "color", "no-color", "quiet", "home", "db", "project", "p", "global", "force", "verbose"];
  const unknown = Object.keys(flags).filter(k => !allowed.includes(k) && !global.includes(k));
  if (unknown.length) {
    bad(ctx, "unknown flag" + (unknown.length > 1 ? "s" : "") + " for research predict " + action + ": " + unknown.map(k => "--" + k).join(" "));
    return 2;
  }
  if (action === "score" && flags.channel !== undefined && (typeof flags.channel !== "string" || !flags.channel.trim())) {
    bad(ctx, "--channel requires a nonempty channel name"); return 2;
  }
  const workspace = flags.all === true && action !== "audit";
  const claims = store.db.all(
    "SELECT id,text,status,confidence,created,channel FROM claims WHERE " + (workspace ? "" : "project_id=? AND ") + "text LIKE '[预测·%' ORDER BY created",
    workspace ? [] : [project.id]
  ) as any[];
  const empty = () => { if (ctx.json) console.log("[]"); else out(ctx, paint(C.dim, "  no [预测·…] claims in this project", ctx.color)); return 0; };
  if (!claims.length && action !== "score") return empty();
  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = (deadline: string) => /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? Math.floor((Date.parse(deadline + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000) : null;

  if (action === "audit") {
    const state = flags.state ? await loadStateSource(String(flags.state)) : null;
    if (flags.state && !state && !ctx.json) out(ctx, paint(C.yellow, "  ⚠ " + "--state " + flags.state + " 加载失败（文件/URL 不可读或非 JSON）——相关判据回落 manual", ctx.color));
    const rows = (await auditPredictions({ claims, db: store.db, npmProbe: flags.offline !== true, state })).map(r => {
      const days_left = daysLeft(r.deadline);
      return { ...r, bucket: days_left === null ? "future" : days_left <= 0 ? "due" : days_left <= 30 ? "near" : "future", days_left };
    });
    const count = (key: string, value: string) => rows.filter(r => (r as any)[key] === value).length;
    const resolved = count("verdict", "resolved");
    const visible = flags.due ? rows.filter(r => r.bucket === "due") : flags.all ? rows : rows.filter(r => r.verdict !== "resolved");
    if (ctx.json) { console.log(JSON.stringify(flags.due ? visible : rows, null, 2)); return 0; }
    if (!visible.length) { out(ctx, paint(C.dim, "  全部 " + rows.length + " 条预测已结案（resolved）——--all 查看终态表", ctx.color)); return 0; }
    head(ctx, "prediction audit — " + project.name + " (" + visible.length + "/" + rows.length + " · due " + count("bucket", "due") + " / near " + count("bucket", "near") + " / future " + count("bucket", "future") + (resolved && !flags.all && !flags.due ? " · " + resolved + " resolved 隐藏 (--all)" : "") + ")");
    table(ctx, visible, ["claim", "horizon", "deadline", "判据", "实测", "判定", "days"], ["claim_id", "horizon", "deadline", "criterion", "actual", "verdict", "days_left"]);
    for (const r of visible) {
      if (r.verdict === "hit" || r.verdict === "miss") out(ctx, paint(C.dim, "  → research claim resolve " + r.claim_id + " --as " + (r.verdict === "hit" ? "supported" : "refuted") + "   # " + r.deadline + " 已到", ctx.color));
    }
    for (const r of visible) if (r.verdict === "manual") out(ctx, paint(C.dim, "  · " + r.claim_id + ": " + r.hint, ctx.color));
    return 0;
  }

  const settled = new Map<string, { brier: string; settler: string }>();
  if (claims.length) for (const r of store.db.all("SELECT ce.claim_id,e.note,e.created FROM claim_evidence ce JOIN evidence e ON e.id=ce.evidence_id ORDER BY e.created")) {
    const m = /outcome=(1|0), brier=([\d.]+), settler=([^\s]+)\s*$/.exec(r.note || "");
    if (m) settled.set(r.claim_id, { brier: m[2], settler: m[3] });
  }
  let rows = claims.map(c => {
    const { horizon, deadline } = parsePrediction(c.text, c.created), note = settled.get(c.id);
    const outcome = c.status === "supported" ? "1" : c.status === "refuted" ? "0" : c.status === "contested" ? "ND" : "未结算";
    const days_left = daysLeft(deadline), brier = note?.brier ?? null;
    return { claim_id: c.id, text: c.text, horizon, deadline, status: c.status, outcome, brier, settler: note?.settler ?? null, channel: c.channel || "", created: c.created, due: days_left !== null && days_left <= 0, days_left, ...predictionScore(c.confidence, outcome, brier) };
  });
  if (action === "score") {
    if (flags.channel !== undefined) rows = rows.filter(r => r.channel === flags.channel);
    const summary = summarizePredictions(rows);
    if (!ctx.json) head(ctx, "prediction scores — " + (workspace ? "workspace" : project.name));
    table(ctx, summary);
    return 0;
  }
  const dueOnly = flags.due === true;
  if (dueOnly) rows = rows.filter(r => r.due);
  if (ctx.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  const visible = flags.all ? rows : rows.filter(r => r.outcome === "未结算");
  head(ctx, "predict list — " + (workspace ? "workspace" : project.name) + " (" + visible.length + "/" + rows.length + (dueOnly ? " · due" : rows.length !== visible.length ? " · 已结案隐藏 (--all)" : "") + ")");
  table(ctx, visible.map(r => ({ ...r, score_check: r.brier_mismatch ? "≠" : "" })), ["claim", "deadline", "days", "outcome", "p", "brier", "brier_calc", "check", "settler", "channel"], ["claim_id", "deadline", "days_left", "outcome", "p", "brier", "brier_calc", "score_check", "settler", "channel"]);
  const noChannel = rows.filter(r => r.outcome === "未结算" && !r.channel).length;
  if (noChannel) out(ctx, paint(C.yellow, "  ⚠ " + noChannel + " 条未结算预测未登记 channel（claim add --channel github-issues|review-rounds|…）——结算时可能通道错配", ctx.color));
  return 0;
}
