/**
 * #171 第1项：便携导出/回装的单元契约。
 *
 * 这里直接驱动 `verify-portable` 模块（不起 CLI、不跑 checker）：用最小但合法的 home 记录
 * 构造 A 家，导出便携件，再回装到全新 B 家，覆盖往返、重复、冲突、篡改与路径安全。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildPortable, decodePortable, importPortable, PORTABLE_FORMAT, PORTABLE_VERSION, portableToText, specIdOf } from "../src/verify-portable";

const ROOT = mkdtempSync(join(tmpdir(), "ygl-portable-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const env = (home: string) => ({ home } as any);

interface Seed {
  home: string;
  materialId: string;
  specId: string;
  textSha: string;
}

/** 在 home 里落一份最小合法冻结件（material + spec + prepare），返回身份。 */
function seed(home: string, opts: { version?: number; text?: string; idSeed?: string } = {}): Seed {
  const text = opts.text ?? "账单总额须等于申报总额。\n";
  const textSha = sha(text);
  const materialId = "mat_" + sha("m" + (opts.idSeed ?? home)).slice(0, 12);
  const specId = specIdOf(materialId);
  const mdir = join(home, "verify", "materials", materialId);
  const sdir = join(home, "verify", "specs", specId);
  mkdirSync(mdir, { recursive: true });
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(mdir, "material.txt"), text);
  writeFileSync(join(mdir, "material.json"), JSON.stringify({
    material_id: materialId,
    title: "t",
    created: "2026-10-20T00:00:00.000Z",
    text_sha256: textSha,
    text_path: "material.txt",
    files: [],
  }, null, 2));
  writeFileSync(join(sdir, "spec.json"), JSON.stringify({
    spec_id: specId,
    spec_version: opts.version ?? 16,
    as_of: { kind: "snapshot", value: "2026-10-24T00:00:00.000Z" },
    created: "2026-10-24T00:00:00.000Z",
    materials_sha256: textSha,
    schema_fingerprint: "sha256:deadbeef",
  }, null, 2));
  writeFileSync(join(sdir, "prepare.json"), JSON.stringify({ spec_id: specId, spec_version: opts.version ?? 16, material_id: materialId, ready: true }, null, 2));
  return { home, materialId, specId, textSha };
}

function exportTo(seedInfo: Seed, file: string): any {
  const bundle = buildPortable(env(seedInfo.home), seedInfo.specId);
  writeFileSync(file, portableToText(bundle));
  return bundle;
}

describe("#171 portable frozen-spec export/import", () => {
  it("导出件带 format/version/entries/digest，且 prepare 缺失时拒绝导出", () => {
    const a = seed(join(ROOT, "a1"));
    const bundle = exportTo(a, join(ROOT, "a1.yglverify.json"));
    expect(bundle.format).toBe(PORTABLE_FORMAT);
    expect(bundle.format_version).toBe(PORTABLE_VERSION);
    expect(bundle.spec_id).toBe(a.specId);
    expect(bundle.spec_version).toBe(16);
    expect(bundle.material_id).toBe(a.materialId);
    expect(bundle.entries.map((e: any) => e.role).sort()).toEqual(["material", "material-text", "prepare", "spec"]);
    expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);

    const b = seed(join(ROOT, "a2"));
    rmSync(join(b.home, "verify", "specs", b.specId, "prepare.json"));
    expect(() => buildPortable(env(b.home), b.specId)).toThrow(/prepare\.json missing/);
  });

  it("A 导出 → B 回装 → B 再导出：digest/entries/payload 逐字节一致，spec_version 不被重置", () => {
    const a = seed(join(ROOT, "rt-a"));
    const file = join(ROOT, "rt.yglverify.json");
    const first = exportTo(a, file);

    const bHome = join(ROOT, "rt-b");
    const res = importPortable(env(bHome), file);
    expect(res.rc).toBe(0);
    expect(res.duplicate).toBeUndefined();
    expect(res.spec_id).toBe(a.specId);
    expect(res.spec_version).toBe(16);

    const second = buildPortable(env(bHome), a.specId);
    expect(second.digest).toBe(first.digest);
    expect(second.entries).toEqual(first.entries);
    expect(second.payload).toEqual(first.payload);
    expect(second.exported.at).not.toBe(first.exported.at);
  });

  it("重复回装同一件 → rc0 duplicate:true，字节不变", () => {
    const a = seed(join(ROOT, "dup-a"));
    const file = join(ROOT, "dup.yglverify.json");
    exportTo(a, file);
    const bHome = join(ROOT, "dup-b");
    expect(importPortable(env(bHome), file).rc).toBe(0);
    const again = importPortable(env(bHome), file);
    expect(again.rc).toBe(0);
    expect(again.duplicate).toBe(true);
  });

  it("同 spec_id 不同冻结字节 → rc1 冲突，保留原件不覆盖", () => {
    const aHome = join(ROOT, "cf-a");
    const a = seed(aHome);
    const file = join(ROOT, "cf.yglverify.json");
    exportTo(a, file);
    const bHome = join(ROOT, "cf-b");
    expect(importPortable(env(bHome), file).rc).toBe(0);

    // 同一 material 身份、版本更高的导出件（模拟别处 v17）
    const other = join(ROOT, "cf-a-v17");
    const sameIds = seed(other, { version: 17, idSeed: aHome });
    const bumped = buildPortable(env(other), sameIds.specId);
    const v17file = join(ROOT, "cf-v17.yglverify.json");
    writeFileSync(v17file, portableToText(bumped));
    const res = importPortable(env(bHome), v17file);
    expect(res.rc).toBe(1);
    expect(res.error).toMatch(/conflict/);
    expect(JSON.parse(readFileSync(join(bHome, "verify", "specs", a.specId, "spec.json"), "utf8")).spec_version).toBe(16);
  });

  it("篡改 payload 字节 / 清单摘要 → rc2 拒绝且不落位", () => {
    const a = seed(join(ROOT, "tm-a"));
    const file = join(ROOT, "tm.yglverify.json");
    const bundle = exportTo(a, file);

    const tampered = JSON.parse(readFileSync(file, "utf8"));
    const entry = tampered.entries.find((e: any) => e.role === "material-text");
    tampered.payload[entry.path] = Buffer.from("被改过的材料文本").toString("base64");
    const bad = join(ROOT, "tm-bad.yglverify.json");
    writeFileSync(bad, JSON.stringify(tampered));
    const bHome = join(ROOT, "tm-b");
    const res = importPortable(env(bHome), bad);
    expect(res.rc).toBe(2);
    expect(res.error).toMatch(/size mismatch|sha256 mismatch/);
    expect(existsSync(join(bHome, "verify", "specs", a.specId))).toBe(false);

    const digestBad = { ...bundle, digest: "0".repeat(64) };
    const digestFile = join(ROOT, "tm-digest.yglverify.json");
    writeFileSync(digestFile, JSON.stringify(digestBad));
    expect(importPortable(env(join(ROOT, "tm-c")), digestFile).rc).toBe(2);
  });

  it("路径穿越 / 未知 role / 重复路径 → rc2 拒绝", () => {
    const a = seed(join(ROOT, "pv-a"));
    const file = join(ROOT, "pv.yglverify.json");
    const bundle = exportTo(a, file);
    const bHome = join(ROOT, "pv-b");

    for (const mutate of [
      (x: any) => { x.entries[0].path = "../escape.json"; },
      (x: any) => { x.entries[0].role = "payload"; },
      (x: any) => { x.entries[1].path = x.entries[0].path; },
    ]) {
      const copy = JSON.parse(JSON.stringify(bundle));
      mutate(copy);
      const f = join(ROOT, "pv-bad.yglverify.json");
      writeFileSync(f, JSON.stringify(copy));
      const res = importPortable(env(bHome), f);
      expect(res.rc).toBe(2);
      expect(existsSync(join(bHome, "verify", "specs", a.specId))).toBe(false);
    }
  });

  it("旧裸 spec 导出件被拒绝并指路 --portable 重导", () => {
    const a = seed(join(ROOT, "bare-a"));
    const bare = join(ROOT, "bare.yglverify.json");
    writeFileSync(bare, JSON.stringify(JSON.parse(readFileSync(join(a.home, "verify", "specs", a.specId, "spec.json"), "utf8"))));
    const res = importPortable(env(join(ROOT, "bare-b")), bare);
    expect(res.rc).toBe(2);
    expect(res.error).toMatch(/--portable/);
  });

  it("decodePortable 对合法件不抛错", () => {
    const a = seed(join(ROOT, "ok-a"));
    const file = join(ROOT, "ok.yglverify.json");
    const bundle = exportTo(a, file);
    expect(() => decodePortable(bundle)).not.toThrow();
  });
});
