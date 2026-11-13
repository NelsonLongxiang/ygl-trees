/** #275 library: market experience library read-only feed (CLI + MCP parity). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
function mkdirSyncUnderTmp(): void { home = mkdtempSync(join(tmpdir(), "y275mcp-")); }
const BIN = join(ROOT, "dist/apps/cli/src/bin.js");
let home = "";
const environment = { ...process.env, YGL_HOME: "", YGL_DB_URL: "", YGL_PG_URL: "", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" };

function cli(args: string[], session = "lib-test"): { rc: number | null; json: any; text: string } {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 60000,
    env: { ...environment, YGL_HOME: home, YGL_SESSION: session } });
  let json: any = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* human face */ }
  return { rc: r.status, json, text: r.stdout + r.stderr };
}
function cliRaw(args: string[], session = "lib-test"): { rc: number | null; text: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 60000,
    env: { ...environment, YGL_HOME: home, YGL_SESSION: session } });
  return { rc: r.status, text: r.stdout + r.stderr };
}

describe("library feed (#275)", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "y275-"));
    cliRaw(["db", "init"]);
    cliRaw(["project", "new", "proj1"]);
  });
  afterAll(() => { try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} });

  it("contract + row shape + frontmatter summary + absent-not-empty on a seeded workspace", () => {
    const src = cli(["research", "source", "add", "--title", "S1", "--url", "https://x.example/a"]).json;
    const ev = cli(["research", "evidence", "add", src.id, "--quote", "q1", "--note", "n1"]).json;
    const cl = cli(["research", "claim", "add", "--text", "claim A text"]).json;
    cliRaw(["research", "claim", "link", cl.id, ev.id, "--stance", "supports"]);
    cliRaw(["research", "claim", "resolve", cl.id, "--outcome", "supported"]);
    writeFileSync(join(home, "n.md"), "---\ncue: c\nlesson: l\nevidence: e\n---\n\nFirst paragraph of the body text here.\n");
    cliRaw(["kb", "add", "--title", "note one", "-f", join(home, "n.md"), "--source-url", "/decisions/1"]);
    cliRaw(["kb", "add", "--title", "plain note", "--body", "no frontmatter paragraph."]);

    const notes = cli(["library", "list", "--kind", "note"]).json;
    expect(notes.contract).toBe("ygl-library/1");
    expect(notes.total).toBe(2);
    const fmed = notes.items.find((i: any) => i.title === "note one");
    expect(fmed.summary).toBe("First paragraph of the body text here.");
    expect(fmed.summary).not.toContain("cue:");
    expect(fmed.source_url).toBe("/decisions/1");
    expect(fmed.scope).toBeUndefined(); // absent, not "" (#276 lands the column)
    const plain = notes.items.find((i: any) => i.title === "plain note");
    expect(plain.summary).toBe("no frontmatter paragraph.");
    // no never-exposed field name leaks
    for (const it of notes.items) { expect("reuse" in it).toBe(false); expect("content_hash" in it).toBe(false); expect("ngram" in it).toBe(false); }

    const claims = cli(["library", "list", "--kind", "claim"]).json;
    expect(claims.items).toHaveLength(1);
    expect(claims.items[0].status).toBe("supported");
    expect(claims.items[0].project).toBe("proj1");
    expect(claims.items[0].scope).toBeUndefined();
    const cshow = cli(["library", "show", "claim", cl.id]).json;
    expect(cshow.contract).toBe("ygl-library/1");
    expect(Array.isArray(cshow.evidence)).toBe(true);
    expect(cshow.evidence[0]).toMatchObject({ quote: "q1", stance: "supports" });
    expect(cshow.evidence[0].source.title).toBe("S1");
  });

  it("bundled skills are absent; a promoted note appears with from_note", () => {
    const skills = cli(["library", "list", "--kind", "skill"]).json;
    expect(skills.items).toHaveLength(0); // db init seeds builtin:* rows — none may leak
    const notes = cli(["library", "list", "--kind", "note"]).json;
    const noteOne = notes.items.find((i: any) => i.title === "note one");
    cliRaw(["kb", "promote", noteOne.id, "--name", "lib-promoted-skill"]);
    const after = cli(["library", "list", "--kind", "skill"]).json;
    expect(after.items).toHaveLength(1);
    expect(after.items[0].from_note).toBe(noteOne.id);
    const show = cli(["library", "show", "skill", "lib-promoted-skill"]).json;
    expect(show.from_note).toBe(noteOne.id);
    expect(typeof show.body).toBe("string");
  });

  it("paging: --limit 2 over 5 rows gives three pages, no repeat or miss; cursor is opaque", () => {
    for (let i = 1; i <= 3; i++) cliRaw(["kb", "add", "--title", `pg-${i}`, "--body", `body ${i}`]);
    // now 5 notes total (note one, plain note, pg-1..3)
    const seen = new Set<string>();
    let cursor: string | undefined; let pages = 0;
    do {
      const args = ["library", "list", "--kind", "note", "--limit", "2"];
      if (cursor) args.push("--cursor", cursor);
      const page = cli(args).json;
      pages++;
      for (const it of page.items) { expect(seen.has(it.id)).toBe(false); seen.add(it.id); }
      cursor = page.next_cursor ?? undefined;
      if (pages > 3) break;
    } while (cursor);
    expect(pages).toBe(3); // 5 rows / 2 = 3 pages
    expect(seen.size).toBe(5);
  });

  it("--since filters by updated (strict ISO); bad ISO is rc 2; bad kind is rc 2", () => {
    const future = cli(["library", "list", "--kind", "note", "--since", "2999-01-01T00:00:00Z"]).json;
    expect(future.items).toHaveLength(0);
    const past = cli(["library", "list", "--kind", "note", "--since", "2000-01-01T00:00:00Z"]).json;
    expect(past.total).toBe(5);
    const badIso = cli(["library", "list", "--kind", "note", "--since", "nope"]);
    expect(badIso.rc).toBe(2);
    const badKind = cli(["library", "list", "--kind", "nope"]);
    expect(badKind.rc).toBe(2);
  });
});

describe("library MCP parity (#275)", () => {
  let server: import("node:http").Server | null = null; let port = 0;
  let oldEnv: NodeJS.ProcessEnv | undefined; let oldArgv = "";
  beforeAll(async () => {
    mkdirSyncUnderTmp();
    cliRaw(["db", "init"]);
    const { serveMcpHttp } = await import("../src/mcp.js");
    oldEnv = process.env; oldArgv = process.argv[1]; process.argv[1] = BIN;
    environment.YGL_HOME = home; process.env = environment as any;
    server = serveMcpHttp("0.126.0", 0);
    await (await import("node:events")).once(server, "listening");
    port = (server.address() as any).port;
  }, 120000);
  afterAll(async () => {
    if (server) { await new Promise<void>((r) => { server!.close(() => r()); (server as any).closeAllConnections(); }); }
    if (oldEnv) process.env = oldEnv;
    if (oldArgv) process.argv[1] = oldArgv;
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });

  async function rpc(body: unknown): Promise<any> {
    const http = await import("node:http");
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json" } },
        (res) => { let out = ""; res.on("data", (d) => (out += d)); res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }); });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
  }

  it("read domain library is listed; list+show round-trip through MCP; kb add passes tags/source_url; frontmatter note promotes without --force", async () => {
    const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const readTool = tools.result.tools.find((t: any) => t.name === "read");
    expect(readTool.inputSchema.properties.domain.enum).toContain("library");
    const call = (args: any) => rpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name: "read", arguments: { domain: "library", ...args } } });
    cliRaw(["kb", "add", "--title", "via-mcp-note", "--body", "text"]);
    const list = await call({ action: "list", kind: "note" });
    expect(list.result.isError ?? false).toBe(false);
    const page = JSON.parse(list.result.content[0].text);
    expect(page.contract).toBe("ygl-library/1");
    const show = await call({ action: "show", kind: "note", id: page.items[0].id });
    expect(JSON.parse(show.result.content[0].text).body).toBe("text");

    // kb add via MCP carries tags + source_url (market writes a site-relative path)
    const wcall = (domain: string, args: any) => rpc({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name: "write", arguments: { domain, ...args } } });
    const addRes = await wcall("kb", { action: "add", name: "mcp fm note", body: "---\ncue: c\nlesson: l\nevidence: e\n---\n\nBody.", tags: "t1", source_url: "/decisions/9" });
    if (addRes.result?.isError) console.log("KB-ADD-ERR:", JSON.stringify(addRes.result.content?.[0]?.text ?? addRes.result).slice(0, 300));
    expect(addRes.result.isError ?? false).toBe(false);
    const added = JSON.parse(addRes.result.content[0].text);
    const shown = cli(["kb", "show", added.id]).json;
    expect(shown.tags).toBe("t1");
    expect(shown.source_url).toBe("/decisions/9");
    // frontmatter with cue/lesson/evidence passes promote admission without --force
    const prom = await wcall("kb", { action: "promote", id: added.id, name: "mcp-promoted-skill" });
    expect(prom.result.isError ?? false).toBe(false);
    const skills = await call({ action: "list", kind: "skill" });
    const spage = JSON.parse(skills.result.content[0].text);
    expect(spage.items).toHaveLength(1);
    expect(spage.items[0].from_note).toBe(added.id);
  }, 60000);
});