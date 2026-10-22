/**
 * GitHub #50: write commands' --json SUCCESS paths must be one JSON object.
 * Six verbs used to print their human ack into the machine channel (the error
 * paths and most writes were already compliant).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "json-paths" },
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe.skipIf(!HAS_BIN)("--json success paths (#50)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-jsonpaths-"));
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("kb link / promote: single object", () => {
    const a = run(["kb", "add", "--title", "甲", "--body", "正文甲"]);
    const b = run(["kb", "add", "--title", "乙", "--body", "正文乙"]);
    const link = run(["kb", "link", a.j.id, b.j.id]);
    expect(link.rc).toBe(0);
    expect(Object.keys(link.j).sort()).toEqual(["a", "b", "rel"]);
    expect(link.j.a).toMatchObject({ id: a.j.id });

    const promote = run(["kb", "promote", a.j.id, "--name", "甲技能"]);
    expect(promote.rc).toBe(0);
    expect(promote.j).toMatchObject({ name: "甲技能", origin: `kb:${a.j.id}` });
  });

  it("db export / webui export: path + bytes", () => {
    const dump = run(["db", "export", join(HOME, "dump.sql")]);
    expect(dump.rc).toBe(0);
    expect(dump.j).toMatchObject({ path: join(HOME, "dump.sql") });
    expect(typeof dump.j.bytes).toBe("number");

    const web = run(["webui", "export", "--out", join(HOME, "snapshot.json")]);
    expect(web.rc).toBe(0);
    expect(web.j).toMatchObject({ path: join(HOME, "snapshot.json") });
    expect(typeof web.j.bytes).toBe("number");
  });

  it("skill refs add / show: single object (content null when absent)", () => {
    const add = run(["skill", "add", "--name", "s1", "--description", "d", "--body", "b"]);
    expect(add.rc).toBe(0);
    const refAdd = run(["skill", "refs", "add", "s1", "docs/x.md", "--body", "ref-body"]);
    expect(refAdd.rc).toBe(0);
    expect(refAdd.j).toMatchObject({ skill: "s1", path: "docs/x.md" });
    const refShow = run(["skill", "refs", "show", "s1", "docs/x.md"]);
    expect(refShow.rc).toBe(0);
    expect(refShow.j).toMatchObject({ skill: "s1", path: "docs/x.md", content: "ref-body" });
  });
});
