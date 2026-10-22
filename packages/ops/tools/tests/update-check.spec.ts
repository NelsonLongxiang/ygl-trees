/**
 * 0.114.6 (#40, owner 2026-10-22 10:01 / fdc757f6 八条): informational CLI
 * version nag. It is NOT the R5b audit clock (#29): cache-only, stderr-only,
 * never gates, never touches stdout/JSON, silent offline, silent in scheduler
 * context, one prompt per npm latest, 24h TTL for the detached refresh.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cachePath,
  compareVersions,
  maybeNag,
  maybeRefresh,
  readCache,
  updateHintFromCache,
  updateCheckDisabled,
} from "../src/update-check";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

const local = () => JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).version as string;

let HOME = "";

function seed(latest: string, extra: Record<string, unknown> = {}) {
  writeFileSync(cachePath(HOME), JSON.stringify({ latest, checked_at: Date.now(), ...extra }), "utf8");
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_NO_UPDATE_CHECK: "" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe("update-check compare/cache (unit)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-upd-"));
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  beforeEach(() => {
    try {
      rmSync(cachePath(HOME), { force: true });
      rmSync(join(HOME, "update-check.lock"), { force: true });
    } catch {
      /* ignore */
    }
  });

  it("semver direction is the guard: local < latest only", () => {
    expect(compareVersions("0.114.5", "0.114.6")).toBe(-1);
    expect(compareVersions("0.114.5", "0.114.5")).toBe(0);
    expect(compareVersions("0.115.0", "0.114.9")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
  });

  it("nag: stderr-only, once per latest; local ==/> latest silent; json silent", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      seed("9.9.9");
      maybeNag(HOME, "0.1.0", "project", "list", false);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toMatch(/npm latest 9\.9\.9/);
      expect(readCache(HOME).last_notified).toBe("9.9.9");

      maybeNag(HOME, "0.1.0", "project", "list", false);
      expect(err).toHaveBeenCalledTimes(1); // same latest never repeats

      seed("9.9.9", { last_notified: "9.8.0" });
      maybeNag(HOME, "9.9.9", "project", "list", false);
      maybeNag(HOME, "9.10.0", "project", "list", false);

      seed("9.9.9");
      maybeNag(HOME, "0.1.0", "project", "list", true); // --json: never print
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("disabled by env / scheduler context; TTL-refresh only when stale", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const prev = process.env.YGL_NO_UPDATE_CHECK;
    const prevServe = process.env.YGL_SERVE;
    try {
      seed("9.9.9");
      process.env.YGL_NO_UPDATE_CHECK = "1";
      maybeNag(HOME, "0.1.0", "project", "list", false);
      expect(err).not.toHaveBeenCalled();
      expect(updateCheckDisabled(undefined, "project", "list")).toBe(true);
      process.env.YGL_NO_UPDATE_CHECK = "";
      process.env.YGL_SERVE = "1";
      expect(updateCheckDisabled(undefined, "project", "list")).toBe(true);
      expect(updateCheckDisabled(undefined, "job", "tick")).toBe(true);
      process.env.YGL_SERVE = "";
      expect(updateCheckDisabled(undefined, "job", "tick")).toBe(true);
      expect(updateCheckDisabled(undefined, "project", "list")).toBe(false);

      seed("9.9.9", { checked_at: Date.now() }); // fresh → no refresh spawn
      expect(maybeRefresh(HOME, "0.1.0", "project", "list")).toBe(false);
      expect(updateHintFromCache(HOME, "0.1.0")).toMatchObject({ latest: "9.9.9", update_available: true });
      expect(updateHintFromCache(HOME, "9.9.9")?.update_available).toBe(false);
    } finally {
      process.env.YGL_NO_UPDATE_CHECK = prev;
      process.env.YGL_SERVE = prevServe;
      err.mockRestore();
    }
  });
});

describe.skipIf(!HAS_BIN)("update-check CLI surface (0.114.6)", () => {
  beforeAll(() => {
    HOME = HOME || mkdtempSync(join(tmpdir(), "ygl-upd-cli-"));
    const init = spawnSync(process.execPath, [BIN, "db", "init"], { encoding: "utf8", env: { ...process.env, YGL_HOME: HOME } });
    expect(init.status).toBe(0);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("human command: update available → stderr line, rc unchanged, stdin/stdout contract intact", () => {
    seed("9.9.9");
    const v = local();
    expect(compareVersions(v, "9.9.9")).toBe(-1);
    const r = run(["project", "list"]);
    expect(r.rc).toBe(0);
    expect(r.err).toMatch(new RegExp(`ygl-trees ${v.replaceAll(".", "\\.")} → npm latest 9\\.9\\.9`));
    const again = run(["project", "list"]);
    expect(again.rc).toBe(0);
    expect(again.err).toBe("");
  });

  it("--json stdout stays byte-pure: no nag, no extra fields (stderr empty)", () => {
    seed("9.9.9");
    const r = run(["job", "list", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.err).toBe("");
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.out).not.toMatch(/update_hint|npm latest 9\.9\.9/);
  });

  it("doctor carries the cached hint as a check; still informational (warn does not fail)", () => {
    seed("9.9.9");
    const r = run(["doctor", "--json"]);
    expect([0, 1]).toContain(r.rc);
    const checks = JSON.parse(r.out);
    const hint = checks.find((c: any) => c.name === "update_hint");
    expect(hint).toBeTruthy();
    expect(hint.status).toBe("warn");
    expect(String(hint.detail)).toMatch(/9\.9\.9/);
    expect(checks.every((c: any) => c.status !== "fail")).toBe(true); // update hint never fails doctor
  });
});
