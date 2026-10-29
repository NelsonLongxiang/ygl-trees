/**
 * MCP (Model Context Protocol) Server — stdio + HTTP transports.
 *
 * Four-tool surface (0.115.0 consolidation, owner ruling "一步到位"):
 *   ygl_read   — all read faces (agent/kb/tree/task/rel/research/verify/project)
 *   ygl_write  — all write faces (research/kb/tree/task/rel/project/produce)
 *   ygl_verify — spec-validator pipeline (submit→prepare→run→report→archive→meta)
 *   ygl_doctor — 9-item health check
 *
 * Design: 少工具、富参数 — domain×action router replaces 11 scattered tools.
 * Each tool's schema is a "router": domain picks the CLI group, action picks
 * the subcommand, params flow through. Write safety unchanged: action enums
 * are closed sets; dangerous CLI faces (db reset/sql, plugin, config, job,
 * patrol) are physically excluded.
 *
 * Each tool routes to the CLI --json backend, inheriting its frozen contracts
 * (idempotent writes, pure JSON errors, snake_case fields). rc fidelity:
 * rc≠0 outcomes surface as MCP isError:true with a machine-readable
 * {rc, error} payload — the exit-code contract is never flattened to text.
 *
 * Transports: stdio (default) + HTTP (0.114.31, --http --port, StreamableHTTP
 * stateless — taste-mcp market precedent: POST /mcp, GET → 405).
 *
 * @module @ygl/ops-tools/mcp
 */
import * as readline from "node:readline";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Execute via CLI --json; returns the parsed JSON or throws with a message. */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/** CLI outcome with the exit code kept first-class (rc fidelity, 0.114.26). */
export interface CliOutcome {
  rc: number;
  /** parsed --json stdout; null when stdout was not parseable JSON */
  json: unknown;
  stderr: string;
}

/** Build a CLI invocation and capture rc + JSON stdout + stderr.
 *  Uses process.argv[1] (the running script — bundle or source) to re-invoke
 *  the CLI as a child process. This works in both dev (dist/apps/...) and
 *  bundle (dist/bundle/bin.cjs) contexts. */
function cliExec(parts: string[], childEnv: NodeJS.ProcessEnv): Promise<CliOutcome> {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const self = process.argv[1]; // the bin.cjs or bin.js that's running this MCP server
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--json", ...parts], {
      env: { ...childEnv, YGL_SERVE: "1", YGL_MCP_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code: number) => {
      let json: unknown = null;
      if (out.trim()) {
        try { json = JSON.parse(out); } catch { /* keep null */ }
      }
      resolve({ rc: code ?? -1, json, stderr: err });
    });
    child.on("error", (e) => reject(e));
  });
}

/** Compat wrapper: rc=0 → parsed JSON; rc≠0 → throw an Error carrying
 *  `.rc` + `.json` so tools/call can surface {rc, error} machine-readably. */
function cliJson(parts: string[], childEnv: NodeJS.ProcessEnv): Promise<unknown> {
  return cliExec(parts, childEnv).then((o) => {
    if (o.rc === 0) return o.json;
    const e = new Error(`CLI rc=${o.rc}: ${o.stderr.slice(0, 200)}`) as Error & { rc: number; json: unknown };
    e.rc = o.rc;
    e.json = o.json && typeof o.json === "object" ? o.json : { error: o.stderr.slice(0, 300) || `CLI rc=${o.rc}` };
    throw e;
  });
}

function usageError(error: string): Error & { rc: number; json: { error: string } } {
  return Object.assign(new Error(error), { rc: 2, json: { error } });
}

/** arg helper: optional string flag pair */
const opt = (flag: string, v: unknown): string[] => (v === undefined || v === null || v === "" ? [] : [flag, String(v)]);
/** arg helper: positional string if present */
const pos = (v: unknown): string[] => (v === undefined || v === null || v === "" ? [] : [String(v)]);

// ============================================================
// Route tables: domain → action → CLI argv builder
// ============================================================

type ArgvBuilder = (a: Record<string, any>) => string[];

/** Read routes — every CLI read face, white-listed. */
const READ_ROUTES: Record<string, Record<string, ArgvBuilder>> = {
  agent: {
    brief: () => ["agent", "brief"],
    match: (a) => ["agent", "match", String(a.query)],
    log: () => ["agent", "log"],
  },
  kb: {
    search: (a) => { const p = ["kb", "search", String(a.query ?? "")]; if (a.eval) p.push("--eval"); return p; },
    show: (a) => ["kb", "show", String(a.id)],
  },
  research: {
    "query-list": (a) => [...opt("-p", a.project), "research", "query", "list"],
    "source-list": (a) => [...opt("-p", a.project), "research", "source", "list"],
    "source-search": (a) => [...opt("-p", a.project), "research", "source", "search", String(a.query)],
    "source-show": (a) => ["research", "source", "show", String(a.id)],
    "evidence-list": (a) => [...opt("-p", a.project), "research", "evidence", "list"],
    "evidence-show": (a) => ["research", "evidence", "show", String(a.id)],
    "claim-list": (a) => [...opt("-p", a.project), "research", "claim", "list"],
    "claim-show": (a) => ["research", "claim", "show", String(a.id)],
    "claim-evaluate": (a) => ["research", "claim", "evaluate", String(a.id)],
    "claim-calibration": () => ["research", "claim", "calibration", "--all"],
    "predict-list": (a) => { const p = ["research", "predict", "list"]; if (a.all) p.push("--all"); if (a.project) p.push("-p", String(a.project)); return p; },
  },
  tree: {
    state: (a) => { const p = ["node", "list"]; if (a.tree) p.push("-t", String(a.tree)); return p; },
    list: () => ["tree", "list"],
    show: () => ["tree", "show"],
  },
  node: {
    can: (a) => { const p = ["node", "can", String(a.key)]; if (a.tree) p.push("-t", String(a.tree)); return [...p, ...opt("--context", a.context), ...opt("--state", a.state)]; },
    ready: (a) => { const p = ["node", "ready"]; if (a.all) p.push("--all"); if (a.tree) p.push("-t", String(a.tree)); return [...p, ...opt("--context", a.context), ...opt("--state", a.state)]; },
  },
  task: {
    list: (a) => [...opt("-p", a.project), "task", "list"],
  },
  rel: {
    list: (a) => { const p = ["rel", "list"]; if (a.node) p.push("--node", String(a.node)); return p; },
  },
  produce: {
    "report-show": (a) => ["produce", "show", String(a.id)],
    "report-list": (a) => [...opt("-p", a.project), "produce", "list"],
  },
  project: {
    list: () => ["project", "list"],
    show: () => ["project", "show"],
  },
  db: {
    stats: () => ["db", "stats"],
    timeline: (a) => { const p = ["db", "timeline"]; if (a.actor) p.push("--actor", String(a.actor)); return p; },
  },
  skill: {
    list: () => ["skill", "list"],
    match: (a) => ["skill", "match", String(a.query)],
    show: (a) => ["skill", "show", String(a.name)],
  },
};

/** Write routes — closed action enums, physically excludes admin faces. */
const WRITE_ROUTES: Record<string, Record<string, ArgvBuilder>> = {
  research: {
    "query-add": (a) => ["research", "query", "add", String(a.text), ...opt("-p", a.project)],
    "query-attach": (a) => ["research", "query", "attach", String(a.query_id), String(a.source_id)],
    // #83: --batch jsonl（batch_file 与 title/text 互斥，由 CLI 层全批拒语义把关）。
    "source-add": (a) => a.batch_file
      ? ["research", "source", "add", "--batch", String(a.batch_file), ...opt("-p", a.project)]
      : ["research", "source", "add", "--title", String(a.text), "--url", String(a.b ?? ""), ...opt("-p", a.project)],
    "evidence-add": (a) => a.batch_file
      ? ["research", "evidence", "add", "--batch", String(a.batch_file), ...opt("-p", a.project)]
      : ["research", "evidence", "add", String(a.text), "--quote", String(a.quote ?? ""), ...opt("-p", a.project)],
    "claim-add": (a) => a.batch_file
      ? ["research", "claim", "add", "--batch", String(a.batch_file), ...opt("-p", a.project)]
      : ["research", "claim", "add", String(a.text), ...opt("-p", a.project)],
    "claim-link": (a) => ["research", "claim", "link", String(a.text), String(a.b), "--stance", String(a.stance ?? "supports"), ...opt("-p", a.project)],
    "claim-resolve": (a) => ["research", "claim", "resolve", String(a.text), "--as", String(a.as ?? "supported"), ...opt("-p", a.project)],
  },
  kb: {
    add: (a) => {
      if (!a.name || (!a.file && !a.body && !a.description)) throw usageError("kb add requires name and body (or file)");
      if (a.file && (a.body !== undefined || a.description !== undefined)) throw usageError("kb add accepts body or file, not both");
      return ["kb", "add", "--title", String(a.name), ...(a.file ? ["-f", String(a.file)] : ["--body", String(a.body ?? a.description)])];
    },
    link: (a) => ["kb", "link", String(a.note), String(a.evidence_id)],
  },
  tree: {
    "tree-new": (a) => ["tree", "new", String(a.tree), ...opt("-p", a.project)],
    "tree-use": (a) => ["tree", "use", String(a.tree)],
    "node-add": (a) => ["node", "add", String(a.key), ...opt("--name", a.name), ...opt("-t", a.tree)],
    "node-link": (a) => ["node", "link", String(a.key), String(a.child), ...opt("-t", a.tree)],
    "node-unlock": (a) => ["node", "unlock", String(a.key), ...opt("-t", a.tree), ...opt("--context", a.context)],
    "node-index": (a) => ["node", "index", ...opt("-t", a.tree)],
    "node-cond": (a) => {
      if (!a.key || !a.name || !a.op || a.value === undefined || a.value === null || String(a.value) === "") throw usageError("node-cond requires key, name, op and a non-empty value");
      const p = ["node", "cond", String(a.key), "--name", String(a.name), "--op", String(a.op), "--value", String(a.value), ...opt("--kind", a.kind), ...opt("--expr", a.expr), ...opt("--effect", a.effect), ...opt("--weight", a.weight), ...opt("--options", a.options), ...opt("--answer", a.answer), ...opt("--levels", a.levels), ...opt("--min-score", a.min_score)];
      if (a.optional) p.push("--optional");
      return [...p, ...opt("-t", a.tree)];
    },
  },
  task: {
    add: (a) => ["task", "add", String(a.text), ...opt("-p", a.project)],
    advance: (a) => ["task", String(a.to ?? "doing"), String(a.id)],
  },
  rel: {
    attach: (a) => {
      if (!a.node || !a.type || !a.target || !String(a.target).includes(":")) throw usageError("rel attach requires node, relation type, and a typed target such as kb:<id>");
      return ["rel", "add", String(a.node).startsWith("node:") ? String(a.node) : "node:" + String(a.node), String(a.target), "--rel", String(a.type)];
    },
  },
  project: {
    new: (a) => ["project", "new", String(a.name), ...opt("-q", a.question)],
    use: (a) => ["project", "use", String(a.name)],
  },
  produce: {
    report: (a) => ["produce", "report", ...opt("-p", a.project)],
  },
};

/** Flatten route table keys for schema enums. */
const routeActions = (routes: Record<string, Record<string, ArgvBuilder>>): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [domain, actions] of Object.entries(routes)) out[domain] = Object.keys(actions);
  return out;
};

export function buildTools(env: NodeJS.ProcessEnv = process.env): McpTool[] {
  const childEnv = { ...env };
  const runCli = (parts: string[]) => cliJson(parts, childEnv);
  const readActions = routeActions(READ_ROUTES);
  const writeActions = routeActions(WRITE_ROUTES);
  const allReadActions = [...new Set(Object.values(readActions).flat())];
  const allWriteActions = [...new Set(Object.values(writeActions).flat())];

  return [
    {
      name: "read",
      description:
        "Read from ygl-trees: workspace state, knowledge search, research pipeline lists, tree/node status, tasks, relations, projects, skills. " +
        "Route via domain + action; extra params flow through to the CLI.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", enum: Object.keys(readActions), description: "CLI domain" },
          action: { type: "string", enum: allReadActions, description: "Read action within domain" },
          query: { type: "string", description: "search/match query" },
          id: { type: "string", description: "entity id (show)" },
          name: { type: "string", description: "entity name (skill show)" },
          tree: { type: "string", description: "tree name filter" },
          node: { type: "string", description: "node key (rel list)" },
          key: { type: "string", description: "node key (can)" },
          context: { type: "string", description: "node can/ready: named state context, default is default" },
          state: { type: "string", description: "node can/ready: temporary state using the CLI key=value,key2=value2 syntax" },
          project: { type: "string", description: "project filter" },
          all: { type: "boolean", description: "include all (ready/predict)" },
          eval: { type: "boolean", description: "enable semantic re-ranking (kb search)" },
          actor: { type: "string", description: "actor filter (db timeline)" },
        },
        required: ["domain", "action"],
      },
      execute: async (a) => {
        const domain = READ_ROUTES[String(a.domain)];
        if (!domain) return Promise.reject(new Error(`unknown domain: ${String(a.domain)}`));
        const builder = domain[String(a.action)];
        if (!builder) return Promise.reject(new Error(`unknown action '${String(a.action)}' for domain '${String(a.domain)}'`));
        return runCli(builder(a));
      },
    },
    {
      name: "write",
      description:
        "Write to ygl-trees: research pipeline (queries/sources/evidence/claims), knowledge notes, tech-tree structure, tasks, relations, projects. " +
        "Idempotent: same-content reruns return the existing row. Route via domain + action.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", enum: Object.keys(writeActions), description: "CLI domain" },
          action: { type: "string", enum: allWriteActions, description: "Write action within domain" },
          text: { type: "string", description: "query/claim/evidence text, or task title" },
          b: { type: "string", description: "second operand (url/source-id/evidence-id per action)" },
          quote: { type: "string", description: "evidence verbatim excerpt" },
          stance: { type: "string", enum: ["supports", "refutes"], description: "claim-link stance" },
          as: { type: "string", enum: ["supported", "refuted", "contested"], description: "claim-resolve verdict" },
          query_id: { type: "string", description: "query-attach: query id" },
          batch_file: { type: "string", description: "#83 source-add/claim-add/evidence-add: jsonl batch file path (all-or-nothing; bad row names line+field rc=2, file missing rc=1, nothing written on failure)" },
          source_id: { type: "string", description: "query-attach/kb-link: source/evidence id" },
          name: { type: "string", description: "kb name / node name / project name" },
          body: { type: "string", description: "kb add: note body; mutually exclusive with file" },
          description: { type: "string", description: "kb add: compatibility alias for body; mutually exclusive with file" },
          file: { type: "string", description: "kb add: markdown file path" },
          note: { type: "string", description: "kb link: note id" },
          evidence_id: { type: "string", description: "kb link: evidence id" },
          tree: { type: "string", description: "tree name" },
          key: { type: "string", description: "node key" },
          child: { type: "string", description: "node-link: child key" },
          optional: { type: "boolean", description: "node-cond: optional" },
          context: { type: "string", description: "node-unlock: named state context, default is default" },
          op: { type: "string", enum: [">=", "==", "<=", "!=", "has", "telemetry", "eval", "eval-choice", "eval-score"], description: "node-cond: required comparison operator" },
          value: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }], description: "node-cond: required condition value or evaluation question" },
          kind: { type: "string", description: "node-cond: flag/resource/etc. condition kind" },
          expr: { type: "string", description: "node-cond: optional state expression" },
          effect: { type: "string", enum: ["gate", "cost_mul"], description: "node-cond effect" },
          weight: { type: "number", description: "node-cond weight" },
          options: { type: "string", description: "eval-choice: comma-separated key=description options" },
          answer: { type: "string", description: "eval-choice: expected option key" },
          levels: { type: "string", description: "eval-score: comma-separated level descriptions" },
          min_score: { type: "number", description: "eval-score: minimum acceptable level" },
          id: { type: "string", description: "task advance: task id" },
          to: { type: "string", enum: ["doing", "done", "todo"], description: "task advance target" },
          node: { type: "string", description: "rel attach: node key" },
          type: { type: "string", description: "rel attach: relation type" },
          target: { type: "string", description: "rel attach: typed target such as kb:<id> or evidence:<id>" },
          project: { type: "string", description: "explicit project" },
          question: { type: "string", description: "project new: research question" },
        },
        required: ["domain", "action"],
      },
      execute: async (a) => {
        const domain = WRITE_ROUTES[String(a.domain)];
        if (!domain) return Promise.reject(new Error(`unknown domain: ${String(a.domain)}`));
        const builder = domain[String(a.action)];
        if (!builder) return Promise.reject(new Error(`unknown action '${String(a.action)}' for domain '${String(a.domain)}'`));
        return runCli(builder(a));
      },
    },
    {
      name: "verify",
      description:
        "spec-validator pipeline: submit freezes business material (encoding fail-closed), prepare builds criteria " +
        "(P0-P5), run executes 7 checker types on a snapshot, archive seals+signs, meta checks repo admission rules.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["submit", "prepare", "run", "report", "archive", "meta"],
            description: "Pipeline verb (archive=verify existing archive; sealing happens automatically during run)",
          },
          a: { type: "string", description: "submit: title | prepare: material-id + b/c/db | run: spec-id + b=db | report/archive/meta: run-id/spec-id/repo-path" },
          b: { type: "string", description: "submit: material text file path | prepare: candidates file | run: snapshot db path" },
          c: { type: "string", description: "prepare: reviews file" },
          db: { type: "string", description: "prepare: snapshot db path (required)" },
        },
        required: ["action", "a"],
      },
      execute: async (a) => {
        switch (String(a.action)) {
          case "submit": return runCli(["verify", "submit", "--title", String(a.a), "--text", String(a.b ?? a.a)]);
          case "prepare": return runCli(["verify", "prepare", String(a.a), ...opt("--candidates", a.b), ...opt("--reviews", a.c), ...opt("--db", a.db)]);
          case "run": return runCli(["verify", "run", String(a.a), ...opt("--db", a.b)]);
          case "report": return runCli(["verify", "report", String(a.a)]);
          case "archive": return runCli(["verify", "archive", "verify", String(a.a)]);
          case "meta": return runCli(["verify", "meta", String(a.a)]);
          default: return Promise.reject(new Error(`unknown action: ${String(a.action)}`));
        }
      },
    },
    {
      name: "doctor",
      description: "9-item workspace health check. Pass fix=true to auto-fix safe issues (dirty index + stale locks).",
      inputSchema: {
        type: "object",
        properties: {
          fix: { type: "boolean", description: "Auto-fix dirty index + stale locks" },
        },
      },
      execute: (a) => runCli(["doctor", ...(a.fix ? ["--fix"] : [])]),
    },
  ];
}

// ============================================================
// Transports: shared handler + stdio + HTTP
// ============================================================

/** Shared JSON-RPC message handler — used by both stdio and HTTP transports.
 *  @internal (exported for tests) */
export function handleMcpMessage(
  msg: any,
  tools: McpTool[],
  version: string,
  respond: (id: unknown, result: unknown) => void,
  respondErr: (id: unknown, code: number, message: string) => void,
): void {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ygl-trees", version },
      });
      break;
    case "tools/list":
      respond(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      break;
    case "tools/call": {
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) { respondErr(id, -32602, `Unknown tool: ${name}`); break; }
      tool
        .execute(params?.arguments || {})
        .then((data) =>
          respond(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] })
        )
        .catch((e) => {
          const rc = typeof e?.rc === "number" ? e.rc : undefined;
          const payload = e?.json && typeof e.json === "object" ? (e.json as Record<string, unknown>) : { error: String(e?.message || e) };
          respond(id, {
            content: [{ type: "text", text: JSON.stringify(rc !== undefined ? { rc, ...payload } : payload) }],
            isError: true,
          });
        });
      break;
    }
    case "ping":
      respond(id, {});
      break;
    default:
      if (id !== undefined) respondErr(id, -32601, `Method not found: ${method}`);
  }
}

/** Run the MCP server on stdio. `version` is the host CLI's package version
 * (bin.ts appVersion()) — the server must advertise what it actually is;
 * the hardcoded stamp went stale at 0.69.0 (cold-run friction log 2026-10-18). */
export function serveMcp(version: string): void {
  const tools = buildTools();
  const rl = readline.createInterface({ input: process.stdin });

  const respond = (id: unknown, result: unknown): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };
  const respondErr = (id: unknown, code: number, message: string): void => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    handleMcpMessage(msg, tools, version, respond, respondErr);
  });

  process.stderr.write(`[ygl-trees MCP] stdio server ready — ${tools.length} tools\n`);
}

/** Run the MCP server over HTTP (StreamableHTTP stateless, taste-mcp 市场先例契约).
 *
 * - POST /mcp — JSON-RPC 2.0 request body → JSON response (single object, no SSE)
 * - GET /mcp — 405 (stateless contract: no session streams)
 * - Optional `--token <T>` → require `Authorization: Bearer <T>` or `X-Market-Client` header
 *   (market gateway injects X-Market-Client: mcp/<session> on upstream forwarding)
 *
 * YGL_SESSION isolation: per-request header `X-YGL-Session` overrides env (market proxy
 * passes the caller's session identity through).
 */
export function serveMcpHttp(version: string, port: number, opts: { token?: string } = {}): import("node:http").Server {
  const { createServer } = require("node:http") as typeof import("node:http");
  const startupEnv = { ...process.env };
  const server = createServer((req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found — MCP endpoint is POST /mcp" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "method not allowed — stateless POST only" }));
      return;
    }
    if (opts.token) {
      const auth = req.headers["authorization"] || "";
      const market = String(req.headers["x-market-client"] || "");
      if (auth !== `Bearer ${opts.token}` && !market.startsWith("mcp/")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized — Bearer token or X-Market-Client required" }));
        return;
      }
    }
    const yglSession = String(req.headers["x-ygl-session"] || "");
    const tools = buildTools({ ...startupEnv, ...(yglSession ? { YGL_SESSION: yglSession } : {}) });

    let body = "";
    req.on("data", (d: Buffer) => {
      body += d;
      if (body.length > 1024 * 1024) { req.destroy(); }
    });
    req.on("end", () => {
      const respond = (id: unknown, result: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      const respondErr = (id: unknown, code: number, message: string): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      };
      let msg: any;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      handleMcpMessage(msg, tools, version, respond, respondErr);
    });
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[ygl-trees MCP] HTTP server ready — POST http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mcp — 4 tools\n`);
  });
  return server;
}
