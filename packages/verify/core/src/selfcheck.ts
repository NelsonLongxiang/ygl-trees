/**
 * `verify self-check`：把「校验器自身可被校验」落成一个可跑的命令（递归验证 L0–L6）。
 *
 * 六环顺序（由外到内、由便宜到贵）：环境指纹 → 契约版本 → canonical 向量 → 语料冻结摘要 →
 * 形状快照 → 语料实跑（引擎）→ 归档包（调用方注入）。
 *
 * 设计底线：**没有语料就报 SKIP 而不是 OK**——发布产物里不带 corpus/，跳过必须显式说出来，
 * 否则 self-check 会退化成一句永远为真的自夸。
 *
 * @module @ygl/verify-core/selfcheck
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { canonicalStringify } from "./canonical";
import { CONTRACT_VERSION } from "./contract";
import { runCorpus } from "./corpus-runner";

export type SelfCheckStatus = "ok" | "fail" | "skip";

export interface SelfCheckItem {
  id: string;
  status: SelfCheckStatus;
  detail: string;
}

export interface SelfCheckEnvironment {
  node: string;
  platform: string;
  arch: string;
  contract_version: string;
  corpus_version: string | null;
}

export interface SelfCheckReport {
  ok: boolean;
  items: SelfCheckItem[];
  environment: SelfCheckEnvironment;
}

export interface SelfCheckOptions {
  /** 语料目录（含 cases/ canonical/ manifest.json）。缺省 = 跳过语料相关三项。 */
  corpusDir?: string;
  /** 形状快照目录。缺省 = <corpusDir>/shapes。 */
  shapesDir?: string;
  /** 归档目录（侧车 JSON）；给了就必须同时给 archiveVerifier。 */
  archivesDir?: string;
  archiveVerifier?: (zipPath: string) => { ok: boolean; problems: string[] };
  /** 是否实跑语料（默认跑步；`--no-cases` 可关，用于快速自检）。 */
  runCases?: boolean;
  /** 只校验前 N 例（调试用）。 */
  caseLimit?: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 语料冻结摘要：与 `corpus/freeze.mjs` 逐字节同算法（`corpus/cases/**` + `canonical/vectors.json`，
 * 相对路径 POSIX + sha256，按路径升序，`path:sha256` 换行拼接后再 sha256）。
 */
export function corpusDigest(corpusDir: string): { entries: Array<{ path: string; sha256: string }>; digest: string } {
  const files = [...walk(join(corpusDir, "cases")), join(corpusDir, "canonical", "vectors.json")].sort();
  const entries = files.map((full) => ({
    path: relative(corpusDir, full).split("\\").join("/"),
    sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
  }));
  return { entries, digest: createHash("sha256").update(entries.map((e) => `${e.path}:${e.sha256}`).join("\n")).digest("hex") };
}

const SHAPE_LINE = /^[A-Za-z0-9_.[\]]+:(object|array|string|number|boolean|null)$/;

/** canonical 向量：TS 侧逐例复算，必须与 expected 逐字节一致（Rust 侧同向量）。 */
function checkCanonicalVectors(corpusDir: string): SelfCheckItem {
  const file = join(corpusDir, "canonical", "vectors.json");
  if (!existsSync(file)) return { id: "canonical-vectors", status: "skip", detail: `missing ${file}` };
  const doc = JSON.parse(readFileSync(file, "utf8")) as { version?: string; cases?: Array<{ name: string; input: unknown; expected: string }> };
  const cases = doc.cases ?? [];
  const bad: string[] = [];
  for (const c of cases) {
    let got: string;
    try {
      got = canonicalStringify(c.input);
    } catch (e) {
      bad.push(`${c.name}: threw ${(e as Error).message}`);
      continue;
    }
    if (got !== c.expected) bad.push(`${c.name}: expected ${c.expected}, got ${got}`);
  }
  return bad.length
    ? { id: "canonical-vectors", status: "fail", detail: bad.join(" | ") }
    : { id: "canonical-vectors", status: "ok", detail: `${cases.length} vector(s), version ${doc.version ?? "?"}` };
}

/** 语料冻结摘要 vs manifest.json：改了已冻结案例、漏写清单都在这里红。 */
function checkCorpusDigest(corpusDir: string): SelfCheckItem {
  const manifestFile = join(corpusDir, "manifest.json");
  if (!existsSync(manifestFile)) return { id: "corpus-digest", status: "skip", detail: `missing ${manifestFile}` };
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    corpus_version?: string;
    digest?: string;
    entries?: Array<{ path: string; sha256: string }>;
  };
  const now = corpusDigest(corpusDir);
  if (now.digest === manifest.digest) {
    return { id: "corpus-digest", status: "ok", detail: `${now.entries.length} file(s), corpus ${manifest.corpus_version ?? "?"}` };
  }
  const before = new Map((manifest.entries ?? []).map((e) => [e.path, e.sha256]));
  const after = new Map(now.entries.map((e) => [e.path, e.sha256]));
  const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  return {
    id: "corpus-digest",
    status: "fail",
    detail: `digest ${now.digest.slice(0, 16)}… != manifest ${String(manifest.digest).slice(0, 16)}…; changed=[${changed.join(",")}] added=[${added.join(",")}] removed=[${removed.join(",")}]`,
  };
}

/** 形状快照：文件存在、每行符合 `path:type`、且首行排序（早期漂移的机械门）。 */
function checkShapes(dir: string): SelfCheckItem {
  if (!existsSync(dir)) return { id: "shapes", status: "skip", detail: `missing ${dir}` };
  const files = readdirSync(dir).filter((f) => f.endsWith(".shape.txt")).sort();
  if (!files.length) return { id: "shapes", status: "fail", detail: `no *.shape.txt in ${dir}` };
  const bad: string[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
    const badLines = lines.filter((l) => !SHAPE_LINE.test(l));
    if (badLines.length) bad.push(`${f}: ${badLines.slice(0, 3).join(" / ")}`);
  }
  return bad.length
    ? { id: "shapes", status: "fail", detail: bad.join(" | ") }
    : { id: "shapes", status: "ok", detail: `${files.length} snapshot(s)` };
}

/** 归档包：逐侧车重算校验链（由调用方注入，避免 verify-core 依赖 ops）。 */
function checkArchives(dir: string, verifier: (zipPath: string) => { ok: boolean; problems: string[] }): SelfCheckItem {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  // G3（评审 r12）：目录为空 = 没东西可验，是 skip 不是 ok。
  if (!files.length) return { id: "archives", status: "skip", detail: `no archived runs in ${dir}` };
  const bad: string[] = [];
  let checked = 0;
  for (const f of files) {
    const side = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      path?: string;
      archive_id?: string;
      archives?: Array<{ path?: string; archive_id?: string }>;
    };
    // 侧车有两种形状：单条记录（{path}）与追加记录（{run_id, archives:[{path}]}）；
    // 后者同一 run 可归档多次（重跑/换 --with），每份都要能被重算。
    const entries = Array.isArray(side.archives) ? side.archives : [side];
    if (!entries.length) {
      bad.push(`${f}: no archive entry recorded`);
      continue;
    }
    for (const entry of entries) {
      checked += 1;
      if (!entry.path || !existsSync(entry.path)) {
        bad.push(`${f}: archive file missing (${entry.path ?? "no path"})`);
        continue;
      }
      const res = verifier(entry.path);
      if (!res.ok) bad.push(`${f}: ${res.problems.join("; ")}`);
    }
  }
  return bad.length
    ? { id: "archives", status: "fail", detail: bad.join(" | ") }
    : { id: "archives", status: "ok", detail: `${checked} archive(s) re-verified` };
}

export async function selfCheck(opts: SelfCheckOptions = {}): Promise<SelfCheckReport> {
  const items: SelfCheckItem[] = [];
  const env: SelfCheckEnvironment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    contract_version: CONTRACT_VERSION,
    corpus_version: null,
  };

  const corpusDir = opts.corpusDir && existsSync(opts.corpusDir) ? opts.corpusDir : undefined;
  if (corpusDir) {
    const manifestFile = join(corpusDir, "manifest.json");
    if (existsSync(manifestFile)) {
      env.corpus_version = (JSON.parse(readFileSync(manifestFile, "utf8")) as { corpus_version?: string }).corpus_version ?? null;
    }
  }

  items.push({ id: "environment", status: "ok", detail: `node ${env.node} · ${env.platform}/${env.arch} · contract ${env.contract_version} · corpus ${env.corpus_version ?? "n/a"}` });

  if (!corpusDir) {
    items.push({ id: "corpus", status: "skip", detail: "corpus not found — pass --corpus <dir> or set YGL_VERIFY_CORPUS" });
  } else {
    items.push(checkCanonicalVectors(corpusDir));
    items.push(checkCorpusDigest(corpusDir));
    items.push(checkShapes(opts.shapesDir ?? join(corpusDir, "shapes")));
    if (opts.runCases === false) {
      items.push({ id: "corpus-cases", status: "skip", detail: "disabled by --no-cases" });
    } else {
      const casesDir = join(corpusDir, "cases");
      try {
        const before = Date.now();
        const runs = await runCorpus(casesDir);
        const limited = opts.caseLimit ? runs.slice(0, opts.caseLimit) : runs;
        const failed = limited.filter((r) => r.diffs.length);
        items.push({
          id: "corpus-cases",
          status: failed.length ? "fail" : "ok",
          detail: failed.length
            ? failed.map((r) => `${r.name}: ${r.diffs.join("; ")}`).join(" | ")
            : `${limited.length} case(s) in ${Date.now() - before}ms`,
        });
      } catch (e) {
        items.push({ id: "corpus-cases", status: "fail", detail: `runner threw: ${(e as Error).message}` });
      }
    }
  }

  if (opts.archivesDir && opts.archiveVerifier) {
    // 评审 fdc757f6 P3：不要把 existsSync 的另一个 stat 当成唯一门——高并发下 fresh 目录
    // 可能撞上文件系统时序（实测 1/374 误走 else）。直接读目录，ENOENT 才是"没有目录"。
    const readable = (() => {
      try {
        readdirSync(opts.archivesDir);
        return true;
      } catch {
        return false;
      }
    })();
    if (readable) {
      try {
        items.push(checkArchives(opts.archivesDir, opts.archiveVerifier));
      } catch (e) {
        items.push({ id: "archives", status: "fail", detail: (e as Error).message });
      }
    } else {
      items.push({ id: "archives", status: "skip", detail: `no archives dir: ${opts.archivesDir}` });
    }
  } else {
    items.push({ id: "archives", status: "skip", detail: "no archives dir / verifier injected" });
  }

  return { ok: items.every((i) => i.status !== "fail"), items, environment: env };
}
