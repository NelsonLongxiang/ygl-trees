/** Shared types + arg parsing — used by both apps/cli and src/ domain modules.
 *  This is the ONLY file domain cmds import that isn't domain-local;
 *  it defines the contract between the CLI layer and domain handlers. */

export interface Args {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
}

export interface Ctx {
  json: boolean;
  color: boolean;
  quiet: boolean;
}

export interface Env {
  ctx: Ctx;
  db: any; // DB instance (import from core/db for the real type)
  store: any; // Store instance (legacy sync face — db-cmds/webui until B4)
  /** B1 async read facade (PG plan): research cmds switch here first.
   *  #77-7: typed as the async research store surface (structural subset of
   *  AsyncResearchStore) — no `any` escape hatch. */
  asyncStore: {
    projectByName(name: string): Promise<any>;
    projectResolve(name?: string): Promise<any>;
    projectList(): Promise<any[]>;
    sourceList(projectId: string, minRelevance?: number): Promise<any[]>;
    sourceSearch(projectId: string, q: string): Promise<any[]>;
    sourceGet(id: string): Promise<any | null>;
    evidenceList(projectId: string): Promise<any[]>;
    claimList(projectId: string): Promise<any[]>;
    artifactList(projectId: string): Promise<any[]>;
    artifactGet(id: string): Promise<any | null>;
    skillList(): Promise<any[]>;
    skillGet(name: string): Promise<any | null>;
    skillMatch(q: string, limit?: number): Promise<any[]>;
    tail(limit?: number): Promise<any[]>;
    queryDone(id: string): Promise<void>;
    stats(): Promise<Record<string, number>>;
  };
  args: Args;
  home: string;
  group: string;
  /** Resolved workspace database file for this invocation (--db or default). */
  dbFile?: string;
  /** CLI version (diagnostics surface; update-hint/doctor only) */
  version?: string;
}

// ── Arg parsing (pure function, no CLI awareness) ──

const BOOLEAN_FLAGS = new Set(["json", "no-color", "no-colour", "quiet", "debug", "help", "version"]);

/** Repeatable value flags: each occurrence APPENDS to an array instead of
 * overwriting (`--attach a --attach b` → ["a","b"]) — multi-file checker
 * specs need multiple staged attachments (0.114.12 engine gap: the last
 * flag silently won). Every other flag keeps last-wins. */
const MULTI_FLAGS = new Set(["attach"]);

export function parse(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let rest = false;
  const takesValue = (name: string) => !BOOLEAN_FLAGS.has(name);
  /** A token is a flag boundary only if this parser could itself consume it as
   *  a flag: `--`, a long `--name`, or a single-letter `-x`. Any other token
   *  starting with `-` (e.g. `- 双平台…`, `-1`, `-abc`) can never be parsed as
   *  a flag, so a value-taking flag safely claims it — `--quote "- text"`
   *  keeps its value instead of collapsing to `true` and leaking the text
   *  into positionals. */
  const looksLikeFlag = (s: string) => s === "--" || s.startsWith("--") || /^-[A-Za-z]$/.test(s);
  const isValue = (s: string) => !looksLikeFlag(s);
  const assign = (k: string, v: string): void => {
    if (!MULTI_FLAGS.has(k)) { flags[k] = v; return }
    const prior = flags[k];
    flags[k] = Array.isArray(prior) ? [...prior, v] : prior === undefined ? [v] : [String(prior), v]
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) { _.push(a); continue; }
    if (a === "--") { rest = true; continue; }
    if (a.startsWith("--")) {
      const [k, inlineVal] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      if (inlineVal !== undefined) { assign(k, inlineVal); }
      else if (takesValue(k) && next !== undefined && isValue(next)) { assign(k, next); i++; }
      else { flags[k] = true; }
    } else if (/^-[A-Za-z]$/.test(a)) {
      const k = a.slice(1);
      const next = argv[i + 1];
      if (takesValue(k) && next !== undefined && isValue(next)) { assign(k, next); i++; }
      else flags[k] = true;
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
