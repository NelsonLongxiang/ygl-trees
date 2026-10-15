/** Arg parsing + command dispatch. No CLI framework: keeps the dep tree tiny. */
import * as os from "node:os";
import * as path from "node:path";
import { DB, dbPath } from "./db";
import { Store } from "./store";
import { Ctx, bad, out, paint, C } from "./fmt";

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value: without this list `--no-color research`
 *  would swallow `research` as the flag's value and break dispatch. */
const BOOLEAN_FLAGS = new Set(["json", "no-color", "no-colour", "quiet", "debug", "help", "version"]);

export function parse(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let rest = false;
  const takesValue = (name: string) => !BOOLEAN_FLAGS.has(name);
  /** `-1` looks like a flag but is a negative number — accept it as a value. */
  const isValue = (s: string) => !s.startsWith("-") || /^-\d+(\.\d+)?$/.test(s);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) {
      _.push(a);
      continue;
    }
    if (a === "--") {
      rest = true;
      continue;
    }
    if (a.startsWith("--")) {
      const [k, inlineVal] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      if (inlineVal !== undefined) {
        flags[k] = inlineVal;
      } else if (takesValue(k) && next !== undefined && isValue(next)) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else if (/^-[A-Za-z]$/.test(a)) {
      const k = a.slice(1);
      const next = argv[i + 1];
      if (takesValue(k) && next !== undefined && isValue(next)) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else _.push(a);
  }
  return { _, flags };
}

export function str(args: Args, key: string, fallback = ""): string {
  const v = args.flags[key];
  return v === undefined || v === true ? fallback : String(v);
}
export function num(args: Args, key: string, fallback = 0): number {
  const v = Number(str(args, key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}
export function bool(args: Args, key: string): boolean {
  const v = args.flags[key];
  return v === true || v === "true" || v === "1";
}

export const HOME = process.env.YGL_HOME || path.join(os.homedir(), ".ygl-trees");

export interface Env {
  ctx: Ctx;
  db: DB;
  store: Store;
  args: Args;
  home: string;
  group: string;
}

const USAGE = `
${paint(C.bold, "ygl-trees", true)}  猿光 · 科技树
${paint(C.dim, "database-centric CLI: research → production → knowledge reuse", true)}

  ygl-trees <group> <action> [args] [options]        add --json for machine output

${paint(C.bold, "config", true)}      user-tunable settings (registry defaults + overrides)
  list                       all keys: value + default + note
  get <key>                  resolved value (config table > default)
  set <key> <value>          validated against registry (type/range); events logged
  reset <key>                drop override → back to default
  keys: eval.pass/fail_threshold, eval.offline, fetch.timeout_ms/user_agent,
        search.limit, default_confidence, job.stale_minutes

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
  query list
  source add --title --url [--abstract --content --relevance --confidence]
  source list | source search "<q>" | source rm <id>
  evidence add <sourceId> --quote "..." [--note --locator]
  evidence list
  claim add "<text>" [--confidence A|B|C]
  claim link <claimId> <evidenceId> [--stance supports|refutes]
  claim list

${paint(C.bold, "produce", true)}     outline → section → report
  outline                    auto-outline from claims
  section <title> --body|-f  add a section artifact
  report                     assemble claims+evidence+sections into a report
  list | show <id> | export <id> <file>

${paint(C.bold, "kb", true)}          long-term knowledge
  add --title --body|-f [--tags --confidence]
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
                                     [--effect gate|cost_mul] [--weight n]
  node index                         rebuild closure (ancestor/descendant) + topo order
  node can <key> [--state k=v]       evaluate required vs optional gates
                                     (--eval: op=eval gates via decision model;
                                      P>=0.7 pass / P<=0.4 fail / gray pending)
  node ready [--state k=v]           currently unlockable set
  node path <key>                    cheapest unlock order to a target
  node parents|children <key>        direct relations
  node ancestors|descendants <key>   transitive, via closure index
  node list | show <key> | search "<q>" | unlock|lock <key>
  node validate                      cycles, dangling edges, dirty index
  node export [--out file.json]      portable JSON
  node import --file <file.json>     [--tree name] [--merge] — strict, transactional

  Writes are idempotent (claim/evidence/query/kb/job dedupe by content
  hash); pass --force to keep a deliberate duplicate.

${paint(C.bold, "agent", true)}       agent-facing views
  brief                      current project state + next actions (start here)
  match "<task>"             which skill should handle this task
  log                        recent events

Global: --json  --no-color  --db <file>  --home <dir>
`;

export function usage(): string {
  return USAGE;
}

export function main(argv: string[]): Promise<number> | number {
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

  let db: DB;
  try {
    db = new DB(file);
  } catch (e: any) {
    bad(ctx, `cannot open database ${file}: ${e?.message || e}`);
    const lock = `${file}.lock`;
    if (require("node:fs").existsSync(lock)) {
      out(ctx, `  stale lock dir detected: ${lock}`);
      out(ctx, `  if no other ygl-trees process is running, remove it:  rmdir "${lock}"`);
    }
    return 1;
  }
  const env: Env = { ctx, db, store: new Store(db), args, home, group };

  /** Async commands (e.g. source fetch) return a promise; main must keep the
   *  db open until it settles — hence the awaited dispatch below. */
  const dispatch = async (): Promise<number> => {
    const mod = require(`./cmds/${safe(group)}`);
    const rc = await mod.run(env, action || "", args._.slice(2), args);
    return typeof rc === "number" ? rc : 0;
  };

  return dispatch()
    .then((rc) => rc)
    .catch((e: any) => {
      if (e && e.code === "MODULE_NOT_FOUND") {
        bad(ctx, `unknown group: ${group}`);
        out(ctx, usage());
        return 2;
      }
      bad(ctx, e?.message || String(e));
      if (process.env.YGL_DEBUG) console.error(e);
      return 1;
    })
    .finally(() => db.close());
}

function safe(s: string): string {
  return /^[a-z]+$/.test(s) ? s : "__invalid__";
}
