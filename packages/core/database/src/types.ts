/** Shared types + arg parsing — used by both apps/cli and src/ domain modules.
 *  This is the ONLY file domain cmds import that isn't domain-local;
 *  it defines the contract between the CLI layer and domain handlers. */

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export interface Ctx {
  json: boolean;
  color: boolean;
  quiet: boolean;
}

export interface Env {
  ctx: Ctx;
  db: any; // DB instance (import from core/db for the real type)
  store: any; // Store instance
  args: Args;
  home: string;
  group: string;
}

// ── Arg parsing (pure function, no CLI awareness) ──

const BOOLEAN_FLAGS = new Set(["json", "no-color", "no-colour", "quiet", "debug", "help", "version"]);

export function parse(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
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

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest) { _.push(a); continue; }
    if (a === "--") { rest = true; continue; }
    if (a.startsWith("--")) {
      const [k, inlineVal] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      if (inlineVal !== undefined) { flags[k] = inlineVal; }
      else if (takesValue(k) && next !== undefined && isValue(next)) { flags[k] = next; i++; }
      else { flags[k] = true; }
    } else if (/^-[A-Za-z]$/.test(a)) {
      const k = a.slice(1);
      const next = argv[i + 1];
      if (takesValue(k) && next !== undefined && isValue(next)) { flags[k] = next; i++; }
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
