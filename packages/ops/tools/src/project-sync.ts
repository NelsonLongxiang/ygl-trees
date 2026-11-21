/** Explicit SQLite project replay. Planning never boots or migrates a workspace. */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SCHEMA_SQL, SCHEMA_VERSION, pidAlive, acquireLockAdmission } from "../../../core/database/src/db";
import type { Args, Ctx } from "../../../core/database/src/types";
import type { ScopedOrm } from "../../../core/database/src/scoped-orm";
import { emitJson, out } from "../../../core/text/src/fmt";
import { validateScope } from "../../../core/text/src/scope";
import { projectSyncStep, type ProjectSyncStep } from "../../../research/pipeline/src/writes";
const Native = require("better-sqlite3");
const tables = { project: "projects", source: "sources", evidence: "evidence", claim: "claims", link: "claim_evidence", supersession: "relations", resolution: "claims" } as const;
type Kind = keyof typeof tables;
type Row = Record<string, any>;
type Graph = Record<Kind, Row[]> & {
  skipped: Row[];
};
const fields: Record<Kind, string[]> = {
  project: ["name", "question", "inclusion", "exclusion", "status"],
  source: ["url", "title", "url_hash", "content_hash", "abstract", "content", "engine", "relevance", "confidence", "tags"],
  evidence: ["source_id", "quote", "note", "locator", "content_hash"],
  claim: ["text", "confidence", "channel", "content_hash", "scope"],
  link: ["stance"], supersession: ["src_type", "src_id", "dst_type", "dst_id", "rel", "weight"], resolution: ["status", "event"],
};
const kinds = Object.keys(tables) as Kind[];
const keys = (kind: Kind) => kind === "link" ? ["claim_id", "evidence_id"] : ["id"];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new Error(message); }
function image(home: string, owner?: string) {
  const file = join(realpathSync(home), "ygl-trees.db"), lock = file + ".ygllock";
  if (existsSync(join(dirname(file), "pg-binding.json")))
    fail("PG-bound home is not a SQLite copy: " + home);
  if (!existsSync(file) || !lstatSync(file).isFile())
    fail("missing workspace database: " + file);
  if (existsSync(lock) && (!owner || !existsSync(join(lock, "owner")) || readFileSync(join(lock, "owner"), "utf8") !== owner))
    fail("locked workspace: " + file);
  if (existsSync(file + "-journal") || (existsSync(file + "-wal") && statSync(file + "-wal").size > 0))
    fail("workspace has an active journal/WAL; close writers and checkpoint before sync: " + file);
  const bytes = readFileSync(file), detached = Buffer.from(bytes);
  // Only the detached checkpointed image changes header mode; source bytes remain untouched.
  detached[18] = 1;
  detached[19] = 1;
  const db = new Native(detached, { readonly: true });
  try {
    if (db.pragma("user_version", { simple: true }) !== SCHEMA_VERSION)
      fail("schema mismatch: " + file + "; upgrade explicitly before sync");
    if (db.prepare("SELECT 1 FROM meta WHERE key='backend_binding' AND value<>''").get())
      fail("PG-bound workspace is not a SQLite copy: " + file);
    if (hash(readFileSync(file)) !== hash(bytes))
      fail("workspace changed while reading: " + file);
    return { file: realpathSync(file), db, hash: hash(bytes), identity: statSync(file, { bigint: true }) };
  }
  catch (error) {
    db.close();
    throw error;
  }
}
type Image = ReturnType<typeof image>;
function distinct(a: Image, b: Pick<Image, "file" | "identity">) {
  if (a.file === b.file || (a.identity.ino !== 0n && a.identity.ino === b.identity.ino && a.identity.dev === b.identity.dev))
    fail("source and target are the same database");
}
function shape(db: any, table: string) {
  const ordered = (rows: Row[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const columns = ordered(db.prepare("PRAGMA table_xinfo(" + table + ")").all().map(({ cid, ...row }: Row) => row));
  const foreign = ordered(db.prepare("PRAGMA foreign_key_list(" + table + ")").all().map(({ id, ...row }: Row) => row));
  const unique = ordered(db.prepare("PRAGMA index_list(" + table + ")").all().filter((row: Row) => row.unique).map((row: Row) => ({ partial: row.partial, columns: db.prepare("SELECT name,coll,desc FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(row.name) })));
  return JSON.stringify({ columns, foreign, unique });
}
function compatible(source: Image, target: Image) {
  const expected = new Native(":memory:");
  try {
    expected.exec(SCHEMA_SQL);
    for (const table of new Set([...Object.values(tables), "events", "meta", "sources_fts", "evidence_fts"])) {
      const wanted = shape(expected, table);
      for (const image of [source, target])
        if (shape(image.db, table) !== wanted)
          fail("schema column/unique mismatch: " + table + " in " + image.file);
    }
  }
  finally {
    expected.close();
  }
}
function unchanged(snapshot: Image, owner?: string) {
  const current = image(dirname(snapshot.file), owner);
  try {
    if (current.file !== snapshot.file || current.identity.dev !== snapshot.identity.dev || current.identity.ino !== snapshot.identity.ino || current.hash !== snapshot.hash)
      fail("workspace changed before write: " + snapshot.file);
  }
  finally {
    current.db.close();
  }
}
function graph(db: any, name: string, required = false): Graph {
  const project = db.prepare("SELECT * FROM projects WHERE name=?").get(name), g: Graph = { project: [], source: [], evidence: [], claim: [], link: [], supersession: [], resolution: [], skipped: [] };
  if (!project) {
    if (required)
      fail("source project not found: " + name);
    return g;
  }
  if (project.status !== "active")
    fail("project is archived: " + name);
  g.project = [project];
  for (const kind of ["source", "evidence", "claim"] as const)
    g[kind] = db.prepare("SELECT * FROM " + tables[kind] + " WHERE project_id=? ORDER BY id").all(project.id);
  const ids = (kind: Kind) => new Set(g[kind].map(row => row.id)), sources = ids("source"), evidence = ids("evidence"), claims = ids("claim");
  for (const row of g.evidence)
    if (!sources.has(row.source_id))
      fail("evidence source outside project: " + row.id);
  for (const row of g.claim)
    try {
      validateScope(row.scope);
    }
    catch {
      fail("invalid persisted claim scope: " + row.id);
    }
  g.link = db.prepare("SELECT ce.* FROM claim_evidence ce JOIN claims c ON c.id=ce.claim_id WHERE c.project_id=? ORDER BY ce.claim_id,ce.evidence_id").all(project.id);
  for (const row of g.link)
    if (!evidence.has(row.evidence_id) || !["supports", "refutes"].includes(row.stance))
      fail("claim evidence outside project or invalid stance: " + row.claim_id);
  const internal = (type: string, id: string) => type === "claim" && claims.has(id);
  const relations = db.prepare("SELECT * FROM relations ORDER BY id").all().filter((row: Row) => internal(row.src_type, row.src_id) || internal(row.dst_type, row.dst_id));
  for (const row of relations) {
    if (internal(row.src_type, row.src_id) && internal(row.dst_type, row.dst_id))
      g.supersession.push(row);
    else
      g.skipped.push({ id: row.id, rel: row.rel, src: row.src_type + ":" + row.src_id, dst: row.dst_type + ":" + row.dst_id, reason: "endpoint outside project claims" });
  }
  const next = new Map<string, string>();
  for (const row of relations.filter((row: Row) => row.rel === "superseded-by" && row.src_type === "claim" && row.dst_type === "claim")) {
    if (!claims.has(row.src_id) || !claims.has(row.dst_id) || next.has(row.src_id))
      fail("invalid superseded-by endpoints: " + row.src_id);
    next.set(row.src_id, row.dst_id);
  }
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let id: string | undefined = start;
    while (id) {
      if (seen.has(id))
        fail("superseded-by cycle: " + start);
      seen.add(id);
      id = next.get(id);
    }
  }
  const events = db.prepare("SELECT e.* FROM events e JOIN claims c ON c.id=e.entity_id WHERE c.project_id=? AND e.entity='claim' AND e.kind IN ('claim.resolve','claim.unresolve') ORDER BY e.ts,e.rowid").all(project.id), latest = new Map<string, Row>();
  for (const event of events)
    latest.set(event.entity_id, event);
  g.resolution = g.claim.map(row => {
    const event = latest.get(row.id);
    if (!["unverified", "supported", "refuted", "contested"].includes(row.status))
      fail("invalid claim status: " + row.id);
    if (event?.kind === "claim.resolve" && String(event.payload).split(/[\s|]/)[0] !== row.status)
      fail("claim resolution disagrees with current status: " + row.id);
    return { id: row.id, status: row.status, updated: row.updated, event: event ? { kind: event.kind, payload: event.payload } : undefined };
  });
  return g;
}
function signature(kind: Kind, row: Row) { return JSON.stringify([...keys(kind), ...fields[kind]].map(key => row[key] ?? null)); }
function proof(g: Graph) { return { counts: Object.fromEntries(kinds.map(kind => [kind, g[kind].length])), hash: hash(JSON.stringify(kinds.map(kind => g[kind].map(row => signature(kind, row))))) }; }
type Step = ProjectSyncStep & {
  source_id: string;
  action: "add" | "duplicate";
};
const stepRef = (step: Step) => ({ kind: step.kind, source_id: step.source_id, target_id: step.row.id ?? step.row.claim_id });
function plan(a: Graph, b: Graph, target: any): Step[] {
  const steps: Step[] = [];
  for (const kind of kinds) {
    const key = (row: Row) => JSON.stringify(keys(kind).map(key => row[key])), expected = new Set(a[kind].map(key));
    if (expected.size !== a[kind].length)
      fail("non-unique source mapping: " + kind);
    if (b[kind].some(row => !expected.has(key(row))))
      fail("target has extra/identity conflict: " + kind + "; no overwrite");
    const current = new Map(b[kind].map(row => [key(row), row]));
    for (const row of a[kind]) {
      const existing = current.get(key(row)), same = existing && signature(kind, row) === signature(kind, existing);
      if (existing && !same && !(kind === "resolution" && existing.status === "unverified" && !existing.event))
        fail(kind + " conflict (including scope/metadata): " + key(row));
      if (!existing && kind !== "resolution" && kind !== "link" && target.prepare("SELECT 1 FROM " + tables[kind] + " WHERE id=?").get(row.id))
        fail(kind + " identity conflict: " + row.id);
      const payload = kind === "claim" ? { ...row, status: "unverified" } : kind === "resolution" ? { id: row.id, status: row.status, updated: row.updated } : row;
      steps.push({ kind, table: tables[kind], row: payload, key: keys(kind), source_id: row.id ?? row.claim_id + "/" + row.evidence_id, action: same ? "duplicate" : "add", event: kind === "resolution" ? row.event : undefined });
    }
  }
  return steps;
}
function abandoned(file: string, task: string) {
  const dir = file + ".ygllock";
  try {
    const owner = readFileSync(join(dir, "owner"), "utf8"), pid = readFileSync(join(dir, "pid"), "utf8").trim();
    if (owner && /^[1-9][0-9]*$/.test(pid) && !pidAlive(pid) && readFileSync(join(dir, "sync"), "utf8") === task)
      return owner;
  }
  catch { /* An unreadable owner is not eligible for recovery. */ }
  fail("locked workspace: resume requires the same sync task and a confirmed dead owner");
}
export async function runProjectSync(ctx: Ctx, args: Args, createOwner: (file: string) => ScopedOrm): Promise<number> {
  let source: Image | undefined, target: Image | undefined, owner: ScopedOrm | undefined, lock: string | undefined, recovery: string | undefined, recoveryToken: string | undefined, token: string | undefined, result: any, rc = 0;
  const completed: Row[] = [];
  const claimLock = (file: string, task: string) => {
    token = randomUUID();
    const dir = file + ".ygllock";
    try {
      mkdirSync(dir);
    }
    catch {
      fail("locked target workspace: " + file);
    }
    lock = dir;
    for (const [key, value] of [["owner", token], ["pid", String(process.pid)], ["cmd", "project sync"], ["sync", task]])
      writeFileSync(join(dir, key), value, { flag: "wx" });
  };
  try {
    const flags = args.flags, allowed = ["home", "to", "json", "dry-run", "verify", "resume", "quiet", "no-color", "no-colour"];
    if (args._.length !== 3 || !args._[2] || Object.keys(flags).some(key => !allowed.includes(key)) || [flags.home, flags.to].some(value => typeof value !== "string" || !value.trim()) || ["dry-run", "verify", "resume"].some(key => flags[key] !== undefined && flags[key] !== true) || [flags["dry-run"], flags.verify, flags.resume].filter(Boolean).length > 1)
      throw Object.assign(new Error("usage: project sync <name> --home <source-home> --to <target-home> [--dry-run|--verify|--resume] [--json]"), { rc: 2 });
    if (process.env.YGL_DB_URL || process.env.YGL_PG_URL)
      throw Object.assign(new Error("project sync accepts explicit SQLite homes only; unset YGL_DB_URL/YGL_PG_URL"), { rc: 2 });
    const from = flags.home as string, to = flags.to as string, name = args._[2];
    for (const [kind, home] of [["source", from], ["target", to]])
      if (!existsSync(home))
        fail("missing " + kind + " home: " + home);
    source = image(resolve(from));
    const task = hash(JSON.stringify([source.file, source.hash, realpathSync(to), name])), targetFile = join(realpathSync(to), "ygl-trees.db");
    const stale = flags.resume && existsSync(targetFile + ".ygllock") ? abandoned(targetFile, task) : undefined;
    if (stale) {
      const identity = statSync(targetFile, { bigint: true });
      distinct(source, { file: realpathSync(targetFile), identity });
      const gate = acquireLockAdmission(targetFile, task), guard = gate.dir;
      recovery = guard;
      recoveryToken = gate.token;
      if (abandoned(targetFile, task) !== stale)
        fail("sync lock ownership changed before resume");
      const check = new Native(targetFile, { readonly: true, fileMustExist: true, timeout: 0 });
      try {
        if (check.pragma("user_version", { simple: true }) !== SCHEMA_VERSION)
          fail("schema mismatch in interrupted target");
        if (check.prepare("SELECT 1 FROM meta WHERE key='backend_binding' AND value<>''").get())
          fail("PG-bound target cannot resume");
        compatible(source, { file: targetFile, db: check } as Image);
        plan(graph(source.db, name, true), graph(check, name), check);
      }
      finally {
        check.close();
      }
      renameSync(targetFile + ".ygllock", join(guard, "previous"));
      claimLock(targetFile, task);
      const recover = new Native(targetFile, { fileMustExist: true, timeout: 0 });
      try {
        if (recover.pragma("wal_checkpoint(TRUNCATE)")[0].busy)
          fail("target recovery checkpoint is busy");
      }
      finally {
        recover.close();
      }
    }
    target = image(resolve(to), token);
    distinct(source, target);
    compatible(source, target);
    const a = graph(source.db, name, true), b = graph(target.db, name), steps = plan(a, b, target.db), expected = proof(a);
    let actual = proof(b);
    const mode = flags["dry-run"] ? "dry-run" : flags.verify ? "verify" : "sync";
    const envelope = () => ({ contract: "ygl-project-sync/1", mode, project: name, source: source!.file, target: target!.file, steps: steps.map(step => ({ ...stepRef(step), action: step.action })), written: completed.length, skipped: a.skipped, skipped_count: a.skipped.length, verify: { ok: expected.hash === actual.hash, source: expected, target: actual } });
    if (mode === "dry-run")
      result = envelope();
    else if (mode === "verify" || (!stale && steps.every(step => step.action === "duplicate"))) {
      if (expected.hash !== actual.hash)
        fail("project sync verification mismatch");
      result = envelope();
    }
    else {
      if (!lock) {
        const gate = acquireLockAdmission(target.file, task);
        recovery = gate.dir;
        recoveryToken = gate.token;
        claimLock(target.file, task);
        gate.release();
        recovery = undefined;
        recoveryToken = undefined;
      }
      unchanged(source);
      unchanged(target, token);
      owner = createOwner(target.file);
      const ds = await owner.getOrm(target.file), version = (await ds.query("PRAGMA data_version"))[0].data_version;
      unchanged(source);
      unchanged(target, token);
      for (const step of steps)
        if (step.action === "add") {
          await projectSyncStep(ds, step, async (mgr) => { if ((await mgr.query("PRAGMA data_version"))[0].data_version !== version)
            fail("target workspace changed between replay transactions"); });
          completed.push(stepRef(step));
        }
      await owner.close();
      owner = undefined;
      target.db.close();
      target = undefined;
      target = image(resolve(to), token);
      unchanged(source);
      actual = proof(graph(target.db, name));
      if (expected.hash !== actual.hash)
        fail("project sync verification mismatch after committed prefix");
      result = envelope();
    }
  }
  catch (error: any) {
    rc = error.rc === 2 ? 2 : 1;
    result = { error: String(error.message ?? error), ...(completed.length ? { partial: { written: completed.length, completed, rerunnable: true } } : {}) };
  }
  finally {
    const failures: string[] = [];
    for (const close of [() => owner?.close(), () => source?.db.close(), () => target?.db.close()])
      try {
        await close();
      }
      catch (error: any) {
        failures.push(error.message);
      }
    for (const [dir, expected] of [[lock, token], [recovery, recoveryToken]])
      if (dir)
        try {
          if (readFileSync(join(dir, "owner"), "utf8") !== expected)
            throw new Error("sync lock ownership changed");
        }
        catch (error: any) {
          failures.push(error.message);
        }
    for (const dir of [lock, recovery])
      if (dir && !failures.length)
        try {
          rmSync(dir, { recursive: true });
        }
        catch (error: any) {
          failures.push(error.message);
        }
    if (failures.length) {
      rc = 1;
      result = { error: (result?.error ? result.error + "; " : "") + "project sync cleanup failed: " + failures.join("; "), partial: { written: completed.length, completed, rerunnable: false, recovery_required: true } };
    }
  }
  if (ctx.json)
    emitJson(ctx, result, 2);
  else
    out(ctx, JSON.stringify(result, null, 2));
  return rc;
}
