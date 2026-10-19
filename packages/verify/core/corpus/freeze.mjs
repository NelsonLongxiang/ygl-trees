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
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const manifestPath = join(here, "manifest.json");

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
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    return { path: rel, sha256 };
  });
  const joined = entries.map((e) => `${e.path}:${e.sha256}`).join("\n");
  return { entries, digest: createHash("sha256").update(joined).digest("hex") };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { entries, digest } = corpusDigest();
  const write = process.argv.includes("--write");
  const next = { corpus_version: "1", digest, entries };
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
