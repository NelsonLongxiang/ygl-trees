import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { DB } from "../../../core/database/src/db";
import { parse } from "../../../core/database/src/types";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import { runProjectSync } from "../src/project-sync";
const repo=resolve(__dirname,"../../../.."),bin=join(repo,"dist/bundle/bin.cjs"),project="copy project's rulings";
let root:string,source:string,target:string;
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
function native<T>(home:string,fn:(db:any)=>T):T {const db=new Sqlite(join(home,"ygl-trees.db"));try{return fn(db);}finally{db.close();}}
function snapshot(home:string):unknown {if(!existsSync(home))return null;return readdirSync(home,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const path=join(e.parentPath,e.name),s=statSync(path);return {path:path.slice(home.length),bytes:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs,hash:hash(readFileSync(path))};}).sort((a,b)=>a.path.localeCompare(b.path));}
function cli(extra:string[]=[],rc=0,from=source,to=target) {
 const p=spawnSync(process.execPath,[bin,"project","sync",project,"--home",from,"--to",to,...extra,"--json"],{cwd:repo,encoding:"utf8",timeout:60000,env:{...process.env,YGL_HOME:join(root,"default-must-not-open"),YGL_DB_URL:"",YGL_PG_URL:"",YGL_PROJECT:"unrelated-session",YGL_NO_UPDATE_CHECK:"1"}});
 expect(p.error).toBeUndefined();expect(p.signal).toBeNull();expect(p.status,p.stdout+p.stderr).toBe(rc);const row=JSON.parse(p.stdout);if(rc)expect(row.error).toBeTypeOf("string");return row;
}
beforeEach(()=>{
 mkdirSync(join(repo,"tmp"),{recursive:true});root=mkdtempSync(join(repo,"tmp/project-sync-"));source=join(root,"source");target=join(root,"target");
 for(const home of [source,target]){const db=new DB(join(home,"ygl-trees.db"),{managed:true});db.closeStrict();}
 native(source,db=>{
  db.prepare("INSERT INTO projects(id,name,question,created,updated) VALUES('p',?,'copy rulings','old','old')").run(project);
  for(const [id,title]of [["s1","first source"],["s2","second source"]])db.prepare("INSERT INTO sources(id,project_id,url,title,url_hash,content_hash,content,created,retrieved_at) VALUES(?,'p',?,?,?,?,?,'old','old')").run(id,"https://example.test/"+id,title,"url-"+id,"source-"+id,"quotes "+id);
  for(const [id,s]of [["e1","s1"],["e2","s2"],["e3","s1"]])db.prepare("INSERT INTO evidence(id,project_id,source_id,quote,note,locator,content_hash,created) VALUES(?,'p',?,?,?,'section',?,'old')").run(id,s,"quote "+id,"note "+id,"ev-"+id);
  for(const [id,text,status,scope]of [["c1","ruling one","refuted","restricted"],["c2","ruling two","contested","dept:ops"],["c3","ruling three","supported",""]])db.prepare("INSERT INTO claims(id,project_id,text,status,scope,content_hash,created,updated) VALUES(?,'p',?,?,?,?, 'old','old')").run(id,text,status,scope,"claim-"+id);
  for(const [c,e,stance]of [["c1","e1","refutes"],["c2","e1","supports"],["c2","e2","refutes"],["c3","e3","supports"]])db.prepare("INSERT INTO claim_evidence VALUES(?,?,?)").run(c,e,stance);
  for(const [id,a,b]of [["r1","c1","c2"],["r2","c2","c3"]])db.prepare("INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight,created) VALUES(?,'claim',?,'claim',?,'superseded-by',1,'old')").run(id,a,b);
  for(const [id,c,status]of [["event1","c1","refuted"],["event2","c2","contested"]])db.prepare("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,'2026-01-01','reviewer','claim.resolve','claim',?,?,'info')").run(id,c,status+" | original ruling");
 });
});
afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
describe("supported SQLite project sync",()=>{
 it("plans with truly read-only source and target, including absent project and a live source-copy snapshot",()=>{
  const a=snapshot(source),b=snapshot(target),plan=cli(["--dry-run"]);
  expect(plan).toMatchObject({contract:"ygl-project-sync/1",mode:"dry-run",project});expect(plan.steps.some((s:any)=>s.kind==="source"&&s.action==="add")).toBe(true);
  expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);expect(existsSync(join(root,"default-must-not-open"))).toBe(false);
 });
 it("replays all materials, stance, refuted/contested rulings, scope and a three-claim replacement chain",()=>{
  const a=snapshot(source),result=cli();expect(result.verify).toMatchObject({ok:true});expect(result.verify.source.hash).toBe(result.verify.target.hash);expect(result.steps.every((s:any)=>s.action==="add")).toBe(true);
  const kinds=result.steps.map((s:any)=>s.kind);expect(kinds.indexOf("source")).toBeLessThan(kinds.indexOf("evidence"));expect(kinds.indexOf("evidence")).toBeLessThan(kinds.indexOf("claim"));expect(kinds.lastIndexOf("link")).toBeLessThan(kinds.indexOf("resolution"));
  native(target,db=>{expect(db.prepare("SELECT text,status,scope FROM claims ORDER BY text").all()).toEqual(native(source,s=>s.prepare("SELECT text,status,scope FROM claims ORDER BY text").all()));expect(db.prepare("SELECT stance FROM claim_evidence ORDER BY stance").all()).toEqual([{stance:"refutes"},{stance:"refutes"},{stance:"supports"},{stance:"supports"}]);expect(db.prepare("SELECT COUNT(*) n FROM relations WHERE rel='superseded-by'").get().n).toBe(2);expect(db.prepare("SELECT payload FROM events WHERE kind='claim.resolve' ORDER BY payload").all()).toEqual([{payload:"contested | original ruling"},{payload:"refuted | original ruling"}]);expect(db.prepare("SELECT COUNT(*) n FROM sources_fts").get().n).toBe(2);expect(db.prepare("SELECT COUNT(*) n FROM evidence_fts").get().n).toBe(3);expect(db.prepare("SELECT * FROM meta WHERE key LIKE 'current_project%'").all()).toEqual([]);});
  expect(snapshot(source)).toEqual(a);
 });
 it("repeated execution reports every row duplicate and makes no filesystem or audit/selection writes",()=>{
  cli();const before=snapshot(target),sourceBefore=snapshot(source),second=cli();expect(second.steps.every((s:any)=>s.action==="duplicate")).toBe(true);expect(second.written).toBe(0);expect(second.verify.ok).toBe(true);expect(snapshot(target)).toEqual(before);expect(snapshot(source)).toEqual(sourceBefore);
  const verified=cli(["--verify"]);expect(verified.mode).toBe("verify");expect(verified.verify.ok).toBe(true);expect(snapshot(target)).toEqual(before);
 });
 it.each(["missing","locked","schema"])("refuses %s target before any writes or migrations",kind=>{
  if(kind==="missing")rmSync(target,{recursive:true,force:true});
  if(kind==="locked"){mkdirSync(join(target,"ygl-trees.db.ygllock"));writeFileSync(join(target,"ygl-trees.db.ygllock","pid"),String(process.pid));}
  if(kind==="schema")native(target,db=>db.pragma("user_version=15"));
  const a=snapshot(source),b=snapshot(target);expect(cli([],1).error).toMatch(new RegExp(kind==="schema"?"schema":kind));expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);
 });
 it("returns a committed prefix on failure and safely resumes without duplicating rows",()=>{
  native(target,db=>db.exec("CREATE TRIGGER interrupt_claim BEFORE INSERT ON claims WHEN NEW.text='ruling two' BEGIN SELECT RAISE(ABORT,'test interruption'); END"));
  const first=cli([],1);expect(first.partial.written).toBeGreaterThan(0);expect(first.partial.completed.length).toBe(first.partial.written);expect(first.error).toContain("test interruption");
  native(target,db=>db.exec("DROP TRIGGER interrupt_claim"));const resumed=cli();expect(resumed.steps.some((s:any)=>s.action==="duplicate")).toBe(true);expect(resumed.verify.ok).toBe(true);expect(cli().written).toBe(0);
 });
 it("refuses conflicting existing scopes and verify detects tampering without overwriting it",()=>{
  cli();native(target,db=>db.prepare("UPDATE claims SET scope='*' WHERE text='ruling two'").run());const before=snapshot(target);expect(cli([],1).error).toMatch(/scope|conflict/);expect(snapshot(target)).toEqual(before);expect(cli(["--verify"],1).error).toMatch(/scope|conflict|verification/);expect(snapshot(target)).toEqual(before);
 });
 it("does not create or fall back to a missing source home",()=>{
  const missing=join(root,"missing-source"),before=snapshot(target);expect(cli([],1,missing).error).toMatch(/missing/);expect(existsSync(missing)).toBe(false);expect(snapshot(target)).toEqual(before);
 });
 it("refuses a same-name target project with a different identity without merging it",()=>{
  native(target,db=>db.prepare("INSERT INTO projects(id,name,question,created,updated) VALUES('target-p',?,'copy rulings','old','old')").run(project));
  const before=snapshot(target);expect(cli([],1).error).toMatch(/identity|extra/);expect(snapshot(target)).toEqual(before);
 });
 it("refuses an identity already occupied by an unrelated target project before writing",()=>{
  native(target,db=>db.prepare("INSERT INTO projects(id,name,created,updated) VALUES('p','unrelated','old','old')").run());
  const before=snapshot(target);expect(cli([],1).error).toMatch(/identity/);expect(snapshot(target)).toEqual(before);
 });
 it("detects extra committed target data in count/hash verification rather than hashing only planned rows",()=>{
  native(target,db=>db.exec("CREATE TRIGGER unexpected_extra AFTER INSERT ON claims WHEN NEW.text='ruling three' BEGIN INSERT INTO claims(id,project_id,text,content_hash,scope,created,updated) VALUES('extra',NEW.project_id,'unexpected','extra','','old','old'); END"));
  const result=cli([],1);expect(result.error).toMatch(/extra|verification/);expect(result.partial.written).toBeGreaterThan(0);
 });
 it.each(["source","target"])("refuses an active journal in the %s copy without touching either workspace",side=>{
  const home=side==="source"?source:target;writeFileSync(join(home,"ygl-trees.db-journal"),"held journal");const a=snapshot(source),b=snapshot(target);
  expect(cli(["--dry-run"],1).error).toMatch(/journal/);expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);
 });
 it.each(["cycle","cross-project","invalid-scope"])("rejects invalid source %s before any target write",kind=>{
  native(source,db=>{if(kind==="cycle")db.prepare("INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,created) VALUES('cycle','claim','c3','claim','c1','superseded-by','old')").run();if(kind==="cross-project"){db.prepare("INSERT INTO projects(id,name,created,updated) VALUES('q','q','old','old')").run();db.prepare("UPDATE evidence SET project_id='q' WHERE id='e1'").run();}if(kind==="invalid-scope")db.prepare("UPDATE claims SET scope='public' WHERE id='c1'").run();});
  const before=snapshot(target);expect(cli([],1).error).toMatch(/cycle|outside|scope/);expect(snapshot(target)).toEqual(before);
 });
 it("reports rollback of the current row when its audit insert fails and releases the target lock",()=>{
  native(target,db=>db.exec("CREATE TRIGGER deny_sync_audit BEFORE INSERT ON events WHEN NEW.kind='source.add' BEGIN SELECT RAISE(ABORT,'sync audit rejected'); END"));
  const result=cli([],1);expect(result.partial.written).toBe(1);native(target,db=>expect(db.prepare("SELECT * FROM sources").all()).toEqual([]));expect(existsSync(join(target,"ygl-trees.db.ygllock"))).toBe(false);
 });
 it.each(["source","target"])("refuses a %s change made after planning before the first write",async side=>{
  const writesBefore=native(target,db=>db.prepare("SELECT COUNT(*) n FROM events").get().n),result:any[]=[];let owner:ReturnType<typeof createWorkspaceOrm>|undefined;
  const args=parse(["project","sync",project,"--home",source,"--to",target,"--json"]);
  const rc=await runProjectSync({json:true,color:false,quiet:true,emitJson:row=>result.push(row)},args,file=>{
   native(side==="source"?source:target,db=>db.prepare("INSERT INTO meta(key,value) VALUES('raced','changed')").run());
   return owner=createWorkspaceOrm({dialect:"sqlite",file});
  });
  expect(rc).toBe(1);expect(result).toHaveLength(1);expect(result[0].error).toMatch(/changed/);
  expect(native(target,db=>db.prepare("SELECT COUNT(*) n FROM events").get().n)).toBe(writesBefore);
  expect(native(target,db=>db.prepare("SELECT COUNT(*) n FROM projects").get().n)).toBe(0);expect(existsSync(join(target,"ygl-trees.db.ygllock"))).toBe(false);
  await owner?.close();
 });
 it("treats a stale user_version with missing mandatory columns as schema mismatch before any write",()=>{
  native(target,db=>db.exec("ALTER TABLE claims DROP COLUMN scope"));const before=snapshot(target);expect(cli([],1).error).toMatch(/schema|scope/);expect(snapshot(target)).toEqual(before);
 });
 it("rejects a source invalid schema even when no project rows exercise the column",()=>{
  native(source,db=>db.exec("ALTER TABLE sources DROP COLUMN engine"));const before=snapshot(target);expect(cli([],1).error).toMatch(/schema|engine/);expect(snapshot(target)).toEqual(before);
 });
 it("does not allow a source-provided extra column to enter write SQL",()=>{
  native(source,db=>db.exec("ALTER TABLE claims ADD COLUMN unknown_field TEXT DEFAULT 'extra'"));const before=snapshot(target);expect(cli([],1).error).toMatch(/schema|column/);expect(snapshot(target)).toEqual(before);
 });
 it("rejects a source resolve marker inconsistent with current status before writing",()=>{
  native(source,db=>db.prepare("UPDATE claims SET status='supported' WHERE id='c1'").run());const before=snapshot(target);
  expect(cli([],1).error).toMatch(/resolution|arbitration/);expect(snapshot(target)).toEqual(before);
 });
 it("uses SQLite timestamp/rowid ordering for tied arbitration, not a migrated seq",()=>{
  native(source,db=>{db.prepare("UPDATE events SET seq=999 WHERE entity_id='c1'").run();db.prepare("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level,seq) VALUES('last','2026-01-01','reviewer','claim.resolve','claim','c1','supported | last ruling','info',1)").run();db.prepare("UPDATE claims SET status='supported' WHERE id='c1'").run();});
  expect(cli().verify.ok).toBe(true);native(target,db=>expect(db.prepare("SELECT payload FROM events WHERE kind='claim.resolve' AND entity_id='c1'").get().payload).toBe("supported | last ruling"));expect(cli().written).toBe(0);
 });
 it("detects another target connection's committed change between replay transactions",async()=>{
  const output:any[]=[],args=parse(["project","sync",project,"--home",source,"--to",target,"--json"]);const targetHome=target;let actual:ReturnType<typeof createWorkspaceOrm>|undefined;
  const rc=await runProjectSync({json:true,quiet:true,color:false,emitJson:row=>output.push(row)},args,file=>{
   actual=createWorkspaceOrm({dialect:"sqlite",file});
   return {...actual,getOrm:async f=>{const ds=await actual!.getOrm(f),transaction=ds.transaction.bind(ds);let count=0;
    return new Proxy(ds,{get(target,key){if(key==="transaction")return async(fn:any)=>{const value=await transaction(fn);if(++count===1)native(targetHome,db=>db.prepare("INSERT INTO meta(key,value) VALUES('external-change','value')").run());return value;};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
   }};
  });
  expect(rc).toBe(1);expect(output[0].error).toMatch(/changed/);expect(output[0].partial.written).toBe(1);expect(existsSync(join(target,"ygl-trees.db.ygllock"))).toBe(false);await actual?.close();
  expect(cli().verify.ok).toBe(true);
 });
 it("rejects missing source uniqueness rather than counting two source claims as one duplicate target",()=>{
  cli();
  native(source,db=>{db.exec("DROP INDEX uq_claims_content");db.prepare("INSERT INTO claims SELECT 'copy-c3',project_id,text,status,confidence,content_hash,scope,channel,created,updated FROM claims WHERE id='c3'").run();});
  const before=snapshot(target);expect(cli([],1).error).toMatch(/schema|unique|mapping/);expect(snapshot(target)).toEqual(before);
 });
 it("rejects missing target uniqueness even when no existing target rows expose it",()=>{
  native(target,db=>db.exec("DROP INDEX uq_evidence_content"));const before=snapshot(target);expect(cli(["--dry-run"],1).error).toMatch(/schema|unique/);expect(snapshot(target)).toEqual(before);
 });
 it("recovers a real exited replay only with explicit resume and leaves dry-run locked",()=>{
  const script=join(root,"exit-after-commit.cjs");
  writeFileSync(script,[
   'const {runProjectSync}=require('+JSON.stringify(join(repo,"dist/packages/ops/tools/src/project-sync.js"))+');',
   'const {createWorkspaceOrm}=require('+JSON.stringify(join(repo,"dist/apps/cli/src/workspace-orm.js"))+');',
   'const {parse}=require('+JSON.stringify(join(repo,"dist/packages/core/database/src/types.js"))+');',
   'runProjectSync({json:true,quiet:true,color:false,emitJson:r=>process.stdout.write(JSON.stringify(r))},parse(process.argv.slice(2)),file=>{',
   ' const owner=createWorkspaceOrm({dialect:"sqlite",file});',
   ' return {...owner,getOrm:async file=>{const ds=await owner.getOrm(file),run=ds.transaction.bind(ds);return new Proxy(ds,{get(t,k){if(k==="transaction")return async fn=>{const result=await run(fn);process.exit(37);return result;};const value=Reflect.get(t,k);return typeof value==="function"?value.bind(t):value;}});}};',
   '}).catch(e=>{console.error(e);process.exitCode=1;});',
  ].join("\n"));
  const exited=spawnSync(process.execPath,[script,"project","sync",project,"--home",source,"--to",target,"--json"],{cwd:repo,encoding:"utf8",timeout:60000,env:{...process.env,YGL_DB_URL:"",YGL_PG_URL:""}});
  expect(exited.error,exited.stderr).toBeUndefined();expect(exited.status,exited.stderr).toBe(37);
  const lock=join(target,"ygl-trees.db.ygllock");expect(existsSync(lock)).toBe(true);
  const wal=join(target,"ygl-trees.db-wal");expect(existsSync(wal)).toBe(true);expect(statSync(wal).size).toBeGreaterThan(0);
  const before=snapshot(target);expect(cli(["--dry-run"],1).error).toMatch(/locked/);expect(snapshot(target)).toEqual(before);
  const resumed=cli(["--resume"]);expect(resumed.verify.ok).toBe(true);expect(resumed.steps[0].action).toBe("duplicate");expect(existsSync(lock)).toBe(false);expect(cli().written).toBe(0);
 });
 it("resume never steals a live lock or accepts dry-run plus recovery",()=>{
  const lock=join(target,"ygl-trees.db.ygllock");mkdirSync(lock);writeFileSync(join(lock,"pid"),String(process.pid));writeFileSync(join(lock,"owner"),"live-owner");
  const before=snapshot(target);expect(cli(["--resume"],1).error).toMatch(/locked|live/);expect(snapshot(target)).toEqual(before);
  expect(cli(["--resume","--dry-run"],2).error).toMatch(/usage|resume/);expect(snapshot(target)).toEqual(before);
 });
 it("reports committed data and a retained lock when owner cleanup cannot be confirmed",async()=>{
  const results:any[]=[],args=parse(["project","sync",project,"--home",source,"--to",target,"--json"]);let real:ReturnType<typeof createWorkspaceOrm>|undefined;
  const rc=await runProjectSync({json:true,quiet:true,color:false,emitJson:r=>results.push(r)},args,file=>{
   real=createWorkspaceOrm({dialect:"sqlite",file});return {...real,close:async()=>{throw new Error("test native close uncertain");}};
  });
  try{expect(rc).toBe(1);expect(results).toHaveLength(1);expect(results[0].error).toMatch(/cleanup failed/);expect(results[0].partial.written).toBeGreaterThan(0);expect(results[0].partial.rerunnable).toBe(false);expect(results[0].partial.recovery_required).toBe(true);expect(existsSync(join(target,"ygl-trees.db.ygllock"))).toBe(true);}
  finally{await real?.close();}
 });
 it("does not release a lock whose owner token changes while replay is in progress",async()=>{
  const results:any[]=[],args=parse(["project","sync",project,"--home",source,"--to",target,"--json"]);let real:ReturnType<typeof createWorkspaceOrm>|undefined;
  const rc=await runProjectSync({json:true,quiet:true,color:false,emitJson:r=>results.push(r)},args,file=>{
   real=createWorkspaceOrm({dialect:"sqlite",file});writeFileSync(join(target,"ygl-trees.db.ygllock","owner"),"replacement-owner");return real;
  });
  try{expect(rc).toBe(1);expect(results[0].error).toMatch(/ownership/);expect(results[0].partial.rerunnable).toBe(false);expect(readFileSync(join(target,"ygl-trees.db.ygllock","owner"),"utf8")).toBe("replacement-owner");}
  finally{await real?.close();}
 });
 it("never removes a recovery guard whose ownership changed",async()=>{
  const exited=spawnSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8",timeout:10000});
  expect(exited.status).toBe(0);const lock=join(target,"ygl-trees.db.ygllock"),guard=lock+".recovery";mkdirSync(lock);
  const task=hash(JSON.stringify([join(source,"ygl-trees.db"),hash(readFileSync(join(source,"ygl-trees.db"))),target,project]));
  for(const [name,value]of [["pid",exited.stdout],["owner","abandoned-test-owner"],["sync",task]])writeFileSync(join(lock,name),value);
  let real:ReturnType<typeof createWorkspaceOrm>|undefined;const output:any[]=[];
  try{
   const rc=await runProjectSync({json:true,color:false,quiet:true,emitJson:r=>output.push(r)},parse(["project","sync",project,"--home",source,"--to",target,"--resume","--json"]),file=>{
    real=createWorkspaceOrm({dialect:"sqlite",file});writeFileSync(join(guard,"owner"),"replacement-recovery-owner");return real;
   });
   expect(rc).toBe(1);expect(output[0].error).toMatch(/ownership/);expect(output[0].partial.rerunnable).toBe(false);expect(readFileSync(join(guard,"owner"),"utf8")).toBe("replacement-recovery-owner");
  }finally{await real?.close();}
 });
 it.each(["source","target"])("refuses a PG-bound %s home before opening a writer",side=>{
  writeFileSync(join(side==="source"?source:target,"pg-binding.json"),JSON.stringify({mode:"pg",url_hash:"sha256:test"}));const a=snapshot(source),b=snapshot(target);
  expect(cli(["--dry-run"],1).error).toMatch(/PG|binding/);expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);
 });
 it.each(["source","target"]) ("rejects %s generated columns before any prefix write and on verify",side=>{
  const home=side==="source"?source:target;
  native(home,db=>db.exec("ALTER TABLE sources ADD COLUMN sync_extra TEXT GENERATED ALWAYS AS ('extra') VIRTUAL"));
  const a=snapshot(source),b=snapshot(target),result=cli([],1);expect(result.error).toMatch(/schema|column/);expect(result.partial).toBeUndefined();expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);
 });
 it.each(["source","target"])("verify refuses %s generated-column drift even after an identical replay",side=>{
  cli();native(side==="source"?source:target,db=>db.exec("ALTER TABLE sources ADD COLUMN sync_extra TEXT GENERATED ALWAYS AS ('extra') VIRTUAL"));
  const a=snapshot(source),b=snapshot(target);expect(cli(["--verify"],1).error).toMatch(/schema|column/);expect(snapshot(source)).toEqual(a);expect(snapshot(target)).toEqual(b);
 });
 it.each(["same-process","child-process"])("excludes %s DB lock takeover between recovery validation and stale-lock rename",async mode=>{
  const exited=spawnSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8",timeout:10000});expect(exited.error).toBeUndefined();expect(exited.status).toBe(0);
  const file=join(target,"ygl-trees.db"),lock=file+".ygllock",task=hash(JSON.stringify([join(source,"ygl-trees.db"),hash(readFileSync(join(source,"ygl-trees.db"))),target,project]));mkdirSync(lock);
  for(const [key,value]of [["owner","abandoned-owner"],["pid",exited.stdout],["sync",task]])writeFileSync(join(lock,key),value);
  const prior=process.env.YGL_LOCK_RETRY_MS;process.env.YGL_LOCK_RETRY_MS="0";
  let attempted=false,writer:DB|undefined,rejected:unknown;const output:any[]=[],close=(Sqlite as any).prototype.close;
  const spy=vi.spyOn((Sqlite as any).prototype,"close").mockImplementation(function(this:any,...args:any[]){
   const value=close.apply(this,args);
   if(!attempted&&this.name===file&&this.readonly){
    attempted=true;
    if(mode==="same-process")try{writer=new DB(file,{lock:true,managed:true});}catch(error){rejected=error;}
    else{
     const script='const {DB}=require('+JSON.stringify(join(repo,"dist/packages/core/database/src/db.js"))+');try{const db=new DB(process.argv[1],{lock:true,managed:true});process.stdout.write(JSON.stringify({acquired:true}));db.closeStrict();}catch(error){process.stdout.write(JSON.stringify({acquired:false,error:error.message}));}';
     const child=spawnSync(process.execPath,["-e",script,file],{cwd:repo,encoding:"utf8",timeout:15000,env:{...process.env,YGL_LOCK_RETRY_MS:"0"}});
     expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status,child.stderr).toBe(0);const result=JSON.parse(child.stdout);expect(result.acquired).toBe(false);rejected=result.error;
    }
   }
   return value;
  });
  try{
   const rc=await runProjectSync({json:true,color:false,quiet:true,emitJson:r=>output.push(r)},parse(["project","sync",project,"--home",source,"--to",target,"--resume","--json"]),file=>createWorkspaceOrm({dialect:"sqlite",file}));
   expect(attempted).toBe(true);expect(writer).toBeUndefined();expect(String(rejected)).toMatch(/locked|admission|recovery/);expect(rc).toBe(0);expect(output[0].verify.ok).toBe(true);
  }finally{spy.mockRestore();writer?.closeStrict();if(prior===undefined)delete process.env.YGL_LOCK_RETRY_MS;else process.env.YGL_LOCK_RETRY_MS=prior;}
 });
 it("requires explicit source and target and rejects same-file aliases before write",()=>{
  const before=snapshot(source);expect(cli([],1,source,source).error).toMatch(/same/);expect(snapshot(source)).toEqual(before);
 });
});
