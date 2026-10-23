/**
 * MCP (Model Context Protocol) Server — stdio transport.
 *
 * Eleven-tool surface (0.114.26: +3 write faces, owner ruling "方案 D"):
 *   agent_brief · agent_match · kb_search · claim_evaluate
 *   tree_state  · produce_report · doctor · task_advance
 *   research_write · tree_write · verify        ← write/pipeline faces
 *
 * Each tool routes to the CLI --json backend, inheriting its frozen contracts
 * (idempotent writes, pure JSON errors, snake_case fields). rc fidelity:
 * rc≠0 outcomes surface as MCP isError:true with a machine-readable
 * {rc, error} payload — the exit-code contract is never flattened to text.
 *
 * Protocol: JSON-RPC 2.0 over stdio (one message per line).
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{...}}
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
function cliExec(parts: string[]): Promise<CliOutcome> {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const self = process.argv[1]; // the bin.cjs or bin.js that's running this MCP server
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--json", ...parts], {
      env: { ...process.env, YGL_SERVE: "1", YGL_MCP_CHILD: "1" },
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
function cliJson(parts: string[]): Promise<unknown> {
  return cliExec(parts).then((o) => {
    if (o.rc === 0) return o.json;
    const e = new Error(`CLI rc=${o.rc}: ${o.stderr.slice(0, 200)}`) as Error & { rc: number; json: unknown };
    e.rc = o.rc;
    e.json = o.json && typeof o.json === "object" ? o.json : { error: o.stderr.slice(0, 300) || `CLI rc=${o.rc}` };
    throw e;
  });
}

/** arg helper: optional string flag pair */
const opt = (flag: string, v: unknown): string[] => (v === undefined || v === null || v === "" ? [] : [flag, String(v)]);

export function buildTools(): McpTool[] {
  return [
    {
      name: "agent_brief",
      description: "Current workspace state: project, progress, counts, next actions, available skills. Always start here.",
      inputSchema: { type: "object", properties: {} },
      execute: () => cliJson(["agent", "brief"]),
    },
    {
      name: "agent_match",
      description: "Discover which skill handles a task. Returns matched skills with relevance scores.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Task description to match" } },
        required: ["query"],
      },
      execute: (a) => cliJson(["agent", "match", String(a.query)]),
    },
    {
      name: "kb_search",
      description: "Search knowledge notes (CJK full-text). Returns notes with title, body, tags, confidence.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (Chinese supported)" },
          eval: { type: "boolean", description: "Enable decision-model semantic re-ranking" },
        },
        required: ["query"],
      },
      execute: (a) => {
        const parts = ["kb", "search", String(a.query)];
        if (a.eval) parts.push("--eval");
        return cliJson(parts);
      },
    },
    {
      name: "claim_evaluate",
      description: "Decision model evaluates a claim's confidence (score 0-5 → grade A/B/C/D).",
      inputSchema: {
        type: "object",
        properties: { claim_id: { type: "string", description: "Claim ID to evaluate" } },
        required: ["claim_id"],
      },
      execute: (a) => cliJson(["research", "claim", "evaluate", String(a.claim_id)]),
    },
    {
      name: "tree_state",
      description: "All trees with node states (locked/unlocked). Visualize the dependency graph.",
      inputSchema: {
        type: "object",
        properties: { tree: { type: "string", description: "Optional tree name (omit for all)" } },
      },
      execute: (a) => cliJson(["node", "list", ...(a.tree ? [String(a.tree)] : [])]),
    },
    {
      name: "produce_report",
      description: "Assemble claims + evidence into a markdown report. Returns report ID and content.",
      inputSchema: { type: "object", properties: {} },
      execute: () => cliJson(["produce", "report"]),
    },
    {
      name: "doctor",
      description: "9-item workspace health check. Pass fix=true to auto-fix safe issues.",
      inputSchema: {
        type: "object",
        properties: { fix: { type: "boolean", description: "Auto-fix dirty index + stale locks" } },
      },
      execute: (a) => cliJson(["doctor", ...(a.fix ? ["--fix"] : [])]),
    },
    {
      name: "task_advance",
      description: "Advance a task through the state machine: todo → doing → done (or roll back).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task artifact ID" },
          action: { type: "string", enum: ["doing", "done", "todo"], description: "Target status" },
        },
        required: ["task_id", "action"],
      },
      execute: (a) => cliJson(["task", String(a.action), String(a.task_id)]),
    },
    {
      name: "research_write",
      description:
        "Idempotent research-pipeline writes: register queries, add sources/evidence, create/link/resolve claims. " +
        "Same-content reruns return the existing row (duplicate:true).",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["query-add", "source-add", "evidence-add", "claim-add", "claim-link", "claim-resolve"],
            description: "Write verb",
          },
          text: { type: "string", description: "query/claim text, source title, or claim id (per action)" },
          b: { type: "string", description: "source-add: url | evidence-add: source-id | claim-link: evidence-id" },
          quote: { type: "string", description: "evidence-add: verbatim excerpt" },
          stance: { type: "string", enum: ["supports", "refutes"], description: "claim-link stance" },
          as: { type: "string", enum: ["supported", "refuted", "contested"], description: "claim-resolve verdict" },
          project: { type: "string", description: "explicit project name (defaults to session selection)" },
        },
        required: ["action", "text"],
      },
      execute: (a) => {
        const p = opt("-p", a.project);
        switch (String(a.action)) {
          case "query-add": return cliJson(["research", "query", "add", String(a.text), ...p]);
          case "source-add": return cliJson(["research", "source", "add", "--title", String(a.text), "--url", String(a.b), ...p]);
          case "evidence-add": return cliJson(["research", "evidence", "add", String(a.text), "--quote", String(a.quote ?? ""), ...p]);
          case "claim-add": return cliJson(["research", "claim", "add", String(a.text), ...p]);
          case "claim-link": return cliJson(["research", "claim", "link", String(a.text), String(a.b), "--stance", String(a.stance ?? "supports"), ...p]);
          case "claim-resolve": return cliJson(["research", "claim", "resolve", String(a.text), "--as", String(a.as ?? "supported"), ...p]);
          default: return Promise.reject(new Error(`unknown action: ${String(a.action)}`));
        }
      },
    },
    {
      name: "tree_write",
      description:
        "Tech-tree structural writes: create/select trees, add/link/unlock nodes, rebuild the closure index. " +
        "Discipline: after structural changes always run action=node-index (index+validate); unlock requires evidence via rel.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["tree-new", "tree-use", "node-add", "node-link", "node-unlock", "node-index"],
            description: "Write verb",
          },
          tree: { type: "string", description: "tree name (tree-*: required; node-*: defaults to selection)" },
          key: { type: "string", description: "node key (node-*)" },
          child: { type: "string", description: "child key (node-link)" },
          name: { type: "string", description: "display name (node-add)" },
          project: { type: "string", description: "explicit project (tree-new)" },
        },
        required: ["action"],
      },
      execute: (a) => {
        const t = opt("-t", a.tree);
        switch (String(a.action)) {
          case "tree-new": return cliJson(["tree", "new", String(a.tree), ...opt("-p", a.project)]);
          case "tree-use": return cliJson(["tree", "use", String(a.tree)]);
          case "node-add": return cliJson(["node", "add", String(a.key), ...opt("--name", a.name), ...t]);
          case "node-link": return cliJson(["node", "link", String(a.key), String(a.child), ...t]);
          case "node-unlock": return cliJson(["node", "unlock", String(a.key), ...t]);
          case "node-index": return cliJson(["node", "index", ...t]);
          default: return Promise.reject(new Error(`unknown action: ${String(a.action)}`));
        }
      },
    },
    {
      name: "verify",
      description:
        "spec-validator pipeline: submit freezes business material (encoding fail-closed), prepare builds criteria " +
        "(P0-P5), run executes 7 checker types on a snapshot, archive seals+signs, tree runs the recursive verifier (A1).",
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
      execute: (a) => {
        switch (String(a.action)) {
          case "submit": return cliJson(["verify", "submit", "--title", String(a.a), "--text", String(a.b ?? a.a)]);
          case "prepare": return cliJson(["verify", "prepare", String(a.a), ...opt("--candidates", a.b), ...opt("--reviews", a.c), ...opt("--db", a.db)]);
          case "run": return cliJson(["verify", "run", String(a.a), ...opt("--db", a.b)]);
          case "report": return cliJson(["verify", "report", String(a.a)]);
          case "archive": return cliJson(["verify", "archive", "verify", String(a.a)]); // 验签既有归档；封存已在 run 时自动发生
          case "meta": return cliJson(["verify", "meta", String(a.a)]);
          default: return Promise.reject(new Error(`unknown action: ${String(a.action)}`));
        }
      },
    },
  ];
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
            // rc fidelity (0.114.26): a non-zero CLI exit surfaces as isError
            // with a MACHINE-READABLE {rc, ...json} payload — the exit-code
            // contract (0 ok / 1 runtime / 2 usage) is never flattened to text.
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
  });

  process.stderr.write(`[ygl-trees MCP] stdio server ready — ${tools.length} tools\n`);
}
