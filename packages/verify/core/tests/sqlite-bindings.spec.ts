import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabaseSync } from "../src/sqlite-bindings";

// #327: SQLite's Win32 open rejects an absolute path past MAX_PATH. The binding
// must hand it the namespaced form while leaving the on-disk path untouched.
describe("openDatabaseSync (#327 long paths)", () => {
  const roots: string[] = [];
  const scratch = (): string => {
    // tmpdir() is repointed by the global tmpdir guard into <repo>/tmp/test-runs/, so
    // scratch stays inside the project (repo rule: never the system temp directory).
    const r = mkdtempSync(join(tmpdir(), "sqlite-long-"));
    roots.push(r);
    return r;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** A real SQLite file whose absolute path is past MAX_PATH, created through the raw node:sqlite ctor. */
  function longSource(): { file: string; length: number } {
    const root = scratch();
    const dir = join(root, "d".repeat(200));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s".repeat(60) + ".sqlite");
    expect(file.length).toBeGreaterThan(260);
    const src = new DatabaseSync(toNamespacedPath(file));
    src.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES (7);");
    src.close();
    return { file, length: file.length };
  }

  it.skipIf(process.platform !== "win32")("opens a real file whose absolute path exceeds MAX_PATH and reads it back", () => {
    const { file, length } = longSource();
    const db = openDatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM t").get()).toEqual({ id: 7 });
    } finally {
      db.close();
    }
    expect(length).toBeGreaterThan(260);
  });

  it.skipIf(process.platform !== "win32")("a path that is already namespaced is not prefixed twice", () => {
    const { file } = longSource();
    const db = openDatabaseSync(toNamespacedPath(file), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("leaves :memory: untouched on every platform", () => {
    const mem = openDatabaseSync(":memory:");
    try {
      mem.exec("CREATE TABLE x(a)");
      expect(mem.prepare("SELECT 1 AS v").get()).toEqual({ v: 1 });
    } finally {
      mem.close();
    }
  });

  it("does not namespace a path that the running platform does not treat as absolute", () => {
    // On win32 "/x" is drive-relative rather than absolute, so the binding must
    // pass it through unchanged; opening it then fails exactly like the raw ctor.
    if (process.platform !== "win32") return;
    const relative = "/" + "p".repeat(300) + "/x.sqlite";
    const raw = (() => { try { new DatabaseSync(relative); return "opened"; } catch { return "threw"; } })();
    const bound = (() => { try { openDatabaseSync(relative); return "opened"; } catch { return "threw"; } })();
    expect(bound).toBe(raw);
    expect(raw).toBe("threw");
  });

  it("keeps the on-disk path and the caller-visible path identical", () => {
    const root = scratch();
    const file = join(root, "plain.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE y(b); INSERT INTO y VALUES (1)");
    db.close();
    const again = openDatabaseSync(file, { readOnly: true });
    try {
      expect(again.prepare("SELECT count(*) AS n FROM y").get()).toEqual({ n: 1 });
    } finally {
      again.close();
    }
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith("plain.sqlite-"))).toEqual([]);
  });
});
