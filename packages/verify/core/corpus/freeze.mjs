#!/usr/bin/env node
/**
 * 语料冻结清单（契约 §4.6）：`corpus/cases/**` 与 `corpus/canonical/vectors.json` 的逐文件哈希。
 *
 * 用法：
 *   node corpus/freeze.mjs          # 打印当前哈希（与 manifest.json 比较，不改文件）
 *   node corpus/freeze.mjs --write  # 重写 manifest.json（仅在 corpus_version 升级时用）
 *
 * 纪律：语料只增不改。改了已冻结案例 = 旧版本行为再也证明不了，
 * 必须升 corpus_version 并在 CHANGELOG 记差异后重写清单。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const manifestPath = join(here, "manifest.json");

/** Repo root (for git) — corpus only exists inside the checkout; installs read
 *  the frozen manifest, they never freeze. */
let repoRoot = null;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  repoRoot = null;
}

/**
 * 0.108.0（fdc757f6 0.103 裁定剩下的两件之一）：manifest 记**blob 内容哈希**，
 * 而不是「这台机器磁盘上的字节」。
 *
 * `git hash-object -w --path=<repo-relative>` 会让 git 按 `.gitattributes` 过滤
 * （语料目录固定 `eol=lf`），再 `git cat-file blob` 取回过滤后的内容算 sha256——
 * 因此同一提交在任何检出配置下（core.autocrlf=true/false）都得到同一个哈希。
 * 未提交的新文件也能算（先 -w 成对象即可）。
 *
 * 盘上字节的核对留给门禁（corpus-freeze.spec）：它断言「磁盘字节 sha256 ==
 * manifest 哈希」。一旦 `.gitattributes` 回归导致工作树被 CRLF 重写，两道哈希
 * 会分叉并大声失败——这正是「身份锚 + 运行时锚」双检。
 */
function blobSha256(full) {
  const disk = readFileSync(full);
  if (!repoRoot) return createHash("sha256").update(disk).digest("hex");
  const relRepo = relative(repoRoot, full).split("\\").join("/");
  const sha = execFileSync("git", ["hash-object", "-w", "--path", relRepo, full], { cwd: repoRoot, encoding: "utf8" }).trim();
  const content = execFileSync("git", ["cat-file", "blob", sha], { cwd: repoRoot, maxBuffer: 1 << 28 });
  return createHash("sha256").update(content).digest("hex");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 相对 corpus/ 的 POSIX 路径 + sha256，按键升序（跨平台稳定）。 */
export function corpusDigest() {
  const files = [...walk(join(root, "cases")), join(root, "canonical", "vectors.json")].sort();
  const entries = files.map((full) => {
    const rel = relative(root, full).split("\\").join("/");
    const sha256 = blobSha256(full);
    return { path: rel, sha256 };
  });
  const joined = entries.map((e) => `${e.path}:${e.sha256}`).join("\n");
  return { entries, digest: createHash("sha256").update(joined).digest("hex") };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { entries, digest } = corpusDigest();
  const write = process.argv.includes("--write");
  const versionArg = process.argv.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  // 版本号由维护者用 --version 显式给（默认沿用现有清单，永不静默回退）
  const prev = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const version = versionArg ?? prev?.corpus_version ?? "1.0";
  // 0.108.0: the attribute file itself joins the protection set — a regression
  // here silently re-introduces the CRLF/digest class of failure from 0.103.
  const attributesPath = join(repoRoot ?? "", ".gitattributes");
  const attributesSha256 = existsSync(attributesPath)
    ? createHash("sha256").update(readFileSync(attributesPath)).digest("hex")
    : "";
  const next = { corpus_version: String(version), digest, attributes_sha256: attributesSha256, entries };
  if (write) {
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`wrote ${relative(process.cwd(), manifestPath)} (${entries.length} files, digest ${digest.slice(0, 16)}…)`);
  } else {
    console.log(`files=${entries.length} digest=${digest}`);
    let prev = null;
    try {
      prev = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      console.log("manifest.json missing — run with --write to freeze the current corpus");
      process.exit(0);
    }
    if (prev.digest === digest) console.log("frozen corpus unchanged ✓");
    else {
      console.log(`DRIFT: frozen digest ${prev.digest.slice(0, 16)}… ≠ current ${digest.slice(0, 16)}…`);
      const prevMap = new Map((prev.entries ?? []).map((e) => [e.path, e.sha256]));
      for (const e of entries) {
        const old = prevMap.get(e.path);
        if (!old) console.log(`  added   ${e.path}`);
        else if (old !== e.sha256) console.log(`  changed ${e.path}`);
        prevMap.delete(e.path);
      }
      for (const gone of prevMap.keys()) console.log(`  removed ${gone}`);
      process.exit(1);
    }
  }
}
