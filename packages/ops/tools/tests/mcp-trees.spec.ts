import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTools, handleMcpMessage } from "../src/mcp";

const tools = () => buildTools({ YGL_HOME: "unused-test-home" });
const dispatch = (t: ReturnType<typeof tools>[number]) => t._meta!["ygl-trees/dispatch"] as any;
afterEach(() => vi.restoreAllMocks());

describe("trees progressive disclosure and transition contract", () => {
  it("lists the compact entry point, conservative annotations and unchanged transition schemas", () => {
    const ts = tools();
    let result: any;
    handleMcpMessage({ id: 1, method: "tools/list" }, ts, "test", (_, r) => { result = r; }, () => { throw Error("rpc"); });
    expect(result.tools.map((t: any) => t.name)).toEqual(["trees", "read", "write", "verify", "doctor"]);
    expect(Object.keys(result.tools[0].inputSchema.properties)).toEqual(["domain", "action", "params"]);
    expect(result.tools[0].annotations.readOnlyHint).toBe(false);
    expect(result.tools[0]._meta["ygl-trees/dispatch"]).toMatchObject({ contract: "ygl-trees/1", unknown: "deny", help_access: "read" });
    for (const t of result.tools.slice(1)) {
      expect(t._meta["ygl-trees/transition"]).toEqual({ replacement: "trees", retain_releases: 1 });
      expect(t.inputSchema).toEqual(ts.find(x => x.name === t.name)!.inputSchema);
    }
  });

  it("discloses directory, domain actions, then parameter schema without executing anything", async () => {
    const ts = tools(), tree = ts[0];
    const spies = ts.slice(1).map(t => vi.spyOn(t, "execute"));
    const root: any = await tree.execute({ action: "help" });
    expect(root.domains).toContain("verify"); expect(root.domains).toContain("doctor");
    expect(root).not.toHaveProperty("params_schema");
    const domain: any = await tree.execute({ domain: "kb", action: "help" });
    expect(domain.actions).toContainEqual({ domain: "kb", action: "add", access: "write", legacy_tool: "write" });
    expect(domain).not.toHaveProperty("params_schema");
    const detail: any = await tree.execute({ domain: "kb", action: "help", params: { action: "add" } });
    expect(detail.params_schema.properties.body.type).toBe("string");
    expect(detail.params_schema.properties).not.toHaveProperty("domain");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("covers every legacy domain/action once, including all verify verbs and both doctor modes", async () => {
    const ts = tools(), tree = ts[0], routes = dispatch(tree).routes;
    const keys = routes.map((r: any) => r.domain + "/" + r.action);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of ["read", "write"]) {
      const t = ts.find(t => t.name === name)!;
      const domains = (t.inputSchema.properties.domain as any).enum;
      const actions = (t.inputSchema.properties.action as any).enum;
      expect([...new Set(routes.filter((r: any) => r.legacy_tool === name).map((r: any) => r.domain))]).toEqual(domains);
      expect(new Set(routes.filter((r: any) => r.legacy_tool === name).map((r: any) => r.action))).toEqual(new Set(actions));
    }
    expect(routes.filter((r: any) => r.domain === "verify").map((r: any) => r.action)).toEqual((ts.find(t => t.name === "verify")!.inputSchema.properties.action as any).enum);
    const spies = new Map(ts.slice(1).map(t => [t.name, vi.spyOn(t, "execute").mockResolvedValue({ stable: true })]));
    for (const r of routes) {
      const params = r.legacy_tool === "verify" && r.action !== "example" ? { a: "fixture-id" } : {};
      const response = await tree.execute({ domain: r.domain, action: r.action, params });
      expect(response).toEqual({ stable: true });
      expect(spies.get(r.legacy_tool)).toHaveBeenLastCalledWith(r.legacy_tool === "doctor" ? { fix: r.action === "fix" }
        : { ...params, ...(r.legacy_tool === "verify" ? {} : { domain: r.domain }), action: r.action });
      const detail: any = await tree.execute({ domain: r.domain, action: "help", params: { action: r.action } });
      expect(detail.access).toBe(r.access);
    }
  });

  it("classifies mutations hidden in the old read face and verify pipeline conservatively", () => {
    const routes = dispatch(tools()[0]).routes;
    for (const pair of ["agent/match", "kb/search", "skill/match", "research/claim-evaluate", "node/validate", "verify/submit", "verify/prepare", "verify/run", "verify/tree-run", "verify/meta", "doctor/fix"]) {
      expect(routes.find((r: any) => r.domain + "/" + r.action === pair)?.access, pair).toBe("write");
    }
    for (const pair of ["library/list", "project/show", "verify/report", "verify/example", "verify/archive", "doctor/check"]) {
      expect(routes.find((r: any) => r.domain + "/" + r.action === pair)?.access, pair).toBe("read");
    }
  });

  it.each([
    { domain: "db", action: "reset" }, { domain: "db", action: "sql" },
    { domain: "project", action: "sync" }, { domain: "plugin", action: "install" },
    { domain: "__proto__", action: "constructor" }, { domain: "kb", action: "toString" },
    { domain: "doctor", action: "check", params: { fix: true } },
    { domain: "project", action: "list", params: { domain: "kb", action: "add" } },
    { domain: "project", action: "list", params: [] },
    { domain: "project", action: "list", params: null },
    { domain: "project", action: "list", fix: true },
    { domain: "kb", action: "help", params: { action: "missing" } },
    { domain: "kb", action: "list", params: { all: "true" } },
    { domain: "tree", action: "node-cond", params: { op: "drop" } },
  ])("rejects invalid routing or privilege selectors before delegation: %j", async args => {
    const ts = tools(), spies = ts.slice(1).map(t => vi.spyOn(t, "execute"));
    await expect(ts[0].execute(args)).rejects.toMatchObject({ rc: 2 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("kb link help names two notes, and trees passes other_note to the write face unchanged", async () => {
    const ts = tools(), tree = ts[0], write = ts.find(t => t.name === "write")!;
    const detail: any = await tree.execute({ domain: "kb", action: "help", params: { action: "link" } });
    const props = detail.params_schema.properties;
    expect(props.other_note.description).toMatch(/second note id/);
    expect(props.evidence_id.description).toMatch(/old name for other_note/);
    expect(props.evidence_id.description).not.toMatch(/^kb link: evidence id$/);
    expect(props.source_id.description).not.toMatch(/kb/i);
    const spy = vi.spyOn(write, "execute").mockResolvedValue({ ok: true } as any);
    await tree.execute({ domain: "kb", action: "link", params: { note: "n1", other_note: "n2" } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ domain: "kb", action: "link", note: "n1", other_note: "n2" }));
  });

  it("preserves booleans, numeric condition values, explicit empty scope and the legacy error object", async () => {
    const ts = tools(), write = ts.find(t => t.name === "write")!;
    const spy = vi.spyOn(write, "execute").mockResolvedValue({ duplicate: true });
    const params = { key: "k", name: "n", op: ">=", value: 0, optional: false, scope: "" };
    expect(await ts[0].execute({ domain: "tree", action: "node-cond", params })).toEqual({ duplicate: true });
    expect(spy).toHaveBeenLastCalledWith({ ...params, domain: "tree", action: "node-cond" });
    const error = Object.assign(Error("runtime"), { rc: 1, json: { error: "runtime" } });
    spy.mockRejectedValueOnce(error);
    await expect(ts[0].execute({ domain: "kb", action: "add", params: { name: "n", body: "b" } })).rejects.toBe(error);
  });
});
