/**
 * Batch-16 user observation: kb_notes vs kb_fts drift in a high-concurrency
 * import workspace. `kb rm` used to delete the shadow and the base row with two
 * autocommit statements — a crash/busy error between them desyncs FTS. The
 * removal now runs through the transactional write service; this spec pins both
 * the single-command invariant and the concurrent-add invariant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "kb-fts-test" },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function counts(): { base: number; fts: number; events: number; added: number } {
  const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
  try {
    return {
      base: Number((db.prepare("SELECT COUNT(*) c FROM kb_notes").get() as any).c),
      fts: Number((db.prepare("SELECT COUNT(*) c FROM kb_fts").get() as any).c),
      events: Number((db.prepare("SELECT COUNT(*) c FROM events WHERE kind='kb.rm'").get() as any).c),
      // events whose entity still exists (the earlier rm test removed one note)
      added: Number((db.prepare("SELECT COUNT(*) c FROM events e JOIN kb_notes n ON n.id=e.entity_id WHERE e.kind='kb.add'").get() as any).c),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!HAS_BIN)("kb FTS transactional removal (batch 16)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-kbfts-"));
    expect(run(["db", "init"]).rc).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("kb rm removes base + FTS + links in one transaction and logs kb.rm", () => {
    const add = run(["kb", "add", "--title", "转移测试", "--body", "正文", "--tags", "t"]);
    expect(add.rc).toBe(0);
    const id = add.j.id as string;
    expect(counts()).toMatchObject({ base: 1, fts: 1 });

    const rm = run(["kb", "rm", id]);
    expect(rm.rc).toBe(0);
    expect(counts()).toMatchObject({ base: 0, fts: 0, events: 1 });

    const doc = run(["doctor"]);
    expect(doc.rc).toBe(0);
  });

  it("concurrent kb add: every dual write lands in the same transaction (base == fts)", async () => {
    const N = 12;
    const children = Array.from({ length: N }, (_, i) => {
      const args = [BIN, "kb", "add", "--title", `并发-${i}`, "--body", `正文 ${i}`, "--json"];
      return new Promise<number>((resolveRc) => {
        const c = spawn(process.execPath, args, {
          env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "kb-fts-test" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (out += d));
        c.on("close", (code) => {
          if (code !== 0) console.error(`kb add ${i} failed: ${out.slice(0, 160)}`);
          resolveRc(code ?? -1);
        });
      });
    });
    const rcs = await Promise.all(children);
    expect(rcs.every((rc) => rc === 0)).toBe(true);
    const c = counts();
    expect(c.base).toBeGreaterThanOrEqual(N);
    expect(c.fts).toBe(c.base);
    // #51: no committed event row may be lost under concurrent writers.
    expect(c.added).toBe(c.base);
  });
});
