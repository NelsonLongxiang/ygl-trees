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
import { Env } from "../../../core/database/src/types";
import { TreeStore } from "./reads";
import { ok, bad, out, head, table, show, paint, C, ack } from "../../../core/text/src/fmt";
import { rejectBare, validateEnum } from "../../../core/text/src/flagcheck";
import { getOrm } from "../../../core/database/src/orm";
import * as treeWrites from "./writes";
import {
  DEFAULT_ENDPOINT, evalBoolean, evalChoice, evalMixed, evalScore, evalToken,
  mapChoiceOutcome, mapOutcome, mapScoreOutcome, packEvalChoiceSpec, packEvalScoreSpec, parseEvalSpec,
} from "../../eval/src/eval";
import { configGet, configGetBool, configGetNumber } from "../../../ops/tools/src/config";
import { nowIso, shortId } from "../../../core/text/src/text";

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
        ack(
          ctx,
          t,
          t?.duplicate === true
            ? `tree exists, selected: ${t.name}  (duplicate, not re-created)`
            : `tree created and selected: ${t.name}`
        );
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
  // UX guard (drift-fix 2026-10-17): `node list <tree>` positional was silently
  // ignored (fell back to current_tree — user saw the WRONG tree with no hint).
  // Now: a positional that names an existing tree selects it; anything else
  // earns an explicit "ignored" notice instead of silent misdirection.
  let positionalTree: any;
  if (env.group === "node" && (action === "list" || action === undefined) && !sel && rest[0]) {
    positionalTree = trees.treeByName(rest[0]);
    if (positionalTree) rest = rest.slice(1);
    else if (!ctx.json) {
      out(ctx, paint(C.yellow, `  ! "${rest[0]}" is not a tree — showing current tree (use -t <tree> to switch)`, ctx.color));
    }
  }
  let tree: any;
  try {
    tree = positionalTree || trees.treeResolve(sel);
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
      if (rejectBare(ctx, args.flags, ["name", "kind", "tier", "cost", "tags", "payload", "cost-unit"])) return 2;
      if (validateEnum(ctx, args.flags, "kind", ["tech", "skill", "quest", "milestone", "resource", "flag"])) return 2;
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
          const dup = row?.duplicate === true;
          ack(
            ctx,
            row,
            dup
              ? `linked ${key} → ${child}  [${row.rel}/${row.mode}/${row.required ? "必检" : "可选"}]  (duplicate, updated in place)`
              : `linked ${key} → ${child}  [${row.rel}/${row.mode}/${row.required ? "必检" : "可选"}]`
          );
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
        bad(ctx, "usage: node cond <key> --name <cond> [--kind ..] [--op >=|==|<=|!=|has] [--value n] [--op eval [--value q] | eval-choice --options k=d,.. --answer k | eval-score --levels a,b,.. --min-score n] [--optional] [--effect gate|cost_mul] [--weight n]");
        return 2;
      }
      if (rejectBare(ctx, args.flags, ["name", "value", "op", "effect", "weight", "options", "answer", "levels", "min-score"])) return 2;
      if (validateEnum(ctx, args.flags, "op", [">=", "==", "<=", "!=", "has", "eval", "eval-choice", "eval-score"])) return 2;
      if (validateEnum(ctx, args.flags, "effect", ["gate", "cost_mul"])) return 2;
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
      // eval-family ops pack a question envelope into value (0.26.0):
      //   eval-choice: --options "k=desc,k2=desc2" --answer k
      //   eval-score:  --levels "级0,级1,..." (2-10) --min-score n
      let value = flagStr("value");
      const op = flagStr("op", ">=");
      if (op === "eval-choice" || op === "eval-score") {
        const q = value || name;
        if (op === "eval-choice") {
          const optStr = flagStr("options");
          const answer = flagStr("answer");
          if (!optStr || !answer) {
            bad(ctx, "eval-choice needs --options \"k=desc,...\" and --answer <k>");
            return 2;
          }
          const options: Record<string, string> = {};
          for (const part of optStr.split(/[,;]/)) {
            const i = part.indexOf("=");
            const k = (i < 0 ? part : part.slice(0, i)).trim();
            const v = i < 0 ? "" : part.slice(i + 1).trim();
            if (k) options[k] = v;
          }
          if (!options[answer]) {
            bad(ctx, `--answer '${answer}' is not one of the --options keys`);
            return 2;
          }
          value = packEvalChoiceSpec(q, options, answer);
        } else {
          const levels = (flagStr("levels") || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          const min = flagNum("min-score", NaN);
          if (levels.length < 2 || levels.length > 10) {
            bad(ctx, "eval-score needs --levels with 2-10 level descriptions");
            return 2;
          }
          if (!Number.isFinite(min) || min < 0 || min > levels.length - 1) {
            bad(ctx, `eval-score needs --min-score in [0, ${levels.length - 1}]`);
            return 2;
          }
          value = packEvalScoreSpec(q, levels, min);
        }
      }
      return runTreeWrite(
        (ds) =>
          treeWrites.condAdd(ds, tid, key, {
            name,
            kind: flagStr("kind", "flag"),
            expr: flagStr("expr") || undefined,
            op,
            value,
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
        ? trees.condList(tid, key).filter((c: any) => /^eval(-choice|-score)?$/.test(String(c.op)))
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
        let usageIn = 0, usageOut = 0; // R10.4: token spend per run
        for (const c of evalConds) {
          const spec = parseEvalSpec(c.value); // envelope (choice/score) or plain question
          const question = spec.q || String(c.name); // R8.7 wording fallback
          if (String(c.op) === "eval-choice") {
            const raw = await evalChoice(contextPkg, question, spec.options || {}, token, endpoint);
            usageIn += raw.usage?.inputTokens ?? 0; usageOut += raw.usage?.outputTokens ?? 0;
            const m = mapChoiceOutcome(raw, spec.answer || "", passT, failT);
            evaluated.push({ name: c.name, question, type: "choice", answer: spec.answer, ...m });
          } else if (String(c.op) === "eval-score") {
            const raw = await evalScore(contextPkg, question, spec.levels || [], token, endpoint);
            usageIn += raw.usage?.inputTokens ?? 0; usageOut += raw.usage?.outputTokens ?? 0;
            const m = mapScoreOutcome(raw, spec.min ?? 0);
            evaluated.push({ name: c.name, question, type: "score", min: spec.min, ...m });
          } else {
            const raw = await evalBoolean(contextPkg, question, token, endpoint);
            usageIn += raw.usage?.inputTokens ?? 0; usageOut += raw.usage?.outputTokens ?? 0;
            const m = mapOutcome(raw, passT, failT);
            evaluated.push({ name: c.name, question, type: "boolean", ...m });
          }
        }
        const pendingList: string[] = [];
        for (const e of evaluated) {
          if (e.outcome === "pass") {
            r.missing_required = (r.missing_required as string[]).filter((m) => !m.startsWith(e.name));
          } else if (e.outcome === "fail") {
            if (!(r.missing_required as string[]).some((m) => m.startsWith(e.name)))
              (r.missing_required as string[]).push(
                `${e.name} (eval ${e.p !== undefined ? `P=${e.p}` : `score=${e.score}`} fail)`
              );
          } else {
            // pending: neither satisfied nor failed — its own lane
            (r.missing_required as string[]) = (r.missing_required as string[]).filter((m) => !m.startsWith(e.name));
            const metric = e.p !== undefined ? `P=${e.p}` : e.score !== undefined ? `score=${e.score}` : "P=-";
            pendingList.push(`${e.name} (${metric}${e.reason ? ` · ${e.reason}` : ""})`);
          }
        }
        r.pending = pendingList;
        r.evaluated = evaluated;
        r.ok = (r.missing_required as string[]).length === 0 && (r.blocked_by as string[]).length === 0 && pendingList.length === 0;
        try {
          const run = process.env.YGL_RUN_ID || "";
          db.run(
            "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,'info')",
            [shortId(["eval.gate", "node", key], 12), nowIso(), "cli", "eval.gate", "node", key,
             JSON.stringify({
               conds: evaluated.map((e) => ({ name: e.name, type: e.type, outcome: e.outcome, p: e.p ?? null, score: e.score ?? null })),
               usage: { inputTokens: usageIn, outputTokens: usageOut },
               ...(run ? { run } : {}),
             })]
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
      const state = parseState(args);
      const ctxName = flagStr("context", "default");
      if (!flagBool("eval")) {
        const rows = trees.ready(tid, ctxName, state);
        if (ctx.json) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        head(ctx, `Ready to unlock (${rows.length})`);
        table(ctx, rows, ["key", "name", "tier", "cost"], ["key", "name", "tier", "cost"]);
        return 0;
      }
      // --eval: nodes blocked ONLY by eval gates get one multi-question
      // decision-model request each (protocol-native batching). Offline or
      // gray answers land in eval_pending — never a failure.
      const rows = trees.ready(tid, ctxName, state);
      const candidates = trees.evalCandidates(tid, ctxName, state);
      if (!candidates.length) {
        if (ctx.json) console.log(JSON.stringify({ ready: rows, eval_pending: [] }, null, 2));
        else {
          head(ctx, `Ready to unlock (${rows.length})`);
          table(ctx, rows, ["key", "name", "tier", "cost"], ["key", "name", "tier", "cost"]);
          out(ctx, paint(C.dim, "  (无仅被 eval 门槛阻塞的节点)", ctx.color));
        }
        return 0;
      }
      const offline = !!process.env.YGL_EVAL_OFFLINE || configGetBool(env.db, "eval.offline");
      const cfgToken = configGet(env.db, "decision_model_llm_token").trim();
      const token = offline ? "" : cfgToken || evalToken();
      const endpoint = configGet(env.db, "decision_model_llm_api_base").trim() || DEFAULT_ENDPOINT;
      const passT = configGetNumber(env.db, "eval.pass_threshold");
      const failT = configGetNumber(env.db, "eval.fail_threshold");
      return (async (): Promise<number> => {
        const promoted: any[] = [];
        const evalPending: any[] = [];
        let usageIn = 0, usageOut = 0; // R10.4
        for (const cand of candidates) {
          const ctxPkg = trees.evalContext(tid, cand.key, state, ctxName);
          // 0.27: mixed question types ride ONE request per node (protocol native)
          const res = await evalMixed(
            ctxPkg,
            cand.conds.map((c: any) => {
              if (c.op === "eval-choice") return { type: "choice", question: c.question, options: c.options || {}, answer: c.answer || "" };
              if (c.op === "eval-score") return { type: "score", question: c.question, levels: c.levels || [], min: c.min ?? 0 };
              return { type: "boolean", question: c.question };
            }),
            token,
            endpoint
          );
          usageIn += (res as any).usage?.inputTokens ?? 0;
          usageOut += (res as any).usage?.outputTokens ?? 0;
          if (!res.ok) {
            evalPending.push({ key: cand.key, results: cand.conds.map((c: any) => ({ name: c.name, outcome: "pending", reason: res.error })) });
            continue;
          }
          const results = cand.conds.map((c: any, i: number) => {
            const r = res.results[i];
            if (c.op === "eval-choice") {
              const m = mapChoiceOutcome(r as any, c.answer || "", passT, failT);
              return { name: c.name, ...m };
            }
            if (c.op === "eval-score") {
              const m = mapScoreOutcome(r as any, c.min ?? 0);
              return { name: c.name, ...m };
            }
            const m = mapOutcome(r as any, passT, failT);
            return { name: c.name, ...m };
          });
          if (results.every((r: any) => r.outcome === "pass")) {
            promoted.push({ key: cand.key, name: cand.name, tier: cand.tier, cost: cand.cost, eval_verified: true });
          } else {
            evalPending.push({ key: cand.key, results });
          }
        }
        const all = [...rows, ...promoted];
        try {
          const run = process.env.YGL_RUN_ID || "";
          db.run(
            "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,'info')",
            [shortId(["eval.ready", "tree", tid], 12), nowIso(), "cli", "eval.ready", "tree", tid,
             JSON.stringify({
               promoted: promoted.map((p) => p.key), pending: evalPending.map((p) => p.key),
               usage: { inputTokens: usageIn, outputTokens: usageOut },
               ...(run ? { run } : {}),
             })]
          );
        } catch { /* audit best-effort */ }
        if (ctx.json) {
          console.log(JSON.stringify({ ready: all, eval_pending: evalPending }, null, 2));
          return 0;
        }
        head(ctx, `Ready to unlock (${all.length}${promoted.length ? `，含 ${promoted.length} 个经决策模型放行` : ""})`);
        table(ctx, all, ["key", "name", "tier", "cost"], ["key", "name", "tier", "cost"]);
        if (evalPending.length) {
          out(ctx, paint(C.bold, `  eval pending（灰带/未配置，非终态，${evalPending.length} 节点）`, ctx.color));
          for (const p of evalPending)
            out(ctx, paint(C.dim, `    - ${p.key}: ${p.results.map((r: any) => `${r.name}=${r.outcome}${r.p !== undefined ? `(P=${r.p})` : r.score !== undefined ? `(score=${r.score})` : ""}`).join(" ")}`, ctx.color));
        }
        return 0;
      })().catch((e: any): number => {
        bad(ctx, e?.message || String(e));
        return 1;
      });
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
      table(ctx, trees.nodeList(tid), ["key", "name", "kind", "tier", "cost", "状态", "必检父", "子节点"], [
        "key",
        "name",
        "kind",
        "tier",
        "cost",
        "state",
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
      const st = trees.nodeStateOf(tid, key);
      if (ctx.json) {
        console.log(JSON.stringify({
          node: { ...n, state: st.state, unlocked_at: st.unlocked_at },
          parents: trees.parents(tid, key),
          conditions: trees.condList(tid, key),
        }, null, 2));
        return 0;
      }
      head(ctx, `${n.key}  (${n.name})`);
      show(ctx, {
        id: n.id, kind: n.kind, tier: n.tier,
        cost: `${n.cost}${n.cost_unit ? " " + n.cost_unit : ""}`,
        tags: n.tags || "-",
        状态: st.state === "unlocked" ? `已解锁${st.unlocked_at ? " @ " + st.unlocked_at : ""}` : st.state,
      });
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
