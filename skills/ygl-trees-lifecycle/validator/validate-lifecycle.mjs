#!/usr/bin/env node
// ygl-trees lifecycle 验证器（ygl-trees-lifecycle 技能的机检面）
// 把技能 §1/§2 触发表、§3 节奏纪律、§5 反模式编码为可执行检查。
// 快照隔离读检（#65，1.2.0）：默认先把 YGL_HOME 整体复制到抛弃式临时目录，所有 CLI 调用
// （含 node validate 的闭包索引重建与 cmd.run 事件）只写副本——被检工作区零写入。
// --no-snapshot 显式退回直检模式（会向被检工作区写 cmd.run 事件，仅诊断用）。
// 数据全部经官方 CLI --json 读取，不直接开 SQLite。会话隔离：子进程固定 YGL_SESSION=lcv-validator。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "1.2.0";
const TOOL = "ygl-trees-lifecycle-validator";

// ---------- 规则表（findings 的语义全部指向技能章节） ----------
const RULES = {
  L1: { sev: "error", title: "解锁无依据", anti: "§5-1 心内解锁 / §3 铁律3",
        fix: "rel add node:<key> evidence:<id> --rel evidenced-by（同轮补挂）" },
  L2: { sev: "warn",  title: "裸节点", anti: "§5-2 裸节点（无任何 rel）",
        fix: "补证据后 rel add node:<key> evidence:<id> --rel evidenced-by；确认是假设就先不要 unlock" },
  L3: { sev: "warn",  title: "资产不挂树", anti: "§5-6 研究资产不挂树（两条流水线漂移）",
        fix: "rel add node:<key> <type>:<id> --rel evidenced-by|decided-by|tracked-by" },
  L4: { sev: "warn",  title: "裸断言", anti: "§5-2 姊妹形态：断言 0 证据链",
        fix: "research claim link <cid> <eid> --stance supports|refutes" },
  L5: { sev: "warn",  title: "状态在正文里", anti: "§5-5 状态写进正文，机器读不到",
        fix: "机器状态落库：node unlock / claim resolve --as supported|refuted|contested" },
  L6: { sev: "error", title: "脏索引", anti: "§5-3 结构改了不重建（can/ready 按旧闭包回答）",
        fix: "node index && node validate（本工具第一时间读 tree list 捕获，读命令可能自愈）" },
  L7: { sev: "error", title: "结构破损", anti: "§5-3（环/悬空边）",
        fix: "按 node validate 的 issues 修：先加新边再删旧边，两次索引之间不跨会话" },
  L8: { sev: "info",  title: "行动项未闭环", anti: "§3 收口纪律（task todo/doing 未 done）",
        fix: "task done <id>；不打算做的就承认并关掉，别挂着装收口" },
  L9: { sev: "info",  title: "判断待仲裁", anti: "§2 判断稳定下来必 resolve（人工仲裁）",
        fix: "research claim resolve <cid> --as supported|refuted|contested" },
  L10: { sev: "warn", title: "doctor 告警", anti: "§3 收口前必 doctor，有脏按提示修",
        fix: "按 doctor detail 处理；安全修复可试 doctor --fix" },
};

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let opt = { home: process.env.YGL_HOME || path.join(os.homedir(), ".ygl-trees"),
            cli: process.env.YGL_CLI || "ygl-trees", json: false, strict: false, quiet: false, rules: null, noSnapshot: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--home") opt.home = argv[++i];
  else if (a === "--cli") opt.cli = argv[++i];
  else if (a === "--json") opt.json = true;
  else if (a === "--strict") opt.strict = true;
  else if (a === "--quiet") opt.quiet = true;
  else if (a === "--no-snapshot") opt.noSnapshot = true;
  else if (a === "--rule") {
    const parts = (argv[++i] || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    opt.rules = new Set([...(opt.rules || []), ...parts]);
  } else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
  else { console.error("usage error: unknown arg " + a); process.exit(2); }
}
function usage() {
  console.log(TOOL + " " + VERSION + " — ygl-trees lifecycle 纪律巡检（快照隔离读检）");
  console.log("用法: node validate-lifecycle.mjs [--home <dir>] [--cli <cmd>] [--json] [--strict] [--rule L1,L2,...] [--quiet] [--no-snapshot]");
  console.log("退出码: 0 干净（--strict 时允许 info）· 1 有 error/warn 发现（--strict 时含 info）· 2 无法执行检查");
  console.log("规则: " + Object.keys(RULES).map(k => k + "=" + RULES[k].title).join(" · "));
}

// ---------- CLI 桥（shell:true 以兼容 Windows .cmd shim；参数全部是本工具构造的固定 token） ----------
function ygl(args, env) {
  const r = spawnSync(opt.cli + " " + args.join(" "),
    { shell: true, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, YGL_HOME: opt.home, YGL_SESSION: "lcv-validator", ...(env || {}) } });
  const out = (r.stdout || "").trim();
  let parsed = null, parseable = false;
  try { parsed = JSON.parse(out); parseable = true; } catch { /* 非干净 JSON（欢迎语/空库提示） */ }
  return { rc: r.status, parsed, parseable, raw: out, err: (r.stderr || "").trim() };
}

const findings = [];
const instrumentErrors = [];
const counts = { trees: 0, nodes: 0, edges: 0, claims: 0, evidence: 0, kb: 0, tasks: 0, relations: 0 };
function add(rule, target, detail, extra) {
  if (opt.rules && !opt.rules.has(rule)) return;
  const R = RULES[rule];
  findings.push({ rule, severity: R.sev, title: R.title, anti_pattern: R.anti,
                  target, detail, fix: R.fix, ...(extra || {}) });
}

// ---------- 采集（顺序是契约：tree list 必须第一条，脏索引信号会被后续读自愈） ----------
if (!fs.existsSync(opt.home)) {
  console.error("instrument error: YGL_HOME 不存在: " + opt.home + "（先 ygl-trees db init）");
  process.exit(2);
}

// #65 快照隔离：复制整个 home（db/-wal/-shm/config），后续全部读写指向副本；退出时清理。
if (!opt.noSnapshot) {
  // #65 residual: Windows may hold the just-closed DB files for a moment;
  // rmSync needs the same bounded retries the repo uses elsewhere. Also sweep
  // stale lcv-snap-* dirs older than 24h from crashed runs.
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith("lcv-snap-")) continue;
      const p = path.join(os.tmpdir(), name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  } catch { /* best effort */ }
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), "lcv-snap-"));
  try {
    fs.cpSync(opt.home, snap, { recursive: true, force: true });
  } catch (e) {
    console.error("instrument error: 快照复制失败（可用 --no-snapshot 直检，但会写 cmd.run 事件）: " + e.message);
    process.exit(2);
  }
  opt.home = snap;
  const cleanup = () => { try { fs.rmSync(snap, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {} };
  process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); }); process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

let trees;
{
  const g = ygl(["tree", "list", "--json"]);
  if (!g.parseable || !Array.isArray(g.parsed)) {
    if (/no database yet/i.test(g.raw)) {
      console.error("instrument error: 工作区尚未初始化（先 ygl-trees db init）: " + opt.home);
    } else {
      const msg = (g.parseable && g.parsed && g.parsed.error) ? g.parsed.error
        : ((g.raw || g.err).split("\n")[0]).slice(0, 200);
      console.error("instrument error: tree list 不可用: " + msg);
    }
    process.exit(2);
  }
  trees = g.parsed;
}
counts.trees = trees.length;
const staleReported = new Set();
for (const t of trees) {
  if (Number(t.dirty) > 0) {
    add("L6", "tree:" + t.name,
      "tree list 报 dirty=" + t.dirty + "（" + t.nodes + " 节点/" + t.edges + " 边），闭包索引过期");
    staleReported.add(t.name);
  }
}

// 每棵树：node list（状态）/ node export（payload+index）/ node validate（结构）
const nodesByKey = {}; // key -> {tree, state, payload, tier}
for (const t of trees) {
  const env = { YGL_TREE: t.name };
  const nl = ygl(["node", "list", "--json"], env);
  if (nl.parseable && Array.isArray(nl.parsed)) {
    counts.nodes += nl.parsed.length;
    for (const n of nl.parsed) nodesByKey[t.name + "/" + n.key] = { tree: t.name, ...n };
  } else instrumentErrors.push({ op: "node list", tree: t.name, raw: nl.raw.slice(0, 200) });

  const ne = ygl(["node", "export"], env);
  if (ne.parseable && ne.parsed && Array.isArray(ne.parsed.nodes)) {
    counts.edges += (ne.parsed.edges || []).length;
    for (const n of ne.parsed.nodes) {
      const slot = nodesByKey[t.name + "/" + n.key];
      if (slot) slot.payload = n.payload || "";
      if (ne.parsed.index && ne.parsed.index.dirty === true && !staleReported.has(t.name)) {
        add("L6", "tree:" + t.name, "node export 报 index.dirty=true（tree list 未及捕获，后续读已自愈一部分信号）");
        staleReported.add(t.name);
        break; // 每树报一次即可
      }
    }
  }
  const nv = ygl(["node", "validate", "--json"], env);
  if (nv.parseable && nv.parsed && Array.isArray(nv.parsed.issues)) {
    for (const iss of nv.parsed.issues) add("L7", "tree:" + t.name, typeof iss === "string" ? iss : JSON.stringify(iss));
  }
}

// 关联织物 + 研究资产 + 任务（全工作区，不分树）
let rels = [];
{
  const g = ygl(["rel", "list", "--json"]);
  if (g.parseable && Array.isArray(g.parsed)) { rels = g.parsed; counts.relations = rels.length; }
}
function relRefId(ref) { const i = ref.indexOf(":"); return i < 0 ? null : { type: ref.slice(0, i), id: ref.slice(i + 1) }; }
const ASSET = new Set(["evidence", "claim", "kb"]);

const relByNode = new Map();   // nodeId -> {asset:bool, any:bool}
const relAnyAsset = new Set(); // asset ids referenced anywhere (src or dst)
for (const r of rels) {
  const s = relRefId(r.src || ""), d = relRefId(r.dst || "");
  if (!s || !d) continue;
  if (s.type === "node") {
    const e = relByNode.get(s.id) || { asset: false, any: false };
    e.any = true; if (ASSET.has(d.type)) e.asset = true; relByNode.set(s.id, e);
  }
  if (d.type === "node") {
    const e = relByNode.get(d.id) || { asset: false, any: false };
    e.any = true; if (ASSET.has(s.type)) e.asset = true; relByNode.set(d.id, e);
  }
  if (ASSET.has(d.type)) relAnyAsset.add(d.id);
  if (ASSET.has(s.type)) relAnyAsset.add(s.id);
}

// node 内部 id -> "tree/key" 全量映射：快路径用两条 SELECT-only 的 db sql 一次拿全
// （大工作区上逐节点 node show 是 N 次 CLI 启动，会拖垮巡检）；快路径失灵再回退慢路径。
const shown = new Map(); // nodeId -> treeKey
{
  const gN = ygl(["db", "sql", '"SELECT id, key, tree_id FROM nodes"', "--json"]);
  const gT = ygl(["db", "sql", '"SELECT id, name FROM trees"', "--json"]);
  if (gN.parseable && Array.isArray(gN.parsed) && gT.parseable && Array.isArray(gT.parsed)) {
    const treeName = new Map(gT.parsed.map(t => [t.id, t.name]));
    for (const row of gN.parsed) {
      const tn = treeName.get(row.tree_id);
      if (tn && nodesByKey[tn + "/" + row.key]) shown.set(row.id, tn + "/" + row.key);
    }
  } else {
    const touched = new Set([...relByNode.keys()]);
    for (const [treeKey, n] of Object.entries(nodesByKey)) {
      if (!touched.size) break;
      const g = ygl(["node", "show", n.key, "--json"], { YGL_TREE: n.tree });
      if (g.parseable && g.parsed && g.parsed.node && g.parsed.node.id && touched.has(g.parsed.node.id)) {
        shown.set(g.parsed.node.id, treeKey);
        touched.delete(g.parsed.node.id);
      }
    }
  }
}

// L1/L2/L5（全节点扫描）。rel 触达集合经 node show 反查只覆盖 rel 端点；
// 其余节点不在任何 rel 里，本身就是 L2 的检出对象——绝不能只扫 rel 触达节点。
const assetRel = new Set(), anyRel = new Set(); // treeKey 集合
for (const [nodeId, treeKey] of shown) {
  const e = relByNode.get(nodeId) || { asset: false, any: false };
  if (e.any) anyRel.add(treeKey);
  if (e.asset) assetRel.add(treeKey);
}
for (const [treeKey, n] of Object.entries(nodesByKey)) {
  if (n.state === "unlocked" && !assetRel.has(treeKey)) add("L1", "node:" + treeKey,
    "state=unlocked（" + (n.unlocked_at || "?") + "）但没有任何 evidence/claim/kb 依据挂在该节点上");
  if (!anyRel.has(treeKey)) add("L2", "node:" + treeKey,
    "节点存在但 0 条 rel（裸节点" + (Number(n.children) > 0 ? "；有 " + n.children + " 个子节点，结构位不豁免挂证据" : "") + "）");
  if (n.payload && /(?<![未没不待否])(已完成|已验证|已解锁|已上线|已发布|already done|shipped)/i.test(n.payload)
      && n.state !== "unlocked") {
    add("L5", "node:" + treeKey, "payload 含完成性表述但 state=" + n.state + "：" + JSON.stringify(n.payload.slice(0, 60)));
  }
}

// 研究资产与任务：claim/evidence/task 是项目作用域（未选项目时 fail-closed），
// 所以按 project list 遍历 + YGL_PROJECT 环境导向；kb 是工作区全局，读一次。
const claimsById = new Map(), evidenceById = new Map(), tasksById = new Map();
{
  const g = ygl(["project", "list", "--json"]);
  const projects = (g.parseable && Array.isArray(g.parsed)) ? g.parsed.map(x => x.name) : [];
  const scopes = projects.length ? projects : [null]; // 无项目信息时按旧样兜底读一次
  for (const pn of scopes) {
    const env = pn ? { YGL_PROJECT: pn } : {};
    const pull = (args, store) => {
      const r2 = ygl(args, env);
      if (r2.parseable && Array.isArray(r2.parsed)) for (const row of r2.parsed) store.set(row.id, row);
    };
    pull(["research", "claim", "list", "--json"], claimsById);
    pull(["research", "evidence", "list", "--json"], evidenceById);
    pull(["task", "list", "--json"], tasksById);
  }
}
let claims = [...claimsById.values()], evidence = [...evidenceById.values()], kbs = [];
counts.claims = claims.length; counts.evidence = evidence.length;
{
  const k = ygl(["kb", "list", "--json"]);
  if (k.parseable && Array.isArray(k.parsed)) { kbs = k.parsed; counts.kb = kbs.length; }
}
for (const c of claims) {
  if (!relAnyAsset.has(c.id)) add("L3", "claim:" + c.id, "断言未被任何节点挂接（decided-by 缺失）：" + JSON.stringify((c.text || "").slice(0, 60)));
  if ((Number(c.sup) || 0) + (Number(c.ref) || 0) === 0) add("L4", "claim:" + c.id, "断言 0 证据链（sup=ref=0）：" + JSON.stringify((c.text || "").slice(0, 60)));
  else if (c.status === "unverified") add("L9", "claim:" + c.id, "证据已够（sup=" + c.sup + " ref=" + c.ref + "）但未人工仲裁");
  if (c.status !== "supported" && /(?<![未没不待否])(已完成|已验证|已证明)/i.test(c.text || "")) {
    add("L5", "claim:" + c.id, "正文含已验证表述但 status=" + c.status);
  }
}
for (const ev of evidence) {
  if (!relAnyAsset.has(ev.id) && (Number(ev.used_by) || 0) === 0) add("L3", "evidence:" + ev.id,
    "证据未被 claim 引用也未被节点挂接：" + JSON.stringify((ev.quote || "").slice(0, 60)));
  else if (!relAnyAsset.has(ev.id)) add("L3", "evidence:" + ev.id, "证据被 claim 引用但没有任何节点挂接它");
}
for (const k of kbs) {
  if (!relAnyAsset.has(k.id)) add("L3", "kb:" + k.id, "知识笔记未挂任何节点（复用无从谈起）：" + JSON.stringify((k.title || "").slice(0, 60)));
}

// 任务（已随项目遍历取回）
counts.tasks = tasksById.size;
for (const t of tasksById.values()) {
  if (t.status === "todo" || t.status === "doing") add("L8", "task:" + t.id, "status=" + t.status + "：" + JSON.stringify((t.title || "").slice(0, 50)));
}

// doctor 收口（放最后：读命令可能自愈部分状态，我们的 L6 信号早已落袋）
{
  const g = ygl(["doctor", "--json"]);
  if (g.parseable && Array.isArray(g.parsed)) {
    for (const c of g.parsed) {
      if (c.status === "warn") add("L10", "doctor:" + c.name, c.detail || "", { doctor_status: "warn" });
      else if (c.status === "fail") { findings.push({ rule: "L10", severity: "error", title: RULES.L10.title + "（fail）", anti_pattern: RULES.L10.anti, target: "doctor:" + c.name, detail: c.detail || "", fix: RULES.L10.fix, doctor_status: "fail" }); }
    }
  } else instrumentErrors.push({ op: "doctor", raw: g.raw.slice(0, 200) });
}

// ---------- 输出 ----------
const RANK = { error: 2, warn: 1, info: 0 };
const summary = { errors: 0, warnings: 0, infos: 0, by_rule: {}, scope: counts, instrument_errors: instrumentErrors.length };
for (const f of findings) {
  summary.by_rule[f.rule] = (summary.by_rule[f.rule] || 0) + 1;
  if (f.severity === "error") summary.errors++;
  else if (f.severity === "warn") summary.warnings++;
  else summary.infos++;
}
findings.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.rule.localeCompare(b.rule));

const failing = summary.errors + summary.warnings > 0 || (opt.strict && summary.infos > 0);
// 整体失联（CLI 缺失/未初始化）已在 preflight exit(2)；零星单命令失败降级为 instrument_errors 记录在案。
const rc = failing ? 1 : 0;

if (opt.json) {
  console.log(JSON.stringify({ tool: TOOL, version: VERSION, workspace: opt.home,
    generated_at: new Date().toISOString(), ok: !failing, summary, findings }, null, 2));
} else {
  if (!opt.quiet) {
    console.log(TOOL + " " + VERSION + " — 工作区 " + opt.home);
    console.log("范围: 树 " + counts.trees + " · 节点 " + counts.nodes + " · 边 " + counts.edges + " · rel " + counts.relations
      + " · claim " + counts.claims + " · evidence " + counts.evidence + " · kb " + counts.kb + " · task " + counts.tasks);
    if (instrumentErrors.length) console.log("采集告警: " + instrumentErrors.length + " 条单命令失败（见 --json .summary.instrument_errors）");
    console.log("");
    if (!findings.length) console.log("✓ 未发现 lifecycle 漂移（干净）");
    for (const f of findings) {
      console.log("[" + f.severity.toUpperCase() + "] " + f.rule + " " + f.title + " — " + f.target);
      console.log("    反模式: " + f.anti_pattern);
      console.log("    事实: " + f.detail);
      console.log("    修法: " + f.fix);
    }
  }
  console.log("RESULT: errors=" + summary.errors + " warnings=" + summary.warnings + " infos=" + summary.infos + " -> rc=" + rc);
}
process.exit(rc);