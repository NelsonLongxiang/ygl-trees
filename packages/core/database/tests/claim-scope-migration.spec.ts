import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { DB, SCHEMA_SQL, SCHEMA_VERSION } from "../src/db";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe("claims.scope schema16 migration", () => {
  it("adds a non-null empty grant to populated v15 data without changing claims or audit history", () => {
    mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); const root = mkdtempSync(join(process.cwd(), "tmp/claim-scope-v15-")); roots.push(root);
    const file = join(root, "workspace.db"), native = new Sqlite(file);
    let before: unknown;
    try {
      const v15 = SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS claims \([\s\S]*?\n\);/, block => block.replace(/^.*\bscope\s+TEXT.*\n/gim, ""));
      native.exec(v15); native.pragma("user_version=15");
      expect(native.prepare("PRAGMA table_info(claims)").all().map((c: any) => c.name)).not.toContain("scope");
      native.prepare("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')").run();
      native.prepare("INSERT INTO claims(id,project_id,text,status,confidence,channel,content_hash,created,updated) VALUES('c','p','ruling','contested','A','review','hash','old','old')").run();
      native.prepare("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES('e','old','actor','claim.resolve','claim','c','original','warn')").run();
      before = { claims: native.prepare("SELECT * FROM claims").all(), events: native.prepare("SELECT * FROM events").all() };
    } finally { native.close(); }
    const db = new DB(file, { managed: true });
    try {
      expect(SCHEMA_VERSION).toBe(16); expect(db.get("PRAGMA user_version")).toEqual({ user_version: 16 });
      expect(db.all("PRAGMA table_info(claims)").find((c: any) => c.name === "scope")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "''" });
      const { scope, ...claim } = db.get("SELECT * FROM claims WHERE id='c'") as any;
      expect(scope).toBe(""); expect({ claims: [claim], events: db.all("SELECT * FROM events") }).toEqual(before);
      expect(() => db.run("UPDATE claims SET scope=NULL WHERE id='c'")).toThrow(/NOT NULL/);
    } finally { db.closeStrict(); }
    const reopened = new DB(file, { managed: true });
    try { expect(reopened.get("SELECT scope FROM claims WHERE id='c'")).toEqual({ scope: "" }); expect(reopened.get("PRAGMA user_version")).toEqual({ user_version: 16 }); }
    finally { reopened.closeStrict(); }
  });
});
