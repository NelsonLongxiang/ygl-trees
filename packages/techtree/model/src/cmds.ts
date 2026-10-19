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
import { ok, bad, out, head, table, show, paint, C, ack, warn } from "../../../core/text/src/fmt";
import { rejectBare, validateEnum } from "../../../core/text/src/flagcheck";
import { getOrm } from "../../../core/database/src/orm";
import { resolveProject, sessionId } from "../../../core/database/src/selection";
import * as treeWrites from "./writes";
import {
  DEFAULT_ENDPOINT, evalBoolean, evalChoice, evalMixed, evalScore, evalToken,
  mapChoiceOutcome, mapOutcome, mapScoreOutcome, packEvalChoiceSpec, packEvalScoreSpec, parseEvalSpec,
} from "../../eval/src/eval";
import { configGet, configGetBool, configGetNumber } from "../../../ops/tools/src/config";
import { clip, nowIso, shortId } from "../../../core/text/src/text";
// 0.91a: selection/eval bare INSERTs gain bus emission — static import per
// direct-032bf3b4 (require-in-catch silently dies under ESM hosts).
import { emitEvent } from "../../../core/text/src/eventbus";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, db } = env;
  const trees = new TreeStore(db);

  // 0.83 (user report ①): --tree long alias alongside -t — pointer-hijack
  // pinning needs an ergonomic, self-documenting form. EXCEPTION: `node
  // import --tree <name>` is that command's own target-tree flag (create or
  // merge destination), never a selector — alias must not shadow it.
  const treeFlagAliasOk = !(action === "import");
  const sel = treeFlagAliasOk
    ? ((args.flags.t ?? args.flags.tree) ? String(args.flags.t ?? args.flags.tree) : undefined)
    : (args.flags.t ? String(args.flags.t) : undefined);
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
        bad(ctx, enrichNodeNotFound(e?.message || String(e)));
        return 1;
      });
  }

  /** Report ③-3: selection changes are now first-class events — a parallel
   *  session flipping current_tree/current_project becomes observable
   *  (agent brief surfaces it; db timeline shows the history). Session
   *  identity comes from YGL_SESSION (agents that care can set it). */
  function logSelectionEvent(database: any, kind: "tree.use" | "project.use", name: string): void {
    try {
      const evTs = new Date().toISOString();
      const evPayload = JSON.stringify({ name, session: process.env.YGL_SESSION || "cli" });
      database.run(
        "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
        [
          `ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          evTs,
          process.env.YGL_SESSION || "cli",
          kind,
          kind === "tree.use" ? "tree" : "project",
          name,
          evPayload,
          "info",
        ]
      );
      // 0.91a: bare INSERT gains bus emission (autocommit == post-commit)
      emitEvent({ kind, entity: kind === "tree.use" ? "tree" : "project", entityId: name, payload: evPayload, ts: evTs });
    } catch { /* telemetry only — never block the selection */
    }
  }

  /** Report ③ enrichment: "node not found: X" earned a cross-tree lookup —
   *  if a parallel session flipped current_tree, the key usually exists in
   *  another tree; name it instead of making the user blind-list. */
  function enrichNodeNotFound(msg: string): string {
    const m = /^node not found: (.+)$/.exec(msg);
    if (!m) return msg;
    const others = trees.nodeInOtherTrees(m[1], tid);
    if (others.length) {
      const names = others.map((o: any) => `'${o.tree}'`).join(", ");
      return `${msg}\n  key exists in other tree(s): ${names} — pin it: ygl-trees ${env.group} ... -t ${others[0].tree}`;
    }
    return `${msg}  (current tree: '${tree?.name ?? "?"}' — node list to inspect, -t <tree> to switch)`;
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
      let proj: any = null;
      if (pid) {
        proj = db.get("SELECT id, name FROM projects WHERE name=?", [pid]);
        // R16.5: an unknown --project used to silently fall through to a
        // workspace-level tree (proj?.id || "") — name it instead.
        if (!proj) {
          bad(ctx, `project not found: ${pid} (tree new stays workspace-level — drop --project or pass an existing name)`);
          return 2;
        }
      }
      return runTreeWrite((ds) => treeWrites.treeCreate(ds, name, proj?.id || ""), (t): number => {
        // R16.2: session-scoped selection — global pointer untouched.
        db.metaSet(`current_tree@${sessionId()}`, t.name);
        logSelectionEvent(db, "tree.use", t.name);
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
    if (sub === "show") {
      // R16.1: selection annotation on the read path (additive JSON field).
      const selT = trees.treeSelection(flagStr("tree") || flagStr("t") || name);
      let t: any = selT.name ? trees.treeByName(selT.name) : null;
      if (!t && name) t = trees.treeByName(name);
      if (!t) {
        bad(ctx, `tree not found: ${selT.name || name || "(none selected)"}`);
        return 1;
      }
      const stats = db.get(
        `SELECT (SELECT COUNT(*) FROM nodes n WHERE n.tree_id=?) AS nodes,
                (SELECT COUNT(*) FROM node_edges e WHERE e.tree_id=?) AS edges,
                (SELECT COUNT(*) FROM node_state s WHERE s.tree_id=? AND s.status='unlocked') AS unlocked`,
        [t.id, t.id, t.id]
      );
      const payload = {
        tree: { name: t.name, note: t.note || "", project_id: t.project_id || null, created: t.created },
        nodes: stats?.nodes ?? 0,
        edges: stats?.edges ?? 0,
        unlocked: stats?.unlocked ?? 0,
        selection_source: selT.source,
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }
      head(ctx, `Tree ${t.name}  (selection: ${selT.source})`);
      show(ctx, payload.tree);
      show(ctx, { nodes: payload.nodes, edges: payload.edges, unlocked: payload.unlocked });
      return 0;
    }
    if (sub === "use") {
      const t = trees.treeByName(name);
      if (!t) {
        bad(ctx, `tree not found: ${name}`);
        return 1;
      }
      // R16.5: a project-bound tree selected while another project resolves
      // as current is suspicious (parallel session / stale pointer) — WARN,
      // don't block; the tree itself is still readable.
      if (t.project_id) {
        const owner = db.get("SELECT name FROM projects WHERE id=?", [t.project_id]);
        const projSel = resolveProject(db, flagStr("project"));
        if (owner && projSel.id && projSel.id !== t.project_id) {
          warn(
            ctx,
            `tree '${name}' belongs to project '${owner.name}'; current project selection is '${projSel.name}' (${projSel.source}) — pin -p <project> if this mismatch is unintended`
          );
        }
      }
      // R16.2: session key by default; --global opts into the migration fallback.
      const scope = args.flags.global === true || args.flags.global === "true" ? "global" : "session";
      db.metaSet(scope === "global" ? "current_tree" : `current_tree@${sessionId()}`, name);
      logSelectionEvent(db, "tree.use", name);
      ack(
        ctx,
        { tree: name, scope, session: sessionId() },
        `now using tree: ${name}  (${scope} selection)`
      );
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
  // 0.82 report ③: `node cond --due [--days N] [--eval]` — eval conds whose
  // question carries a YYYY-MM-DD deadline, due (or overdue) within N days
  // (default 7). --eval runs the decision model on each; judgment only —
  // resolve/unlock stay human (same discipline as predict audit). Pre-tree-
  // resolution like ready --all: --due is inherently cross-tree.
  if (env.group === "node" && action === "cond" && args?.flags?.due === true) {
    const days = flagNum("days", 7);
    const ctxName = flagStr("context", "default");
    const conds = db.all(
      `SELECT nc.id, nc.name, nc.op, nc.value, n.key node_key, n.id node_id, t.id tree_id, t.name tree
         FROM node_conditions nc JOIN nodes n ON n.id=nc.node_id JOIN trees t ON t.id=n.tree_id
        WHERE nc.op LIKE 'eval%' ORDER BY t.name, n.key`
    ) as any[];
    const now = Date.now();
    const due: any[] = [];
    for (const c of conds) {
      const spec = parseEvalSpec(c.value);
      const q = spec.q || String(c.name);
      const m = q.match(/(20\d{2})-(\d{2})-(\d{2})/);
      if (!m) continue;
      const dl = Date.parse(`${m[1]}-${m[2]}-${m[3]}T23:59:59Z`);
      if (!Number.isFinite(dl) || dl > now + days * 86400000) continue;
      due.push({
        tree: c.tree, tree_id: c.tree_id, node: c.node_key, node_id: c.node_id,
        name: String(c.name), op: String(c.op), question: q, envelope: spec,
        deadline: `${m[1]}-${m[2]}-${m[3]}`, days_left: Math.ceil((dl - now) / 86400000),
      });
    }
    due.sort((a: any, b: any) => a.days_left - b.days_left);
    if (args?.flags?.eval !== true) {
      if (ctx.json) console.log(JSON.stringify(due, null, 2));
      else {
        head(ctx, `临期 eval 门槛 × ${due.length}（${days} 天窗口）`);
        if (!due.length) out(ctx, paint(C.dim, "  (无临期 eval 条件)", ctx.color));
        table(
          ctx,
          due.map((d: any) => ({ tree: d.tree, node: d.node, cond: d.name, deadline: d.deadline, 剩余天数: d.days_left, question: clip(d.question, 40) })),
          ["tree", "node", "cond", "deadline", "剩余天数", "question"],
          ["tree", "node", "cond", "deadline", "剩余天数", "question"]
        );
      }
      return 0;
    }
    // --eval: one decision-model request per due cond (ready --eval wiring)
    const offline = !!process.env.YGL_EVAL_OFFLINE || configGetBool(env.db, "eval.offline");
    const cfgToken = configGet(env.db, "decision_model_llm_token").trim();
    const token = offline ? "" : cfgToken || evalToken();
    const endpoint = configGet(env.db, "decision_model_llm_api_base").trim() || DEFAULT_ENDPOINT;
    const passT = configGetNumber(env.db, "eval.pass_threshold");
    const failT = configGetNumber(env.db, "eval.fail_threshold");
    return (async (): Promise<number> => {
      const rows: any[] = [];
      for (const d of due) {
        const ctxPkg = trees.evalContext(d.tree_id, d.node, {}, ctxName);
        const q =
          d.op === "eval-choice" ? { type: "choice" as const, question: d.question, options: d.envelope.options || {}, answer: d.envelope.answer || "" }
          : d.op === "eval-score" ? { type: "score" as const, question: d.question, levels: d.envelope.levels || [], min: d.envelope.min ?? 0 }
          : { type: "boolean" as const, question: d.question };
        const res = await evalMixed(ctxPkg, [q], token, endpoint);
        if (!res.ok) {
          rows.push({ ...d, outcome: "pending", reason: res.error });
          continue;
        }
        const r = res.results[0];
        const m = d.op === "eval-choice" ? mapChoiceOutcome(r, d.envelope.answer || "", passT, failT)
          : d.op === "eval-score" ? mapScoreOutcome(r, d.envelope.min ?? 0)
          : mapOutcome(r, passT, failT);
        rows.push({ ...d, ...m });
      }
      if (ctx.json) console.log(JSON.stringify(rows, null, 2));
      else {
        head(ctx, `临期 eval 门槛 — 已判定 × ${rows.length}`);
        table(
          ctx,
          rows.map((d: any) => ({ tree: d.tree, node: d.node, deadline: d.deadline, outcome: d.outcome, p: d.p ?? d.score ?? "", question: clip(d.question, 36) })),
          ["tree", "node", "deadline", "判定", "p", "question"],
          ["tree", "node", "deadline", "outcome", "p", "question"]
        );
        out(ctx, paint(C.dim, "  判定只报告不仲裁：通过 ≠ 自动解锁（resolve/unlock 保持人工）", ctx.color));
      }
      return 0;
    })();
  }
  // 0.82 report ②: `node ready --all` sweeps EVERY tree — no tree use / -t
  // needed (12 trees used to cost 24 commands). Runs before tree resolution
  // because --all deliberately ignores the current selection.
  if (env.group === "node" && action === "ready" && args?.flags?.all === true) {
    const state = parseState(args);
    const ctxName = flagStr("context", "default");
    const all = db.all("SELECT id, name FROM trees ORDER BY created") as any[];
    const per: any[] = [];
    for (const t of all) {
      const rows = trees.ready(t.id, ctxName, state);
      if (rows.length) per.push({ tree: t.name, ready: rows });
    }
    if (ctx.json) {
      console.log(JSON.stringify(per, null, 2));
      return 0;
    }
    head(ctx, `Ready across ${all.length} trees`);
    if (!per.length) out(ctx, paint(C.dim, "  (no tree has ready nodes)", ctx.color));
    for (const p of per) {
      out(ctx, paint(C.bold, `  ${p.tree} (${p.ready.length})`, ctx.color));
      table(ctx, p.ready, ["key", "name", "tier", "cost"], ["key", "name", "tier", "cost"]);
    }
    return 0;
  }
  let tree: any;
  try {
    tree = positionalTree || trees.treeResolve(sel);
  } catch (e: any) {
    bad(ctx, e.message);
    return 1;
  }
  let tid = tree.id;

  if (env.group === "node") {
    const sub = action;               // add | link | can | ready | ...
    // 0.90 ③ (direct-ce7e561b): accept qualified node refs — `node:<tree>/<key>`
    // and `<tree>/<key>` retarget the tree; `node:<key>` sheds its prefix.
    // Keys and tree names never contain '/', so the first slash unambiguously
    // splits when the head names an existing tree. Cross-tree link refs are
    // refused (edges stay single-tree); a qualified ref overrides -t.
    const unqualify = (s: string): { ref: string; treeName?: string } => {
      let ref = String(s ?? "");
      if (ref.startsWith("node:")) ref = ref.slice(5);
      const i = ref.indexOf("/");
      if (i > 0) {
        const head = ref.slice(0, i);
        const t = db.get("SELECT name FROM trees WHERE name=? OR id=?", [head, head]) as any;
        if (t) return { ref: ref.slice(i + 1), treeName: t.name };
      }
      return { ref };
    };
    if (rest[0] !== undefined) {
      const q = unqualify(rest[0]);
      if (q.treeName && q.treeName !== tree.name) {
        const t2 = db.get("SELECT * FROM trees WHERE name=?", [q.treeName]) as any;
        if (!t2) { bad(ctx, `tree not found: ${q.treeName}`); return 1; }
        tree = t2; tid = t2.id; rest[0] = q.ref;
      } else if (q.ref !== rest[0]) {
        rest[0] = q.ref;
      }
    }
    if (sub === "link" && rest[1] !== undefined) {
      const q2 = unqualify(rest[1]);
      if (q2.treeName && q2.treeName !== tree.name) {
        bad(ctx, `cross-tree link refused: '${rest[1]}' lives in tree '${q2.treeName}' but the parent is in '${tree.name}' — edges stay single-tree`);
        return 2;
      }
      if (q2.ref !== rest[1]) rest[1] = q2.ref;
    }
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
      // 0.81 action-word consistency: `node cond add <key>` used to parse
      // "add" as the node key ("node not found: add"); link/unlock style
      // now works, and the long-missing `node cond rm <key> --name <n>`
      // finally exists (was db-sql-only cleanup).
      let cKey: string | undefined = key;
      const cAct = key === "add" ? "add" : key === "rm" || key === "remove" ? "rm" : "";
      if (cAct) cKey = rest[1];
      if (cAct === "rm") {
        const name = flagStr("name");
        if (!cKey || !name) {
          bad(ctx, "usage: node cond rm <key> --name <cond>");
          return 2;
        }
        return runTreeWrite(
          (ds) => treeWrites.condRemove(ds, tid, cKey!, name),
          (r): number => {
            ok(ctx, `condition removed: ${cKey} · ${name}  (was ${r.required ? "必检" : "可选"}/${r.effect})`);
            return 0;
          }
        );
      }
      if (!cKey) {
        bad(ctx, "usage: node cond [add|rm] <key> --name <cond> [--kind ..] [--op >=|==|<=|!=|has] [--value n] [--op telemetry --value 'cmd.run>=100'|'cmd.run:14d>=100'] [--op eval [--value q] | eval-choice --options k=d,.. --answer k | eval-score --levels a,b,.. --min-score n] [--optional] [--effect gate|cost_mul] [--weight n]");
        return 2;
      }
      const k = cKey;
      if (rejectBare(ctx, args.flags, ["name", "value", "op", "effect", "weight", "options", "answer", "levels", "min-score"])) return 2;
      if (validateEnum(ctx, args.flags, "op", [">=", "==", "<=", "!=", "has", "telemetry", "eval", "eval-choice", "eval-score"])) return 2;
      if (validateEnum(ctx, args.flags, "effect", ["gate", "cost_mul"])) return 2;
      const name = flagStr("name");
      // 0.89.1: `node cond <key> --op eval --value q` without --name used to
      // fall through to list mode ("(empty)", rc=0, zero writes) — a success-
      // shaped receipt masking a no-op (same family as the unlink fix, 单2).
      // Add-shaped flags without --name are a usage error, not a list request.
      const addShaped = ["op", "value", "options", "answer", "levels", "min-score", "kind", "optional", "effect", "weight"].some((f) => args.flags[f] !== undefined);
      if (!name && addShaped) {
        bad(ctx, "usage: node cond add <key> --name <cond> [--kind ..] [--op ..] — condition add requires --name (bare `node cond <key>` lists existing conditions)");
        return 2;
      }
      if (!name) {
        table(ctx, trees.condList(tid, k), ["id", "name", "kind", "op", "value", "必检", "effect"], [
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
          treeWrites.condAdd(ds, tid, k, {
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
          if ((c as any).duplicate) {
            ack(ctx, c, `condition exists (duplicate): ${k} · ${c.name}  [${c.required ? "必检" : "可选"}/${c.effect}]`);
          } else {
            ack(ctx, c, `condition added: ${k} · ${c.name}  [${c.required ? "必检" : "可选"}/${c.effect}]`);
          }
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
        bad(ctx, "usage: node can <key...> [--context ctx] [--state k=v] [--state-file file] [--eval]");
        return 2;
      }
      // 0.79.1 (R297 user report): batch mode — multiple keys judged in ONE
      // process (probes used to pay ~1s cold start per node), plus
      // --state-file for JSON state bags (shared or per-node).
      const keys = [...new Set((rest as string[]).filter(Boolean))];
      const sharedState = parseState(args);
      let perKeyBags: Record<string, any> | null = null;
      try {
        perKeyBags = loadStateFile(args, sharedState);
      } catch (e: any) {
        const msg = e?.message || String(e);
        bad(ctx, msg);
        return /^usage:/.test(msg) ? 2 : /must contain a JSON object/.test(msg) ? 2 : 1;
      }
      const stateFor = (k: string): Record<string, any> =>
        perKeyBags ? (perKeyBags[k] && typeof perKeyBags[k] === "object" && !Array.isArray(perKeyBags[k]) ? perKeyBags[k] : {}) : sharedState;
      const ctxName = flagStr("context", "default");
      // eval-family config read once per run (R8 credential priority:
      // config decision_model_llm_* first, then env AI_GATEWAY_API_KEY)
      const offline = !!process.env.YGL_EVAL_OFFLINE || configGetBool(env.db, "eval.offline");
      const cfgToken = configGet(env.db, "decision_model_llm_token").trim();
      const token = offline ? "" : cfgToken || evalToken();
      const endpoint = configGet(env.db, "decision_model_llm_api_base").trim() || DEFAULT_ENDPOINT;
      const passT = configGetNumber(env.db, "eval.pass_threshold");
      const failT = configGetNumber(env.db, "eval.fail_threshold");
      /** Judge one node: canUnlock (+ eval gates when --eval). Never throws —
       *  hard failures come back as {key, error}. */
      const judgeOne = async (k: string): Promise<any> => {
        let r: any;
        try {
          r = trees.canUnlock(tid, k, ctxName, stateFor(k));
        } catch (e: any) {
          return { key: k, error: enrichNodeNotFound(e?.message || String(e)) };
        }
        const state = stateFor(k);
        const evalConds = flagBool("eval")
          ? trees.condList(tid, k).filter((c: any) => /^eval(-choice|-score)?$/.test(String(c.op)))
          : [];
        if (!evalConds.length) return r;
        // R8: decision-model evaluation for op=eval conditions.
        // Offline-safe: no token / network failure → pending (rc=0).
        const contextPkg = trees.evalContext(tid, k, state, ctxName);
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
        // 0.83 (user report ④): snapshot the rel attachments the eval actually
        // consumed — otherwise a passing P value can't be reproduced without
        // digging the db. Byte-compat: field only when attachments exist.
        const atts = (contextPkg as any).attachments;
        if (Array.isArray(atts) && atts.length) r.eval_attachments = atts;
        r.ok = (r.missing_required as string[]).length === 0 && (r.blocked_by as string[]).length === 0 && pendingList.length === 0;
        try {
          const run = process.env.YGL_RUN_ID || "";
          const evTs = nowIso();
          const evPayload = JSON.stringify({
            conds: evaluated.map((e) => ({ name: e.name, type: e.type, outcome: e.outcome, p: e.p ?? null, score: e.score ?? null })),
            usage: { inputTokens: usageIn, outputTokens: usageOut },
            ...(run ? { run } : {}),
          });
          db.run(
            "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,'info')",
            [shortId(["eval.gate", "node", k], 12), evTs, "cli", "eval.gate", "node", k, evPayload]
          );
          // 0.91a: bus emission joins the audit row (post-commit, same snapshot)
          emitEvent({ kind: "eval.gate", entity: "node", entityId: k, payload: evPayload, ts: evTs });
        } catch { /* audit best-effort */ }
        return r;
      };
      const batch = keys.length > 1;
      return (async (): Promise<number> => {
        const results = [] as any[];
        for (const k of keys) results.push(await judgeOne(k));
        if (ctx.json) {
          // single key → object (frozen shape); batch → array
          console.log(JSON.stringify(batch ? results : results[0], null, 2));
          return results.some((r) => r.error) ? 1 : 0;
        }
        if (!batch) {
          const r = results[0];
          if (r.error) { bad(ctx, r.error); return 1; }
          if (!r.evaluated) {
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
          head(ctx, `can unlock: ${r.key}`);
          out(ctx, `  ${r.ok ? paint(C.green, "✓ 可解锁", ctx.color) : r.pending.length ? paint(C.yellow, "… 待判定（决策模型 pending）", ctx.color) : paint(C.red, "✗ 不可解锁", ctx.color)}`);
          if (r.missing_required.length) {
            out(ctx, paint(C.bold, "  必检未满足", ctx.color));
            for (const m of r.missing_required) out(ctx, `    - ${m}`);
          }
          if (r.pending.length) {
            out(ctx, paint(C.bold, "  决策模型 pending（灰带/未配置，非终态）", ctx.color));
            for (const p of r.pending) out(ctx, `    - ${p}`);
          }
          if (r.blocked_by.length) {
            out(ctx, paint(C.bold, "  被排斥", ctx.color));
            for (const b of r.blocked_by) out(ctx, `    - ${b}`);
          }
          if (r.missing_optional.length) {
            out(ctx, paint(C.dim, "  可选未满足（不阻塞）", ctx.color));
            for (const m of r.missing_optional) out(ctx, `    - ${m}`);
          }
          for (const e of r.evaluated) out(ctx, paint(C.dim, `  eval ${e.name}: P=${e.p ?? "-"} → ${e.outcome}${e.reason ? ` (${e.reason})` : ""}`, ctx.color));
          // 0.83 ④: what the model actually ate this run (rel fabric snapshot)
          if (Array.isArray(r.eval_attachments) && r.eval_attachments.length) {
            out(ctx, paint(C.dim, `  attachments ×${r.eval_attachments.length}:`, ctx.color));
            for (const a of r.eval_attachments) {
              const label = a.type === "claim" ? `${a.id}(${a.status})`
                : a.type === "evidence" ? `${a.id} "${clip(a.quote, 36)}"`
                : a.type === "kb" || a.type === "source" ? `${a.id} ${clip(a.title, 30)}`
                : a.type === "node" ? `${a.key ?? a.id}`
                : String(a.id);
              out(ctx, paint(C.dim, `    - ${a.rel} ← ${a.type}:${label}`, ctx.color));
            }
          }
          if (r.cost_multiplier !== 1) out(ctx, `  成本系数 ${r.cost_multiplier}`);
          return 0;
        }
        // batch human view: one compact line per node (probe-friendly)
        const via = perKeyBags ? "per-node --state-file" : Object.keys(sharedState).length ? "shared state" : "";
        head(ctx, `can unlock × ${results.length}${via ? ` (${via})` : ""}`);
        for (const r of results) {
          if (r.error) {
            out(ctx, `  ${paint(C.red, "✗", ctx.color)} ${r.key}  ${r.error}`);
            continue;
          }
          const mark = r.ok ? paint(C.green, "✓", ctx.color) : r.pending?.length ? paint(C.yellow, "…", ctx.color) : paint(C.red, "✗", ctx.color);
          const blockers = [
            ...(r.missing_required || []).map((m: string) => m),
            ...(r.blocked_by || []).map((b: string) => `excluded:${b}`),
          ].join(", ");
          out(ctx, `  ${mark} ${r.key}${r.pending?.length ? " (eval pending)" : ""}${blockers ? `  — ${blockers}` : ""}`);
        }
        return results.some((r) => r.error) ? 1 : 0;
      })().catch((e: any): number => {
        bad(ctx, e?.message || String(e));
        return 1;
      });
    }

    if (sub === "ready") {
      const state = parseState(args);
      try {
        // 0.79.1: --state-file flat bag works here too (per-node shape makes
        // no sense for ready — it judges the whole tree, so flat-only).
        const bags = loadStateFile(args, state);
        if (bags) {
          bad(ctx, "--state-file per-node shape (key→object) only applies to batch `node can k1 k2 …`; ready wants a flat counter object");
          return 2;
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        bad(ctx, msg);
        return /^usage:/.test(msg) || /must contain a JSON object/.test(msg) ? 2 : 1;
      }
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
          const evTs = nowIso();
          const evPayload = JSON.stringify({
            promoted: promoted.map((p) => p.key), pending: evalPending.map((p) => p.key),
            usage: { inputTokens: usageIn, outputTokens: usageOut },
            ...(run ? { run } : {}),
          });
          db.run(
            "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,'info')",
            [shortId(["eval.ready", "tree", tid], 12), evTs, "cli", "eval.ready", "tree", tid, evPayload]
          );
          // 0.91a: bus emission joins the audit row (post-commit, same snapshot)
          emitEvent({ kind: "eval.ready", entity: "tree", entityId: tid, payload: evPayload, ts: evTs });
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
      let p: any;
      try {
        p = trees.pathTo(tid, key, flagStr("context", "default"));
      } catch (e: any) {
        bad(ctx, enrichNodeNotFound(e?.message || String(e)));
        return 1;
      }
      if (ctx.json) {
        console.log(JSON.stringify(p, null, 2));
        return 0;
      }
      head(ctx, `Unlock order to ${key}`);
      p.order.forEach((k: any, i: number) => out(ctx, `  ${i + 1}. ${k}`));
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
      // Contract ⑤ extension (user report: `node list --tree X` silently
      // swallowed the unknown flag and listed the CURRENT tree). node list
      // takes exactly -t/--tree <tree> / --json — any other flag is a typo
      // worth an explicit rc=2 instead of silent misdirection.
      for (const f of Object.keys(args.flags || {})) {
        if (!["t", "tree", "json", "no-color"].includes(f)) {
          bad(ctx, `unknown flag --${f} for 'node list' — tree selection is '-t|--tree <tree>' (positional <tree> also works)`);
          return 2;
        }
      }
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
        bad(ctx, enrichNodeNotFound(`node not found: ${key}`));
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
          // R16.2: import re-points the SESSION selection, not the global.
          db.metaSet(`current_tree@${sessionId()}`, r.tree.name);
          logSelectionEvent(db, "tree.use", r.tree.name);
          if (!ctx.json) out(ctx, paint(C.dim, `  index rebuilt; now using tree: ${r.tree.name}`, ctx.color));
          return 0;
        }
      );
    }

    // Report ⑤: tree-scoped growth timeline — workspace-level `db timeline`
    // already existed; this projects a single tree's unlock/add milestones.
    if (sub === "timeline") {
      const rows = db.all(
        `SELECT e.ts, e.kind, e.payload FROM events e
          WHERE e.entity = 'node'
            AND e.entity_id IN (SELECT id FROM nodes WHERE tree_id = ?)
          ORDER BY e.ts DESC LIMIT 30`,
        [tid]
      );
      if (ctx.json) {
        console.log(JSON.stringify(rows.map((r: any) => ({
          ts: r.ts, kind: r.kind, ...(JSON.parse(r.payload || "{}") as any),
        })), null, 2));
        return 0;
      }
      head(ctx, `Timeline — tree '${tree.name}' (last ${rows.length})`);
      for (const r of rows) {
        let detail = "";
        try {
          const p = JSON.parse(r.payload || "{}") as any;
          detail = [p.key, p.name ? String(p.name).slice(0, 30) : ""].filter(Boolean).join("  ");
        } catch { /* */ }
        out(ctx, `  ${String(r.ts).slice(0, 16)}  ${r.kind.padEnd(14)} ${detail}`);
      }
      if (!rows.length) out(ctx, paint(C.dim, "  (no node events yet — unlock/add to start the history)", ctx.color));
      return 0;
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

  // 0.91.0 (cold-run friction log): bare group = usage display (rc 0);
  // unknown subaction = usage ERROR (rc 2) — the frozen exit-code contract.
  if (action) {
    bad(ctx, `unknown ${env.group} subcommand: ${action}`);
  }
  out(
    ctx,
    paint(
      C.dim,
      "  tree new|list|use <name>   ·   node add|link|unlink|cond|index|can|ready|path|parents|children|ancestors|descendants|list|show|search|unlock|lock|validate|export|rm",
      ctx.color
    )
  );
  return action ? 2 : 0;
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

/**
 * 0.79.1 (R297 user report): `--state-file <path.json>` loads the state bag
 * from JSON instead of inline `--state k=v`. Two accepted shapes:
 *   flat shared   {"y_imported": 12}            → merged over --state, all keys share it
 *   per-node map  {"node-a": {"y": 1}, ...}     → each judged node gets its own bag
 * (disambiguated by "every value is a plain object"). Returns the per-node map
 * when shape B, null when merged into `shared`. Throws on unreadable/invalid.
 */
function loadStateFile(args: any, shared: Record<string, any>): Record<string, any> | null {
  const sf = args.flags["state-file"];
  if (sf === undefined) return null; // flag absent → no bags (plain can/ready)
  if (sf === true || sf === "") throw new Error("usage: --state-file <path.json>");
  let parsed: any;
  try {
    parsed = JSON.parse(require("node:fs").readFileSync(String(sf), "utf8"));
  } catch (e: any) {
    throw new Error(`cannot read --state-file ${sf}: ${e?.message || e}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--state-file must contain a JSON object (flat counters, or per-node key→object map)");
  }
  const vals: any[] = Object.values(parsed);
  if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) return parsed;
  Object.assign(shared, parsed);
  return null;
}
