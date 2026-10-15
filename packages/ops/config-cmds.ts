/** config group — user-tunable settings (schema v6, src/config.ts registry).
 *  meta = runtime state the tool writes; config = what the user tunes. */
import { Env } from "../core/types";
import { ok, bad, out, head, table, paint, C, ack } from "../core/fmt";
import { configAll, configGet, configReset, configSet } from "./config";

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, db } = env;

  switch (action) {
    case "list":
    case "": {
      const rows = configAll(db);
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      head(ctx, `Config (${rows.length} keys)`);
      table(
        ctx,
        rows.map((r) => ({ key: r.key, value: r.value, type: r.type, 来源: r.is_default ? "default" : "user", note: r.note })),
        ["key", "value", "type", "来源", "note"],
        ["key", "value", "type", "来源", "note"]
      );
      return 0;
    }
    case "get": {
      if (!rest[0]) {
        bad(ctx, "usage: config get <key>");
        return 2;
      }
      try {
        ack(ctx, { key: rest[0], value: configGet(db, rest[0]) }, `${rest[0]} = ${configGet(db, rest[0])}`);
        return 0;
      } catch (e: any) {
        bad(ctx, e?.message || String(e));
        return 2;
      }
    }
    case "set": {
      if (!rest[0] || rest[1] === undefined) {
        bad(ctx, "usage: config set <key> <value>   (config list 查看全部键)");
        return 2;
      }
      try {
        const r = configSet(db, rest[0], rest.slice(1).join(" "));
        ack(ctx, r, `${r.key} = ${r.value}`);
        return 0;
      } catch (e: any) {
        bad(ctx, e?.message || String(e));
        return 2;
      }
    }
    case "reset": {
      if (!rest[0]) {
        bad(ctx, "usage: config reset <key>");
        return 2;
      }
      try {
        const r = configReset(db, rest[0]);
        ack(ctx, { ...r, reset: true }, `${r.key} reset → ${r.value}`);
        return 0;
      } catch (e: any) {
        bad(ctx, e?.message || String(e));
        return 2;
      }
    }
    default:
      bad(ctx, `unknown config action: ${action} (list | get | set | reset)`);
      return 2;
  }
}
