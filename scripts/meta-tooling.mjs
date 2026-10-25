#!/usr/bin/env node
/**
 * verify/meta.json `tooling[]` 登记维护（charter §4.4 R3 登记制，meta_index_version 2）。
 *
 *   node scripts/meta-tooling.mjs --check    # 只比对：任一条目 sha 漂移或文件缺失 → rc=1（contract-audit / 评审用）
 *   node scripts/meta-tooling.mjs --reregister <path> --reason "<why>"   # 显式重登记一条（必须已漂移）
 *   node scripts/meta-tooling.mjs --add <path> --role <build|test|release|gate>   # 追加一条登记（path 仓内相对）
 *
 * 纪律（GLM Q3，r32）：
 * - **禁 auto-rehash**：没有隐式刷新路径；重登记必须逐条显式 `--reregister` 且带 reason。
 * - 每次重登记把一条审计记录追加进 `verify/meta.json` 的 **`reregistrations[]`**（append-only，
 *   随仓库走）：{path, old_sha256, new_sha256, reason, at}——clone/评审者能看到「为什么重登记」，
 *   不是把 red 改成 green；本地 DB 事件不随 commit 走，故不再作为唯一账本（#37）。
 * - 只维护登记，不产出也不汇总任何验证判定（tooling 的定义）；`verify meta .` 才是判定。
 * - **--audit**（#37 执法半）：打印完整重登记审计链 + **链完整性校验**——每条 old_sha256 必须
 *   匹配前一条 new_sha256（首条匹配 tooling[].sha256 注册时值），断链 → rc=1。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.YGL_META_ROOT ? resolve(process.env.YGL_META_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "verify", "meta.json");
const ROLES = ["build", "test", "release", "gate"];
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const KNOWN = ["--check", "--add", "--role", "--reregister", "--reason", "--audit", "--actor", "--against-git"];
for (const a of args) {
  if (a.startsWith("--") && !KNOWN.includes(a)) {
    console.error(`meta-tooling: unknown flag ${a}`);
    process.exit(2);
  }
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const index = JSON.parse(readFileSync(INDEX, "utf8"));
if (index.meta_index_version !== 2 && index.meta_index_version !== 3) {
  console.error(`meta-tooling: verify/meta.json is meta_index_version ${index.meta_index_version}; tooling[] belongs to version 2+`);
  process.exit(2);
}
index.tooling ??= [];

const add = flag("add");

function atomicWriteIndex(next) {
  const tmp = INDEX + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + String.fromCharCode(10), "utf8");
  renameSync(tmp, INDEX);
}

const reregister = flag("reregister");
if (reregister) {
  const rel = reregister.split("\\").join("/");
  const entry = index.tooling.find((t) => t.path === rel);
  if (!entry) {
    console.error(`meta-tooling: --reregister ${rel} is not registered (use --add for a new file)`);
    process.exit(2);
  }
  const reason = flag("reason");
  if (!reason || !reason.trim()) {
    console.error("meta-tooling: --reregister needs --reason \"<why did the bytes change>\" (GLM Q3: no silent rehash)");
    process.exit(2);
  }
  // #37 执法项④：actor 必需——显式 --actor 或从 git config 取（留痕谁做的重登记）。
  let actor = flag("actor");
  if (!actor) {
    try {
      const { execFileSync } = require("node:child_process");
      actor = String(execFileSync("git", ["config", "user.name"], { encoding: "utf8" })).trim();
    } catch { /* no git */ }
  }
  if (!actor) {
    console.error("meta-tooling: --reregister needs --actor \"<who>\" (or a git user.name) — #37 enforcement item 4");
    process.exit(2);
  }
  const full = join(ROOT, entry.path);
  if (!existsSync(full)) {
    console.error(`meta-tooling: registered file is missing: ${entry.path}`);
    process.exit(1);
  }
  const got = sha256(full);
  if (got === entry.sha256) {
    console.error(`meta-tooling: ${entry.path} has no drift (sha unchanged) — nothing to re-register`);
    process.exit(2);
  }
  const old = entry.sha256;
  // #37: the audit record lives IN the repo index (reregistrations[]) so it
  // travels with the commit; one atomic write keeps old/new/reason consistent.
  index.reregistrations ??= [];
  index.reregistrations.push({
    path: entry.path,
    old_sha256: old,
    new_sha256: got,
    reason: reason.trim(),
    actor,
    at: new Date().toISOString(),
  });
  entry.sha256 = got;
  atomicWriteIndex(index);
  console.log(`meta-tooling: re-registered ${entry.path} ${old.slice(0, 8)} -> ${got.slice(0, 8)} (reregistrations[] recorded)`);
  process.exit(0);
}

if (args.includes("--audit")) {
  // #37 enforcement half: print the full reregistration audit trail + chain
  // integrity check. Each entry's old_sha256 must match the previous
  // new_sha256 for that path (or the tooling[] registered sha for the first
  // entry) — a broken chain means someone edited meta.json by hand.
  const rr = index.reregistrations ?? [];
  if (!rr.length) {
    console.log("meta-tooling --audit: no reregistrations (clean history)");
    process.exit(0);
  }
  console.log(`meta-tooling --audit: ${rr.length} reregistration(s), chain check:`);
  // Build per-path expected sha chains from tooling[]
  const currentSha = new Map(index.tooling.map((t) => [t.path, t.sha256]));
  // Reconstruct: walk backward from current sha via reregistrations
  const chainOk = [];
  for (const r of rr) {
    const entry = index.tooling.find((t) => t.path === r.path);
    if (!entry) { chainOk.push({ r, ok: false, problem: "path not in tooling[]" }); continue; }
    // For the LAST reregistration of a path, new_sha256 must == current tooling sha
    // For non-last, old must chain to next entry's new (checked below via reverse walk)
  }
  // Reverse walk: last entry per path → current sha; earlier → next new
  const lastPerPath = new Map();
  for (let i = rr.length - 1; i >= 0; i--) {
    const p = rr[i].path;
    if (!lastPerPath.has(p)) lastPerPath.set(p, i);
  }
  let broken = 0;
  for (let i = 0; i < rr.length; i++) {
    const r = rr[i];
    const isLast = lastPerPath.get(r.path) === i;
    let expectedOld = null;
    if (isLast) {
      expectedOld = currentSha.get(r.path); // current tooling sha (after this reregister)
      if (expectedOld !== r.new_sha256) { broken++; console.error(`  ✗ chain: ${r.path} last new ${r.new_sha256.slice(0, 8)} ≠ current tooling ${String(expectedOld || "?").slice(0, 8)}`); }
    }
    // Find the NEXT reregistration for this path to check old→new chaining
    for (let j = i + 1; j < rr.length; j++) {
      if (rr[j].path === r.path) {
        if (rr[j].old_sha256 !== r.new_sha256) { broken++; console.error(`  ✗ chain: ${r.path} entry ${i} new ${r.new_sha256.slice(0, 8)} → entry ${j} old ${rr[j].old_sha256.slice(0, 8)} (gap)`); }
        break;
      }
    }
    console.log(`  ${r.at.slice(0, 10)} ${r.path} ${r.old_sha256.slice(0, 8)}→${r.new_sha256.slice(0, 8)} "${r.reason.slice(0, 60)}"`);
  }
  if (broken) {
    console.error(`meta-tooling --audit: ${broken} chain break(s) — meta.json was hand-edited or reregistrations were removed`);
    process.exit(1);
  }

  // #37 执法项③：at 方向校验——未来时间戳（> 现在 + 1h）拒绝。
  let tsBad = 0;
  const now = Date.now();
  for (const r of rr) {
    const t = Date.parse(String(r.at ?? ""));
    if (!Number.isFinite(t)) { tsBad++; console.error(`  ✗ at unparseable: ${r.path} at=${r.at}`); continue; }
    if (t > now + 60 * 60 * 1000) { tsBad++; console.error(`  ✗ future timestamp: ${r.path} at=${r.at} (now=${new Date(now).toISOString()})`); }
  }
  if (tsBad) {
    console.error(`meta-tooling --audit: ${tsBad} timestamp violation(s) — future/at values are not evidence (#37 item 3)`);
    process.exit(1);
  }

  // #37 执法项④：actor 缺失（历史遗留项允许旧记录，但新记录必须带 —— 报告可见）。
  const noActor = rr.filter((r) => !r.actor || !String(r.actor).trim());
  if (noActor.length) {
    console.log(`  · actor missing on ${noActor.length}/${rr.length} legacy entr(ies) — new reregistrations must carry actor (#37 item 4)`);
  }

  // #37 执法项⑤：链首锚定——每个 path 的第一条 old_sha256 必须能在 git 历史中找到
  // （该文件的某个历史 blob sha），否则是孤儿值（首条删除隐形/凭空构造）。
  // 需要 --against-git 显式开启（git 历史对账较重，且要 clone 完整历史）。
  if (args.includes("--against-git")) {
    let gitBad = 0;
    const paths = [...new Set(rr.map((r) => r.path))];
    for (const path of paths) {
      const firstIdx = rr.findIndex((r) => r.path === path);
      const first = rr[firstIdx];
      const shas = new Set();
      try {
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("git", ["log", "--all", "--format=%H", "--", path], { cwd: ROOT, encoding: "utf8" });
        for (const commit of out.split(String.fromCharCode(10)).filter(Boolean)) {
          const blob = execFileSync("git", ["show", `${commit}:${path}`], { cwd: ROOT, encoding: "buffer" });
          shas.add(createHash("sha256").update(blob).digest("hex"));
        }
      } catch { /* not a git repo / path never tracked */ }
      if (shas.size && !shas.has(first.old_sha256)) {
        gitBad++;
        console.error(`  ✗ chain first anchor: ${path} first old_sha256 ${first.old_sha256.slice(0, 8)} not in git history (orphan value — first entry may have been deleted, #37 item 5)`);
      }
    }
    if (gitBad) {
      console.error(`meta-tooling --audit --against-git: ${gitBad} orphan chain first item(s)`);
      process.exit(1);
    }

    // #37 执法项①②：静默重哈希 / 仅追加——git 侧对账。
    // 对每个已登记 tooling 文件，取 git 历史中每个提交的 blob sha 序列；
    // 若相邻两次变更不在 reregistrations[] 的 old→new 对里，说明有改文件+对齐 sha 而没登记。
    let silentBad = 0;
    for (const t of index.tooling) {
      let commits;
      try {
        const { execFileSync } = require("node:child_process");
        commits = execFileSync("git", ["log", "--all", "--reverse", "--format=%H", "--", t.path], { cwd: ROOT, encoding: "utf8" })
          .split(String.fromCharCode(10)).filter(Boolean);
      } catch { continue; }
      const chain = [];
      for (const commit of commits) {
        try {
          const { execFileSync } = require("node:child_process");
          const blob = execFileSync("git", ["show", `${commit}:${t.path}`], { cwd: ROOT, encoding: "buffer" });
          chain.push(createHash("sha256").update(blob).digest("hex"));
        } catch { /* file absent at this commit */ }
      }
      // 同一 sha 连续出现合并为一次变更
      const transitions = [];
      for (let i = 1; i < chain.length; i++) if (chain[i] !== chain[i - 1]) transitions.push([chain[i - 1], chain[i]]);
      const recorded = new Set(rr.filter((r) => r.path === t.path).map((r) => r.old_sha256 + "->" + r.new_sha256));
      for (const [from, to] of transitions) {
        if (!recorded.has(from + "->" + to)) {
          silentBad++;
          console.error(`  ✗ silent rehash: ${t.path} ${from.slice(0, 8)}→${to.slice(0, 8)} appears in git history but has no reregistrations[] entry (#37 item 1)`);
        }
      }
    }
    if (silentBad) {
      console.error(`meta-tooling --audit --against-git: ${silentBad} unrecorded byte transition(s)`);
      process.exit(1);
    }
  }

  console.log(`meta-tooling --audit: chain OK (${rr.length} entries, 0 breaks, 0 future timestamps${args.includes("--against-git") ? ", git-consistent" : ""})`);
  process.exit(0);
}

if (!args.includes("--check") && !add) {
  console.error("meta-tooling: nothing to do — use --check, --reregister <path> --reason <why>, or --add <path> --role <role>");
  process.exit(2);
}

let drift = 0;
for (const t of index.tooling) {
  const full = join(ROOT, t.path);
  if (!existsSync(full)) {
    console.error(`  ✗ missing: ${t.path}`);
    drift++;
    continue;
  }
  const got = sha256(full);
  if (got !== t.sha256) {
    drift++;
    console.error(`  ✗ drift: ${t.path} (registered ${t.sha256.slice(0, 8)}, on disk ${got.slice(0, 8)})`);
  }
}
index.tooling.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

if (add) {
  const role = flag("role");
  const rel = add.split("\\").join("/");
  if (!ROLES.includes(role)) {
    console.error(`meta-tooling: --add needs --role ${ROLES.join("|")}`);
    process.exit(2);
  }
  if (!existsSync(join(ROOT, rel))) {
    console.error(`meta-tooling: --add path must exist: ${rel}`);
    process.exit(2);
  }
  const entry = index.tooling.find((t) => t.path === rel);
  if (entry) {
    console.error(`meta-tooling: ${rel} is already registered — use --reregister for a byte change`);
    process.exit(2);
  }
  index.tooling.push({ path: rel, sha256: sha256(join(ROOT, rel)), role });
  index.tooling.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  atomicWriteIndex(index);
  console.log(`meta-tooling: added ${rel} (${role})`);
  process.exit(0);
}

console.log(`meta-tooling: ${index.tooling.length} entries, ${drift} drift`);
process.exit(drift ? 1 : 0);
