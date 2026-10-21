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
 * - 每次重登记写 `meta.reregister` 事件（workspace events 表，append-only）：{path, old_sha256,
 *   new_sha256, reason, actor}——漂移修复本身可审计，不是把 red 改成 green。
 * - 只维护登记，不产出也不汇总任何验证判定（tooling 的定义）；`verify meta .` 才是判定。
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = process.env.YGL_META_ROOT ? resolve(process.env.YGL_META_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "verify", "meta.json");
const ROLES = ["build", "test", "release", "gate"];
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const KNOWN = ["--check", "--add", "--role", "--reregister", "--reason"];
for (const a of args) {
  if (a.startsWith("--") && !KNOWN.includes(a)) {
    console.error(`meta-tooling: unknown flag ${a}`);
    process.exit(2);
  }
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const index = JSON.parse(readFileSync(INDEX, "utf8"));
if (index.meta_index_version !== 2) {
  console.error(`meta-tooling: verify/meta.json is meta_index_version ${index.meta_index_version}; tooling[] belongs to version 2`);
  process.exit(2);
}
index.tooling ??= [];

const add = flag("add");

function writeEvent(payload) {
  // append-only audit of the drift repair; missing workspace DB = fail-closed
  // (an unrecorded re-registration would be an unauditable green edit).
  const home = process.env.YGL_HOME ? resolve(process.env.YGL_HOME) : join(homedir(), ".ygl-trees");
  const dbPath = join(home, "ygl-trees.db");
  if (!existsSync(dbPath)) {
    console.error(`meta-tooling: --reregister needs a workspace DB at ${dbPath} to record the meta.reregister event`);
    process.exit(1);
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
  } catch (e) {
    console.error(`meta-tooling: cannot open sqlite to record the event: ${e?.message || e}`);
    process.exit(1);
  }
  const actor = process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "cli";
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)").run(
      `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      new Date().toISOString(),
      actor,
      "meta.reregister",
      "meta",
      payload.path,
      JSON.stringify(payload),
      "warn",
    );
  } finally {
    db.close();
  }
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
  entry.sha256 = got;
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  writeEvent({ path: entry.path, old_sha256: old, new_sha256: got, reason: reason.trim() });
  console.log(`meta-tooling: re-registered ${entry.path} ${old.slice(0, 8)} → ${got.slice(0, 8)} (meta.reregister recorded)`);
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
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`meta-tooling: added ${rel} (${role})`);
  process.exit(0);
}

console.log(`meta-tooling: ${index.tooling.length} entries, ${drift} drift`);
process.exit(drift ? 1 : 0);
