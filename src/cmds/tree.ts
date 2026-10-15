/**
 * tree / node commands — the tech-tree node model.
 *
 *   ygl-trees tree new <name>           create a tree
 *   ygl-trees node add <key>            add a node
 *   ygl-trees node link <parent> <child> [--rel prereq] [--mode AND|OR|XOR|NOT] [--optional]
 *   ygl-trees node cond <key> --name .. [--kind ..] [--op ..] [--value ..] [--optional] [--effect cost_mul]
 *   ygl-trees node index                rebuild closure + topological index (fails on cycle)
 *   ygl-trees node can <key>            required vs optional gate evaluation
 *   ygl-trees node ready                currently unlockable set
 *   ygl-trees node path <key>           cheapest order to reach a node
 *   ygl-trees node parents|children|ancestors|descendants <key>
 *   ygl-trees node validate             sanity checks
 *   ygl-trees node export [--out file]  portable JSON
 */
import * as fs from "node:fs";
import { Env } from "../cli";
import { TreeStore } from "../tree";
import { ok, bad, out, head, table, show, paint, C, ack } from "../fmt";
import { getOrm } from "../orm";
import * as treeWrites from "../treeWrites";
import { DEFAULT_ENDPOINT, evalBoolean, evalToken, mapOutcome } from "../eval";
import { configGet, configGetBool, configGetNumber } from "../config";
import { nowIso, shortId } from "../text";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, db } = env;
  const trees = new TreeStore(db);

  const sel = args.flags.t ? String(args.flags.t) : undefined;
  const flagNum = (k: string, d: number) => {
    const v = Number(args.flags[k]);
    return Number.isFinite(v) ? v : d;
  };
  const flagStr = (k: string, d = "") => (args.flags[k] === undefined || args.flags[k] === true ? d : String(args.flags[k]));
  const flagBool = (k: string) => args.flags[k] === true || args.flags[k] === "true" || args.flags[k] === "1";

  /** tree-domain write through the transactional service (async command). */
  function runTreeWrite<T>(fn: (ds: any) => Promise<T>, print: (r: T) => number): Promise<number> {
    return getOrm(env.db.path)
      .then(fn)
      .then(print)
      .catch((e: any): number => {
        bad(ctx, e?.message || String(e));
        return 1;
      });
  }

  // ---------------------------------------------------------------- tree group
  if (env.group === "tree") {
    const sub = action;               // new | list | use
    const name = rest[0];
    if (sub === "new") {
      if (!name) {
        bad(ctx, "usage: tree new <name> [--project <name>]");
        return 2;
      }
      const pid = flagStr("project");
      const proj = pid ? db.get("SELECT id FROM projects WHERE name=?", [pid]) : null;
      return runTreeWrite((ds) => treeWrites.treeCreate(ds, name, proj?.id || ""), (t): number => {
        db.metaSet("current_tree", t.name);
        ack(ctx, t, `tree created and selected: ${t.name}`);
        return 0;
      });
    }
    if (sub === "list") {
      table(ctx, trees.treeList(), ["tree", "note", "nodes", "edges", "dirty", "created"], [
        "name",
        "note",
        "nodes",
        "edges",
        "dirty",
        "created",
      ]);
      return 0;
    }
    if (sub === "use") {
      if (!trees.treeByName(name)) {
        bad(ctx, `tree not found: ${name}`);
        return 1;
      }
      db.metaSet("current_tree", name);
      ack(ctx, { tree: name }, `now using tree: ${name}`);
      return 0;
    }
  }

  // ---------------------------------------------------------------- node group
  let tree: any;
  try {
    tree = trees.treeResolve(sel);
  } catch (e: any) {
    bad(ctx, e.message);
    return 1;
  }
  const tid = tree.id;

  if (env.group === "node") {
    const sub = action;               // add | link | can | ready | ...
    const key = rest[0];

    if (sub === "add") {
      if (!key) {
        bad(ctx, "usage: node add <key> [--name ..] [--tier n] [--cost n] [--kind tech|skill|..] [--tags ..]");
        return 2;
      }
      const spec = {
        key,
        name: flagStr("name") || undefined,
        kind: flagStr("kind", "tech"),
        tier: flagNum("tier", 0),
        cost: flagNum("cost", 0),
        cost_unit: flagStr("cost_unit"),
        payload: flagStr("payload"),
        tags: flagStr("tags"),
      };
      return runTreeWrite((ds) => treeWrites.nodeAdd(ds, tid, spec), (r): number => {
        if (ctx.json) console.log(JSON.stringify(r.created ? r.row : { ...r.row, duplicate: true }, null, 2));
        else if (!r.created) out(ctx, paint(C.yellow, `  ! node already exists: ${key}`, ctx.color));
        else ok(ctx, `node added: ${key}${r.row.name !== key ? `  (${r.row.name})` : ""}`);
        return 0;
      });
    }

    if (sub === "link") {
      const child = rest[1];
      if (!key || !child) {
        bad(ctx, "usage: node link <parent> <child> [--rel prereq|unlock|excludes|enables] [--mode AND|OR|XOR|NOT] [--optional] [--min-level n] [--weight n]");
        return 2;
      }
      return runTreeWrite(
        (ds) =>
          treeWrites.link(ds, tid, key, child, {
            rel: flagStr("rel", "prereq"),
            mode: flagStr("mode", "AND"),
            required: !flagBool("optional"),
            min_level: flagNum("min-level", 1),
            weight: flagNum("weight", 1),
            note: flagStr("note"),
          }),
        (row): number => {
          ack(ctx, row, `linked ${key} → ${child}  [${row.rel}/${row.mode}/${row.required ? "必检" : "可选"}]`);
          return 0;
        }
      );
    }

    if (sub === "unlink") {
      if (!key || !rest[1]) {
        bad(ctx, "usage: node unlink <parent> <child> [--rel prereq]");
        return 2;
      }
      const relU = flagStr("rel", "prereq");
      return runTreeWrite((ds) => treeWrites.unlink(ds, tid, key, rest[1], relU), (): number => {
        ack(ctx, { unlinked: `${key} -> ${rest[1]}` }, `unlinked ${key} → ${rest[1]}`);
        return 0;
      });
    }

    if (sub === "cond") {
      if (!key) {
        bad(ctx, "usage: node cond <key> --name <cond> [--kind flag|resource|level|quest|time|expr] [--op >=|==|<=|!=|has] [--value n] [--optional] [--effect gate|cost_mul] [--weight n]");
        return 2;
      }
      const name = flagStr("name");
      if (!name) {
        table(ctx, trees.condList(tid, key), ["id", "name", "kind", "op", "value", "必检", "effect"], [
          "id",
          "name",
          "kind",
          "op",
          "value",
          "required",
          "effect",
        ]);
        return 0;
      }
      return runTreeWrite(
        (ds) =>
          treeWrites.condAdd(ds, tid, key, {
            name,
            kind: flagStr("kind", "flag"),
            expr: flagStr("expr") || undefined,
            op: flagStr("op", ">="),
            value: flagStr("value"),
            required: !flagBool("optional"),
            effect: flagStr("effect", "gate"),
            weight: flagNum("weight", 1),
          }),
        (c): number => {
          ack(ctx, c, `condition added: ${key} · ${c.name}  [${c.required ? "必检" : "可选"}/${c.effect}]`);
          return 0;
        }
      );
    }

    if (sub === "index") {
      return runTreeWrite((ds) => treeWrites.rebuildIndex(ds, tid), (r): number => {
        ack(ctx, { nodes: r.nodes, closure_rows: r.closureRows }, `index rebuilt: ${r.nodes} nodes, closure ${r.closureRows} rows`);
        if (!ctx.json) {
          const st = db.get("SELECT tiers FROM node_index WHERE tree_id=?", [tid]);
          if (st?.tiers) {
            const tiers = JSON.parse(st.tiers);
            out(ctx, paint(C.dim, `  tiers: ${Object.keys(tiers).map((t) => `t${t}(${tiers[t].length})`).join(" ")}`, ctx.color));
          }
        }
        return 0;
      });
    }

    if (sub === "can") {
      if (!key) {
        bad(ctx, "usage: node can <key> [--context ctx] [--state k=v] [--eval]");
        return 2;
      }
      const state = parseState(args);
      const ctxName = flagStr("context", "default");
      const r = trees.canUnlock(tid, key, ctxName, state);
      const evalConds = flagBool("eval")
        ? trees.condList(tid, key).filter((c: any) => String(c.op) === "eval")
        : [];
      if (!evalConds.length) {
        if (ctx.json) {
          console.log(JSON.stringify(r, null, 2));
          return 0;
        }
        head(ctx, `can unlock: ${r.key}`);
        out(ctx, `  ${r.ok ? paint(C.green, "✓ 可解锁", ctx.color) : paint(C.red, "✗ 不可解锁", ctx.color)}`);
        if (r.missing_required.length) {
          out(ctx, paint(C.bold, "  必检未满足", ctx.color));
          for (const m of r.missing_required) out(ctx, `    - ${m}`);
        }
        if (r.blocked_by.length) {
          out(ctx, paint(C.bold, "  被排斥", ctx.color));
          for (const b of r.blocked_by) out(ctx, `    - ${b}`);
        }
        if (r.missing_optional.length) {
          out(ctx, paint(C.dim, "  可选未满足（不阻塞）", ctx.color));
          for (const m of r.missing_optional) out(ctx, `    - ${m}`);
        }
        if (r.cost_multiplier !== 1) out(ctx, `  成本系数 ${r.cost_multiplier}`);
        return 0;
      }
      // R8: decision-model boolean evaluation for op=eval conditions.
      // Offline-safe: no token / network failure → pending (rc=0).
      // Credential/endpoint priority (user ruling): CONFIG first —
      // decision_model_llm_token / decision_model_llm_api_base — then env
      // AI_GATEWAY_API_KEY / ~/.vercel.ai-gateway.env, then the default
      // Vercel gateway. Thresholds + offline are config-tunable too;
      // env YGL_EVAL_OFFLINE still wins over config eval.offline.
      const offline = !!process.env.YGL_EVAL_OFFLINE || configGetBool(env.db, "eval.offline");
      const cfgToken = configGet(env.db, "decision_model_llm_token").trim();
      const token = offline ? "" : cfgToken || evalToken();
      const endpoint = configGet(env.db, "decision_model_llm_api_base").trim() || DEFAULT_ENDPOINT;
      const passT = configGetNumber(env.db, "eval.pass_threshold");
      const failT = configGetNumber(env.db, "eval.fail_threshold");
      const contextPkg = trees.evalContext(tid, key, state, ctxName);
      return (async (): Promise<number> => {
        const evaluated: any[] = [];
        for (const c of evalConds) {
          const question = String(c.value || c.name); // R8.7 wording fallback
          const m = mapOutcome(await evalBoolean(contextPkg, question, token, endpoint), passT, failT);
          evaluated.push({ name: c.name, question, ...m });
        }
        const pendingList: string[] = [];
        for (const e of evaluated) {
          if (e.outcome === "pass") {
            r.missing_required = (r.missing_required as string[]).filter((m) => !m.startsWith(e.name));
          } else if (e.outcome === "fail") {
            if (!(r.missing_required as string[]).some((m) => m.startsWith(e.name)))
              (r.missing_required as string[]).push(`${e.name} (eval P=${e.p} fail)`);
          } else {
            // pending: neither satisfied nor failed — its own lane
            (r.missing_required as string[]) = (r.missing_required as string[]).filter((m) => !m.startsWith(e.name));
            pendingList.push(`${e.name} (P=${e.p ?? "-"}${e.reason ? ` · ${e.reason}` : ""})`);
          }
        }
        r.pending = pendingList;
        r.evaluated = evaluated;
        r.ok = (r.missing_required as string[]).length === 0 && (r.blocked_by as string[]).length === 0 && pendingList.length === 0;
        try {
          db.run(
            "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES(?,?,?,?,?,?,?)",
            [shortId(["eval.gate", "node", key], 12), nowIso(), "cli", "eval.gate", "node", key,
             JSON.stringify(evaluated.map((e) => ({ name: e.name, outcome: e.outcome, p: e.p ?? null })))]
          );
        } catch { /* audit best-effort */ }
        if (ctx.json) {
          console.log(JSON.stringify(r, null, 2));
          return 0;
        }
        head(ctx, `can unlock: ${r.key}`);
        out(ctx, `  ${r.ok ? paint(C.green, "✓ 可解锁", ctx.color) : pendingList.length ? paint(C.yellow, "… 待判定（决策模型 pending）", ctx.color) : paint(C.red, "✗ 不可解锁", ctx.color)}`);
        if (r.missing_required.length) {
          out(ctx, paint(C.bold, "  必检未满足", ctx.color));
          for (const m of r.missing_required) out(ctx, `    - ${m}`);
        }
        if (pendingList.length) {
          out(ctx, paint(C.bold, "  决策模型 pending（灰带/未配置，非终态）", ctx.color));
          for (const p of pendingList) out(ctx, `    - ${p}`);
        }
        if (r.blocked_by.length) {
          out(ctx, paint(C.bold, "  被排斥", ctx.color));
          for (const b of r.blocked_by) out(ctx, `    - ${b}`);
        }
        if (r.missing_optional.length) {
          out(ctx, paint(C.dim, "  可选未满足（不阻塞）", ctx.color));
          for (const m of r.missing_optional) out(ctx, `    - ${m}`);
        }
        for (const e of evaluated) out(ctx, paint(C.dim, `  eval ${e.name}: P=${e.p ?? "-"} → ${e.outcome}${e.reason ? ` (${e.reason})` : ""}`, ctx.color));
        if (r.cost_multiplier !== 1) out(ctx, `  成本系数 ${r.cost_multiplier}`);
        return 0;
      })().catch((e: any): number => {
        bad(ctx, e?.message || String(e));
        return 1;
      });
    }

    if (sub === "ready") {
      const rows = trees.ready(tid, flagStr("context", "default"), parseState(args));
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      head(ctx, `Ready to unlock (${rows.length})`);
      table(ctx, rows, ["key", "name", "tier", "cost"], ["key", "name", "tier", "cost"]);
      return 0;
    }

    if (sub === "path") {
      if (!key) {
        bad(ctx, "usage: node path <key>");
        return 2;
      }
      const p = trees.pathTo(tid, key, flagStr("context", "default"));
      if (ctx.json) {
        console.log(JSON.stringify(p, null, 2));
        return 0;
      }
      head(ctx, `Unlock order to ${key}`);
      p.order.forEach((k, i) => out(ctx, `  ${i + 1}. ${k}`));
      out(ctx, paint(C.dim, `  total cost: ${p.total_cost}`, ctx.color));
      return 0;
    }

    if (sub === "parents") {
      table(ctx, trees.parents(tid, key), ["parent", "name", "rel", "mode", "必检", "level"], [
        "key",
        "name",
        "rel",
        "mode",
        "required",
        "min_level",
      ]);
      return 0;
    }

    if (sub === "children") {
      table(ctx, trees.children(tid, key), ["child", "name", "rel", "mode", "必检", "level"], [
        "key",
        "name",
        "rel",
        "mode",
        "required",
        "min_level",
      ]);
      return 0;
    }

    if (sub === "ancestors") {
      table(ctx, trees.ancestors(tid, key), ["ancestor", "name", "depth"], ["key", "name", "depth"]);
      return 0;
    }

    if (sub === "descendants") {
      table(ctx, trees.descendants(tid, key), ["descendant", "name", "depth"], ["key", "name", "depth"]);
      return 0;
    }

    if (sub === "list" || sub === undefined) {
      table(ctx, trees.nodeList(tid), ["key", "name", "kind", "tier", "cost", "必检父", "子节点"], [
        "key",
        "name",
        "kind",
        "tier",
        "cost",
        "req_parents",
        "children",
      ]);
      return 0;
    }

    if (sub === "search") {
      const q = rest.join(" ");
      table(ctx, trees.nodeSearch(tid, q), ["key", "name", "tier", "matched"], ["key", "name", "tier", "matched"]);
      return 0;
    }

    if (sub === "show") {
      const n = trees.nodeGet(tid, key);
      if (!n) {
        bad(ctx, `node not found: ${key}`);
        return 1;
      }
      if (ctx.json) {
        console.log(JSON.stringify({ node: n, parents: trees.parents(tid, key), conditions: trees.condList(tid, key) }, null, 2));
        return 0;
      }
      head(ctx, `${n.key}  (${n.name})`);
      show(ctx, { id: n.id, kind: n.kind, tier: n.tier, cost: `${n.cost}${n.cost_unit ? " " + n.cost_unit : ""}`, tags: n.tags || "-" });
      const ps = trees.parents(tid, key);
      out(ctx, paint(C.bold, "\n  父节点 / 关联", ctx.color));
      if (!ps.length) out(ctx, paint(C.dim, "    (root)", ctx.color));
      for (const p of ps)
        out(ctx, `    ${p.key}  ${paint(C.dim, `${p.rel}/${p.mode} ${p.required ? "必检" : "可选"}`, ctx.color)}`);
      const cs = trees.children(tid, key);
      out(ctx, paint(C.bold, "  子节点", ctx.color));
      if (!cs.length) out(ctx, paint(C.dim, "    (leaf)", ctx.color));
      for (const c of cs) out(ctx, `    ${c.key}  ${paint(C.dim, `${c.rel}/${c.mode} ${c.required ? "必检" : "可选"}`, ctx.color)}`);
      const cd = trees.condList(tid, key);
      if (cd.length) {
        out(ctx, paint(C.bold, "  条件", ctx.color));
        for (const c of cd) out(ctx, `    ${c.name} ${c.op} ${c.value}  ${paint(C.dim, `${c.required ? "必检" : "可选"}/${c.effect}`, ctx.color)}`);
      }
      return 0;
    }

    if (sub === "unlock" || sub === "lock") {
      if (!key) {
        bad(ctx, `usage: node ${sub} <key> [--context ctx] [--level n]`);
        return 2;
      }
      const status = sub === "unlock" ? "unlocked" : "locked";
      const ctxName = flagStr("context", "default");
      return runTreeWrite((ds) => treeWrites.stateSet(ds, tid, key, status, ctxName, flagNum("level", 1)), (): number => {
        ack(ctx, { key, status, context: ctxName }, `marked ${status}: ${key}`);
        return 0;
      });
    }

    if (sub === "validate") {
      const issues = trees.validate(tid);
      if (ctx.json) {
        console.log(JSON.stringify({ issues }, null, 2));
        return issues.length ? 1 : 0;
      }
      if (!issues.length) {
        ok(ctx, "no issues");
        return 0;
      }
      head(ctx, `Validation (${issues.length})`);
      for (const i of issues) bad(ctx, i);
      return 1;
    }

    if (sub === "export") {
      const data = trees.exportTree(tid);
      const dest = flagStr("out");
      if (dest) {
        fs.writeFileSync(dest, JSON.stringify(data, null, 2), "utf8");
        ack(ctx, { written: dest, nodes: data.nodes.length, edges: data.edges.length }, `exported to ${dest}`);
      } else console.log(JSON.stringify(data, null, 2));
      return 0;
    }

    if (sub === "import") {
      const file = flagStr("file");
      if (!file) {
        bad(ctx, "usage: node import --file <tree.json> [--tree <name>] [--merge]");
        return 2;
      }
      let spec: any;
      try {
        spec = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e: any) {
        bad(ctx, `cannot parse ${file}: ${e?.message || e}`);
        return 1;
      }
      return runTreeWrite(
        (ds) => treeWrites.importTree(ds, spec, { name: flagStr("tree") || undefined, merge: flagBool("merge") }),
        (r): number => {
          ack(
            ctx,
            { tree: r.tree.name, nodes: r.nodes, edges: r.edges, conditions: r.conditions },
            `imported tree ${r.tree.name}: ${r.nodes} nodes, ${r.edges} edges, ${r.conditions} conditions`
          );
          db.metaSet("current_tree", r.tree.name);
          if (!ctx.json) out(ctx, paint(C.dim, `  index rebuilt; now using tree: ${r.tree.name}`, ctx.color));
          return 0;
        }
      );
    }

    if (sub === "rm") {
      if (!key) {
        bad(ctx, "usage: node rm <key>");
        return 2;
      }
      return runTreeWrite((ds) => treeWrites.nodeDel(ds, tid, key), (): number => {
        ack(ctx, { removed: key }, `node removed: ${key}`);
        return 0;
      });
    }
  }

  out(
    ctx,
    paint(
      C.dim,
      "  tree new|list|use <name>   ·   node add|link|unlink|cond|index|can|ready|path|parents|children|ancestors|descendants|list|show|search|unlock|lock|validate|export|rm",
      ctx.color
    )
  );
  return 0;
}

function parseState(args: any): Record<string, any> {
  const raw = args.flags.state;
  if (!raw || raw === true) return {};
  const out: Record<string, any> = {};
  for (const part of String(raw).split(/[;,]/)) {
    const [k, v] = part.split("=");
    if (!k) continue;
    const val = v === undefined ? true : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    out[k.trim()] = val;
  }
  return out;
}
