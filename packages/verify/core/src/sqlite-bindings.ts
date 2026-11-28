/**
 * node:sqlite 的惰性绑定。
 *
 * 为什么不在模块顶层 `import { DatabaseSync } from "node:sqlite"`：Node 24 在首次加载该模块时
 * 往 stderr 打一条 ExperimentalWarning，而 bin 的 --json 契约要求 stdout 纯净、demo 用 2>&1
 * 捕获输出——顶层导入会让**每个**命令都带上这条警告（M13-1 demo「batch json shape」红）。
 * 因此只在真正要用 SQLite 时才 require，未触达 verify 的命令保持零噪音。
 *
 * @module @ygl/verify-core/sqlite-bindings
 */
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, toNamespacedPath } from "node:path";

type SqliteModule = typeof import("node:sqlite");

let cached: SqliteModule | null = null;

/** 惰性加载 node:sqlite（进程内只 require 一次）。 */
export function sqliteModule(): SqliteModule {
  if (!cached) cached = require("node:sqlite") as SqliteModule;
  return cached;
}

/** 构造 DatabaseSync（与 `import { DatabaseSync }` 同形，但延迟到调用点）。 */
export function openDatabaseSync(path: string, opts?: { readOnly?: boolean }): DatabaseSync {
  const { DatabaseSync: Ctor } = sqliteModule();
  // node:sqlite 对显式 undefined 的 options 报 "The options argument must be an object"，
  // 所以只在真给了 options 时才传第二个参数。
  // #327: SQLite's Win32 open rejects a file whose absolute path exceeds MAX_PATH.
  // The namespaced (\\?\) form is the documented long-path spelling; Node resolves
  // it through the same native open, so the file on disk is unchanged. Only an
  // absolute path on win32 needs it: ":memory:", URIs and POSIX paths pass through.
  const open = process.platform === "win32" && isAbsolute(path) ? toNamespacedPath(path) : path;
  return opts ? new Ctor(open, opts as never) : new Ctor(open);
}
