/**
 * GitHub #53: the native driver (0.114.12+) makes PRAGMA journal_mode=WAL real;
 * opening a pre-0.114.12 workspace (DELETE mode) converts it, which the old wasm
 * driver cannot reopen. Pin the upgrade notice + the legacy escape hatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, ...extraEnv },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function mode(): string {
  const db = new DatabaseSync(join(HOME, "ygl-trees.db"));
  try {
    return String((db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toLowerCase();
  } finally {
    db.close();
  }
}

describe.skipIf(!HAS_BIN)("journal_mode upgrade notice (#53)", () => {
  beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ygl-journal-")); });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("fresh workspace: no migration notice, WAL by default", () => {
    const init = run(["db", "init"]);
    expect(init.rc).toBe(0);
    expect(init.err).not.toMatch(/journal_mode/);
    expect(mode()).toBe("wal");
  });

  it("legacy workspace: first normal open converts with a stderr notice", () => {
    // rebuild as a pre-0.114.12 style workspace (DELETE)
    rmSync(join(HOME, "ygl-trees.db"), { force: true });
    const legacy = run(["db", "init"], { YGL_LEGACY_JOURNAL: "1" });
    expect(legacy.rc).toBe(0);
    expect(mode()).toBe("delete");

    const up = run(["db", "stats"]);
    expect(up.rc).toBe(0);
    expect(up.err).toMatch(/journal_mode delete → wal/);
    expect(up.err).toMatch(/YGL_LEGACY_JOURNAL=1/);
    expect(mode()).toBe("wal");
  });

  it("switch back works even with another idle connection open (checkpoint retry)", () => {
    // WAL->DELETE needs an exclusive moment; an idle holder used to make the
    // pragma silently return "wal". The constructor checkpoints, retries, and
    // (if truly blocked) prints a BLOCKED warning instead of a no-op.
    const holder = new DatabaseSync(join(HOME, "ygl-trees.db"));
    try {
      const back = run(["db", "stats"], { YGL_LEGACY_JOURNAL: "1" });
      expect(back.rc).toBe(0);
      expect(mode()).toBe("delete");
    } finally {
      holder.close();
    }
  });

  it("YGL_LEGACY_JOURNAL=1 switches back (downgrade escape hatch)", () => {
    expect(run(["db", "stats"]).rc).toBe(0); // (re)enter WAL first
    expect(mode()).toBe("wal");
    const back = run(["db", "stats"], { YGL_LEGACY_JOURNAL: "1" });
    expect(back.rc).toBe(0);
    expect(back.err).toMatch(/journal_mode wal → delete/);
    expect(mode()).toBe("delete");
  });
});
