/** library 命令壳：#275 市场经验库只读出口。解析参数 → library.ts → 输出。 */
import type { Env } from "../../../core/database/src/types";
import { ok, bad } from "../../../core/text/src/fmt";
import { LIBRARY_KINDS, libraryList, libraryShow, LibraryUsageError, type LibraryKind } from "./library";

export async function run(env: Env, action: string, rest: string[], args: any): Promise<number> {
  const ctx = env.ctx;
  try {
    if (action === "list") {
      const kind = String(args.flags.kind || rest[0] || "");
      if (!LIBRARY_KINDS.includes(kind as LibraryKind)) {
        bad(ctx, "usage: library list --kind <" + LIBRARY_KINDS.join("|") + "> [--scope <s>] [--since <iso>] [--limit 1..500] [--cursor <c>]");
        return 2;
      }
      const page = await libraryList(env, {
        kind: kind as LibraryKind,
        limit: args.flags.limit !== undefined ? String(args.flags.limit) : undefined,
        cursor: args.flags.cursor !== undefined ? String(args.flags.cursor) : undefined,
        since: args.flags.since !== undefined ? String(args.flags.since) : undefined,
        scope: args.flags.scope !== undefined ? String(args.flags.scope) : undefined,
        project: args.flags.project !== undefined ? String(args.flags.project) : undefined,
      });
      if (ctx.json) { console.log(JSON.stringify(page, null, 2)); return 0; }
      ok(ctx, `${page.items.length} item(s), total ${page.total}${page.next_cursor ? ", more pages" : ""}`);
      for (const it of page.items) out(ctx, `  [${it.kind}] ${it.id}  ${it.title}`);
      return 0;
    }
    if (action === "show") {
      const kind = String(rest[0] || ""); const id = String(rest.slice(1).join(" ") || "");
      if (!LIBRARY_KINDS.includes(kind as LibraryKind) || !id) {
        bad(ctx, `usage: library show <${LIBRARY_KINDS.join("|")}> <id|title>`);
        return 2;
      }
      const row = await libraryShow(env, kind as LibraryKind, id);
      if (ctx.json) { console.log(JSON.stringify(row, null, 2)); return 0; }
      ok(ctx, `[${row.kind}] ${row.id}  ${String(row.title || "")}`);
      return 0;
    }
    bad(ctx, `usage: library list --kind <...> [--limit N] [--cursor C] | library show <kind> <id>`);
    return 2;
  } catch (e: any) {
    if (e instanceof LibraryUsageError) { bad(ctx, e.message); return 2; }
    if (e && typeof e.rc === "number") { bad(ctx, e.message); return e.rc; }
    throw e;
  }
}
function out(ctx: any, line: string): void { console.log(line); }