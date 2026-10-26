import * as path from "node:path";
import * as fs from "node:fs";
import { Env, lastFlagOf } from "../../../core/database/src/types";
import { ok, bad, warn, out, head, table, paint, C, show, ack } from "../../../core/text/src/fmt";
import { clearLockDir, dbPath, pidAlive, takeoverLockDir } from "../../../core/database/src/db";
import { syncToPg, migrateToPg } from "./pgsync";


/**
 * Cold-start: import the built-in skills that ship with this package, so a
 * fresh workspace immediately has capability discovery (agent match) working.
 * Resolves skills/ relative to the CLI installation (repo root or npm package).
 */
async function autoImportBuiltinSkills(env: any, dbFile: string): Promise<{ imported: number; failed: string[]; ms: number }> {
  const fs2 = require("node:fs");
  const path2 = require("node:path");
  // probe upward from this module to find skills/ (same approach as repoRoot)
  let skillsDir: string | null = null;
  let dir: string = __dirname;
  for (let i = 0; i < 6; i++, dir = path2.dirname(dir)) {
    const candidate = path2.join(dir, "skills");
    if (fs2.existsSync(candidate)) {
      const entries = fs2.readdirSync(candidate).filter((e: string) =>
        fs2.existsSync(path2.join(candidate, e, "SKILL.md"))
      );
      if (entries.length > 0) {
        skillsDir = candidate;
        break;
      }
    }
  }
  if (!skillsDir) {
    // Fail-loud (was silent return 0): the npm package MUST ship skills/ —
    // if we can't find them, the user deserves to know why agent match
    // returns nothing. This is a packaging bug indicator, not a valid state.
    const { out: outFn, paint: paintFn, C: Cf } = require("../../../core/text/src/fmt");
    if (env.ctx && !env.ctx.json) {
      outFn(env.ctx, paintFn(Cf.yellow, "  ! built-in skills: 0 found (skills/ not shipped or not in package)", env.ctx.color));
      outFn(env.ctx, paintFn(Cf.dim, "    this is a packaging bug — skills/ should be in the npm tarball", env.ctx.color));
    }
    return { imported: 0, failed: [], ms: 0 };
  }
  const { getOrm } = require("../../../core/database/src/orm");
  const writes = require("../../../research/pipeline/src/writes");
  const { parseFrontmatter } = require("../../../core/text/src/text");
  const ds = await getOrm(dbFile);
  // Parse every SKILL.md OUTSIDE the transaction (file IO must not hold it).
  const parsed: Array<{ name: string; input: any }> = [];
  for (const entry of fs2.readdirSync(skillsDir)) {
    const skillFile = path2.join(skillsDir, entry, "SKILL.md");
    if (!fs2.existsSync(skillFile)) continue;
    try {
      const raw = fs2.readFileSync(skillFile, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      parsed.push({
        name: meta.name || entry,
        input: {
          name: meta.name || entry,
          description: meta.description || "",
          body,
          tags: (meta.tags || "").toString(),
          version: meta.version || "0.1.0",
          origin: `builtin:${entry}`,
        },
      });
    } catch {
      /* unreadable/malformed SKILL.md: counted as failed below */
      parsed.push({ name: entry, input: null as any });
    }
  }
  // 0.110.x: ONE transaction for the cold-start import (was one per skill:
  // 85-86s on this host). Each skill keeps its own savepoint so one bad skill
  // rolls back alone; the summary event records the whole batch (not N rows).
  const failed: string[] = [];
  let count = 0;
  const started = Date.now();
  await ds.transaction(async (mgr: any) => {
    let i = 0;
    for (const cand of parsed) {
      i++;
      if (!cand.input) {
        failed.push(cand.name);
        continue;
      }
      const sp = `sk_${i}`;
      await mgr.query(`SAVEPOINT ${sp}`);
      try {
        await writes.skillUpsertIn(mgr, cand.input, { emit: false });
        await mgr.query(`RELEASE SAVEPOINT ${sp}`);
        count++;
      } catch (e: any) {
        await mgr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await mgr.query(`RELEASE SAVEPOINT ${sp}`);
        failed.push(cand.name);
      }
    }
    await writes.logEvent(
      mgr,
      "skill.import",
      "skills",
      "builtin",
      JSON.stringify({ imported: count, failed }),
      failed.length ? "warn" : "info",
    );
  });
  return { imported: count, failed, ms: Date.now() - started };
}

export async function run(env: Env, action: string, rest: string[], args: any): Promise<number> {
  const { ctx, db, home } = env;
  // #91：--db 数组形（tree run 分叶绑库）——单值面统一 lastFlagOf 取末位。
  const file = lastFlagOf(args.flags.db) || dbPath(home);
  // B7：PG 模式（boot 已收口到 stats/path 两动作）——file 显示 PG URL、export 等 SQLite 面点名拒。
  const pgMode = db === null || db === undefined;

  switch (action) {
    case "init": {
      fs.mkdirSync(home, { recursive: true });
      const d = new (require("../../../core/database/src/db").DB)(file);
      d.metaSet("created", new Date().toISOString());
      d.metaSet("schema_version", String(require("../../../core/database/src/db").SCHEMA_VERSION));
      d.close();
      if (!ctx.json) {
        ok(ctx, `workspace ready: ${home}`);
        ok(ctx, `database:        ${file}`);
      }
      // Cold-start fix (0.48): a fresh workspace has ZERO skills, so agent match
      // returns nothing and a cold user thinks the tool has no capabilities.
      // Auto-import the built-in skills that ship with this package.
      return autoImportBuiltinSkills(env, file).then(async (r: any) => {
        const secs = (r.ms / 1000).toFixed(1);
        if (ctx.json) console.log(JSON.stringify({ created: true, db: file, imported: r.imported, failed: r.failed, ms: r.ms }));
        else if (r.imported > 0) ok(ctx, `built-in skills:  ${r.imported} imported in ${secs}s (agent match ready)`);
        else warn(ctx, "built-in skills:  0 imported — skills/ directory not found in package");
        if (r.failed.length && !ctx.json) warn(ctx, `built-in skills:  ${r.failed.length} failed: ${r.failed.join(", ")}`);
        // Release the ORM connection so the lock doesn't linger
        try { const { closeOrm } = require("../../../core/database/src/orm"); await closeOrm(); } catch { /* */ }
        // Partial import is a failure signal (fdc757f6 pre-audit ④): callers
        // must not read rc=0 as "cold-start is fully ready" when skills dropped.
        return r.failed.length ? 1 : 0;
      });
    }
    case "path":
      if (pgMode) {
        const pgTarget = String(process.env.YGL_DB_URL || lastFlagOf(args.flags.db));
        if (ctx.json) console.log(JSON.stringify({ dialect: "pg", url: pgTarget.replace(/\/\/[^@]*@/, "//") }, null, 2));
        else out(ctx, "pg: " + pgTarget.replace(/\/\/[^@]*@/, "//"));
        return 0;
      }
      if (ctx.json) console.log(JSON.stringify({ path: file }, null, 2));
      else out(ctx, file);
      return 0;
    case "unlock": {
      // Real-user report ②: residual .ygllock after a crash left users with
      // an "rmdir" instruction and no safety net. `db unlock` checks pid
      // liveness — dead/absent holder clears, a LIVE holder is refused
      // (that is a parallel session or webui serve, not garbage) unless --force.
      const lockDir = `${file}.ygllock`;
      let holder = "";
      try { holder = fs.readFileSync(`${lockDir}/pid`, "utf8").trim(); } catch { /* */ }
      if (!fs.existsSync(lockDir)) {
        if (ctx.json) console.log(JSON.stringify({ lock: lockDir, holder: null, cleared: false, reason: "no lock present" }, null, 2));
        else ok(ctx, `no lock present: ${lockDir}`);
        return 0;
      }
      if (holder && pidAlive(holder) && !args.flags.force) {
        // Self-check: OUR OWN boot may hold this lock — that is not a
        // parallel session, and refusing here would deadlock the command
        // against itself. Clear it; the process exits right after anyway.
        const self = Number(holder) === process.pid;
        // 0.79.1: echo the holder's self-reported command line (R297 report —
        // guessing "serve?" sent users to kill the wrong process).
        let holderCmd = "";
        try { holderCmd = fs.readFileSync(`${lockDir}/cmd`, "utf8").trim(); } catch { /* */ }
        const msg = self
          ? `lock is held by THIS process (pid ${holder}) — acquired during boot; clearing.`
          : `lock held by LIVE process (pid: ${holder}${holderCmd ? ` — ${holderCmd}` : ""}) — refusing to clear.`;
        if (self) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
            if (ctx.json) console.log(JSON.stringify({ lock: lockDir, holder, cleared: true, reason: "self (acquired during boot)" }, null, 2));
            else ok(ctx, `lock cleared: ${lockDir}  (self — acquired during boot)`);
            return 0;
          } catch { /* fall through to the generic clear below */ }
        }
        if (ctx.json) console.log(JSON.stringify({ lock: lockDir, holder, holder_cmd: holderCmd || null, cleared: false, reason: "holder alive (use --force to override)" }, null, 2));
        else {
          bad(ctx, msg);
          out(ctx, paint(C.yellow, `  that is a parallel CLI session (serve never takes the write lock) — retry after it exits;`, ctx.color));
          out(ctx, paint(C.yellow, `  the lock self-heals then. --force overrides (corruption risk if writes are in flight).`, ctx.color));
        }
        return 1;
      }
      try {
        if (!takeoverLockDir(lockDir)) throw new Error("directory still exists after retries (Windows handle?)");
        const why = !holder || !pidAlive(holder) ? `stale (pid ${holder || "?"} dead)` : "forced";
        if (ctx.json) console.log(JSON.stringify({ lock: lockDir, holder: holder || null, cleared: true, reason: why }, null, 2));
        else ok(ctx, `lock cleared: ${lockDir}  (${why})`);
        return 0;
      } catch (e: any) {
        if (ctx.json) console.log(JSON.stringify({ error: `remove failed: ${e?.message || e}` }, null, 2));
        else bad(ctx, `remove failed: ${e?.message || e}`);
        return 1;
      }
    }
    case "snapshot": {
      // B5（PG §5 / 护栏④）：快照产物 = 文件 + sha256 + **脱敏来源**。
      // 来源字段只含 kind/host_db_basename/captured_at —— 绝不带 YGL_SESSION
      // （会话 id 是隐私面；快照会在归档/报告间流转）。
      const { createHash } = require("node:crypto");
      const bytes = fs.readFileSync(file);
      const sha = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      const snapDir = path.join(path.dirname(file), "verify", "snapshots");
      fs.mkdirSync(snapDir, { recursive: true });
      const target = path.join(snapDir, sha.replace(/^sha256:/, "") + ".sqlite");
      if (!fs.existsSync(target)) fs.copyFileSync(file, target);
      const outPath = args.flags.out !== undefined ? String(args.flags.out) : target;
      if (args.flags.out !== undefined) {
        // 显式 --out：落调用方指定路径（内容寻址副本身仍留在 snapshots/）
        fs.copyFileSync(file, outPath);
      }
      const payload = {
        path: outPath,
        sha256: sha,
        bytes: bytes.length,
        source: {
          kind: "sqlite-workspace",
          db_basename: path.basename(file), // 去目录、去会话
          captured_at: new Date().toISOString(),
        },
      };
      // 护栏④自检：payload 里不得出现会话 id / 凭证样式
      const blob = JSON.stringify(payload);
      if (/session-[0-9a-f]{8,}/.test(blob) || /(?:password|passwd|secret|token)\s*[:=]/i.test(blob)) {
        if (ctx.json) console.log(JSON.stringify({ error: "snapshot payload tripped the desensitization guard (session id or credential-shaped field)" }));
        else bad(ctx, "snapshot payload tripped the desensitization guard");
        return 2;
      }
      if (ctx.json) console.log(JSON.stringify(payload, null, 2));
      else ack(ctx, payload, `snapshot ${payload.sha256.slice(0, 19)}… (${(bytes.length / 1024).toFixed(1)} KB) at ${outPath}`);
      return 0;
    }
    case "stats": {
      const s = await env.asyncStore.stats();
      if (ctx.json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      head(ctx, "Database");
      // B7: PG 直连面无 SQLite 文件——dialect/url 代替 file/size。
      show(ctx, pgMode ? { dialect: "pg", url: String(process.env.YGL_DB_URL || lastFlagOf(args.flags.db)).replace(/\/\/[^@]*@/, "//"), ...s } : { file, size_kb: (fs.statSync(file).size / 1024).toFixed(1), ...s });
      return 0;
    }
    case "export-markdown": {
      // v2: auto-generated workspace report in markdown
      const lines: string[] = [];
      lines.push(`# ygl-trees Workspace Report`);
      lines.push(`> Generated: ${new Date().toISOString()}`);
      lines.push("");

      // Metrics
      const counts: Record<string, number> = {};
      for (const t of ["projects","sources","evidence","claims","kb_notes","skills","trees","nodes","artifacts","events"]) {
        try { counts[t] = (db.get(`SELECT COUNT(*) as n FROM ${t}`) as any)?.n || 0; } catch { counts[t] = 0; }
      }
      lines.push(`## Summary`);
      lines.push("");
      lines.push(`| Entity | Count |`);
      lines.push(`|---|---|`);
      const labels: Record<string,string> = {projects:"项目",sources:"来源",evidence:"证据",claims:"断言",kb_notes:"知识",skills:"技能",trees:"树",nodes:"节点",artifacts:"产出",events:"事件"};
      for (const [k,v] of Object.entries(counts)) lines.push(`| ${labels[k]||k} | ${v} |`);
      lines.push("");

      // Projects
      lines.push(`## Projects`);
      const projects = db.all("SELECT name, question, created FROM projects ORDER BY created DESC LIMIT 10") as any[];
      for (const p of projects) {
        lines.push(`- **${p.name}**: ${p.question || "(no question)"}`);
      }
      lines.push("");

      // Recent claims
      lines.push(`## Recent Claims`);
      const claims = db.all("SELECT text, status, confidence FROM claims ORDER BY created DESC LIMIT 10") as any[];
      for (const c of claims) {
        lines.push(`- [${c.status}] ${String(c.text).slice(0, 80)}... (${c.confidence})`);
      }
      lines.push("");

      // Knowledge
      lines.push(`## Knowledge Notes`);
      const kb = db.all("SELECT title, tags, confidence FROM kb_notes ORDER BY created DESC LIMIT 10") as any[];
      for (const k of kb) {
        lines.push(`- **${String(k.title).slice(0, 50)}** ${k.tags ? `(${k.tags})` : ""} [${k.confidence}]`);
      }
      lines.push("");

      // Trees
      lines.push(`## Trees`);
      const trees = db.all("SELECT name FROM trees") as any[];
      for (const t of trees) {
        const nodes = (db.get("SELECT COUNT(*) as n FROM nodes WHERE tree_id=(SELECT id FROM trees WHERE name=?)", [t.name]) as any)?.n || 0;
        lines.push(`- **${t.name}** (${nodes} nodes)`);
      }
      lines.push("");
      lines.push(`---`);
      lines.push(`*Auto-generated by ygl-trees db export-markdown*`);

      const md = lines.join("\n");
      const outPath = rest[0];
      if (outPath) {
        fs.writeFileSync(outPath, md);
        ok(ctx, `markdown report saved: ${outPath} (${md.length} chars)`);
      } else {
        if (ctx.json) { console.log(JSON.stringify({ markdown: md, chars: md.length }, null, 2)); return 0; }
        out(ctx, md);
      }
      return 0;
    }
    case "time-travel": {
      // v2: query workspace state at a past moment using entity created_at
      const when = rest[0];
      if (!when) {
        bad(ctx, 'usage: db time-travel "YYYY-MM-DD HH:MM" (or "YYYY-MM-DD")');
        return 2;
      }
      const ts = when.includes(" ") ? when : when + " 23:59:59";
      const tables = ["projects", "sources", "evidence", "claims", "kb_notes", "skills", "trees", "nodes", "artifacts", "events"];
      const counts: Record<string, number> = {};
      for (const t of tables) {
        try {
          const r = db.get(`SELECT COUNT(*) as n FROM ${t} WHERE created <= ?`, [ts]) as any;
          counts[t] = r?.n || 0;
        } catch { counts[t] = 0; }
      }
      // node unlock state at that time (via events)
      let unlockedAt = 0;
      try {
        const r = db.get(
          `SELECT COUNT(DISTINCT entity_id) as n FROM events WHERE kind='node.unlock' AND ts <= ?`, [ts]
        ) as any;
        unlockedAt = r?.n || 0;
      } catch { /* */ }
      if (ctx.json) { console.log(JSON.stringify({ timestamp: ts, counts, unlocked_nodes: unlockedAt }, null, 2)); return 0; }
      head(ctx, `Workspace at ${ts}`);
      const labels: Record<string, string> = {
        projects: "项目", sources: "来源", evidence: "证据", claims: "断言",
        kb_notes: "知识", skills: "技能", trees: "树", nodes: "节点",
        artifacts: "产出", events: "事件",
      };
      for (const [k, v] of Object.entries(counts)) {
        out(ctx, `  ${String(labels[k] || k).padEnd(6)} ${String(v).padStart(5)}`);
      }
      out(ctx, `  已解锁  ${String(unlockedAt).padStart(5)}`);
      return 0;
    }
    case "timeline": {
      // v2: workspace growth timeline — events per day with entity milestones
      // 0.81 ⑧: --actor <a> / --session <s> narrow the stream for multi-agent
      // reconciliation (actor column / payload.session); a filtered run also
      // shows a raw tail so 对账 doesn't need db sql.
      const actorF = String(args.flags.actor || "");
      const sessionF = String(args.flags.session || "");
      const conds: string[] = [];
      const params: any[] = [];
      if (actorF) { conds.push("actor=?"); params.push(actorF); }
      if (sessionF) { conds.push(`payload LIKE ?`); params.push(`%"session":"${sessionF}"%`); }
      const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
      const days = db.all(`
        SELECT date(ts) as day, COUNT(*) as events,
          SUM(CASE WHEN kind LIKE 'project%' THEN 1 ELSE 0 END) as projects,
          SUM(CASE WHEN kind LIKE 'source%' THEN 1 ELSE 0 END) as sources,
          SUM(CASE WHEN kind LIKE 'claim%' THEN 1 ELSE 0 END) as claims,
          SUM(CASE WHEN kind LIKE 'kb%' THEN 1 ELSE 0 END) as kb,
          SUM(CASE WHEN kind LIKE 'node%' THEN 1 ELSE 0 END) as nodes
        FROM events${where} GROUP BY date(ts) ORDER BY day
      `, params) as any[];
      if (!days.length) { ok(ctx, "no events yet"); return 0; }
      const tail = conds.length
        ? (db.all(`SELECT ts, actor, kind, entity_id FROM events${where} ORDER BY rowid DESC LIMIT 20`, params) as any[])
        : [];
      // F2 fix: --json outputs pure JSON (frozen contract ④)
      if (ctx.json) {
        console.log(JSON.stringify({ timeline: days, total: days.reduce((s2: number, d: any) => s2 + d.events, 0), ...(tail.length ? { tail } : {}) }, null, 2));
        return 0;
      }
      const maxEvents = Math.max(...days.map(d => d.events));
      head(ctx, `Workspace Timeline${actorF ? ` · actor=${actorF}` : ""}${sessionF ? ` · session=${sessionF}` : ""}`);
      let totalP = 0, totalS = 0, totalC = 0, totalK = 0, totalN = 0;
      for (const d of days) {
        totalP += d.projects; totalS += d.sources; totalC += d.claims;
        totalK += d.kb; totalN += d.nodes;
        const barLen = Math.round(d.events / maxEvents * 30);
        const bar = "█".repeat(barLen);
        const milestones: string[] = [];
        if (d.projects > 0) milestones.push(`+${d.projects}项目`);
        if (d.sources > 0) milestones.push(`+${d.sources}来源`);
        if (d.claims > 0) milestones.push(`+${d.claims}断言`);
        if (d.kb > 0) milestones.push(`+${d.kb}知识`);
        if (d.nodes > 0) milestones.push(`+${d.nodes}节点`);
        out(ctx, `  ${d.day} ${bar.padEnd(32)} ${String(d.events).padStart(5)} events  ${milestones.join(" ")}`);
      }
      out(ctx, "");
      out(ctx, paint(C.dim, `  累计: ${totalP}项目 · ${totalS}来源 · ${totalC}断言 · ${totalK}知识 · ${totalN}节点变更`, ctx.color));
      if (tail.length) {
        out(ctx, "");
        out(ctx, paint(C.dim, `  最近 ${tail.length} 条（按时间倒序）:`, ctx.color));
        for (const t of tail) out(ctx, `  ${String(t.ts).slice(0, 19)}  ${String(t.actor).padEnd(12)} ${String(t.kind).padEnd(14)} ${String(t.entity_id || "")}`);
      }
      return 0;
    }
    case "workspace": {
      // v2: multi-workspace management — each workspace is a YGL_HOME directory
      const sub = rest[0] || "list";
      const wsRoot = path.join(env.home, ".."); // parent of current workspace
      if (sub === "list") {
        const dirs = fs.existsSync(wsRoot) ? fs.readdirSync(wsRoot).filter((d: string) =>
          fs.existsSync(path.join(wsRoot, d, "ygl-trees.db"))
        ) : [];
        const cur = path.basename(env.home);
        head(ctx, "Workspaces (parent: " + wsRoot + ")");
        for (const d of dirs) {
          out(ctx, (d === cur ? "  * " : "    ") + d);
        }
        out(ctx, "");
        out(ctx, paint(C.dim, "  * = current | switch: YGL_HOME=<path> ygl-trees <cmd>", ctx.color));
        return 0;
      }
      if (sub === "create") {
        const name = rest[1];
        if (!name) { bad(ctx, "usage: db workspace create <name>"); return 2; }
        const dir = path.join(wsRoot, name);
        if (fs.existsSync(path.join(dir, "ygl-trees.db"))) {
          ok(ctx, `workspace already exists: ${name}`);
          return 0;
        }
        fs.mkdirSync(dir, { recursive: true });
        ok(ctx, `workspace created: ${dir}`);
        out(ctx, paint(C.dim, `  init: YGL_HOME=${dir} ygl-trees db init`, ctx.color));
        return 0;
      }
      bad(ctx, "usage: db workspace list | create <name>");
      return 2;
    }
    case "obsidian": {
      // v2 feature: export workspace as Obsidian-compatible markdown vault
      const outDir = rest[0] || path.join(env.home, "obsidian-export");
      fs.mkdirSync(path.join(outDir, "projects"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "knowledge"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "skills"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "trees"), { recursive: true });
      fs.mkdirSync(path.join(outDir, "claims"), { recursive: true });
      let count = 0;
      const safe = (t: string) => String(t).replace(/[\/:*?"<>|]/g, "_").slice(0, 50);
      for (const p of db.all("SELECT * FROM projects") as any[]) {
        fs.writeFileSync(path.join(outDir, "projects", safe(p.name) + ".md"),
          `---
type: project
id: ${p.id}
---

# ${p.name}

${p.question || ""}
`);
        count++;
      }
      for (const n of db.all("SELECT * FROM kb_notes") as any[]) {
        fs.writeFileSync(path.join(outDir, "knowledge", safe(n.title) + ".md"),
          `---
type: knowledge
tags: ${n.tags || ""}
confidence: ${n.confidence}
---

# ${n.title}

${n.body}
`);
        count++;
      }
      for (const sk of db.all("SELECT * FROM skills WHERE enabled=1") as any[]) {
        fs.writeFileSync(path.join(outDir, "skills", safe(sk.name) + ".md"),
          `---
type: skill
version: ${sk.version}
---

# ${sk.name}

${String(sk.body).slice(0, 500)}
`);
        count++;
      }
      for (const t of db.all("SELECT * FROM trees") as any[]) {
        const nodes = db.all("SELECT * FROM nodes WHERE tree_id=?", [t.id]) as any[];
        let c = `---
type: tree
---

# ${t.name} (${nodes.length} nodes)

`;
        for (const n of nodes) c += `- **${n.key}** (${n.kind}, tier ${n.tier})
`;
        fs.writeFileSync(path.join(outDir, "trees", safe(t.name) + ".md"), c);
        count++;
      }
      for (const cl of db.all("SELECT * FROM claims") as any[]) {
        const links = db.all("SELECT e.quote FROM claim_evidence ce JOIN evidence e ON ce.evidence_id=e.id WHERE ce.claim_id=?", [cl.id]) as any[];
        let c2 = `---
type: claim
status: ${cl.status}
confidence: ${cl.confidence}
---

# ${cl.id}

${cl.text}

## Evidence
`;
        for (const l of links) c2 += `- > ${String(l.quote).slice(0, 100)}
`;
        fs.writeFileSync(path.join(outDir, "claims", cl.id + ".md"), c2);
        count++;
      }
      ok(ctx, `obsidian vault exported: ${count} files → ${outDir}`);
      return 0;
    }
    case "export": {
      if (!rest[0]) {
        bad(ctx, "usage: db export <file.sql> [--lean]");
        return 2;
      }
      const dest = rest[0];
      // --lean: skip derived-table data (node_closure / node_index are
      // rebuilt by `node index`; their DDL still ships).
      const lean = args.flags.lean === true || args.flags.lean === "true";
      const skip = lean ? new Set(["node_closure", "node_index"]) : new Set<string>();
      // Order respects FK dependencies so the dump replays into a fresh db.
      const dataTables = [
        "meta", "config", "skills", "skill_refs", "projects", "queries", "sources", "query_sources", "evidence",
        "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links",
        "trees", "nodes", "node_edges", "node_closure", "node_conditions", "node_state", "node_index",
        "relations", "jobs", "runs", "events", "schema_migrations", "patrol_checks", "patrol_findings",
      ];
      const lines: string[] = [
        "-- ygl-trees full dump",
        "-- replay: sqlite3 new.db < dump.sql   (foreign_keys toggled below)",
        "PRAGMA foreign_keys=OFF;",
      ];
      // FTS5 shadow tables (skills_fts_data, …_idx, …) don't carry the
      // sqlite_ prefix; replaying their CREATE after CREATE VIRTUAL TABLE
      // would collide with the ones the virtual table creates itself.
      // DR 修单（总工席派）：影子表组仍排除，但 **CREATE VIRTUAL TABLE 本体必须随 dump**——
      // 否则回放后五张检索表不存在（external-content/常规 fts5 一致适用）。数据行随后
      // 由 fts 段补齐（常规 fts5 的行可以直接 INSERT 回去）。
      const FTS_TABLES = ["skills_fts", "sources_fts", "evidence_fts", "kb_fts", "nodes_fts"];
      const isShadow = (n: string) => FTS_TABLES.some((f) => n !== f && n.startsWith(f + "_"));
      const ftsDdl: string[] = [];
      for (const r of db.all(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
      )) {
        if (isShadow(r.name)) continue; // 影子组：虚拟表自建，重复 CREATE 会撞
        if ((FTS_TABLES as string[]).includes(r.name)) { ftsDdl.push(r.sql + ";"); continue; }
        lines.push(r.sql + ";");
      }
      const counts: string[] = [];
      for (const t of dataTables) {
        if (skip.has(t)) {
          counts.push(`${t}:skipped`);
          continue;
        }
        const rows = db.all(`SELECT * FROM ${t}`);
        for (const r of rows) {
          const cols = Object.keys(r);
          const vals = cols.map((c) => sqlLit(r[c])).join(",");
          lines.push(`INSERT OR REPLACE INTO ${t}(${cols.join(",")}) VALUES(${vals});`);
        }
        counts.push(`${t}:${rows.length}`);
      }
      // fts 段：虚拟表 DDL 在基表数据之后建（无 FK 依赖），数据行回填，
      // 保证往返后检索面可用（kbSearch/skillMatch/sourceSearch 等）。
      lines.push(...ftsDdl);
      for (const t of FTS_TABLES) {
        const rows = db.all(`SELECT * FROM ${t}`);
        for (const r of rows) {
          const cols = Object.keys(r);
          const vals = cols.map((c) => sqlLit(r[c])).join(",");
          lines.push(`INSERT OR REPLACE INTO ${t}(${cols.join(",")}) VALUES(${vals});`);
        }
        counts.push(`${t}:${rows.length}`);
      }
      lines.push("PRAGMA foreign_keys=ON;");
      // atomic: a truncated SQL dump restores as data loss — never half-write
      const { writeFileAtomic } = require("@deepseek-ai/dsh-atomic-write");
      return writeFileAtomic(dest, lines.join("\n") + "\n", {} as any).then((): number => {
        ack(ctx, { path: dest, bytes: fs.statSync(dest).size, tables: dataTables.length - skip.size }, `dumped to ${dest}`);
        if (!ctx.json) out(ctx, paint(C.dim, `  ${counts.join("  ")}`, ctx.color));
        return 0;
      });
    }
    case "reset": {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
      }
      ok(ctx, `removed ${file}`);
      return 0;
    }
    case "sql": {
      const sql = rest.join(" ");
      // 0.104.0 (batch nine P2): a bare `db sql` used to exit 0 silently,
      // which reads as "nothing matched" instead of "you forgot the statement".
      // The usage line also carries the id-vs-key refs that cost reviewers a
      // round trip: edge columns are integer ids, node text lives in nodes.key.
      if (!sql) {
        bad(
          ctx,
          'usage: db sql "<query>"   (refs are integer ids: edges.parent_id/child_id → nodes.id — join and alias nodes.key, e.g. SELECT n.key AS node_key FROM edges e JOIN nodes n ON n.id=e.parent_id)'
        );
        return 2;
      }
      // better-sqlite3 (single driver, #51) rejects .all() on statements that
      // return no data; the wasm driver used to return []. Keep the ad-hoc
      // power tool usable for INSERT/UPDATE/DELETE too.
      let rows: any[];
      try {
        rows = db.all(sql);
      } catch (e: any) {
        if (!/does not return data/i.test(String(e?.message || e))) throw e;
        const r = db.run(sql);
        rows = [{ changes: r.changes }];
      }
      table(ctx, rows);
      return 0;
    }
    case "dups": {
      // Rows sharing identical base content (incl. pre-v3 duplicates kept
      // alive by salted hashes during migration).
      const checks: Array<[string, string]> = [
        ["claims", "project_id || '|' || text"],
        ["queries", "project_id || '|' || text"],
        ["evidence", "source_id || '|' || quote"],
        ["kb_notes", "title || '|' || body"],
        ["jobs", "title"],
      ];
      const found: any[] = [];
      for (const [t, grp] of checks) {
        const rows = db.all(
          `SELECT ${grp} AS g, COUNT(*) AS c FROM ${t} GROUP BY g HAVING c>1 ORDER BY c DESC LIMIT 20`
        );
        for (const r of rows) found.push({ table: t, count: r.c, content: String(r.g).replace(/\s+/g, " ").slice(0, 70) });
      }
      if (ctx.json) {
        console.log(JSON.stringify(found, null, 2));
        return 0;
      }
      if (!found.length) {
        ok(ctx, "no duplicate content rows");
        return 0;
      }
      head(ctx, `Duplicate content (${found.length})`);
      table(ctx, found, ["table", "count", "content"], ["table", "count", "content"]);
      return 1;
    }
    case "sync": {
      if (rest[0] !== "pg") {
        bad(ctx, 'usage: db sync pg <url> [--tables a,b]   (url or env YGL_PG_URL)');
        return 2;
      }
      const url = rest[1] || process.env.YGL_PG_URL || "";
      if (!url) {
        bad(ctx, "missing postgres url — pass it or set YGL_PG_URL (keeps credentials out of shell history)");
        return 2;
      }
      const only = args.flags.tables ? String(args.flags.tables).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
      return syncToPg(db, url, only)
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify(r, null, 2));
            return 0;
          }
          ok(ctx, `mirrored ${r.tables.length} table(s) to PostgreSQL (${r.fulltext})`);
          out(ctx, paint(C.dim, `  ${r.server_version.split(" (")[0]}`, ctx.color));
          out(ctx, paint(C.dim, `  ${r.tables.map((t) => `${t.table}:${t.rows}`).join("  ")}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `sync failed: ${e?.message || e}`);
          return 1;
        });
    }
    case "migrate": {
      if (rest[0] !== "pg") {
        bad(ctx, "usage: db migrate pg <url> [--fresh]   (url or env YGL_PG_URL)");
        return 2;
      }
      const url = rest[1] || process.env.YGL_PG_URL || "";
      if (!url) {
        bad(ctx, "missing postgres url — pass it or set YGL_PG_URL");
        return 2;
      }
      const fresh = args.flags.fresh === true || args.flags.fresh === "true";
      return migrateToPg(db, url, fresh)
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify(r, null, 2));
            return 0;
          }
          ok(ctx, `migrated ${r.tables.length} table(s) into PostgreSQL — one-time, full fidelity`);
          out(ctx, paint(C.dim, `  ${r.server_version.split(" (")[0]} · FK ${r.constraints.fk} · UNIQUE ${r.constraints.unique} · ${r.fulltext}`, ctx.color));
          out(ctx, paint(C.dim, `  ${r.tables.map((t) => `${t.table}:${t.rows}`).join("  ")}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `migrate failed: ${e?.message || e}`);
          return 1;
        });
    }
    case "":
      out(ctx, paint(C.dim, "  db: init | stats | path | export [--lean] | sync pg <url> | migrate pg <url> [--fresh] | dups | reset | sql \"<sql>\"", ctx.color));
      return 0;
    default:
      out(ctx, paint(C.red, `  unknown db action: ${action}`, ctx.color));
      return 2;
  }
}

function sqlLit(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
