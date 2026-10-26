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
import { execFileSync } from "node:child_process";
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
  // #37 repro 3：空账本不再无条件放行——tooling 非空时「无法证明没有静默改写」，
  // 由下方清空检测接管（rc1）。真正 tooling 也为空时才 clean。
  if (!rr.length && !(index.tooling ?? []).length) {
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

  // #37 repro 3：清空账本检测——tooling 非空而 reregistrations 为空 ⇒ 无法证明没有静默改写过。
  if (!rr.length && (index.tooling ?? []).length) {
    console.error(`meta-tooling --audit: reregistrations[] is empty but tooling[] has ${index.tooling.length} entr(ies) — ledger cleared/unverifiable (#37 repro 3)`);
    process.exit(1);
  }

  // #37 repro 4：时间倒退——同 path 的 at 必须非递减（历史可质疑：倒填不改事实）。
  {
    const lastAt = new Map();
    let back = 0;
    for (const r of rr) {
      const t = Date.parse(String(r.at ?? ""));
      if (!Number.isFinite(t)) continue;
      const prev = lastAt.get(r.path);
      if (prev !== undefined && t < prev) {
        back++;
        console.error(`  ✗ time reversal: ${r.path} at=${r.at} precedes the previous entry (${new Date(prev).toISOString()}) (#37 repro 4)`);
      }
      lastAt.set(r.path, t);
    }
    if (back) {
      console.error(`meta-tooling --audit: ${back} time-reversal(s) in reregistrations[]`);
      process.exit(1);
    }
  }

  // #37 条目5：actor 切换点——meta.actor_required_from 起，新记录无 actor 即红（不再全员 legacy 豁免）。
  const cutoff = Date.parse(String(index.actor_required_from ?? ""));
  if (Number.isFinite(cutoff)) {
    let actorBad = 0;
    for (const r of rr) {
      const t = Date.parse(String(r.at ?? ""));
      if (!Number.isFinite(t) || t < cutoff) continue; // 切换点前 = legacy
      // #88：'unknown' 也算缺失——切换点后无真名 = 无留痕。
      if (!r.actor || !String(r.actor).trim() || String(r.actor).trim().toLowerCase() === "unknown") {
        actorBad++;
        console.error(`  ✗ actor missing/unknown after cutoff: ${r.path} at=${r.at} (cutoff ${index.actor_required_from}) (#37 item 5 / #88)`);
      }
    }
    if (actorBad) {
      console.error(`meta-tooling --audit: ${actorBad} post-cutoff entr(ies) without actor`);
      process.exit(1);
    }
  }
  // 执法项④（报告面）：legacy 缺 actor 计数仍然可见。
  const noActor = rr.filter((r) => !r.actor || !String(r.actor).trim());
  if (noActor.length) {
    console.log(`  · actor missing on ${noActor.length}/${rr.length} legacy entr(ies) — post-cutoff entries are enforced above`);
  }

  // #37 执法项⑤：链首锚定——每个 path 的第一条 old_sha256 必须能在 git 历史中找到
  // （该文件的某个历史 blob sha），否则是孤儿值（首条删除隐形/凭空构造）。
  // 需要 --against-git 显式开启（git 历史对账较重，且要 clone 完整历史）。
  if (args.includes("--against-git")) {
    // #37 genesis：reregistrations 账本从 bf54281（0.114.2/3）起才有——引入之前的
    // 字节变迁是历史欠账，不追溯（否则 100+ 条噪音掩盖新缺陷）。取 git 里第一个
    // 引入 '"reregistrations"' 的提交作为基线。
    let genesisCommit = "";
    try {
      const out = execFileSync("git", ["log", "--reverse", "--format=%H", "-S", '"reregistrations"', "--", "verify/meta.json"], { cwd: ROOT, encoding: "utf8" });
      genesisCommit = out.split(String.fromCharCode(10)).filter(Boolean)[0] || "";
    } catch { genesisCommit = ""; }
    let gitBad = 0;
    const paths = [...new Set(rr.map((r) => r.path))];
    // #894784e8：git 探针统一走这里——path 不在目标提交时的 fatal 是预期分支，stderr 不外泄。
    const gitProbe = (gitArgs) => {
      try {
        return execFileSync("git", gitArgs, { cwd: ROOT, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
      } catch { return null; }
    };
    const sha256buf = (b) => createHash("sha256").update(b).digest("hex");
    /** 路径在 genesis 提交时的 blob sha（不存在 → ""）。 */
    const genesisBlobOf = (path) => {
      if (!genesisCommit) return "";
      const blob = gitProbe(["show", `${genesisCommit}:${path}`]);
      return blob ? sha256buf(blob) : "";
    };
    /** 路径首个 git 提交（--reverse 首行）的 blob sha（无历史 → ""）。 */
    const firstAddBlobOf = (path) => {
      const out = gitProbe(["log", "--reverse", "--format=%H", "--", path]);
      if (!out) return "";
      const firstCommit = out.toString().split(String.fromCharCode(10)).filter(Boolean)[0];
      if (!firstCommit) return "";
      const blob = gitProbe(["show", `${firstCommit}:${path}`]);
      return blob ? sha256buf(blob) : "";
    };
    const pinnedGenesis = index.reregistration_genesis ?? {};
    const Z = "0".repeat(64);
    for (const path of paths) {
      const firstIdx = rr.findIndex((r) => r.path === path);
      const first = rr[firstIdx];
      const pinned = pinnedGenesis[path];
      if (pinned) {
        // 显式 pin（reregistration_genesis）：链根必须等于 pin 值——删早期记录即露馅。
        if (first.old_sha256 !== pinned) {
          gitBad++;
          console.error(`  ✗ chain first anchor: ${path} first old_sha256 ${first.old_sha256.slice(0, 8)} ≠ pinned genesis ${pinned.slice(0, 8)} (earlier record deleted? #37 item 5)`);
        }
        continue;
      }
      const atGenesis = genesisBlobOf(path);
      if (atGenesis) {
        // genesis 前就存在的工具：链根必须锚在 genesis blob（记录 2 的 old 恰好等于记录 1 的
        // new，仅凭「在历史里出现过」无法发现删除——故必须精确等于起点态）。
        if (first.old_sha256 !== atGenesis) {
          gitBad++;
          console.error(`  ✗ chain first anchor: ${path} first old_sha256 ${first.old_sha256.slice(0, 8)} ≠ pinned genesis ${atGenesis.slice(0, 8)} (earlier record deleted? #37 item 5)`);
        }
        continue;
      }
      // #894784e8（监督席 direct-9cbd2de7）：genesis 之后新增的工具——初始登记 = Z 锚
      // （old=00000000），且 new 必须等于该路径**首个 git 提交**的 blob sha：
      // 既接受正当 --add 初始登记，又不放手工构造（伪造 new 对不上首提交内容；
      // 首登前已改过一版而漏登早期变迁，同样对不上；未提交的路径直接点名）。
      const firstAdd = firstAddBlobOf(path);
      if (!firstAdd) {
        gitBad++;
        console.error(`  ✗ chain first anchor: ${path} has no git history (untracked?) — tooling entries must be committed before registering (#894784e8)`);
        continue;
      }
      if (first.old_sha256 !== Z || first.new_sha256 !== firstAdd) {
        gitBad++;
        console.error(`  ✗ chain first anchor: ${path} post-genesis tool must root at ${Z.slice(0, 8)}→${firstAdd.slice(0, 8)} (first git commit blob), got ${first.old_sha256.slice(0, 8)}→${first.new_sha256.slice(0, 8)} (#894784e8)`);
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
        // 有 genesis 时用 range（不能带 --all——它会把全 refs 历史并进来使 range 失效）
        // 只取 genesis..HEAD（post-genesis 提交），起点态由下面的 seed 补——
        // 不能取 genesis^..（会把 pre-genesis 分支合并的噪声并进来）。
        const logArgs = genesisCommit
          ? ["log", "--reverse", "--format=%H", `${genesisCommit}..HEAD`, "--", t.path]
          : ["log", "--all", "--reverse", "--format=%H", "--", t.path];
        commits = execFileSync("git", logArgs, { cwd: ROOT, encoding: "utf8" })
          .split(String.fromCharCode(10)).filter(Boolean);
      } catch { continue; }
      const chain = [];
      // seed：账本起点态（genesis 提交时的 blob）——否则「genesis 后只改一次」
      // 的 transitions 为空，静默重哈希漏检（监督席 gap (a)）
      if (genesisCommit) {
        const seedBlob = gitProbe(["show", `${genesisCommit}:${t.path}`]);
        if (seedBlob) chain.push(sha256buf(seedBlob)); /* 否则文件在 genesis 时不存在——首提交即起点 */
      }
      for (const commit of commits) {
        const blob = gitProbe(["show", `${commit}:${t.path}`]);
        if (blob) chain.push(sha256buf(blob)); /* file absent at this commit */
      }
      // 同一 sha 连续出现合并为一次变更
      const transitions = [];
      for (let i = 1; i < chain.length; i++) if (chain[i] !== chain[i - 1]) transitions.push([chain[i - 1], chain[i]]);
      const recorded = new Set(rr.filter((r) => r.path === t.path).map((r) => r.old_sha256 + "->" + r.new_sha256));
      // 历史欠账基线（meta.reregistration_baseline）：enforcement 之前的真实变迁，
      // 已被核对过并永久豁免——不追溯。
      const baseline = (index.reregistration_baseline ?? []).map(String);
      const inBaseline = (from, to) => baseline.some((b) => {
        const [pair, at] = b.split("@");
        const [o, n] = pair.split("->");
        return (!o || from.startsWith(o.replace("\*", ""))) && (!n || to.startsWith(n.replace("\*", "")));
      });
      for (const [from, to] of transitions) {
        if (!recorded.has(from + "->" + to) && !inBaseline(from, to)) {
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
  // #88（监督席 direct-fe588519）：初始锚也要真 actor——--actor 或 git user.name，
  // 都没有就拒绝（不得写 'unknown'：切换点后 unknown = 无留痕）。
  let addActor = flag("actor");
  if (!addActor) {
    try {
      addActor = String(execFileSync("git", ["config", "user.name"], { encoding: "utf8" })).trim();
    } catch { /* no git */ }
  }
  if (!addActor) {
    console.error('meta-tooling: --add needs --actor "<who>" (or a git user.name) for the initial registration anchor (#88)');
    process.exit(2);
  }
  index.tooling.push({ path: rel, sha256: sha256(join(ROOT, rel)), role });
  // #37 条目1（初始锚点）：--add 顺手记一条初始 reregistration（Z→当前 sha）——
  // 新路径从登记起就有 lineage 锚，未提交手工对齐立刻可查。
  {
    index.reregistrations = index.reregistrations ?? [];
    index.reregistrations.push({
      path: rel, old_sha256: "0".repeat(64), new_sha256: sha256(join(ROOT, rel)),
      reason: "initial registration (--add; #37 item 1 anchor)", actor: addActor,
      at: new Date().toISOString(),
    });
  }
  index.tooling.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  atomicWriteIndex(index);
  console.log(`meta-tooling: added ${rel} (${role})`);
  process.exit(0);
}

// #37 条目1（lineage）：tooling sha == 该 path 最后 new_sha256——未提交的手工对齐
// （改文件+对齐 tooling sha、不写 reregistration）drift 为 0 但 lineage 必红。
{
  const rr = index.reregistrations ?? [];
  const lastNew = new Map();
  for (const r of rr) if (r?.path && r?.new_sha256) lastNew.set(r.path, r.new_sha256);
  let lineage = 0;
  for (const t of index.tooling ?? []) {
    const expect = lastNew.get(t.path);
    if (expect !== undefined && expect !== t.sha256) {
      lineage++;
      console.error(`  ✗ lineage: ${t.path} tooling sha ${t.sha256.slice(0, 8)} ≠ last new_sha256 ${expect.slice(0, 8)} (hand-aligned rehash? #37 item 1)`);
    }
  }
  drift += lineage;
}
console.log(`meta-tooling: ${index.tooling.length} entries, ${drift} drift`);
process.exit(drift ? 1 : 0);
