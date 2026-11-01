#!/usr/bin/env node
// Skill doc-truth gate (#147/#149): every command literal in skills/*/SKILL.md
// (fenced code lines + inline `code` spans) is run against the release bundle in
// a scratch workspace. Placeholder-driven failures (not found / usage) are fine;
// what fails the gate is the CLI rejecting the command SHAPE — unknown group,
// subcommand, action or flag — i.e. the skill teaches a command that does not exist.
//
// Usage: node scripts/skills-audit.mjs [--bin dist/bundle/bin.cjs] [--skills <dir>] [--json]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const bin = path.resolve(repo, flag("--bin") || "dist/bundle/bin.cjs");
const asJson = argv.includes("--json");
if (!fs.existsSync(bin)) { console.error(`skills-audit: ${bin} missing — run pnpm build first`); process.exit(2); }

const GROUPS = new Set(["config", "db", "skill", "project", "research", "verify", "produce", "task", "kb", "job",
  "patrol", "tree", "node", "webui", "rel", "plugin", "agent", "doctor", "llms",
  // not groups: the bare research actions a skill might wrongly teach without their group
  "source", "query", "evidence", "claim", "predict", "promote"]);
const REF_TYPES = new Set(["node", "claim", "evidence", "source", "query", "kb", "artifact", "task", "skill"]);
// long-running, networked or destructive shapes: existence is covered by readme:verify / demo
const SKIP = /\b(serve|tick|reset|sync pg|migrate pg|source fetch|mcp|plugin install|skill link --global)\b/;
const REJECT = /unknown (group|flag|option|[a-z]+ (sub)?command|[a-z]+ action|reference type)|did you mean/i;

function extract() {
  const out = [];
  const dir = path.resolve(repo, flag("--skills") || "skills");
  for (const d of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, d, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    let inCode = false, cont = "";
    fs.readFileSync(f, "utf8").split("\n").forEach((raw, i) => {
      if (/^\s*```/.test(raw)) { inCode = !inCode; cont = ""; return; }
      const cands = [];
      if (inCode) {
        let l = (cont + " " + raw.replace(/\s#\s.*$/, "")).trim();
        if (l.endsWith("\\")) { cont = l.slice(0, -1); return; }
        cont = ""; cands.push(l);
      }
      for (const m of raw.matchAll(/`([^`]+)`/g)) cands.push(m[1].trim());
      for (const c of cands) for (let seg of c.split(/\s*(?:&&|;|→)\s*|\s+\|\s+/)) {
        seg = seg.replace(/^\$\s*/, "").replace(/^(npx\s+)?ygl-trees\s+/, "").trim();
        const w = seg.split(/\s+/);
        if (!GROUPS.has(w[0]) || w.length < 2) continue;
        if (w.slice(1, 3).some((x) => /[/|]/.test(x) && !/^-|:/.test(x))) continue; // "add/list/show" shorthand, paths
        if (w.every((x) => REF_TYPES.has(x))) continue;                      // ref-type enumerations
        if (!/^[A-Za-z<"-]/.test(w[1])) continue;
        out.push({ skill: d, line: i + 1, cmd: seg });
      }
    });
  }
  const seen = new Set();
  return out.filter((o) => !seen.has(o.skill + "|" + o.cmd) && seen.add(o.skill + "|" + o.cmd));
}

function tokens(s) {
  s = s.replace(/<[^>]*>:/g, "kb:").replace(/<[^>]*>/g, "x").replace(/\[[^\]]*\]/g, "").replace(/\.\.\.|…/g, "");
  const t = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s))) t.push(m[1] ?? m[2] ?? m[3]);
  return t.filter(Boolean);
}

const tmpRoot = path.join(repo, "tmp"); fs.mkdirSync(tmpRoot, { recursive: true });
const ws = fs.mkdtempSync(path.join(tmpRoot, "skills-audit-"));
const home = path.join(ws, "home"), cwd = path.join(ws, "cwd");
fs.mkdirSync(home); fs.mkdirSync(cwd);
const env = { ...process.env, YGL_HOME: home, YGL_SESSION: "skills-audit", YGL_TEST: "1", YGL_EVAL_OFFLINE: "1", NO_COLOR: "1",
  AI_GATEWAY_API_KEY: "", YGL_DB_URL: "", YGL_PG_URL: "" };
const run = (a) => new Promise((res) => {
  const p = spawn(process.execPath, [bin, ...a], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
  const t = setTimeout(() => p.kill(), 15000);
  p.on("close", (rc) => { clearTimeout(t); res({ rc, out: o.replace(/\x1b\[[0-9;]*m/g, "") }); });
});

try {
  for (const a of [["db", "init"], ["project", "new", "p", "-q", "skills audit"], ["tree", "new", "t"], ["node", "add", "x"]]) await run(a);
  const cmds = extract().filter((c) => !SKIP.test(c.cmd));
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.cpus().length - 1)) }, async () => {
    while (next < cmds.length) {
      const c = cmds[next++];
      const r = await run(tokens(c.cmd));
      const first = r.out.split("\n").map((s) => s.trim()).find(Boolean) || "";
      results.push({ ...c, rc: r.rc, rejected: r.rc === 2 && REJECT.test(r.out), first: first.slice(0, 160) });
    }
  }));
  const bad = results.filter((r) => r.rejected).sort((a, b) => (a.skill + a.line).localeCompare(b.skill + b.line));
  if (asJson) console.log(JSON.stringify({ checked: results.length, rejected: bad.length, findings: bad }, null, 2));
  else {
    for (const b of bad) console.log(`  ✗ skills/${b.skill}/SKILL.md:${b.line}  ${b.cmd}\n      → ${b.first}`);
    console.log(`skills-audit: ${results.length} command literal(s) checked, ${bad.length} rejected by the CLI`);
  }
  process.exitCode = bad.length ? 1 : 0;
} finally {
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
