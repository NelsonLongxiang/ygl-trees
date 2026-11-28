import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runnerModule from "../../../verify/core/src/sqlite-runner";
import { draftRun, snapshotCopy } from "../src/verify-cmds";

/**
 * #327: draftRun builds SqliteRunner straight after snapshotCopy. When the
 * constructor throws (e.g. a path SQLite cannot open) the working copy must
 * still be removed and the failure returned rather than escaping.
 *
 * `verify run` is not the subject here: it probes --db several times before
 * building the runner, so a plain non-database file is rejected earlier and
 * never reaches that constructor over the CLI.
 */
describe("draftRun working-copy cleanup on runner construction failure (#327)", () => {
  const saved = { TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  let scratch = "";
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function source(): string {
    scratch = mkdtempSync(join(tmpdir(), "ygl-draft-327-"));
    process.env.TEMP = scratch;
    process.env.TMPDIR = scratch;
    const src = join(scratch, "source.sqlite");
    const db = new DatabaseSync(src);
    db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY); PRAGMA user_version=7");
    db.close();
    return src;
  }
  const left = (): string[] => {
    const dir = join(scratch, "ygl-verify-snapshots");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it("removes the copy and returns the error instead of throwing", async () => {
    const src = source();
    vi.spyOn(runnerModule, "SqliteRunner").mockImplementation(() => { throw new Error("synthetic open failure (#327)"); });
    const r = await draftRun({} as never, src, undefined, undefined);
    expect(r.report).toBeNull();
    expect(r.error).toContain("synthetic open failure");
    expect(left(), "a copy whose runner could not be built must be removed").toEqual([]);
  });

  it("does not touch a copy made by another caller", async () => {
    const src = source();
    const other = snapshotCopy(src);
    expect(existsSync(other.path)).toBe(true);
    vi.spyOn(runnerModule, "SqliteRunner").mockImplementation(() => { throw new Error("synthetic open failure (#327)"); });
    await draftRun({} as never, src, undefined, undefined);
    expect(existsSync(other.path), "another caller working copy is spared").toBe(true);
    other.cleanup();
  });
});
