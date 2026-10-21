#!/usr/bin/env node
/**
 * verify/meta.json `tooling[]` 登记维护（charter §4.4 R3 登记制，meta_index_version 2）。
 *
 *   node scripts/meta-tooling.mjs            # 按现有条目的 path 重算 sha256 并回写（改了脚本之后跑）
 *   node scripts/meta-tooling.mjs --check    # 只比对：任一条目 sha 漂移或文件缺失 → rc=1（contract-audit / 评审用）
 *   node scripts/meta-tooling.mjs --add <path> --role <build|test|release|gate>   # 追加一条登记（path 仓内相对）
 *
 * 纪律：只维护登记，不产出也不汇总任何验证判定（tooling 的定义）。`verify meta .` 才是判定，
 * contract-audit 12 对本仓跑它——登记漂移在那里变红。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "verify", "meta.json");
const ROLES = ["build", "test", "release", "gate"];
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
for (const a of args) {
  if (a.startsWith("--") && !["--check", "--add", "--role"].includes(a)) {
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
if (add) {
  const role = flag("role");
  if (!ROLES.includes(role)) {
    console.error(`meta-tooling: --add needs --role ${ROLES.join("|")}`);
    process.exit(2);
  }
  const rel = add.split("\\").join("/");
  if (rel.startsWith("/") || rel.split("/").includes("..") || !existsSync(join(ROOT, rel))) {
    console.error(`meta-tooling: --add path must be repo-relative and exist: ${add}`);
    process.exit(2);
  }
  if (!index.tooling.some((t) => t.path === rel)) index.tooling.push({ path: rel, sha256: "", role });
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
    console.error(`  ${args.includes("--check") ? "✗ drift" : "~ refresh"}: ${t.path}`);
    t.sha256 = got;
  }
}
index.tooling.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

if (args.includes("--check")) {
  console.log(`meta-tooling: ${index.tooling.length} entries, ${drift} drift`);
  process.exit(drift ? 1 : 0);
}
writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`meta-tooling: ${index.tooling.length} entries written (${drift} refreshed)`);
