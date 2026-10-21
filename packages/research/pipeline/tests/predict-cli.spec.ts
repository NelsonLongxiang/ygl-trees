/**
 * F6 (0.110.0): settlement calendar on the predict surface.
 *
 * - `research predict list` projects `due` / `days_left` and filters with `--due`
 * - `research predict audit` buckets rows into due/near/future and filters with `--due`
 * - unknown flags are usage errors (rc=2, single JSON error object) instead of
 *   being silently ignored (the 0.109.1 ticket: `--due` read as "nothing due")
 *
 * days_left definition (frozen here): floor((deadline - as_of) / 86_400s), both
 * deadline and as_of parsed at UTC midnight; near = 1..30 days inclusive,
 * future = 31+, due = 0 or negative.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = (() => {
  try {
    return spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function jrun(args: string[]) {
  const r = run(args);
  let j: any = null;
  try {
    j = JSON.parse(r.out);
  } catch {
    j = null;
  }
  return { rc: r.rc, j, raw: r.out };
}

function addClaim(text: string, channel = "review-rounds") {
  return jrun(["research", "claim", "add", text, "--channel", channel, "--json"]);
}

function setCreatedLike(textLike: string, created: string) {
  const db = new DatabaseSync(resolve(HOME, "ygl-trees.db"));
  db.prepare("UPDATE claims SET created=? WHERE text LIKE ?").run(created, textLike);
  db.close();
}

describe.skipIf(!HAS_BIN)("F6 predict settlement calendar (0.110.0)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-predict-f6-"));
    run(["db", "init"]);
    run(["project", "new", "alpha"]);
    // due: created 2026-10-10 + 7d → deadline 2026-10-17 (past)
    addClaim("[预测·7天] 到期探测");
    // near boundary: created today, horizon 30 → deadline = today+30 (exactly 30 → near)
    addClaim("[预测·30天] 临近边界");
    // future boundary: created today, horizon 31 → deadline = today+31 (31 → future)
    addClaim("[预测·31天] 未来边界");
    setCreatedLike("%到期探测%", "2026-10-10T00:00:00.000Z");
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("projects due/days_left and filters --due", () => {
    const all = jrun(["research", "predict", "list", "--all", "--json"]);
    expect(all.rc).toBe(0);
    expect(Array.isArray(all.j)).toBe(true);
    const dueRow = all.j.find((r: any) => r.text.includes("到期探测"));
    expect(dueRow).toMatchObject({ deadline: "2026-10-17", due: true, days_left: -4 });

    const dueOnly = jrun(["research", "predict", "list", "--all", "--due", "--json"]);
    expect(dueOnly.rc).toBe(0);
    expect(dueOnly.j.map((r: any) => r.text)).toEqual([expect.stringContaining("到期探测")]);
    expect(dueOnly.j.every((r: any) => r.due === true)).toBe(true);
  });

  it("buckets audit rows into due/near/future (near = 1..30 days inclusive)", () => {
    const audit = jrun(["research", "predict", "audit", "--offline", "--all", "--json"]);
    expect(audit.rc).toBe(0);
    expect(Array.isArray(audit.j)).toBe(true);
    const rows = audit.j as any[];
    // 2026-10-10 + 7d → deadline in the past
    const dueRow = rows.find((r) => r.days_left === -4);
    expect(dueRow?.bucket).toBe("due");
    // boundary literals: 30 → near, 31 → future
    const nearRow = rows.find((r) => r.days_left === 30);
    const futureRow = rows.find((r) => r.days_left === 31);
    expect(nearRow?.bucket).toBe("near");
    expect(futureRow?.bucket).toBe("future");
  });

  it("audit --due keeps only the due bucket and exits 0 on an empty set", () => {
    const due = jrun(["research", "predict", "audit", "--offline", "--due", "--json"]);
    expect(due.rc).toBe(0);
    expect(Array.isArray(due.j)).toBe(true);
    expect(due.j.length).toBeGreaterThan(0);
    expect(due.j.every((r: any) => r.bucket === "due")).toBe(true);
  });

  it("unknown flags are usage errors, not silent no-ops", () => {
    for (const args of [
      ["research", "predict", "list", "--bogus"],
      ["research", "predict", "audit", "--bogus"],
      ["research", "predict", "list", "--du"],
    ]) {
      const r = jrun([...args, "--json"]);
      expect(r.rc).toBe(2);
      expect(r.j).toHaveProperty("error");
      expect(String(r.j.error)).toMatch(/unknown flag/);
    }
  });
});
