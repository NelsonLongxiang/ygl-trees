/**
 * MCP (Model Context Protocol) Server — stdio transport.
 *
 * Eight-tool surface designed by the unified three-pillar theory (R8 research):
 *   agent_brief · agent_match · kb_search · claim_evaluate
 *   tree_state  · produce_report · doctor · task_advance
 *
 * Each tool routes to the CLI --json backend, inheriting its frozen contracts
 * (idempotent writes, pure JSON errors, snake_case fields). Agents call tools
 * directly — no command-line parsing layer.
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

/** Build a CLI invocation and capture JSON stdout.
 *  Uses process.argv[1] (the running script — bundle or source) to re-invoke
 *  the CLI as a child process. This works in both dev (dist/apps/...) and
 *  bundle (dist/bundle/bin.cjs) contexts. */
function cliJson(parts: string[]): Promise<unknown> {
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
      if (out.trim()) {
        try { resolve(JSON.parse(out)); return; } catch { /* fall through */ }
      }
      reject(new Error(`CLI rc=${code}: ${err.slice(0, 200) || out.slice(0, 200)}`));
    });
    child.on("error", (e) => reject(e));
  });
}

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
          .catch((e) =>
            respond(id, {
              content: [{ type: "text", text: `Error: ${e?.message || e}` }],
              isError: true,
            })
          );
        break;
      }
      case "ping":
        respond(id, {});
        break;
      default:
        if (id !== undefined) respondErr(id, -32601, `Method not found: ${method}`);
    }
  });

  process.stderr.write("[ygl-trees MCP] stdio server ready — 8 tools\n");
}
