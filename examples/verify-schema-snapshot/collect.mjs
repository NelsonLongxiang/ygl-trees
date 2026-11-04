#!/usr/bin/env node
/** Collect table metadata from a quiescent SQLite snapshot into a separate evidence DB (Node >=24). */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function requireStandalone(path) {
  for (const suffix of ["-wal", "-journal"]) {
    if (existsSync(path + suffix) && statSync(path + suffix).size > 0) {
      throw new Error("source must be a quiescent standalone snapshot (nonempty WAL/journal found)");
    }
  }
}

export function collectSchema(sourcePath, outputPath) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  if (!statSync(source).isFile()) throw new Error("source must be an existing SQLite file");
  const pathKey = path => process.platform === "win32" ? path.toLowerCase() : path;
  if (["", "-wal", "-shm", "-journal"].some(suffix => pathKey(output) === pathKey(source + suffix))) {
    throw new Error("output must not be the source or one of its SQLite sidecars");
  }
  if (existsSync(output)) throw new Error("output already exists; choose a new evidence snapshot path");
  requireStandalone(source);
  const before = hash(source);
  const input = new DatabaseSync(source, { readOnly: true });
  let target, reserved = false;
  try {
    input.exec("PRAGMA query_only=ON; BEGIN");
    // Fixed read-only queries only. Table names are bound values, never SQL fragments; views are not executed.
    const tables = input.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE BINARY").all();
    const tableInfo = input.prepare("SELECT cid,name,type,\"notnull\" AS not_null,dflt_value,pk FROM pragma_table_info(?) ORDER BY cid");
    const columns = tables.flatMap(table => tableInfo.all(table.name).map(column => ({ table_name: table.name, ...column })));
    const userVersion = input.prepare("PRAGMA user_version").get().user_version;
    input.exec("COMMIT");
    requireStandalone(source);
    if (hash(source) !== before) throw new Error("source changed while collecting metadata; retry from a frozen snapshot");
    closeSync(openSync(output, "wx")); reserved = true;
    target = new DatabaseSync(output);
    target.exec("BEGIN; CREATE TABLE schema_tables(table_name TEXT PRIMARY KEY); CREATE TABLE schema_columns(table_name TEXT NOT NULL,cid INTEGER NOT NULL,column_name TEXT NOT NULL,declared_type TEXT NOT NULL,not_null INTEGER NOT NULL,default_sql TEXT,pk_order INTEGER NOT NULL,PRIMARY KEY(table_name,cid)); CREATE TABLE collection_source(source_sha256 TEXT NOT NULL,user_version INTEGER NOT NULL,captured_at TEXT NOT NULL)");
    const putTable = target.prepare("INSERT INTO schema_tables VALUES(?)");
    const putColumn = target.prepare("INSERT INTO schema_columns VALUES(?,?,?,?,?,?,?)");
    for (const table of tables) putTable.run(table.name);
    for (const column of columns) putColumn.run(column.table_name, column.cid, column.name, column.type, column.not_null, column.dflt_value, column.pk);
    target.prepare("INSERT INTO collection_source VALUES(?,?,?)").run("sha256:" + before, userVersion, new Date().toISOString());
    target.exec("COMMIT");
    return { probe_sha256: "sha256:" + hash(fileURLToPath(import.meta.url)), platform: process.platform + "-" + process.arch, runtime: process.version, package_manager: "none (Node standard library example)", identity: "schema-snapshot-example" };
  } catch (error) {
    // Only the exclusively reserved output belongs to this invocation; never delete a pre-existing file.
    target?.close(); target = undefined;
    if (reserved) rmSync(output);
    throw error;
  } finally {
    input.close(); target?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("usage: node examples/verify-schema-snapshot/collect.mjs <standalone-source.sqlite> <new-evidence.sqlite>");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(collectSchema(process.argv[2], process.argv[3]))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
