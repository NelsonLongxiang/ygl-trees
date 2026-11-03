import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const ROOT = resolve(__dirname, "../../../.."), BIN = join(ROOT, "dist/bundle/bin.cjs");
let home = "", source = "", empty = "";
function cli(args: string[], rc = 0) {
 const env = { ...process.env, YGL_HOME: home, YGL_SESSION: "quote-check-160", YGL_TEST: "1", YGL_EVAL_OFFLINE: "1", YGL_NO_UPDATE_CHECK: "1" };
 for(const key of ["YGL_DB_URL", "YGL_PG_URL", "YGL_PROJECT", "YGL_DB"]) delete env[key];
 const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: home, env, encoding: "utf8", timeout: 30000 });
 expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status, r.stdout + r.stderr).toBe(rc);
 return JSON.parse(r.stdout);
}
function dbRows(sql: string, params: any[] = []) { const db = new DatabaseSync(join(home, "ygl-trees.db"), { readOnly: true }); try { return db.prepare(sql).all(...params); } finally { db.close(); } }
const snapshot = () => ({ evidence: dbRows("SELECT * FROM evidence ORDER BY id"), fts: dbRows("SELECT * FROM evidence_fts ORDER BY id"), events: dbRows("SELECT * FROM events WHERE kind='evidence.add' ORDER BY id") });
function batch(lines: any[]) { const file = join(home, "quotes-" + Math.random().toString(16).slice(2) + ".jsonl"); writeFileSync(file, lines.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("\n")); return file; }
beforeAll(() => {
 mkdirSync(join(ROOT,"tmp"), { recursive: true }); home=mkdtempSync(join(ROOT,"tmp/quote-160-"));
 cli(["db","init"]); cli(["project","new","quotes"]);
 source=cli(["research","source","add","--title","Stored original","--url","session://quote-original","--content","The quick  brown\nfox jumps. exact fragment. first batch fragment; last batch fragment; duplicate fragment; ＡＢＣ is not ABC."]).id;
 empty=cli(["research","source","add","--title","Unstored original","--url","session://quote-empty"]).id;
},120000);
afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
describe("#160 evidence quote verification",()=>{
 it("rejects a mismatch with one source-named runtime error and zero side effects",()=>{
  const before=snapshot(),r=cli(["research","evidence","add",source,"--quote","a sentence absent from this source"],1);
  expect(Object.keys(r)).toEqual(["error"]);expect(r.error).toContain(source);expect(r.error).toMatch(/quote/);expect(snapshot()).toEqual(before);
 });
 it("accepts a verbatim fragment and reports checked status",()=>{
  const r=cli(["research","evidence","add",source,"--quote","exact fragment."]);expect(r.quote_verified).toBe(true);expect(r.quote).toBe("exact fragment.");
 });
 it("collapses whitespace without rewriting the submitted quote",()=>{
  const quote="  quick\t brown fox  ";const r=cli(["research","evidence","add",source,"--quote",quote]);expect(r).toMatchObject({quote,quote_verified:true});
 });
 it("preserves checked status on duplicate receipts without a second event",()=>{
  const args=["research","evidence","add",source,"--quote","duplicate fragment"];
  const a=cli(args),b=cli(args);expect(b).toMatchObject({id:a.id,duplicate:true,quote_verified:true});
  expect(dbRows("SELECT id FROM events WHERE kind='evidence.add' AND entity_id=?",[a.id])).toHaveLength(1);
 });
 it("allows unstored source content but marks the result unchecked",()=>{
  const r=cli(["research","evidence","add",empty,"--quote","Original text has not been stored."]);expect(r.quote_verified).toBe(false);
 });
 it("does not treat --force as a quote-check bypass",()=>{
  const before=snapshot();expect(cli(["research","evidence","add",source,"--quote","forced absent quote","--force"],1).error).toContain(source);expect(snapshot()).toEqual(before);
 });
 it("--unverified explicitly permits a translation and records bypass in evidence.add",()=>{
  const r=cli(["research","evidence","add",source,"--quote","Deliberate translation, not an original quotation.","--unverified"]);expect(r.quote_verified).toBe(false);
  const events=dbRows("SELECT payload FROM events WHERE kind='evidence.add' AND entity_id=?",[r.id]);expect(events).toHaveLength(1);expect(JSON.parse(String(events[0].payload))).toMatchObject({unverified:true,quote_verified:false,source_id:source});
 });
 it("bypass never claims verification even when the text matches",()=>{
  const r=cli(["research","evidence","add",source,"--quote","The quick","--unverified"]);expect(r.quote_verified).toBe(false);
 });
 it("does not silently use NFKC or case-insensitive matching",()=>{
  for(const quote of ["ABC is not ABC.","the quick"]){expect(cli(["research","evidence","add",source,"--quote",quote],1).error).toContain(source);}
 });
 it("batch mismatch names the physical JSONL line and rolls every row back",()=>{
  const file=batch([{source_id:source,quote:"first batch fragment"},"",{source_id:source,quote:"batch absent phrase"}]);const before=snapshot();
  const r=cli(["research","evidence","add","--batch",file],1);expect(r.error).toContain("line 3");expect(r.error).toContain(source);expect(snapshot()).toEqual(before);
 });
 it("successful and bypassed batch rows expose checked status individually",()=>{
  const file=batch([{source_id:source,quote:"first batch fragment"},{source_id:empty,quote:"unchecked batch row"}]);const r=cli(["research","evidence","add","--batch",file]);
  expect(r.rows.map((row:any)=>row.quote_verified)).toEqual([true,false]);
  const bypass=batch([{source_id:source,quote:"explicitly bypassed batch phrase"}]);const b=cli(["research","evidence","add","--batch",bypass,"--unverified"]);expect(b.rows[0].quote_verified).toBe(false);
 });
 it("does not recheck existing evidence when its source content later changes",()=>{
  const src=cli(["research","source","add","--title","mutable source","--url","session://mutable-quote","--content","initial original"]);
  const first=cli(["research","evidence","add",src.id,"--quote","initial original"]);expect(first.quote_verified).toBe(true);
  const db=new DatabaseSync(join(home,"ygl-trees.db"));try{db.prepare("UPDATE sources SET content=? WHERE id=?").run("replacement content",src.id);}finally{db.close();}
  const before=snapshot();expect(cli(["research","evidence","add",src.id,"--quote","initial original"])).toMatchObject({id:first.id,duplicate:true,quote_verified:true});expect(snapshot()).toEqual(before);
 });
 it("legacy duplicate evidence is returned unchecked without retroactive validation",()=>{
  const src=cli(["research","source","add","--title","legacy source","--url","session://legacy-quote","--content","legacy phrase"]);
  const first=cli(["research","evidence","add",src.id,"--quote","legacy phrase"]);
  const db=new DatabaseSync(join(home,"ygl-trees.db"));try{db.prepare("UPDATE events SET payload=? WHERE kind='evidence.add' AND entity_id=?").run("legacy plain payload",first.id);db.prepare("UPDATE sources SET content=? WHERE id=?").run("changed source",src.id);}finally{db.close();}
  expect(cli(["research","evidence","add",src.id,"--quote","legacy phrase"])).toMatchObject({id:first.id,duplicate:true,quote_verified:false});
 });
 it("generic event feed and SQL export preserve legacy strings and versioned audit JSON",()=>{
  const src=cli(["research","source","add","--title","mixed event source","--url","session://mixed-event","--content","legacy retained and new retained"]);
  const legacy=cli(["research","evidence","add",src.id,"--quote","legacy retained"]);
  const db=new DatabaseSync(join(home,"ygl-trees.db"));try{db.prepare("UPDATE events SET payload=? WHERE kind='evidence.add' AND entity_id=?").run("legacy plain payload",legacy.id);}finally{db.close();}
  const fresh=cli(["research","evidence","add",src.id,"--quote","new retained"]);
  const rows=dbRows("SELECT entity_id,payload FROM events WHERE kind='evidence.add' AND entity_id IN (?,?)",[legacy.id,fresh.id]);
  expect(rows.find((r:any)=>r.entity_id===legacy.id)?.payload).toBe("legacy plain payload");
  expect(JSON.parse(String(rows.find((r:any)=>r.entity_id===fresh.id)?.payload))).toMatchObject({payload_version:1,evidence_id:fresh.id,source_id:src.id,quote_verified:true,unverified:false});
  const feed=cli(["agent","log","--limit","100"]);expect(feed).toBeInstanceOf(Array);
  const file=join(home,"mixed-events.sql");cli(["db","export",file]);const dump=readFileSync(file,"utf8");
  expect(dump).toContain("legacy plain payload");expect(dump).toContain('"payload_version":1');expect(dump).toContain('"evidence_id":"'+fresh.id+'"');
 });
 it("rejects value-bearing bypass options as usage errors",()=>{
  for(const flags of [["--unverified=maybe"],["--unverified", "no"]])expect(cli(["research","evidence","add",source,"--quote","absent",...flags],2).error).toContain("--unverified");
 });
 it("batch --unverified=false is not a bypass",()=>{
  const before=snapshot(),file=batch([{source_id:source,quote:"not a literal phrase"}]);expect(cli(["research","evidence","add","--batch",file,"--unverified=false"],1).error).toContain(source);expect(snapshot()).toEqual(before);
 });
});
