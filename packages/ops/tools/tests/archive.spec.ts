import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_NAME_RE,
  appendRegistry,
  archiveFileName,
  buildArchive,
  collisionProblems,
  pathProblems,
  safeNameSegment,
  slugifyTitle,
  unarchivedRuns,
  utcStamp,
  verifyArchiveBytes,
} from "../src/archive";
import { readZipStore, writeZipStore } from "../src/zip-store";
import { payloadHash } from "../../../verify/core/src/engine";
import type { VerifyReport, VerifySpec } from "../../../verify/core/src/contract";

const sha = (s: string): string => require("node:crypto").createHash("sha256").update(s).digest("hex");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ygl-archive-"));
}

/** 最小可归档工作区：materials + specs + reports（与 CLI 落盘布局一致）。 */
function seedRun(root: string): { runId: string; specId: string } {
  const runId = "run_0123456789abcdef";
  const specId = "spec_abcdef123456";
  const matId = "mat_111122223333";

  mkdirSync(join(root, "materials", matId, "files"), { recursive: true });
  writeFileSync(join(root, "materials", matId, "material.txt"), "对账要求：账单金额不得为负。\n");
  writeFileSync(join(root, "materials", matId, "files", "aabbccddeeff-账单.xlsx"), Buffer.from("fake-xlsx-bytes"));
  writeFileSync(
    join(root, "materials", matId, "material.json"),
    JSON.stringify({ material_id: matId, title: "t", created: "2026-10-20T00:00:00.000Z", text_sha256: sha("x"), text_path: "material.txt", files: [{ path: "账单.xlsx", sha256: sha("f"), mime: "application/vnd.ms-excel", size: 3, stored: "aabbccddeeff-账单.xlsx" }] }),
  );

  const spec: VerifySpec = {
    contract_version: "1.0",
    spec_id: specId,
    spec_version: 3,
    title: "运费账单对账",
    domain: "freight",
    created: "2026-10-20T00:00:00.000Z",
    runtime_min: "0.1.0",
    verifier: { engine_version: "0.1.0", corpus_version: "1.0" },
    as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
    vu: [],
    attachments: [],
    materials_sha256: sha("materials"),
    sealed: { review: false },
  };
  mkdirSync(join(root, "specs", specId), { recursive: true });
  writeFileSync(join(root, "specs", specId, "spec.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(root, "specs", specId, "prepare.json"), JSON.stringify({ material_id: matId, materials_sha256: sha("materials") }, null, 2));

  const report = {
    contract_version: "1.0",
    run_id: runId,
    spec_id: specId,
    started: "2026-10-20T00:00:00.000Z",
    finished: "2026-10-20T00:00:01.000Z",
    verifier: { mode: "open", engine_version: "0.1.0", spec_version: 3, corpus_version: "1.0", sealed_review: false },
    as_of: spec.as_of,
    summary: { pass: 0, fail: 0, needs_material: 0, error: 0 },
    overall: "PASS",
    reason: "",
    vu: [],
    exceptions: [],
    data_source: { kind: "sqlite-snapshot", sha256: sha("db"), source: "db.sqlite", captured_at: "2026-10-20T00:00:00.000Z" },
  } as unknown as VerifyReport;
  report.payload_sha256 = payloadHash(report);
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", `${runId}.json`), JSON.stringify(report, null, 2));
  return { runId, specId };
}

describe("archive 命名规范（§7.1）", () => {
  it("文件名由 manifest 字段派生且匹配语法", () => {
    const name = archiveFileName({ domain: "freight", title: "Freight Bill Audit", specId: "spec_abcdef123456", specVersion: 3, created: "2026-10-20T00:30:15.123Z", runId: "run_0123456789abcdef" });
    expect(name).toBe("yglverify-freight-freight-bill-audit-v3-20261020T003015Z-r01234567.yglverify.zip");
    expect(name).toMatch(ARCHIVE_NAME_RE);
    expect(name.length).toBeLessThanOrEqual(120);
  });

  it("中文标题折叠为空时退化 s<spec 后 8 位>；非法 domain 退化 general", () => {
    const name = archiveFileName({ domain: "中文域", title: "运费账单对账", specId: "spec_abcdef123456", specVersion: 1, created: "2026-10-20T00:00:00.000Z", runId: "run_ffffffff00000000" });
    expect(name).toMatch(ARCHIVE_NAME_RE);
    expect(name).toContain("-general-sabcdef12-v1-");
    expect(slugifyTitle("Café résumé", "spec_x")).toBe("cafe-resume");
    expect(slugifyTitle("***", "spec_12345678")).toBe("s12345678");
  });

  it("utcStamp 固定 UTC 秒级形态", () => {
    expect(utcStamp("2026-10-20T00:30:15.999Z")).toBe("20261020T003015Z");
    expect(() => utcStamp("not-a-date")).toThrow(/invalid archive timestamp/);
  });
});

describe("archive 包内路径规范（§7.2）", () => {
  it("消毒：中文/空格/保留名/尾随点", () => {
    expect(safeNameSegment("aabbccddeeff-账单 2026.xlsx")).toBe("aabbccddeeff-_2026.xlsx");
    expect(safeNameSegment("CON")).toBe("_CON");
    expect(safeNameSegment("name.")).toBe("name");
    expect(safeNameSegment("...")).toBe("file");
  });

  it("拒绝对路径/反斜杠/越界/超深/非 ASCII", () => {
    expect(pathProblems("report.json")).toEqual([]);
    expect(pathProblems("/etc/passwd").length).toBeGreaterThan(0);
    expect(pathProblems("C:/x").length).toBeGreaterThan(0);
    expect(pathProblems("a\\b").length).toBeGreaterThan(0);
    expect(pathProblems("a/../../b").length).toBeGreaterThan(0);
    expect(pathProblems("a/b/c/d/e").length).toBeGreaterThan(0);
    expect(pathProblems("materials/mat/files/x.xlsx")).toEqual([]);
    expect(pathProblems("materials/mat/账单.txt").length).toBeGreaterThan(0);
    expect(pathProblems("a/lpt1.txt").length).toBeGreaterThan(0);
  });

  it("大小写/NFC 冲突检测（跨平台解压不互相覆盖）", () => {
    expect(collisionProblems(["a/x.txt", "a/y.txt"])).toEqual([]);
    expect(collisionProblems(["a/X.txt", "a/x.txt"]).length).toBe(1);
    expect(collisionProblems(["caf\u00e9.txt", "cafe\u0301.txt"]).length).toBe(1);
  });
});

describe("zip-store 确定性（§7.3）", () => {
  it("同内容不同顺序 → 同一字节；读回逐条 CRC 校验", () => {
    const a = writeZipStore([{ path: "b.txt", data: Buffer.from("B") }, { path: "a/x.txt", data: Buffer.from("A") }]);
    const b = writeZipStore([{ path: "a/x.txt", data: Buffer.from("A") }, { path: "b.txt", data: Buffer.from("B") }]);
    expect(a.equals(b)).toBe(true);
    const back = readZipStore(a);
    expect(back.map((e) => e.path)).toEqual(["a/x.txt", "b.txt"]);
    expect(back.map((e) => e.data.toString())).toEqual(["A", "B"]);
  });

  it("非 ASCII 路径、重复条目、坏 CRC 都拒绝", () => {
    expect(() => writeZipStore([{ path: "账.txt", data: Buffer.from("x") }])).toThrow(/portable ASCII/);
    expect(() => writeZipStore([{ path: "a", data: Buffer.from("1") }, { path: "a", data: Buffer.from("2") }])).toThrow(/duplicate/);
    const zip = writeZipStore([{ path: "a.txt", data: Buffer.from("hello") }]);
    const idx = zip.indexOf(Buffer.from("hello"));
    zip[idx] = "H".charCodeAt(0);
    expect(() => readZipStore(zip)).toThrow(/crc mismatch/);
  });
});

describe("buildArchive + verifyArchiveBytes（§7.4）", () => {
  it("归档 → 校验全链通过，manifest 形状稳定", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const built = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    expect(built.filename).toMatch(ARCHIVE_NAME_RE);
    // 默认落点：$YGL_HOME/verify/archives/，不污染调用者 cwd
    expect(built.path).toBe(join(root, "archives", built.filename));
    const res = verifyArchiveBytes(readFileSync(built.path));
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.manifest?.format_version).toBe(ARCHIVE_FORMAT_VERSION);
    // 形状守卫：manifest 顶层键集合是契约的一部分（加字段要升 format_version）
    expect(Object.keys(res.manifest ?? {}).sort()).toEqual([
      "archive_id", "archive_sha256", "as_of", "contract_version", "corpus_version", "created", "data_source",
      "engine_version", "filename", "format_version", "items", "materials_sha256", "payload_sha256", "run_id",
      "spec", "with",
    ]);
    expect(res.manifest?.items.map((i) => i.role).sort()).toEqual(["attachment", "material", "prepare", "report", "spec"]);
    // 附件原始名进 manifest（包内名 ASCII 化）
    const att = res.manifest?.items.find((i) => i.role === "attachment");
    expect(att?.path).toMatch(/^materials\/mat_111122223333\/files\/[A-Za-z0-9._-]+$/);
    expect(att?.original_name).toBe("账单.xlsx");
  });

  it("篡改报告字节 → payload 不一致；篡改附件 → item 哈希不一致", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const built = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    const entries = readZipStore(readFileSync(built.path));

    const tamperedReport = entries.map((e) => (e.path === "report.json" ? { ...e, data: Buffer.from(e.data.toString().replace('"PASS"', '"FAIL"')) } : e));
    const r1 = verifyArchiveBytes(writeZipStore(tamperedReport));
    expect(r1.ok).toBe(false);
    expect(r1.problems.some((p) => /item hash mismatch: report\.json/.test(p))).toBe(true);

    const tamperedAtt = entries.map((e) => (e.path.includes("/files/") ? { ...e, data: Buffer.from("evil") } : e));
    const r2 = verifyArchiveBytes(writeZipStore(tamperedAtt));
    expect(r2.ok).toBe(false);
    expect(r2.problems.some((p) => /item hash mismatch: materials\/.*files\//.test(p))).toBe(true);
  });

  it("未声明的额外条目、缺 manifest、改名 → 各自点名", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const built = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    const entries = readZipStore(readFileSync(built.path));

    const extra = verifyArchiveBytes(writeZipStore([...entries, { path: "extra.txt", data: Buffer.from("x") }]));
    expect(extra.ok).toBe(false);
    expect(extra.problems.some((p) => /undeclared entry/.test(p))).toBe(true);

    const noManifest = verifyArchiveBytes(writeZipStore(entries.filter((e) => e.path !== "manifest.json")));
    expect(noManifest.ok).toBe(false);
    expect(noManifest.problems).toContain("missing manifest.json");

    const renamed = { ...entries.find((e) => e.path === "manifest.json")! };
    const manifest = JSON.parse(renamed.data.toString());
    renamed.data = Buffer.from(JSON.stringify({ ...manifest, filename: "custom-name.zip" }, null, 2));
    const r3 = verifyArchiveBytes(writeZipStore([renamed, ...entries.filter((e) => e.path !== "manifest.json")]));
    expect(r3.ok).toBe(false); // manifest 改了 → archive_sha256 不再匹配
    expect(r3.problems.some((p) => /archive_sha256 mismatch/.test(p))).toBe(true);
  });

  it("材料缺失时 buildArchive 报可读错误（fail-closed，不产半包）", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const { rmSync } = require("node:fs");
    rmSync(join(root, "materials"), { recursive: true, force: true });
    expect(() => buildArchive({ verifyRoot: root, runId, with: ["materials"] })).toThrow(/materials not found|attachment missing/);
  });
});

describe("r12 残余 G1/G4/G5（确定性与 fail-closed）", () => {
  it("G1 未显式给 created 时，同一 run 两次归档字节一致", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const a = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    const b = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    expect(b.zip_sha256).toBe(a.zip_sha256);
    expect(b.path).toBe(a.path);
    // created 从 report.finished 派生（不是 now()）
    expect(a.manifest.created).toBe("2026-10-20T00:00:01.000Z");
  });

  it("G4 报告没有 payload_sha256 → 拒绝归档（不产出必红的包）", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const reportPath = join(root, "reports", `${runId}.json`);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    delete report.payload_sha256;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    expect(() => buildArchive({ verifyRoot: root, runId, with: ["materials"] })).toThrow(/payload_sha256/);
  });

  it("G5 归档内 report 的 engine_version 与 manifest 不一致 → 点名", () => {
    const root = scratch();
    const { runId } = seedRun(root);
    const built = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    const entries = readZipStore(readFileSync(built.path));
    const tampered = entries.map((e) => {
      if (e.path !== "report.json") return e;
      const report = JSON.parse(e.data.toString("utf8"));
      report.verifier.engine_version = "9.9.9";
      return { path: e.path, data: Buffer.from(JSON.stringify(report, null, 2)) };
    });
    const res = verifyArchiveBytes(writeZipStore(tampered));
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /engine_version mismatch/.test(p))).toBe(true);
  });
});

describe("归档侧车登记（报告保持不可变）", () => {
  it("appendRegistry 后 unarchivedRuns 不再列出该 run", () => {
    const root = scratch();
    const { runId, specId } = seedRun(root);
    expect(unarchivedRuns(root).map((r) => r.run_id)).toContain(runId);
    const built = buildArchive({ verifyRoot: root, runId, with: ["materials"] });
    appendRegistry(root, runId, { id: specId, version: 3 }, {
      archive_id: built.manifest.archive_id,
      archive_sha256: built.manifest.archive_sha256,
      zip_sha256: built.zip_sha256,
      filename: built.filename,
      path: built.path,
      created: built.manifest.created,
      with: built.manifest.with,
    });
    expect(unarchivedRuns(root).map((r) => r.run_id)).not.toContain(runId);
    // 报告字节未被归档改写（payload 仍自洽）
    const report = JSON.parse(readFileSync(join(root, "reports", `${runId}.json`), "utf8"));
    expect(report.payload_sha256).toBe(payloadHash(report));
  });
});
