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
  return new Ctor(path, opts as never);
}
