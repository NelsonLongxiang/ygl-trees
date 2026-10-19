#!/usr/bin/env node
/**
 * Command-line entry for ygl-trees (DSH bin.ts shape: shebang + self-execute;
 * root package.json bin field points at the compiled dist file — the old
 * bin/ygl-trees.js wrapper is gone, this IS the executable).
 * Composition happens in profile-boot; no domain logic here.
 */
import * as os from "node:os";
import * as path from "node:path";
import { dbPath } from "../../../packages/core/database/src/db";
import { Ctx, bad, out, paint, C } from "../../../packages/core/text/src/fmt";
import { Args, parse, str, num, bool, Env } from "../../../packages/core/database/src/types";
import { apply as DatabasePlugin } from "../../../packages/core/database/src/plugin";
import { apply as ResearchPlugin } from "../../../packages/research/pipeline/src/plugin";
import { apply as OpsPlugin } from "../../../packages/ops/tools/src/plugin";
import TimerPlugin from "@deepseek-ai/cordis-plugin-timer";
import { bootApp, type BootedApp } from "./profile-boot";
import { StartupError, reportStartupFailure } from "./startup-diagnostics";
import { createProcessShutdown } from "./process-shutdown";
import { runPluginCommand } from "./plugin";
import { DOMAIN_MODULES } from "./domain-barrel";
import Schema from "@deepseek-ai/schemastery";

export const HOME = process.env.YGL_HOME || path.join(os.homedir(), ".ygl-trees");

// ── Declarative composition registry (spec R14 L2) ──
// ygl.bundle.json names plugins by id; this map is the code-side "where".
const PLUGINS: Record<string, { apply: any; config?: (file: string) => any }> = {
  database: { apply: DatabasePlugin, config: (file) => ({ file }) },
  ops: { apply: OpsPlugin },
  research: { apply: ResearchPlugin },
  timer: { apply: TimerPlugin },
};

const BundleSchema = Schema.object({
  name: Schema.string().required(),
  plugins: Schema.array(Schema.string()).required(),
});

/** Read + validate ygl.bundle.json. Resolved by probing upward from the
 *  module (src run and dist run land at different depths), then cwd. */
export function loadBundle(from = __dirname): string[] {
  const file = path.join(repoRoot(from), "ygl.bundle.json");
  if (!require("node:fs").existsSync(file)) throw new Error(`ygl.bundle.json not found (probed from ${from} and cwd)`);
  const raw = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  const parsed = BundleSchema(raw);
  for (const id of parsed.plugins) {
    if (!PLUGINS[id]) throw new Error(`bundle lists unknown plugin '${id}' (known: ${Object.keys(PLUGINS).join(", ")})`);
  }
  return parsed.plugins;
}

/** Repo root by upward probe (src and dist land at different depths). */
export function repoRoot(from = __dirname): string {
  const fs = require("node:fs");
  for (let dir = from, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "ygl.bundle.json"))) return dir;
  }
  if (fs.existsSync(path.join(process.cwd(), "ygl.bundle.json"))) return process.cwd();
  throw new Error("repo root not found (ygl.bundle.json probe failed)");
}

/** Package version resolved at runtime (dist cannot require ../../package.json). */
export function appVersion(): string {
  try {
    return JSON.parse(require("node:fs").readFileSync(path.join(repoRoot(), "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

// ── Usage text ──
// (kept in apps/cli because it's presentation, not domain logic)
// 0.88 单4: color is a PARAMETER (never hardcoded) — non-TTY pipes get plain
// text; the old `paint(..., true)` template leaked 16 ANSI lines into
// redirected --help output.

function usageText(color: boolean): string {
  return `
${paint(C.bold, "ygl-trees", color)}  猿光 · 科技树
${paint(C.dim, "database-centric CLI: research → production → knowledge reuse", color)}

  ygl-trees <group> <action> [args] [options]        add --json for machine output
  ${paint(C.dim, "new here? docs/scenarios.md — six walkthroughs by use case (工程/预测/调研/知识/治理/采纳)", color)}

${paint(C.bold, "config", color)}      user-tunable settings (registry defaults + overrides)
  list                       all keys: value + default + note
  get <key>                  resolved value (config table > default)
  set <key> <value>          validated against registry (type/range); events logged
  reset <key>                drop override → back to default

${paint(C.bold, "db", color)}
  init                       create the workspace + schema
  stats                      row counts per table
  path                       print the database file path
  export <file.sql> [--lean] dump ALL data tables (+ summary); --lean skips derived
  sync pg <url>              one-way full mirror to PostgreSQL (L1, see docs/pg-compat.md)
  migrate pg <url> [--fresh] one-time full-fidelity graduation (constraints + data, atomic)
  dups                       list duplicate-content rows
  reset                      delete the database (asks nothing, be careful)
  sql "<sql>"                ad-hoc statement (can mutate — power tool, no guardrails)

${paint(C.bold, "skill", color)}        L1 description / L2 body / L3 references
  import <file.md>           import a SKILL.md (frontmatter = L1, body = L2)
  add                        --name --description --body [-f file.md]
  list | show <name> | rm <name> | enable <name> | disable <name>
  match "<query>"            full-text match, prints L1 candidates for an agent
  refs add <skill> <path> --body ...

${paint(C.bold, "project", color)}
  new <name> -q "<question>"  create + select
  list | use <name> | show

${paint(C.bold, "research", color)}    collect → screen → extract → claim
  query add "<text>"          register a search query
  query attach <qid> <sid>    link source to query (recalled count)
  query list
  source add --title --url [--abstract --content --relevance --confidence --query]
  source fetch <url>          fetch page, extract title/meta/text (zero side-effect on failure)
  source list | search "<q>" | show <id> | rm <id>
  evidence add <sourceId> --quote "..." | --file <path> [--note --locator]
  evidence list
  claim add "<text>" [--confidence A|B|C] [--channel <台账通道：预测登记用>]
  claim link <claimId> <evidenceId> [--stance supports|refutes]
                                      --by-source <claimId> <sourceId>: link ALL evidence under a source
  claim resolve <claimId> --as supported|refuted|contested [--note]
  claim unresolve <claimId>   reset to unverified (undo auto-promote / early arbitration)
  claim evaluate <claimId>    decision-model confidence from linked evidence (persisted)
  claim calibration [--all]   model-vs-human grade gap readout (校准预测判据)
  claim list
  predict list [--all]        settlement projection: outcome 未结算/1/0/ND + channel + 结算三段式 note（brier/settler）

${paint(C.bold, "verify", color)}      spec validator (M13): material → spec → report
  submit --title <t> --text <file|->   freeze material (text + attachments w/ sha256)
  prepare <material-id>                extract → blind self-review → freeze spec (rc=0 only when ready)
  run <spec-id> --db <snapshot.sqlite> run checkers on a snapshot copy (rc=0 even on FAIL)
  register <sealed-binary>            register a sealed build (footer chain → registrations/ + binaries/)
  list | report <run-id> | trace <spec-id> | export <spec-id>
  report import <report.json>          import a sealed-run report (payload/binary/version checks)
  archive <run-id|spec-id> | archive verify <file>   take-away archive (default after run) / re-verify chain
  self-check [--corpus <dir>] [--no-cases]           recursive gate: vectors → digest → shapes → cases → archives

${paint(C.bold, "produce", color)}     outline → section → report · spec/design（工程产出）
  outline                    auto-outline from claims
  section <title> --body|-f  add a section artifact
  report                     assemble claims+evidence+sections into a report
  spec <title> --body|-f     requirements spec artifact (R12)
  design <title> --body|-f   design artifact (R12) --design-type ui-ux|arch|decision
  list | show <id> | export <id> <file>

${paint(C.bold, "task", color)}          任务清单（todo|doing|done 状态机，R12）
  add "<title>" [--note ...] create a task (status todo)
  list [--status todo|doing|done]
  doing|done <id>            move along the state machine（勾销全程留痕）

${paint(C.bold, "kb", color)}          long-term knowledge
  add --title --body|-f [--tags --confidence]
  import <dir|file.md>       batch markdown (frontmatter, idempotent, single tx)
  search "<q>" | list | show <id>
  link <a> <b> [--rel]
  ingest <artifactId>        import a finished artifact
  promote <noteId> [--name]  turn a note into a reusable skill

${paint(C.bold, "job", color)}         batch + schedule (drive with cron: job tick)
${paint(C.bold, "patrol", color)}       boundary assertions + disposition queue (S1|S2|S3)
  add <title> -- <command> [--every <min>] [--at "YYYY-MM-DD HH:MM"]
  list | run <id> | tick | enable <id> | disable <id> | logs

${paint(C.bold, "tree / node", color)}   tech-tree node model
  tree new <name> [--project p]      create a tree (nodes live in it)
  tree list | tree use <name> [--global]
  tree show [name]                   selection source + node/edge/unlocked stats

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
                                     (--all: sweep every tree — no tree use needed)
  node cond --due [--days n] [--eval]  eval gates with YYYY-MM-DD deadlines due in n days
  node path <key>                    dependency-order path to target (all locked ancestors; OR branches not optimized)
  node parents|children <key>        direct relations
  node ancestors|descendants <key>   transitive, via closure index
  node list | show <key> | search "<q>" | unlock|lock <key>
  node validate                      cycles, dangling edges, dirty index
  node export [--out file.json]      portable JSON
  node import --file <file.json>     [--tree name] [--merge] — strict, transactional
  node timeline [tree]               per-tree growth history (add/link/unlock events)

  Writes are idempotent (claim/evidence/query/kb/job dedupe by content
  hash); pass --force to keep a deliberate duplicate.

${paint(C.bold, "webui", color)}            React client (0.88: the only front end)
  serve [--port N] [--host H] live at http://127.0.0.1:N/ (Ctrl+C to stop)
  export [--out <file>]     service snapshot.json (same payload as /api/data)

${paint(C.bold, "rel", color)}             关联织物（spec R9：任意两类实体互相挂接）
  add <src> <dst> [--rel t]   link two refs: node:key claim:id kb:id artifact:id
                             skill:name evidence:id source:id query:id
  rm <src> <dst> [--rel t]    unlink
  list [--src r] [--dst r]    browse (either side filter, resolves displays)

${paint(C.bold, "plugin", color)}          用户层插件分发（spec R14 L3，业务域扩展位）
  init                       create $YGL_HOME/plugins profile
  install <spec>             npm package / git url / local dir (auto link:)
  remove <name> | list       manage the user layer ($YGL_HOME/ygl.user.bundle.json)
  插件契约：export apply(ctx,config) + 可选 commands 贡献 CLI 命令组

${paint(C.bold, "agent", color)}       agent-facing views
  brief                      current project state + next actions (start here)
  match "<task>"             which skill should handle this task
  log                        recent events

Global: --json  --no-color  --db <file>  --home <dir>
`;
}

export function usage(color = false): string {
  return usageText(color);
}

/** 0.83 (user report ②): `--help` at any depth prints the relevant usage
 * slice — `kb add --help` used to fall into flag validation rc=2. Renders the
 * group's own block (found by its header line); unknown groups get the
 * full usage. 0.88 单4: color-aware + ANSI-independent block detection. */
const stripAnsi = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
export function groupHelp(group: string, color = false): string {
  const lines = usageText(color).split("\n");
  const plain = lines.map(stripAnsi);
  // header line: starts at col-0 with the group name (body lines are all
  // indented ≥2 spaces, so a col-0 match can only be a header; "tree / node"
  // is the combined block shared by both names)
  const isHeader = (l: string) =>
    l === group || l.startsWith(group + " ") || l.startsWith(group + " / ");
  const start = plain.findIndex(isHeader);
  if (start < 0) return usageText(color);
  let end = plain.length;
  for (let i = start + 1; i < plain.length; i++) {
    // next block header: any non-indented, non-empty line (headers live at
    // col-0; body lines are indented ≥2 spaces)
    if (plain[i] !== "" && !plain[i].startsWith(" ")) { end = i; break; }
  }
  return lines.slice(0, 4).join("\n") + "\n\n" + lines.slice(start, end).join("\n").trimEnd();
}

// ── Main ──

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const ctx: Ctx = {
    json: bool(args, "json"),
    // Color detection (strict): colors ONLY when we're sure the terminal
    // supports ANSI. Fixes Linux garbled output when piped/redirected.
    //   --no-color flag → always off
    //   NO_COLOR env → off (https://no-color.org convention)
    //   FORCE_COLOR env → always on (override for exotic terminals)
    //   isTTY === true → on (real terminal)
    //   isTTY === false/undefined → off (pipe, redirect, cron, etc.)
    color:
      !bool(args, "no-color") &&
      process.env.NO_COLOR === undefined &&
      (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true),
    quiet: bool(args, "quiet"),
  };
  const group = args._[0];
  const action = args._[1];

  // F1 fix (a2a review): webui serve holds its DB connection for the process
  // lifetime — a process-level exclusive lock there would block ALL CLI
  // commands until serve exits. SQLite WAL already permits concurrent readers
  // + serialized writers, so serve skips the app-level lock. Short CLI
  // commands still lock (single-writer for the brief write window).
  if (group === "webui" && (action === "serve" || action === "export")) {
    process.env.YGL_SERVE = "1";
  }

  // 0.79.1 (R297 user report follow-up): `db unlock` must be callable WHILE
  // another process holds the lock — otherwise its live-holder refusal and
  // --force paths are unreachable (boot would collide first). It only touches
  // the lock dir on the filesystem, never the DB, so boot lock-free.
  if (group === "db" && action === "unlock") {
    process.env.YGL_SERVE = "1";
  }

  // P4 fix: --version prints the actual version number (cold-user report);
  // the parser eats --version as a flag, so check flags not positional args.
  if (args.flags.version === true || group === "version") {
    out(ctx, appVersion());
    return 0;
  }

  // 0.83 (user report ②): `--help` at ANY depth prints the group's usage
  // slice rc=0 — `kb add --help` used to fall into flag validation rc=2.
  // Fires before dispatch and before db boot: help never touches the db.
  if (args.flags.help === true && group) {
    const text = groupHelp(group, ctx.color);
    if (ctx.json) console.log(JSON.stringify({ help: text.replace(/\u001b\[[0-9;]*m/g, "") }, null, 2));
    else out(ctx, text);
    return 0;
  }

  // llms: structured capability manifest for LLM consumption (Ant Design
  // "for-agents" pattern — one output gives any Agent the full command surface).
  // Onboarding: detect first run (no DB) and guide to db init
  if (!group || group === "help") {
    const dbFile = require("node:path").join(
      process.env.YGL_HOME || require("node:path").join(require("node:os").homedir(), ".ygl-trees"),
      "ygl-trees.db"
    );
    if (!require("node:fs").existsSync(dbFile)) {
      console.log("✓ Welcome to ygl-trees! 🐵");
      console.log();
      console.log("  This workspace has no database yet. Get started in 3 steps:");
      console.log();
      console.log("  1.  ygl-trees db init              # create workspace (9 skills auto-imported)");
      console.log("  2.  ygl-trees agent brief           # see current state + next actions");
      console.log('  3.  ygl-trees project new my-research -q "your question"');
      console.log();
      console.log("  More: ygl-trees llms (full capability manifest) | ygl-trees (no args, after init)");
      console.log();
      return 0;
    }
  }

  if (group === "llms") {
    // v2: llms enhancement — --json, --section <name>, dynamic skills
    const section = String(args.flags.section || "");
    if (args.flags.json === true) {
      const manifest = generateLlmsManifest();
      const sections: Record<string, string> = {};
      let current = "header";
      for (const line of manifest.split("\n")) {
        if (line.startsWith("## ")) { current = line.slice(3).toLowerCase().replace(/\s+/g, "_"); sections[current] = line + "\n"; }
        else if (sections[current] !== undefined) sections[current] += line + "\n";
      }
      console.log(JSON.stringify({ version: appVersion(), sections }, null, 2));
      return 0;
    }
    if (section) {
      const manifest = generateLlmsManifest();
      const all = manifest.split("\n## ");
      const match = all.find(s2 => s2.toLowerCase().startsWith(section.toLowerCase()));
      if (match) {
        out(ctx, "## " + match);
        return 0;
      }
      bad(ctx, `section not found: ${section}`);
      out(ctx, `  available: ${all.map(s3 => s3.split("\n")[0]).join(" | ")}`);
      return 1;
    }
    // 0.91.0 (cold-run friction log): llms is flag-driven — a positional is
    // a usage error, not a silently-ignored token.
    if (action) {
      bad(ctx, `llms takes no positional arguments (got '${action}') — use --json / --section <name>`);
      return 2;
    }
    out(ctx, generateLlmsManifest());
    return 0;
  }

  // MCP: Model Context Protocol server (stdio) — 8-tool surface.
  // Designed by the unified three-pillar theory (R8 research); each tool
  // routes to CLI --json, inheriting frozen contracts.
  if (group === "mcp") {
    // 0.91.0 (cold-run friction log): mcp is a single-purpose group — guard
    // the usage contract instead of silently starting a server for typos.
    if (action) {
      bad(ctx, `mcp takes no subcommands (got '${action}') — it starts the stdio server`);
      return 2;
    }
    const { serveMcp } = await import("../../../packages/ops/tools/src/mcp");
    serveMcp(appVersion());
    return new Promise<number>(() => { /* server runs until stdin closes */ });
  }

  if (!group || group === "help" || group === "-h" || group === "--help") {
    if (!ctx.json) out(ctx, usage(ctx.color));
    return 0;
  }

  const home = str(args, "home", HOME);
  const file = str(args, "db", "") || dbPath(home);
  // plugin management never touches the db (DSH exemplar: launcher-owned
  // mode) — it must work on a fresh workspace before `db init`
  const needInit = !(group === "db" && action === "init") && group !== "plugin";
  if (needInit && !require("node:fs").existsSync(file)) {
    bad(ctx, `no database at ${file}`);
    // P1-4 (REVIEW-0.84.0): with --json, stdout is the machine channel — bad()
    // already emits the single {"error":…} object; these hints must not pollute
    // it. They go to stderr for humans/CI logs instead.
    // 0.83 (user report ③): name the workspace root cause — a foreign
    // YGL_HOME (or its absence) is invisible otherwise, and the user chases
    // the db instead of the environment.
    const wsHint = `  run: ygl-trees db init\n  workspace: ${home}${process.env.YGL_HOME ? "  (from YGL_HOME)" : "  (default ~/.ygl-trees — set YGL_HOME to switch)"}`;
    if (ctx.json) console.error(wsHint); else out(ctx, wsHint);
    return 2;
  }

  // ── Cordis composition via bootApp (DSH profile-boot exemplar) ──
  // Base bundle from ygl.bundle.json (data), user layer from the workspace
  // profile; per-plugin issues surface through StartupError → diagnostics.
  const VERSION = appVersion();
  let booted: BootedApp;
  try {
    booted = await bootApp({
      home,
      dbFile: file,
      baseBundle: loadBundle().map((id) => {
        const entry = PLUGINS[id];
        if (!entry) throw new Error(`bundle lists unknown plugin '${id}' (known: ${Object.keys(PLUGINS).join(", ")})`);
        return { id, apply: entry.apply, config: entry.config };
      }),
      version: VERSION,
    });
  } catch (e: any) {
    if (e instanceof StartupError) {
      // P0 fix (a2a 7aa5c871): a bad plugin entry must not brick the home —
      // plugin remove/install must work even when other plugins fail to load.
      // If the command is plugin-related, proceed with a degraded boot.
      if (group === "plugin") {
        const pluginCmds = await import("./plugin");
        const { dbPath } = await import("../../../packages/core/database/src/db");
        const dbFile2 = dbPath(home);
        // Minimal env — no plugins, direct DB access
        const env2: any = {
          home, dbFile: dbFile2, ctx,
          db: null, store: null, cordis: null,
        };
        // JSON purity: stdout is the machine channel — degraded-mode notice goes to stderr there
        if (ctx.json) console.error(paint(C.yellow, "  ! degraded mode: user plugins failed to load — plugin commands only", ctx.color));
        else out(ctx, paint(C.yellow, "  ! degraded mode: user plugins failed to load — plugin commands only", ctx.color));
        return pluginCmds.runPluginCommand(env2, action || "list", args._.slice(2), args);
      }
      reportStartupFailure(e, home, VERSION);
      return 1;
    }
    bad(ctx, `cannot open database ${file}: ${e?.message || e}`);
    // F2 fix (a2a review): --json mode must stay a single parseable object —
    // suppress the human-only lock hints. Also check PID liveness, not just
    // directory existence (a live serve holder is NOT stale).
    const lock = `${file}.ygllock`;
    if (!ctx.json && require("node:fs").existsSync(lock)) {
      const pidFile = require("node:path").join(lock, "pid");
      let holder = "?";
      try { holder = require("node:fs").readFileSync(pidFile, "utf8").trim(); } catch { /* */ }
      let alive = false;
      try { process.kill(Number(holder), 0); alive = true; } catch (err: any) { alive = err.code === "EPERM"; }
      if (alive) {
        // 0.79.1 (R297 user report): the old hint guessed "(serve? webui
        // dashboard)" — serve never takes the write lock, so the guess sent
        // users to kill the wrong process. Echo the holder's self-reported
        // command line from the lock dir instead.
        let holderCmd = "";
        try { holderCmd = require("node:fs").readFileSync(require("node:path").join(lock, "cmd"), "utf8").trim(); } catch { /* */ }
        out(ctx, `  lock held by live process pid ${holder}${holderCmd ? `\n  holder command: ${holderCmd}` : " (parallel CLI session — serve never takes the write lock)"}`);
        out(ctx, `  reads still work; the lock serializes CLI writers and self-heals when pid ${holder} exits`);
        out(ctx, `  force through (know what you are doing): YGL_TEST=1  ·  inspect/clear: ygl-trees db unlock`);
      } else {
        out(ctx, `  orphaned lock (pid ${holder} is dead) — removing: ${lock}`);
        try { require("node:fs").rmSync(lock, { recursive: true, force: true }); } catch { /* */ }
        out(ctx, `  retry the command — the lock has been cleaned`);
      }
    }
    return 1;
  }
  const app = booted.ctx;
  const db = booted.db;
  const store = booted.store;
  const pluginCommands = booted.pluginCommands;
  const loadedPlugins = booted.loadedPlugins;
  const shutdown = createProcessShutdown(async () => {
    try { db?.close(); } catch { /* best effort */ }
    // P0-2 belt-and-suspenders: force-release the lock on any exit path —
    // but ONLY one this process owns. Unconditional release nuked FOREIGN
    // locks whenever a lock-less process (serve; db unlock since 0.79.1)
    // exited next to a live holder.
    try {
      const { DB } = require("../../../packages/core/database/src/db");
      if (db?.ownsLock) DB.releaseLockFor(file);
      else if (DB.lockHolder(file) === String(process.pid)) DB.releaseLockFor(file);
    } catch { /* */ }
  });
  process.on("SIGINT", () => shutdown.interrupt(0));
  process.on("SIGTERM", () => shutdown.interrupt(0));
  const env: any = {
    ctx,
    cordis: app,     // Cordis Context (long-running services)
    db,              // DB instance (from ctx.database or fallback)
    store,           // Store (from ctx.research or fallback)
    plugins: { loaded: loadedPlugins, commands: Object.keys(pluginCommands) },
    args, home, group,
  };

  /** Async commands (e.g. source fetch) return a promise; main must keep the
   *  db open until it settles — hence the awaited dispatch below.
   *  Domain routing: each group maps to its owning domain module. */
  // Domain routing: static barrel (bundle-traceable) — see domain-barrel.ts
  const dispatch = async (): Promise<number> => {
    const t0 = Date.now();
    // R10.3: one run id per CLI invocation — same-process events carry it in
    // their payload so `agent log --run` can reconstruct the invocation.
    process.env.YGL_RUN_ID = process.env.YGL_RUN_ID || String(Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    // R14 L3 (DSH exemplar): plugin management is launcher-owned — a bin mode
    // dispatched BEFORE the domain routes, not a packages command.
    if (group === "plugin") {
      const rc = await runPluginCommand(env, action || "", args._.slice(2), args);
      return typeof rc === "number" ? rc : 0;
    }
    // R14 L3: plugin-contributed command groups win before "unknown group"
    const pluginCmd = pluginCommands[group];
    if (pluginCmd) {
      const rc = await pluginCmd.run(env, action || "", args._.slice(2), args);
      const code = typeof rc === "number" ? rc : 0;
      try {
        // 0.93 T3: cmd.run attribution — bare shells keep the historical
        // "cli" actor; session-tagged invocations (YGL_SESSION/DSH_SESSION_ID)
        // carry their seat identity so adoption telemetry can tell seats apart
        // (.157 ops-handbook blind spot #1, mirrored on our side).
        const actor = process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "cli";
        db.run(
          "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
          [`${process.env.YGL_RUN_ID}`, new Date().toISOString(), actor, "cmd.run", group, String(action || ""),
           JSON.stringify({ run: process.env.YGL_RUN_ID, group, action: action || "", rc: code, duration_ms: Date.now() - t0, plugin: true, session: actor === "cli" ? undefined : actor }),
           code === 0 ? "info" : code === 2 ? "warn" : "error"]
        );
      } catch { /* telemetry best-effort */ }
      return code;
    }
    const mod = DOMAIN_MODULES[group];
    if (!mod) {
      // Help guidance: suggest closest match for unknown commands
      const known = ["agent","research","produce","kb","skill","tree","node","task","rel","plugin","webui","db","doctor","config","job","patrol","verify","project","mcp","llms","version","help"];
      const aliases: Record<string, string> = {
        database: "db", data: "db", sqlite: "db",
        knowledge: "kb", notes: "kb", notebook: "kb",
        helth: "doctor", check: "doctor", health: "doctor",
        server: "webui", dashboard: "webui", ui: "webui",
        timeline: "db", "time-travel": "db", workspace: "db", obsidian: "db",
      };
      const input = String(group).toLowerCase();
      const suggestions: string[] = [];
      // 0. alias check (database→db, knowledge→kb, etc.)
      if (aliases[input]) suggestions.push(aliases[input]);
      // 0b. alias prefix (databse→database→db, knolge→knowledge→kb)
      for (const [alias, cmd] of Object.entries(aliases)) {
        if (alias.startsWith(input.slice(0, 4)) && !suggestions.includes(cmd)) {
          suggestions.push(cmd); break;
        }
      }
      // 1. exact prefix match (strongest)
      for (const k of known) if (k.startsWith(input.slice(0, 3)) && !suggestions.includes(k)) suggestions.push(k);
      // 2. subsequence match (input chars appear in order)
      if (suggestions.length < 2) {
        for (const k of known) {
          if (suggestions.includes(k)) continue;
          let ki = 0;
          for (const ch of input) {
            ki = k.indexOf(ch, ki);
            if (ki === -1) break;
            ki++;
          }
          if (ki !== -1) suggestions.push(k);
          if (suggestions.length >= 3) break;
        }
      }
      // 3. known command contains input
      if (suggestions.length < 2) {
        for (const k of known) if (k.includes(input) && !suggestions.includes(k)) suggestions.push(k);
      }
      if (suggestions.length === 1) {
        bad(ctx, `unknown group: ${group} — did you mean "${suggestions[0]}"?`);
      } else if (suggestions.length > 1) {
        bad(ctx, `unknown group: ${group} — did you mean: ${suggestions.slice(0, 3).join(" | ")}?`);
      } else {
        bad(ctx, `unknown group: ${group}`);
      }
      if (!ctx.json) {
        out(ctx, paint(C.dim, "  try: ygl-trees (no args) for full usage", ctx.color));
      }
      if (!ctx.json) out(ctx, usage(ctx.color)); // usage text belongs to the human channel
      return 2;
    }
    const rc = await mod.run(env, action || "", args._.slice(2), args);
    const code = typeof rc === "number" ? rc : 0;
    // R10.3: cmd.run ledger row — rc-mapped severity (0→info, 2→warn, else→error)
    try {
      // 0.93 T3: session attribution (see the plugin-branch twin above)
      const actor = process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "cli";
      db.run(
        "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
        [
          `${process.env.YGL_RUN_ID}`,
          new Date().toISOString(),
          actor,
          "cmd.run",
          group,
          String(action || ""),
          JSON.stringify({ run: process.env.YGL_RUN_ID, group, action: action || "", rc: code, duration_ms: Date.now() - t0, session: actor === "cli" ? undefined : actor }),
          code === 0 ? "info" : code === 2 ? "warn" : "error",
        ]
      );
    } catch { /* telemetry best-effort — never fail the command */ }
    return code;
  };

  return dispatch()
    .then((rc) => rc)
    .catch((e: any) => {
      bad(ctx, e?.message || String(e));
      if (process.env.YGL_DEBUG) console.error(e);
      return 1;
    })
    .finally(() => {
      // Cordis lifecycle (0.76): Services' stop() hooks clean resources.
      // This fork has no ctx.dispose() — we call Service.stop() explicitly.
      // DatabaseService.stop() closes SQLite + releases .ygllock + closes ORM.
      try {
        if (booted?.ctx?.database?.stop) {
          booted.ctx.database.stop(); // service-managed DB cleanup
        }
      } catch { /* dispose best-effort */ }
      // Fallback path: if the service didn't take (bootApp fallback), db was
      // constructed directly — it's not service-managed, close it here.
      if (!booted?.ctx?.database) {
        try { db?.close(); } catch { /* best effort */ }
      }
    });
}

// ── llms manifest: structured capability list for LLM consumption ──
// Ant Design "for-agents" pattern: one command gives any Agent the full
// command surface, contracts, and skill list — no need to read docs.
export function generateLlmsManifest(): string {
  const V = appVersion();
  const L: string[] = [];
  L.push(`# ygl-trees v${V} — AI Agent Research Workbench`);
  L.push("");
  L.push(`> Single SQLite source of truth. Research → Production → Knowledge Reuse + Tech Tree.`);
  L.push(`> CLI for AI agents: every command supports --json (machine-readable, including errors).`);
  L.push("");
  L.push(`## Frozen Contracts`);
  L.push("");
  L.push(`| Contract | Rule | Gate |`);
  L.push(`|---|---|---|`);
  L.push(`| Exit codes | 0 success (incl. duplicate) · 1 runtime error · 2 usage error | contract 4 |`);
  L.push(`| --json | stdout is ONE JSON object/array; failures emit {"error":"..."} + rc 1/2 | contract 5 |`);
  L.push(`| Write idempotency | same content re-run → rc=0 + duplicate:true | contract 1+2 |`);
  L.push(`| Bad references | named not-found (never raw SqliteError) | contract 3 |`);
  L.push(`| Flag validation | bare flag / bad enum → rc=2, never writes "true"/"nonsense" | contract 6 |`);
  L.push(`| Field naming | snake_case only, camelCase leak = violation | contract 5 |`);
  L.push("");
  L.push(`## Command Surface`);
  L.push("");
  const groups: Array<[string, string, Array<[string, string]>]> = [
    ["scenarios", "pick a walkthrough by use case (docs/scenarios.md)", [
      ["工程迭代/预测回测/证据调研/知识复利/协作治理/采纳追踪", "six standard flows, each: entry → commands → exit → criteria → anti-patterns"],
    ]],
    ["agent", "Agent-facing views (START HERE)", [
      ["agent brief", "current state + next actions"],
      ["agent match \"<task>\"", "which skill handles this task"],
      ["agent log [--level] [--run]", "recent events with filters"],
    ]],
    ["research", "Evidence-first research pipeline", [
      ["research query add \"<text>\"", "register a search query"],
      ["research source add --title --url", "add a source (also: --relevance 0-5 --confidence A|B|C)"],
      ["research source fetch <url>", "fetch page, extract title/meta/text"],
      ["research evidence add <sid> --quote \"...\"", "verbatim quote from source"],
      ["research claim add \"<text>\"", "refutable assertion"],
      ["research claim link <cid> <eid> --stance supports|refutes", "link claim to evidence"],
      ["research claim resolve <cid> --as supported|refuted|contested", "manual arbitration"],
      ["research claim unresolve <cid>", "reset to unverified (undo link auto-promote)"],
      ["research claim evaluate <cid>", "decision model confidence (0-5 → A/B/C/D), persisted as claim.eval"],
      ["research claim calibration [--all]", "model-vs-human grade gap (校准预测判据 ≥60%)"],
      ["research evidence assess <eid>", "decision model quality assessment"],
    ]],
    ["produce", "Reports + engineering artifacts", [
      ["produce outline", "auto-outline from claims"],
      ["produce section <title> --body|-f", "add section"],
      ["produce report", "assemble claims+evidence+sections → report"],
      ["produce spec <title> --body|-f", "requirements spec artifact"],
      ["produce design <title> --body|-f --design-type ui-ux|arch|decision", "design artifact"],
      ["produce export <id> <file>", "export artifact to file"],
    ]],
    ["kb", "Long-term knowledge + reuse", [
      ["kb add --title --body|-f", "add knowledge note"],
      ["kb import <dir|file.md>", "batch markdown import (>1MB skipped, --force to include)"],
      ["kb search \"<q>\" [--eval]", "FTS5 CJK search (--eval: semantic re-rank via decision model)"],
      ["kb rm <id>", "remove note"],
      ["kb ingest <artifactId>", "sink a report into kb"],
      ["kb promote <noteId>", "promote note to reusable skill"],
    ]],
    ["skill", "Skill registry (L1/L2/L3)", [
      ["skill list", "all skills with hits"],
      ["skill match \"<query>\"", "full-text match for agent"],
      ["skill show <name>", "full skill body"],
      ["skill link [--global]", "junction to .agents/skills/ (or ~/.agents/skills/)"],
    ]],
    ["tree / node", "Tech tree model (nodes/edges/conditions/closure)", [
      ["tree new <name>", "create tree"],
      ["node add <key>", "add node (--name --kind --tier --cost --tags)"],
      ["node link <parent> <child> [--rel prereq|unlock|excludes|enables] [--mode AND|OR|XOR|NOT] [--optional]", "link nodes"],
      ["node cond <key> --name <c> --kind <k> [--op eval] [--value \"<question>\"]", "add condition (eval = decision model gate)"],
      ["node index", "rebuild closure + topo order"],
      ["node can <key> [--state k=v] [--eval]", "can unlock? (required vs optional + cost)"],
      ["node ready [--all]", "currently unlockable set (--all: every tree)"],
      ["node cond --due [--days n] [--eval]", "eval gates with deadlines due in n days"],
      ["node path <key>", "dependency-order path (OR branches not optimized)"],
      ["node unlock <key>", "mark unlocked"],
      ["node list", "list with state column (locked/unlocked)"],
      ["node validate", "cycles, dangling edges, dirty index"],
    ]],
    ["task", "Task state machine", [
      ["task add \"<title>\"", "create task (todo)"],
      ["task list [--status]", "list by status"],
      ["task doing <id> / task done <id> / task todo <id>", "advance or roll back"],
    ]],
    ["rel", "Relation fabric (cross-entity linking)", [
      ["rel add <src> <dst> [--rel t]", "link two refs: node:key claim:id kb:id artifact:id ..."],
      ["rel list [--src r] [--dst r]", "browse relations"],
    ]],
    ["plugin", "User-level plugin distribution (R14 L3)", [
      ["plugin init", "create $YGL_HOME/plugins profile"],
      ["plugin install <spec>", "npm package / git url / local dir (auto link:)"],
      ["plugin config <name> '<json>'", "set plugin config"],
      ["plugin disable/enable <name>", "toggle plugin"],
      ["plugin list", "version + state + resolvable"],
    ]],
    ["webui", "Dashboard (React + embedded)", [
      ["webui serve [--port N] [--host H]", "live dashboard (default 127.0.0.1, --host 0.0.0.0 for LAN)"],
      ["webui export [--out <file>]", "single-file offline dashboard"],
    ]],
    ["db", "Database operations", [
      ["db init", "create workspace + schema (auto-imports 9 built-in skills)"],
      ["db stats", "row counts per table"],
      ["db export <file>", "full backup"],
      ["db sync pg <url>", "one-way mirror to PostgreSQL"],
      ["db migrate pg <url> [--fresh]", "full-fidelity graduation (with type preflight)"],
      ["db unlock [--force]", "clear stale .ygllock (pid-liveness checked; refuses live holders)"],
      ["db reset", "delete database"],
    ]],
    ["doctor", "Health check (10 items)", [
      ["doctor [--fix]", "diagnose (+ auto-fix: dirty index, dead stale lock, phantom writes)"],
    ]],
    ["config", "User settings", [
      ["config list / get / set / reset", "registry-backed settings"],
    ]],
    ["job", "Batch scheduling", [
      ["job add <title> -- \"<cmd>\" [--every <min>]", "create scheduled job"],
      ["job tick", "run due jobs (drive with cron)"],
    ]],
    ["verify", "Spec validator (M13): material → spec → report", [
      ["verify submit --title <t> --text <file|-> [--attach <f>]", "freeze material (text + attachments w/ sha256)"],
      ["verify prepare <material-id> --candidates <f> --reviews <f> --db <snap> [--draft]", "extract → translate → blind self-review → freeze spec (--draft = dry run, writes nothing)"],
      ["verify run <spec-id> --db <snapshot.sqlite>", "run checkers on a snapshot copy → report (rc=0 even on FAIL)"],
      ["verify register <sealed-binary>", "register a sealed yglverify build (footer chain → registrations/ + binaries/)"],
      ["verify list / report <run-id> / trace <spec-id> / export <spec-id>", "catalog, reports, construction trace, .yglverify.json"],
      ["verify report import <report.json>", "import a sealed-run report (payload/binary/spec_version checks)"],
      ["verify archive <run-id|spec-id> [--with …] [--snapshot <db>]", "archive bundle (report+spec+materials; --snapshot for cross-impl runs)"],
      ["verify archive verify <file>", "recompute the full hash chain of an archive bundle"],
      ["verify list --unarchived", "runs that exist but were never archived"],
      ["verify self-check", "recursive gate: canonical vectors → corpus digest → shapes → corpus cases → archives"],
    ]],
    ["patrol", "Boundary patrol (0.93)", [
      ["patrol add <name> --sql \"SELECT …\" [--severity S1|S2|S3]", "register assertion (violating rows)"],
      ["patrol run / list / findings", "evaluate + disposition queue"],
    ]],
    ["project", "Project management", [
      ["project new <name> -q \"<question>\"", "create + select (session-scoped)"],
      ["project use <name> [--global] / list / show", "switch / browse (selection_source shown)"],
    ]],
  ];

  for (const [name, desc, cmds] of groups) {
    L.push(`### ${name}`);
    L.push("");
    L.push(desc);
    L.push("");
    L.push("```bash");
    for (const [cmd, note] of cmds) {
      L.push(`${cmd.padEnd(60)} # ${note}`);
    }
    L.push("```");
    L.push("");
  }

  L.push(`## Decision Model (R15)`);
  L.push("");
  L.push(`- kb search --eval: semantic re-ranking (P(relevant) per candidate)`);
  L.push(`- claim evaluate: confidence 0-5 → A/B/C/D (auto-triggered on claim link)`);
  L.push(`- evidence assess: quality 0-5 → 高/中/低`);
  L.push(`- node can --eval: semantic unlock gates (boolean/choice/score)`);
  L.push(`- Offline safe: no AI_GATEWAY_API_KEY → shows "离线" and falls back`);
  L.push("");
  L.push(`## Quick Start`);
  L.push("");
  L.push("```bash");
  L.push("ygl-trees db init");
  L.push("ygl-trees agent brief        # START HERE — state + next actions");
  L.push("ygl-trees project new my-project -q \"research question\"");
  L.push("ygl-trees agent match \"my task\"  # which skill to use");
  L.push("```");
  L.push("");
  L.push(`## More`);
  L.push("");
  L.push(`- docs/scenarios.md: six scenario walkthroughs — pick by use case (engineering / prediction / research / knowledge / governance / adoption)`);
  L.push(`- DESIGN.md: design system tokens (colors/type/components)`);
  L.push(`- docs/spec.md: full spec R1-R15`);
  L.push(`- docs/plugin-authoring.md: write your own plugins`);
  L.push(`- docs/release.md: publish procedure + known pitfalls`);
  L.push("");
  return L.join("\n");
}

// ── self-execute (the executable; rc contract lives HERE) ──
// 0/1/2 from main(); rejection → 1. Agents rely on rc≠0 to detect failures.
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (rc) => { if (typeof rc === "number") process.exitCode = rc; },
    () => { process.exitCode = 1; }
  );
}
