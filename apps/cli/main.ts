/**
 * CLI application layer — composes domain packages via Cordis Context.
 * Services are accessed through ctx.database, ctx.research, ctx.techtree.
 * No domain logic here; only composition and dispatch.
 */
import * as os from "node:os";
import * as path from "node:path";
import { Context as CordisContext } from "cordis";
import { dbPath } from "../../packages/core/database/src/db";
import { Ctx, bad, out, paint, C } from "../../packages/core/text/src/fmt";
import { Args, parse, str, num, bool, Env } from "../../packages/core/database/src/types";
import { apply as DatabasePlugin } from "../../packages/core/database/src/plugin";
import { Store } from "../../packages/research/pipeline/src/reads";
import { apply as TechTreePlugin } from "../../packages/techtree/model/src/plugin";

export const HOME = process.env.YGL_HOME || path.join(os.homedir(), ".ygl-trees");

// ── Usage text ──
// (kept in apps/cli because it's presentation, not domain logic)

const USAGE = `
${paint(C.bold, "ygl-trees", true)}  猿光 · 科技树
${paint(C.dim, "database-centric CLI: research → production → knowledge reuse", true)}

  ygl-trees <group> <action> [args] [options]        add --json for machine output

${paint(C.bold, "config", true)}      user-tunable settings (registry defaults + overrides)
  list                       all keys: value + default + note
  get <key>                  resolved value (config table > default)
  set <key> <value>          validated against registry (type/range); events logged
  reset <key>                drop override → back to default

${paint(C.bold, "db", true)}
  init                       create the workspace + schema
  stats                      row counts per table
  path                       print the database file path
  export <file.sql> [--lean] dump ALL data tables (+ summary); --lean skips derived
  sync pg <url>              one-way full mirror to PostgreSQL (L1, see docs/pg-compat.md)
  migrate pg <url> [--fresh] one-time full-fidelity graduation (constraints + data, atomic)
  dups                       list duplicate-content rows
  reset                      delete the database (asks nothing, be careful)
  sql "<sql>"                ad-hoc statement (can mutate — power tool, no guardrails)

${paint(C.bold, "skill", true)}        L1 description / L2 body / L3 references
  import <file.md>           import a SKILL.md (frontmatter = L1, body = L2)
  add                        --name --description --body [-f file.md]
  list | show <name> | rm <name> | enable <name> | disable <name>
  match "<query>"            full-text match, prints L1 candidates for an agent
  refs add <skill> <path> --body ...

${paint(C.bold, "project", true)}
  new <name> -q "<question>"  create + select
  list | use <name> | show

${paint(C.bold, "research", true)}    collect → screen → extract → claim
  query add "<text>"          register a search query
  query attach <qid> <sid>    link source to query (recalled count)
  query list
  source add --title --url [--abstract --content --relevance --confidence --query]
  source fetch <url>          fetch page, extract title/meta/text (zero side-effect on failure)
  source list | search "<q>" | show <id> | rm <id>
  evidence add <sourceId> --quote "..." [--note --locator]
  evidence list
  claim add "<text>" [--confidence A|B|C]
  claim link <claimId> <evidenceId> [--stance supports|refutes]
  claim resolve <claimId> --as supported|refuted|contested [--note]
  claim list

${paint(C.bold, "produce", true)}     outline → section → report
  outline                    auto-outline from claims
  section <title> --body|-f  add a section artifact
  report                     assemble claims+evidence+sections into a report
  list | show <id> | export <id> <file>

${paint(C.bold, "kb", true)}          long-term knowledge
  add --title --body|-f [--tags --confidence]
  import <dir|file.md>       batch markdown (frontmatter, idempotent, single tx)
  search "<q>" | list | show <id>
  link <a> <b> [--rel]
  ingest <artifactId>        import a finished artifact
  promote <noteId> [--name]  turn a note into a reusable skill

${paint(C.bold, "job", true)}         batch + schedule (drive with cron: job tick)
  add <title> -- <command> [--every <min>] [--at "YYYY-MM-DD HH:MM"]
  list | run <id> | tick | enable <id> | disable <id> | logs

${paint(C.bold, "tree / node", true)}   tech-tree node model
  tree new <name> [--project p]      create a tree (nodes live in it)
  tree list | tree use <name>

  node add <key> [--name --kind --tier --cost --tags --payload]
  node link <parent> <child>         [--rel prereq|unlock|excludes|enables]
                                      [--mode AND|OR|XOR|NOT] [--optional]
                                      [--min-level n] [--weight n]
  node unlink <parent> <child> [--rel prereq]
  node cond <key> --name <c>         [--kind flag|resource|level|quest|time|expr]
                                      [--op >=|==|<=|!=|has] [--value v] [--optional]
                                      [--op eval --value "<布尔问题>"]
                                      [--op eval-choice --value "<问题>" --options "k=desc,..." --answer k]
                                      [--op eval-score --value "<问题>" --levels "级0,..." --min-score n]
                                      [--effect gate|cost_mul] [--weight n]
  node index                         rebuild closure + topo order
  node can <key> [--state k=v]       evaluate required vs optional gates
                                     (--eval: eval 题型经决策模型判定；
                                      boolean P / choice P(期望答案) / score ±1 灰带)
  node ready [--state k=v] [--eval]  currently unlockable set
  node path <key>                    cheapest unlock order to a target
  node parents|children <key>        direct relations
  node ancestors|descendants <key>   transitive, via closure index
  node list | show <key> | search "<q>" | unlock|lock <key>
  node validate                      cycles, dangling edges, dirty index
  node export [--out file.json]      portable JSON
  node import --file <file.json>     [--tree name] [--merge] — strict, transactional

  Writes are idempotent (claim/evidence/query/kb/job dedupe by content
  hash); pass --force to keep a deliberate duplicate.

${paint(C.bold, "webui", true)}            dashboard (zero-dependency)
  export [--out <file>]     single-file dashboard.html (open in browser)
  serve [--port N]          live dashboard at http://127.0.0.1:N/ (Ctrl+C to stop)

${paint(C.bold, "agent", true)}       agent-facing views
  brief                      current project state + next actions (start here)
  match "<task>"             which skill should handle this task
  log                        recent events

Global: --json  --no-color  --db <file>  --home <dir>
`;

export function usage(): string {
  return USAGE;
}

// ── Main ──

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const ctx: Ctx = {
    json: bool(args, "json"),
    color: !bool(args, "no-color") && process.stdout.isTTY !== false,
    quiet: bool(args, "quiet"),
  };
  const group = args._[0];
  const action = args._[1];

  if (!group || group === "help" || group === "-h" || group === "--help") {
    out(ctx, usage());
    return 0;
  }

  const home = str(args, "home", HOME);
  const file = str(args, "db", "") || dbPath(home);
  const needInit = !(group === "db" && action === "init");
  if (needInit && !require("node:fs").existsSync(file)) {
    bad(ctx, `no database at ${file}`);
    out(ctx, `  run: ygl-trees db init`);
    return 2;
  }

  // ── Cordis composition ──
  // Context + DatabasePlugin for architecture; Store created synchronously
  // for CLI speed (async plugin chain is for long-running processes).
  const app = new CordisContext();
  let db: any;
  let store: any;
  try {
    app.plugin(DatabasePlugin, { file });
    // One yield for the database service (no inject deps)
    await new Promise((r) => setImmediate(r));
    db = app.database?.db;
    if (!db) {
      // Fallback: direct construction (Cordis rc timing can be unpredictable)
      const { DB } = require("../../packages/core/database/src/db");
      db = new DB(file);
    }
    store = new Store(db);
  } catch (e: any) {
    bad(ctx, `cannot open database ${file}: ${e?.message || e}`);
    const lock = `${file}.lock`;
    if (require("node:fs").existsSync(lock)) {
      out(ctx, `  stale lock dir detected: ${lock}`);
      out(ctx, `  if no other ygl-trees process is running, remove it:  rmdir "${lock}"`);
    }
    return 1;
  }
  const env: any = {
    ctx,
    cordis: app,     // Cordis Context (future: long-running services)
    db,              // DB instance (from ctx.database or fallback)
    store,           // Store (created synchronously for CLI)
    args, home, group,
  };

  /** Async commands (e.g. source fetch) return a promise; main must keep the
   *  db open until it settles — hence the awaited dispatch below.
   *  Domain routing: each group maps to its owning domain module. */
  const DOMAIN_ROUTES: Record<string, string> = {
    db: "../../packages/ops/tools/src/db-cmds",
    config: "../../packages/ops/tools/src/config-cmds",
    job: "../../packages/ops/tools/src/job-cmds",
    agent: "../../packages/ops/tools/src/agent-cmds",
    research: "../../packages/research/pipeline/src/cmds",
    project: "../../packages/research/produce/src/project-cmds",
    produce: "../../packages/research/produce/src/produce-cmds",
    tree: "../../packages/techtree/model/src/cmds",
    node: "../../packages/techtree/model/src/cmds",
    skill: "../../packages/knowledge/skills/src/skill-cmds",
    kb: "../../packages/knowledge/skills/src/cmds",
    webui: "../../packages/ops/tools/src/webui",
    doctor: "../../packages/ops/tools/src/doctor",
  };
  const dispatch = async (): Promise<number> => {
    const route = DOMAIN_ROUTES[group];
    if (!route) {
      bad(ctx, `unknown group: ${group}`);
      out(ctx, usage());
      return 2;
    }
    const mod = require(route);
    const rc = await mod.run(env, action || "", args._.slice(2), args);
    return typeof rc === "number" ? rc : 0;
  };

  return dispatch()
    .then((rc) => rc)
    .catch((e: any) => {
      bad(ctx, e?.message || String(e));
      if (process.env.YGL_DEBUG) console.error(e);
      return 1;
    })
    .finally(() => {
      // Cordis Context lifecycle: services auto-cleanup on process exit.
      // For long-running processes, call app.dispose() explicitly.
      try { db?.close(); } catch { /* best effort */ }
    });
}
