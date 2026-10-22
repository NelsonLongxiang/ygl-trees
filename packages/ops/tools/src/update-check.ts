/**
 * CLI 版本漂移提示（属主令 2026-10-22 10:01；fdc757f6 预审八条）。
 *
 * 这是**信息性 nag**，不是 R5b 执法时钟：#29 裁定拒绝把 npm latest at check time
 * 当审计时钟（网络/可变引用/离线不可用/回滚错时钟）；nag 只影响 UX，不 gate 任何东西，
 * R5b 审计时钟仍只认审计方发行物内嵌能力表。
 *
 * 机制（冷启动不进关键路径）：
 * - 父进程只**同步读缓存** `$YGL_HOME/update-check.json`（不存在/过期都不联网），命中
 *   `local < latest` 且该 latest 未提示过 → stderr 单行 + 记 last_notified；stdout/JSON 零污染。
 * - 缓存过 TTL（24h）才起一个 **detached 子进程**去查 registry dist-tags（1.5s 硬顶，
 *   registry 取 `npm config get registry`，失败完全静默），子进程写缓存；父进程不等它。
 * - `YGL_NO_UPDATE_CHECK=1` 或 config `update_check=false` 永久关；调度上下文（YGL_RUN_ID /
 *   job tick|run）不查也不提示。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { DB } from "../../../core/database/src/db";
import { configGetBool } from "./config";

export const PKG = "ygl-trees";
const DAY_MS = 24 * 3600 * 1000;
const REFRESH_TIMEOUT_MS = 1500;
const LOCK_STALE_MS = 5 * 60 * 1000;
/** Captured at module load: the CLI assigns a fresh YGL_RUN_ID to EVERY
 *  invocation later, so a runtime check would disable the nag everywhere.
 *  Only an id inherited from the job runner counts as scheduler context. */
const INHERITED_RUN_ID = process.env.YGL_RUN_ID;

export interface UpdateCache {
  latest?: string;
  checked_at?: number;
  last_notified?: string;
}

export function cachePath(home: string): string {
  return path.join(home, "update-check.json");
}

export function readCache(home: string): UpdateCache {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(home), "utf8"));
    if (!raw || typeof raw !== "object") return {};
    return {
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
      ...(typeof raw.checked_at === "number" ? { checked_at: raw.checked_at } : {}),
      ...(typeof raw.last_notified === "string" ? { last_notified: raw.last_notified } : {}),
    };
  } catch {
    return {};
  }
}

function writeCache(home: string, next: UpdateCache): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    const file = cachePath(home);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort: a read-only workspace simply never gets a cache */
  }
}

/** Semver compare on MAJOR.MINOR.PATCH (prerelease sorts below release). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre = ""] = v.trim().replace(/^v/, "").split("-", 2);
    const nums = main.split(".").map((x) => Number(x) || 0);
    return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function disabledByEnv(): boolean {
  const v = String(process.env.YGL_NO_UPDATE_CHECK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function disabledByConfig(db?: DB): boolean {
  if (!db) return false;
  try {
    return !configGetBool(db, "update_check");
  } catch {
    return false;
  }
}

function schedulerContext(group: string, action: string): boolean {
  if (INHERITED_RUN_ID) return true; // spawned by the job runner
  if (process.env.YGL_SERVE === "1") return true; // serve / tick child processes
  return group === "job" && (action === "tick" || action === "run");
}

export function updateCheckDisabled(db?: DB, group = "", action = ""): boolean {
  return disabledByEnv() || disabledByConfig(db) || schedulerContext(group, action);
}

export interface UpdateHint {
  latest: string;
  update_available: boolean;
  checked_at?: number;
}

/** Cached view for doctor (no network). */
export function updateHintFromCache(home: string, localVersion: string): UpdateHint | null {
  const cache = readCache(home);
  if (!cache.latest) return null;
  return { latest: cache.latest, update_available: compareVersions(localVersion, cache.latest) < 0, ...(cache.checked_at ? { checked_at: cache.checked_at } : {}) };
}

/** Parent-process nag: synchronous cache read, stderr only, once per latest. */
export function maybeNag(home: string, localVersion: string, group: string, action: string, json: boolean, db?: DB): void {
  if (json) return; // machine channel stays clean; JSON consumers use doctor's update_hint
  if (updateCheckDisabled(db, group, action)) return;
  const cache = readCache(home);
  if (!cache.latest) return;
  if (compareVersions(localVersion, cache.latest) >= 0) return; // local >= latest: silent (staged-publish window)
  if (cache.last_notified === cache.latest) return;
  console.error(`ygl-trees ${localVersion} → npm latest ${cache.latest} 可用；npm i -g ygl-trees@latest`);
  writeCache(home, { ...cache, last_notified: cache.latest });
}

/** Refresh entry: spawn a detached child at most once per TTL (never blocks). */
export function maybeRefresh(home: string, localVersion: string, group: string, action: string, db?: DB): boolean {
  if (updateCheckDisabled(db, group, action)) return false;
  // Test processes own temp workspaces that are removed in afterAll; a detached
  // 1.5s network child racing that cleanup leaves the dir behind (Windows EPERM).
  // Production never sets VITEST; the spawn path is covered by the child script
  // itself and the cache contract, not by a real detached process in CI.
  if (process.env.VITEST) return false;
  const cache = readCache(home);
  if (cache.checked_at && Date.now() - cache.checked_at < DAY_MS) return false;
  const lock = path.join(home, "update-check.lock");
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
  } catch {
    /* no lock */
  }
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(lock, String(process.pid), "utf8");
  } catch {
    return false;
  }
  const child = `
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const cp = require("node:child_process");
const home = process.argv[1], pkg = process.argv[2], timeoutMs = Number(process.argv[3]) || 1500;
const cacheFile = path.join(home, "update-check.json");
const lock = path.join(home, "update-check.lock");
function done(latest) {
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(cacheFile, "utf8")) || {}; } catch {}
    const tmp = cacheFile + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, ...(latest ? { latest } : {}), checked_at: Date.now() }, null, 2) + "\\n");
    fs.renameSync(tmp, cacheFile);
  } catch {}
  try { fs.rmSync(lock, { force: true }); } catch {}
}
function registry() {
  try {
    const out = cp.execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["config", "get", "registry"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    const r = String(out).trim();
    if (/^https?:\\/\\//.test(r)) return r;
  } catch {}
  return "https://registry.npmjs.org/";
}
function get(url, depth, cb) {
  if (depth > 2) return cb(null);
  const mod = url.startsWith("https:") ? https : http;
  const req = mod.get(url, { timeout: timeoutMs, headers: { "user-agent": pkg + "-update-check" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      return get(next, depth + 1, cb);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(null); }
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d) => { body += d; if (body.length > 65536) { req.destroy(); cb(null); } });
    res.on("end", () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
  });
  req.on("timeout", () => { req.destroy(); cb(null); });
  req.on("error", () => cb(null));
}
const base = registry().replace(/\\/+$/, "");
get(base + "/-/package/" + pkg + "/dist-tags", 0, (tags) => done(tags && typeof tags.latest === "string" ? tags.latest : null));
`;
  try {
    const childProc = spawn(process.execPath, ["-e", child, home, PKG, String(REFRESH_TIMEOUT_MS)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    childProc.unref();
    return true;
  } catch {
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function defaultHomeForHint(): string {
  return process.env.YGL_HOME || path.join(os.homedir(), ".ygl-trees");
}
