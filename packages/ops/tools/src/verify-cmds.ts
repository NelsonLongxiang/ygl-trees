/** verify group — spec-validator 命令面（M13-1）.
 *
 * 构造面（submit / prepare / trace）在 ygl 工作区里完成，执行面（run）只碰**库快照副本**，
 * 报告与规范都是文件工件：`$YGL_HOME/verify/{materials,specs,reports}`。
 *
 * 两条裁定决定了这里没有模型调用：
 * - 构造期的提取/翻译由 agent 做，CLI 只吃它的输出（`--candidates`）；
 * - 盲审同理（`--reviews`，每候选一组三问结论），CLI 只做机械判定（fail-closed）。
 * 真网关适配器属于 M13-1b；M13-1 的 CLI 是「注入接口的文件形态」。
 *
 * 运行契约：rc 只表达过程——0=跑完出报告（PASS/FAIL 都是有效结论），1=运行错误，2=用法错误。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { openDatabaseSync } from "../../../verify/core/src/sqlite-bindings";

import type { Env } from "../../../core/database/src/types";
import { bad, C, out, paint, table } from "../../../core/text/src/fmt";
import type { ReviewFinding, ReviewRunner, VerifyReport, VerifySpec } from "../../../verify/core/src/contract";
import { payloadHash, runVerify } from "../../../verify/core/src/engine";
import type { MaterialIndex, PrepareCandidate, PrepareRunner } from "../../../verify/core/src/prepare";
import { prepareSpec } from "../../../verify/core/src/prepare";
import { SqliteRunner } from "../../../verify/core/src/sqlite-runner";

const KINDS = ["materials", "specs", "reports", "registrations"] as const;

function paths(env: Env) {
  const root = join(env.home, "verify");
  for (const k of KINDS) mkdirSync(join(root, k), { recursive: true });
  return {
    root,
    materials: join(root, "materials"),
    specs: join(root, "specs"),
    reports: join(root, "reports"),
    registrations: join(root, "registrations"),
  };
}

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");
const short = (sha: string): string => sha.slice(0, 12);

interface MaterialRecord {
  material_id: string;
  title: string;
  created: string;
  text_sha256: string;
  text_path: string;
  files: Array<{ path: string; sha256: string; mime: string; size: number; stored: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 以文件形态注入 prepare 的候选（agent 的提取/翻译产物）。 */
function fileRunner(candidates: PrepareCandidate[]): PrepareRunner {
  return {
    async prepare() {
      return candidates;
    },
  };
}

/** 以文件形态注入盲审结论：每候选一组三问，按 source_clause 对齐（不认 VU id —— 那由 prepare 生成）。 */
function fileReviewer(reviews: Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }>): ReviewRunner {
  return {
    async review(req) {
      const hit = reviews.find((r) => r.source_clause === req.vu.source_clause);
      if (!hit) return []; // 没有该候选的盲审结论 → prepare 的 fail-closed 会判"自审不完整"
      return hit.findings.map((f) => ({ ...f, vu_id: req.vu.id }));
    },
  };
}

/** P4 最小红队（fdc757f6 裁定①配套）：空快照上不得 ERROR、不得空洞 PASS。 */
function minimalRedTeam(schemaSql: string[]): (s: VerifySpec) => Promise<string[]> {
  return async (s: VerifySpec) => {
    const db = openDatabaseSync(":memory:");
    try {
      for (const ddl of schemaSql) {
        try {
          db.exec(ddl);
        } catch {
          /* 视图/触发器/索引失败不影响空表门 */
        }
      }
      const runner = {
        query: (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>,
        tableRows: (t: string) => db.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>,
        schemaFingerprint: () => "empty-snapshot",
        sourceTables: () => [] as string[],
      };
      const report = await runVerify(s, { runner: runner as never, mode: "open", nowIso: () => "1970-01-01T00:00:00.000Z" });
      const failures: string[] = [];
      if (report.overall === "ERROR") failures.push("spec errors out on an empty snapshot (construction bug, not a data finding)");
      for (const r of report.vu) {
        if (r.verdict === "PASS" && (r.witness?.rows_scanned ?? 0) === 0) failures.push(`${r.id} passes on an empty snapshot — vacuous pass`);
      }
      return failures;
    } finally {
      db.close();
    }
  };
}

/** 从快照库取建表 DDL（红队空库用；不复制数据）。 */
function schemaOf(dbPath: string): { ddl: string[]; fingerprint: string } {
  const db = openDatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
    return { ddl: rows.map((r) => r.sql).filter(Boolean), fingerprint: sha256(rows.map((r) => `${r.name}:${r.sql}`).join("\n")) };
  } finally {
    db.close();
  }
}

/** run 只碰副本（裁定 A）：把快照复制到临时文件，报告记来源 + sha256。 */
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 清理过期快照副本（r11 R7）：只删自己目录里超过 7 天的文件。 */
function pruneSnapshots(dir: string): number {
  let removed = 0;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > SNAPSHOT_TTL_MS) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* 并发删除/占用不影响本次 run */
    }
  }
  return removed;
}

function snapshotCopy(dbPath: string): { path: string; sha256: string; source: string } {
  const stat = statSync(dbPath);
  if (!stat.isFile()) throw new Error(`--db must point to a SQLite file (snapshot copy), not a directory: ${dbPath}`);
  const dir = join(process.env.TEMP || process.env.TMPDIR || ".", "ygl-verify-snapshots");
  mkdirSync(dir, { recursive: true });
  pruneSnapshots(dir);
  const target = join(dir, `${basename(dbPath)}.${Date.now()}.sqlite`);
  copyFileSync(dbPath, target);
  return { path: target, sha256: sha256(readFileSync(target)), source: basename(dbPath) };
}

function specDir(env: Env, specId: string): string {
  return join(paths(env).specs, specId);
}

function findMaterial(env: Env, id: string): MaterialRecord {
  const dir = join(paths(env).materials, id);
  const file = join(dir, "material.json");
  if (!existsSync(file)) throw new Error(`material not found: ${id} (verify submit first)`);
  return readJson<MaterialRecord>(file);
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx } = env;
  const p = paths(env);

  switch (action) {
    case "submit": {
      const title = String(args.flags.title || "").trim();
      const textArg = args.flags.text ? String(args.flags.text) : "";
      if (!title || !textArg) {
        bad(ctx, 'usage: verify submit --title "<what>" --text <file|-> [--attach <file> ...]');
        return 2;
      }
      let text: string;
      try {
        text = textArg === "-" ? readFileSync(0, "utf8") : readFileSync(textArg, "utf8");
      } catch (e: any) {
        bad(ctx, `cannot read --text ${textArg}: ${e?.message || e}`);
        return 1;
      }
      if (!text.trim()) {
        bad(ctx, "--text is empty — a submission with no material cannot be prepared");
        return 2;
      }
      const attachArgs: string[] = Array.isArray(args.flags.attach)
        ? args.flags.attach.map(String)
        : args.flags.attach
          ? [String(args.flags.attach)]
          : [];
      const materialId = `mat_${short(sha256(`${title}\n${text}`))}`;
      const dir = join(p.materials, materialId);
      mkdirSync(join(dir, "files"), { recursive: true });
      writeFileSync(join(dir, "material.txt"), text, "utf8");
      const files: MaterialRecord["files"] = [];
      for (const a of attachArgs) {
        if (!existsSync(a)) {
          bad(ctx, `attachment not found: ${a}`);
          return 1;
        }
        const buf = readFileSync(a);
        const sha = sha256(buf);
        const stored = `${short(sha)}-${basename(a)}`;
        writeFileSync(join(dir, "files", stored), buf);
        files.push({ path: basename(a), sha256: sha, mime: mimeOf(a), size: buf.length, stored });
      }
      const record: MaterialRecord = {
        material_id: materialId,
        title,
        created: new Date().toISOString(),
        text_sha256: sha256(text),
        text_path: "material.txt",
        files,
      };
      writeJson(join(dir, "material.json"), record);
      if (ctx.json) {
        console.log(JSON.stringify(record));
        return 0;
      }
      out(ctx, `  ✓ material frozen: ${materialId}  (${text.length} chars${files.length ? `, ${files.length} attachment(s)` : ""})`);
      out(ctx, paint(C.dim, `  next: verify prepare ${materialId} --candidates <file> --reviews <file> --db <snapshot.sqlite>`, ctx.color));
      return 0;
    }

    case "prepare": {
      const materialId = rest[0];
      const candidatesPath = String(args.flags.candidates || "");
      const reviewsPath = String(args.flags.reviews || "");
      const dbPath = String(args.flags.db || "");
      if (!materialId || !candidatesPath || !reviewsPath || !dbPath) {
        bad(ctx, "usage: verify prepare <material-id> --candidates <file> --reviews <file> --db <snapshot.sqlite> [--spec-version N]");
        return 2;
      }
      let material: MaterialRecord;
      try {
        material = findMaterial(env, materialId);
      } catch (e: any) {
        bad(ctx, e.message);
        return 1;
      }
      const text = readFileSync(join(p.materials, materialId, material.text_path), "utf8");
      // 两种形态都收：裸数组，或 { candidates: [...] } / { reviews: [...] } 信封
      const candidatesRaw = readJson<unknown>(candidatesPath);
      const reviewsRaw = readJson<unknown>(reviewsPath);
      const candidatesFile = { candidates: Array.isArray(candidatesRaw) ? (candidatesRaw as PrepareCandidate[]) : ((candidatesRaw as { candidates?: PrepareCandidate[] }).candidates ?? []) };
      const reviewsFile = { reviews: Array.isArray(reviewsRaw) ? (reviewsRaw as Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }>) : ((reviewsRaw as { reviews?: Array<{ source_clause: string; findings: Array<Omit<ReviewFinding, "vu_id">> }> }).reviews ?? []) };
      const schema = existsSync(dbPath) ? schemaOf(dbPath) : null;
      if (!schema) {
        bad(ctx, `--db snapshot not found: ${dbPath} (prepare needs the probed schema for column checks)`);
        return 1;
      }
      const materialIndex: MaterialIndex = {
        text,
        files: material.files.map((f) => ({ path: f.path, sha256: f.sha256, mime: f.mime, size: f.size })),
      };
      const schemaProbe = probeOf(schema.ddl);
      const prevVersion = latestVersionOf(env, materialId);
      return prepareSpec(text, {
        runner: fileRunner(candidatesFile.candidates ?? []),
        reviewer: fileReviewer(reviewsFile.reviews ?? []),
        redteam: minimalRedTeam(schema.ddl),
        materialIndex,
        schemaProbe,
        specId: `spec_${short(sha256(materialId))}`,
        specVersion: args.flags["spec-version"] ? Number(args.flags["spec-version"]) : prevVersion + 1,
        // as_of 由调用方（= 这里）给：默认冻结时刻；--as-of 可显式钉快照时点
        asOf: { kind: "snapshot", value: String(args.flags["as-of"] || new Date().toISOString()) },
        engineVersion: "0.1.0",
        corpusVersion: "1.0",
        knownMaterialHashes: knownMaterialHashes(env, materialId),
      }).then((res): number => {
        const dir = specDir(env, `spec_${short(sha256(materialId))}`);
        mkdirSync(dir, { recursive: true });
        writeJson(join(dir, "prepare.json"), {
          material_id: materialId,
          created: new Date().toISOString(),
          verdict: res.verdict,
          rounds: res.rounds,
          rejected: res.rejected,
          diagnostics: res.diagnostics,
          materials_sha256: res.materials_sha256,
        });
        if (res.verdict === "ready" && res.spec) {
          writeJson(join(dir, "spec.json"), res.spec);
          writeJson(join(dir, "trace.json"), {
            material_id: materialId,
            spec_id: res.spec.spec_id,
            spec_version: res.spec.spec_version,
            units: res.spec.vu.map((v) => ({ id: v.id, title: v.title, source_clause: v.source_clause, severity: v.severity, checker: v.checker.type, expected_from: v.expected_from })),
            rejected: res.rejected,
          });
        }
        if (ctx.json) {
          console.log(JSON.stringify({ verdict: res.verdict, spec_id: res.spec?.spec_id, spec_version: res.spec?.spec_version, rounds: res.rounds, rejected: res.rejected.length, diagnostics: res.diagnostics }));
          return res.verdict === "ready" ? 0 : 1;
        }
        if (res.verdict === "ready") {
          out(ctx, `  ✓ prepared & frozen: ${res.spec?.spec_id} v${res.spec?.spec_version}  (${res.spec?.vu.length} unit(s), ${res.rounds} round(s))`);
          out(ctx, paint(C.dim, "  next: verify run " + res.spec?.spec_id + " --db <snapshot.sqlite>", ctx.color));
          return 0;
        }
        out(ctx, paint(C.red, `  ✗ not ready: ${res.verdict} — ${res.diagnostics.map((d) => `[${d.stage}] ${d.message}`).join("; ")}`, ctx.color));
        for (const r of res.rejected.slice(0, 5)) out(ctx, paint(C.dim, `    · [${r.stage}] ${r.reason}`, ctx.color));
        return 1;
      });
    }

    case "run": {
      const specId = rest[0];
      const dbPath = String(args.flags.db || "");
      if (!specId || !dbPath) {
        bad(ctx, "usage: verify run <spec-id> --db <snapshot.sqlite> [--submission <dir>]");
        return 2;
      }
      const specFile = join(specDir(env, specId), "spec.json");
      if (!existsSync(specFile)) {
        bad(ctx, `spec not found: ${specId} (prepare first)`);
        return 1;
      }
      const spec = readJson<VerifySpec>(specFile);
      const submission = args.flags.submission ? String(args.flags.submission) : undefined;
      let snap: { path: string; sha256: string; source: string };
      try {
        snap = snapshotCopy(dbPath);
      } catch (e: any) {
        bad(ctx, `cannot snapshot --db: ${e?.message || e}`);
        return 1;
      }
      const runner = new SqliteRunner(snap.path);
      return runVerify(spec, { runner, submissionDir: submission, mode: "open" })
        .then((report): number => {
          const withSource = { ...report, data_source: { kind: "sqlite-snapshot", sha256: snap.sha256, source: snap.source, captured_at: new Date().toISOString() } } as VerifyReport;
          withSource.payload_sha256 = payloadHash(withSource);
          const file = join(p.reports, `${report.run_id}.json`);
          writeJson(file, withSource);
          if (ctx.json) {
            console.log(JSON.stringify({ run_id: report.run_id, spec_id: report.spec_id, spec_version: report.verifier.spec_version, overall: report.overall, summary: report.summary, report_path: file }));
          } else {
            out(ctx, `  ${report.overall === "PASS" ? paint(C.green, "PASS", ctx.color) : report.overall === "FAIL" ? paint(C.red, "FAIL", ctx.color) : paint(C.yellow, report.overall, ctx.color)}  ${report.run_id}`);
            out(ctx, `  pass ${report.summary.pass} · fail ${report.summary.fail} · needs-material ${report.summary.needs_material} · error ${report.summary.error}`);
            const titles = new Map(spec.vu.map((u) => [u.id, u.title]));
            for (const v of report.vu) {
              const mark = v.verdict === "PASS" ? paint(C.green, "✓", ctx.color) : v.verdict === "FAIL" ? paint(C.red, "✗", ctx.color) : paint(C.yellow, "…", ctx.color);
              out(ctx, `    ${mark} ${v.id} ${v.verdict}${titles.get(v.id) ? `  ${titles.get(v.id)}` : ""}${"witness" in v && v.witness ? `  (scanned ${v.witness.rows_scanned} / matched ${v.witness.rows_matched})` : ""}`);
            }
            out(ctx, paint(C.dim, `  report: ${file}`, ctx.color));
          }
          return 0; // rc 只表达过程：FAIL 是有效结论
        })
        .catch((e: any): number => {
          bad(ctx, `run failed: ${e?.message || e}`);
          return 1;
        });
    }

    case "list": {
      const dirs = existsSync(p.specs) ? readdirSync(p.specs) : [];
      const rows = dirs
        .filter((d) => existsSync(join(p.specs, d, "spec.json")))
        .map((d) => {
          const spec = readJson<VerifySpec>(join(p.specs, d, "spec.json"));
          const prep = existsSync(join(p.specs, d, "prepare.json")) ? readJson<any>(join(p.specs, d, "prepare.json")) : {};
          const reports = existsSync(p.reports) ? readdirSync(p.reports).filter((f) => f.endsWith(".json")).map((f) => readJson<VerifyReport>(join(p.reports, f))).filter((r) => r.spec_id === spec.spec_id) : [];
          const last = reports.sort((a, b) => String(a.finished).localeCompare(String(b.finished))).pop();
          return { spec_id: spec.spec_id, version: spec.spec_version, title: spec.title, units: spec.vu.length, material: prep.material_id ?? "", runs: reports.length, last_overall: last?.overall ?? "", last_run: last?.run_id ?? "" };
        });
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) {
        out(ctx, paint(C.dim, "  no specs yet — verify submit → verify prepare", ctx.color));
        return 0;
      }
      table(ctx, rows, ["spec_id", "version", "units", "runs", "last_overall", "title"], []);
      return 0;
    }

    case "report": {
      const target = rest[0];
      if (!target) {
        bad(ctx, "usage: verify report <run-id> | verify report import <report.json>");
        return 2;
      }
      if (target === "import") {
        const file = rest[1];
        if (!file) {
          bad(ctx, "usage: verify report import <report.json>");
          return 2;
        }
        if (!existsSync(file)) {
          bad(ctx, `report file not found: ${file}`);
          return 1;
        }
        let report: VerifyReport;
        try {
          report = readJson<VerifyReport>(file);
        } catch (e: any) {
          bad(ctx, `report is not valid JSON: ${e?.message || e}`);
          return 1;
        }
        const problems: string[] = [];
        // 先验形状：整份报告缺 verifier/summary 时给"形状不对"，不要把 TypeError 当结论
        if (!report || typeof report !== "object" || !report.verifier || !report.summary) {
          problems.push("malformed report: missing verifier/summary — not a ygl-trees verify report");
        }
        const declared = report.payload_sha256 ?? "";
        const actual = problems.length ? "" : payloadHash({ ...report, payload_sha256: undefined } as VerifyReport);
        if (!declared) problems.push("payload tampered: report carries no payload_sha256");
        else if (declared !== actual) problems.push("payload tampered: payload_sha256 does not match the file contents");
        // 形状不对就别再往下摸字段：早退，给出可读结论（rc=1）
        if (problems.length) {
          if (ctx.json) console.log(JSON.stringify({ imported: false, problems }));
          else for (const pr of problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
          return 1;
        }
        const bin = report.verifier.binary_sha256;
        const regFile = join(p.registrations, `${bin ?? "unsigned"}.json`);
        if (bin) {
          if (!existsSync(regFile)) problems.push(`unknown verifier: binary ${String(bin).slice(0, 16)}… has no build registration`);
          else {
            const reg = readJson<{ spec_version?: number; engine_version?: string; corpus_version?: string }>(regFile);
            if (reg.spec_version !== undefined && report.verifier.spec_version !== undefined && reg.spec_version !== report.verifier.spec_version) problems.push(`version mismatch: report spec_version ${report.verifier.spec_version} ≠ registered ${reg.spec_version}`);
            if (reg.engine_version !== undefined && reg.engine_version !== report.verifier.engine_version) problems.push(`version mismatch: report engine_version ${report.verifier.engine_version} ≠ registered ${reg.engine_version}`);
            if (reg.corpus_version !== undefined && reg.corpus_version !== report.verifier.corpus_version) problems.push(`version mismatch: report corpus_version ${report.verifier.corpus_version} ≠ registered ${reg.corpus_version}`);
          }
        }
        if (problems.length) {
          if (ctx.json) console.log(JSON.stringify({ imported: false, problems }));
          else for (const pr of problems) out(ctx, paint(C.red, `  ✗ ${pr}`, ctx.color));
          return 1;
        }
        const stored = join(p.reports, `${report.run_id ?? `imported_${short(sha256(readFileSync(file)))}`}.json`);
        writeJson(stored, report);
        if (ctx.json) console.log(JSON.stringify({ imported: true, run_id: report.run_id, report_path: stored }));
        else out(ctx, `  ✓ report imported: ${report.run_id} → ${stored}`);
        return 0;
      }
      const file = join(p.reports, `${target}.json`);
      if (!existsSync(file)) {
        bad(ctx, `report not found: ${target}`);
        return 1;
      }
      const report = readJson<VerifyReport>(file);
      if (ctx.json) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      out(ctx, `  ${report.overall}  ${report.run_id}  (spec ${report.spec_id ?? "?"} v${report.verifier.spec_version})`);
      out(ctx, `  pass ${report.summary.pass} · fail ${report.summary.fail} · needs-material ${report.summary.needs_material} · error ${report.summary.error}`);
      for (const v of report.vu) out(ctx, `    ${v.verdict}  ${v.id}`);
      return 0;
    }

    case "trace": {
      const specId = rest[0];
      if (!specId) {
        bad(ctx, "usage: verify trace <spec-id>");
        return 2;
      }
      const file = join(specDir(env, specId), "trace.json");
      if (!existsSync(file)) {
        bad(ctx, `trace not found: ${specId} (was the spec prepared?)`);
        return 1;
      }
      const trace = readJson<any>(file);
      if (ctx.json) {
        console.log(JSON.stringify(trace, null, 2));
        return 0;
      }
      out(ctx, `  ${trace.spec_id} v${trace.spec_version}  ← material ${trace.material_id}`);
      for (const u of trace.units ?? []) out(ctx, `    ${u.id} [${u.severity}] ${u.checker}  “${String(u.source_clause).slice(0, 48)}”`);
      for (const r of trace.rejected ?? []) out(ctx, paint(C.dim, `    ✗ [${r.stage}] ${r.reason}`, ctx.color));
      return 0;
    }

    case "export": {
      const specId = rest[0];
      if (!specId) {
        bad(ctx, "usage: verify export <spec-id> [--out <file>]");
        return 2;
      }
      const src = join(specDir(env, specId), "spec.json");
      if (!existsSync(src)) {
        bad(ctx, `spec not found: ${specId}`);
        return 1;
      }
      const spec = readJson<VerifySpec>(src);
      const target = args.flags.out ? String(args.flags.out) : join(process.cwd(), `${specId}.yglverify.json`);
      writeJson(target, spec);
      if (ctx.json) console.log(JSON.stringify({ spec_id: spec.spec_id, version: spec.spec_version, path: target, sha256: sha256(readFileSync(target)) }));
      else out(ctx, `  ✓ exported ${spec.spec_id} v${spec.spec_version} → ${target}`);
      return 0;
    }

    default: {
      if (action) {
        bad(ctx, `unknown verify action: ${action}`);
        return 2;
      }
      out(ctx, "usage: verify submit|prepare|run|list|report|report import|trace|export");
      return 0;
    }
  }
}

function mimeOf(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

/** 建表 DDL → prepare 的 schema 探针（表 → 列名）。 */
function probeOf(ddl: string[]): { tables: Record<string, string[]> } {
  const tables: Record<string, string[]> = {};
  for (const sql of ddl) {
    const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z0-9_]+)["'`\]]?\s*\(([\s\S]*)\)/i);
    if (!m) continue;
    const cols: string[] = [];
    for (const raw of m[2].split(/,(?![^()]*\))/)) {
      const line = raw.trim();
      if (!line || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line)) continue;
      const name = line.match(/^["'`\[]?([A-Za-z0-9_]+)["'`\]]?/);
      if (name) cols.push(name[1]);
    }
    tables[m[1]] = cols;
  }
  return { tables };
}

function latestVersionOf(env: Env, materialId: string): number {
  const dir = specDir(env, `spec_${short(sha256(materialId))}`);
  const file = join(dir, "spec.json");
  if (!existsSync(file)) return 0;
  try {
    return Number(readJson<VerifySpec>(file).spec_version ?? 0);
  } catch {
    return 0;
  }
}

function knownMaterialHashes(env: Env, currentMaterialId: string): string[] {
  const dir = paths(env).materials;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d !== currentMaterialId)
    .map((d) => {
      try {
        return readJson<MaterialRecord>(join(dir, d, "material.json")).text_sha256;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}
