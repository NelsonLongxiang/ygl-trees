/** #62 (release/verify-seat report): material encoding must be fail-closed.
 *  - UTF-8 BOM: strip + record `text_encoding` so the first clause is not lost
 *  - UTF-16 (BOM or NUL pattern): rc=2 with an explicit "转码为 UTF-8" message,
 *    never freeze mojibake that later reports a misleading P1 fabrication. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    cwd: HOME,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "enc" },
    timeout: 60_000,
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim() };
}

describe.skipIf(!HAS_BIN)("verify submit material encoding (#62)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-verify-enc-"));
    expect(jrun(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("UTF-8 BOM is stripped, first clause survives, text_encoding recorded", () => {
    const f = join(HOME, "bom.md");
    writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("S1 账单金额不得为负。\nS2 每期须附原件。\n", "utf8")]));
    const r = jrun(["verify", "submit", "--title", "bom", "--text", f]);
    expect(r.rc, r.out).toBe(0);
    const mid = r.j.material_id as string;
    const rec = JSON.parse(readFileSync(join(HOME, "verify", "materials", mid, "material.json"), "utf8"));
    expect(rec.text_encoding).toBe("utf-8-bom-stripped");
    expect(readFileSync(join(HOME, "verify", "materials", mid, "material.txt"), "utf8")).toMatch(/^S1 账单金额不得为负。/);
  });

  it("UTF-16 BOM is refused rc=2 with an explicit transcode message", () => {
    const f = join(HOME, "utf16.md");
    writeFileSync(f, Buffer.from("\uFEFFS1 账单金额不得为负。\n", "utf16le"));
    const r = jrun(["verify", "submit", "--title", "u16", "--text", f]);
    expect(r.rc).toBe(2);
    expect(String(r.j?.error)).toMatch(/UTF-16/);
    expect(String(r.j?.error)).toMatch(/转码为 UTF-8/);
  });

  it("UTF-16 without BOM (NUL pattern) is refused rc=2", () => {
    const f = join(HOME, "utf16-nobom.md");
    writeFileSync(f, Buffer.from("S1 账单金额不得为负。\nS2 每期须附原件。\n", "utf16le"));
    const r = jrun(["verify", "submit", "--title", "u16n", "--text", f]);
    expect(r.rc).toBe(2);
    expect(String(r.j?.error)).toMatch(/UTF-16\/NUL/);
  });

  it("#69: lint --text with BOM material does not silently lose first clause", () => {
    // 与 submit 同源：BOM 剥除后首条子句 S1 保留（#69 前直接 utf8 读入 → S1 蒸发）
    const mat = join(HOME, "bom-lint.md");
    writeFileSync(mat, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("S1 首条判据。\n", "utf8")]));
    const cand = join(HOME, "cand-lint.json");
    writeFileSync(cand, JSON.stringify([{ source_clause: "S1 首条判据。", anchor: { quote: "S1 首条判据。", locator: "m:1" } }]));
    const r = jrun(["verify", "lint-candidates", cand, "--text", mat]);
    expect(r.rc).toBe(0);
    // S1 应被 P1 命中（verbatim 匹配成功——BOM 已剥）
    expect(JSON.stringify(r.j)).not.toMatch(/not a verbatim excerpt/);
  });
});
