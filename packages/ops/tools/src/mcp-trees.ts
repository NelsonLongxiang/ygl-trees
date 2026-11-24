/** Progressive disclosure over the existing closed MCP routes. @module @ygl/ops-tools/mcp-trees */
import type { McpTool } from "./mcp";

export const TREES_CONTRACT = "ygl-trees/1";
type Access = "read" | "write";
interface Route { domain: string; action: string; access: Access; legacy_tool: string }
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function fail(message: string): never { throw Object.assign(new Error(message), { rc: 2, json: { error: message } }); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** These legacy read routes can write counters, evaluation events or derived indexes. */
const MUTATING_READS = new Set(["agent/match", "kb/search", "skill/match", "research/claim-evaluate", "node/validate"]);
const VERIFY_READS = new Set(["report", "trace", "archive", "example", "tree-report", "tree-trace"]);

export function buildTreesTool(legacy: McpTool[], read: Record<string, string[]>, write: Record<string, string[]>): McpTool {
  const byName = new Map(legacy.map(t => [t.name, t]));
  const routes: Route[] = [];
  for (const [tool, table] of [["read", read], ["write", write]] as const) {
    for (const [domain, actions] of Object.entries(table)) for (const action of actions) {
      routes.push({ domain, action, access: tool === "write" || MUTATING_READS.has(domain + "/" + action) ? "write" : "read", legacy_tool: tool });
    }
  }
  const verifier = byName.get("verify")!;
  for (const action of (verifier.inputSchema.properties.action as { enum: string[] }).enum) {
    routes.push({ domain: "verify", action, access: VERIFY_READS.has(action) ? "read" : "write", legacy_tool: "verify" });
  }
  routes.push({ domain: "doctor", action: "check", access: "read", legacy_tool: "doctor" },
    { domain: "doctor", action: "fix", access: "write", legacy_tool: "doctor" });
  const find = (domain: unknown, action: unknown) => routes.find(r => r.domain === domain && r.action === action);
  const schema = (r: Route) => {
    const props = { ...byName.get(r.legacy_tool)!.inputSchema.properties };
    delete props.domain; delete props.action;
    // Old builders accept these fields even though the legacy list omitted their schemas.
    if (r.legacy_tool === "write") {
      props.tags = { type: "string", description: "kb add: comma-separated tags" };
      props.source_url = { type: "string", description: "kb add: source URL" };
    }
    if (r.legacy_tool === "verify") {
      props.text = { type: "string", description: "lint-candidates: material text path" };
      props.reviews = { type: "string", description: "lint-candidates: reviews path" };
    }
    // The action, never a caller-controlled boolean, selects repair privileges.
    if (r.legacy_tool === "doctor") delete props.fix;
    const required = r.legacy_tool === "verify" && r.action !== "example" ? ["a"] : [];
    return { type: "object" as const, properties: props, additionalProperties: false, required };
  };
  const validate = (params: Record<string, unknown>, s: ReturnType<typeof schema>) => {
    for (const k of s.required) if (!own(params, k)) fail("missing parameter: " + k);
    for (const [k, v] of Object.entries(params)) {
      if (!own(s.properties, k)) fail("unknown parameter: " + k);
      const field = s.properties[k] as { type?: string | string[]; oneOf?: { type: string }[]; enum?: unknown[] };
      const types = field.oneOf ? field.oneOf.map(f => f.type) : Array.isArray(field.type) ? field.type : [field.type];
      if (v === null || !types.includes(typeof v)) fail("invalid parameter type: " + k);
      if (field.enum && !field.enum.includes(v)) fail("invalid parameter value: " + k);
    }
  };
  return {
    name: "trees",
    description: "ygl-trees entry point. Start with {action:'help'}, then {domain,action,params}. Help discloses domain actions and parameter schemas. Read/write classification is in _meta and help; the host must enforce role authorization. Legacy tools remain for one transition release.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        domain: { type: "string", description: "Domain from help; omit for the help directory" },
        action: { type: "string", description: "help or an exact domain action" },
        params: { type: "object", description: "Action parameters. For domain help, optional {action:'<action>'} requests detail.", additionalProperties: true },
      }, required: ["action"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    _meta: { "ygl-trees/dispatch": { contract: TREES_CONTRACT, domain_key: "domain", action_key: "action", params_key: "params", unknown: "deny", help_access: "read", routes } },
    execute: async (a) => {
      if (!object(a)) fail("trees arguments must be an object");
      for (const k of Object.keys(a)) if (!["domain", "action", "params"].includes(k)) fail("unknown trees field: " + k);
      if (typeof a.action !== "string" || (a.domain !== undefined && typeof a.domain !== "string")) fail("domain and action must be strings");
      const params = a.params === undefined ? {} : a.params;
      if (!object(params)) fail("params must be an object");
      if (a.action === "help") {
        for (const k of Object.keys(params)) if (k !== "action") fail("unknown help parameter: " + k);
        if (a.domain === undefined) {
          if (Object.keys(params).length) fail("action help requires domain");
          return { contract: TREES_CONTRACT, access: "read", domains: [...new Set(routes.map(r => r.domain))],
            next: { domain: "kb", action: "help" }, transition: { legacy_tools: [...byName.keys()], retain_releases: 1 } };
        }
        const selected = routes.filter(r => r.domain === a.domain);
        if (!selected.length) fail("unknown domain: " + a.domain);
        if (params.action === undefined) return { contract: TREES_CONTRACT, domain: a.domain, actions: selected };
        const r = find(a.domain, params.action);
        if (!r) fail("unknown action for domain: " + String(params.action));
        return { contract: TREES_CONTRACT, ...r, params_schema: schema(r),
          usage: { domain: r.domain, action: r.action, params: {} },
          note: "Parameter descriptions specify applicable actions; existing CLI validation remains authoritative." };
      }
      const route = find(a.domain, a.action);
      if (!route) fail("unknown domain/action; use trees {action:'help'}");
      validate(params, schema(route));
      const args = route.legacy_tool === "doctor" ? { fix: route.action === "fix" }
        : { ...params, ...(route.legacy_tool === "verify" ? {} : { domain: route.domain }), action: route.action };
      return byName.get(route.legacy_tool)!.execute(args);
    },
  };
}
