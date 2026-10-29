/** Service-level PG proofs, not CLI acceptance. All arbitration below belongs only to disposable fixtures. */
import { describe,it,expect,beforeAll,afterAll,vi } from "vitest";
import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { join } from "node:path";
import { DB } from "../../../core/database/src/db";
import { getPgOrm,closeOrm } from "../../../core/database/src/orm";
import { bindPgWorkspace } from "../../../core/database/src/pg-workspace";
import { migrateToPg } from "../../../ops/tools/src/pgsync";
import * as writes from "../src/writes";
const adminUrl=process.env.B8_TEST_PG_ADMIN_URL||"";
let admin:any,client:any,ds:any,dir="",name="",url="",project="",sid:string|undefined;
let serial=0;
async function fixture(prediction=false){
 const key="fixture-"+(++serial);
 const source=await writes.sourceAdd(ds,project,{title:key,url:"session://"+key});
 const e1=(await writes.evidenceAdd(ds,project,source.row.id,key+"-support")).row.id;
 const e2=(await writes.evidenceAdd(ds,project,source.row.id,key+"-refute")).row.id;
 const c=(await writes.claimAdd(ds,project,(prediction?"[预测·7天] ":"")+key)).row.id;
 return {c,e1,e2};
}
const state=async(c:string)=>(await client.query("SELECT status,updated FROM claims WHERE id=$1",[c])).rows[0];
describe.skipIf(!adminUrl)("B8 batch 3 claim state service (official PG migration)",()=>{
 beforeAll(async()=>{
  const {Client}=require("pg");mkdirSync(join(process.cwd(),"tmp"),{recursive:true});dir=mkdtempSync(join(process.cwd(),"tmp/b8-state-"));
  admin=new Client({connectionString:adminUrl});await admin.connect();name="b8_state_"+Date.now();await admin.query('CREATE DATABASE "'+name+'"');
  const u=new URL(adminUrl);u.pathname="/"+name;url=u.toString();
  const seed=new DB(join(dir,"seed.db"),{lock:false});try{await migrateToPg(seed,url);}finally{seed.close();}
  client=new Client({connectionString:url});await client.connect();ds=await getPgOrm(url);
  await bindPgWorkspace(ds,join(dir,"home"),url,"0.117.0");sid=process.env.YGL_SESSION;process.env.YGL_SESSION="batch3-state-fixture";
  project=(await writes.projectCreate(ds,"state-fixtures")).id;
 },60000);
 afterAll(async()=>{
  vi.restoreAllMocks();if(sid===undefined)delete process.env.YGL_SESSION;else process.env.YGL_SESSION=sid;
  await closeOrm();await client?.end();if(admin){if(name)await admin.query('DROP DATABASE IF EXISTS "'+name+'" WITH (FORCE)');await admin.end();}
  if(dir)rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 it("stance mutation, manual lock, updated/recalculated and unresolve mirror the SQLite sequence",async()=>{
  const {c,e1,e2}=await fixture();
  expect(await writes.claimLink(ds,c,e1,"supports")).toMatchObject({status:"supported",auto_promote:true});
  expect(await writes.claimLink(ds,c,e1,"refutes")).toMatchObject({status:"refuted",auto_promote:true,duplicate:true});
  expect(await writes.claimLink(ds,c,e2,"supports")).toEqual({status:"contested",auto_promote:true});
  await writes.claimResolve(ds,c,"refuted","isolated fixture only");const locked=await state(c);
  expect(await writes.claimUnlink(ds,c,e1)).toMatchObject({stance:"refutes",status:"refuted",recalculated:false});expect(await state(c)).toEqual(locked);
  expect(await writes.claimUnresolve(ds,c)).toEqual({status:"unverified",duplicate:false});
  expect(await writes.claimLink(ds,c,e2,"supports")).toMatchObject({status:"supported",auto_promote:true});
  expect((await client.query("SELECT kind FROM events WHERE entity_id=$1 AND kind='claim.unresolve'",[c])).rows).toHaveLength(1);
 });
 it("prediction evidence does not settle or refresh updated; explicit fixture arbitration survives unlink",async()=>{
  const {c,e1}=await fixture(true);const original=await state(c);
  expect(await writes.claimLink(ds,c,e1)).toEqual({status:"unverified",auto_promote:false});expect(await state(c)).toEqual(original);
  await writes.claimResolve(ds,c,"supported","fixture only");const arb=await state(c);
  expect(await writes.claimUnlink(ds,c,e1)).toMatchObject({status:"supported",recalculated:false});expect(await state(c)).toEqual(arb);
 });
 it("resolve-as-unverified then duplicate unresolve deliberately retains the existing arbitration lock",async()=>{
  const {c,e1}=await fixture();await writes.claimResolve(ds,c,"unverified");
  expect(await writes.claimUnresolve(ds,c)).toEqual({status:"unverified",duplicate:true});
  expect(await writes.claimLink(ds,c,e1)).toEqual({status:"unverified",auto_promote:false});
  expect((await client.query("SELECT id FROM events WHERE entity_id=$1 AND kind='claim.unresolve'",[c])).rows).toEqual([]);
 });
 it("same-ts native resolve/unresolve order is selected by monotonic seq, never rowid",async()=>{
  const {c,e1}=await fixture();const clock=vi.spyOn(Date.prototype,"toISOString").mockReturnValue("2031-01-01T00:00:00.000Z");
  try{
   await writes.claimResolve(ds,c,"refuted");await writes.claimUnresolve(ds,c);
   expect(await writes.claimLink(ds,c,e1)).toMatchObject({status:"supported",auto_promote:true});
   const events=(await client.query("SELECT kind,seq,ts FROM events WHERE entity_id=$1 AND kind IN ('claim.resolve','claim.unresolve') ORDER BY seq",[c])).rows;
   expect(events.map((r:any)=>r.kind)).toEqual(["claim.resolve","claim.unresolve"]);expect(events[0].ts).toBe(events[1].ts);expect(BigInt(events[1].seq)>BigInt(events[0].seq)).toBe(true);
  }finally{clock.mockRestore();}
 });
 it("tied historical NULL seq refuses and rolls back relation/event/status; one historic event is unambiguous",async()=>{
  const {c,e1}=await fixture();const ts="2032-01-01T00:00:00.000Z";
  for(const [id,kind,payload]of [["old-resolve-"+c,"claim.resolve","refuted"],["old-unresolve-"+c,"claim.unresolve","refuted → unverified"]])await client.query("INSERT INTO events(id,ts,kind,entity,entity_id,payload,seq) VALUES($1,$2,$3,'claim',$4,$5,NULL)",[id,ts,kind,c,payload]);
  const before=await state(c);await expect(writes.claimLink(ds,c,e1)).rejects.toThrow("历史仲裁事件顺序不可确定");
  expect(await state(c)).toEqual(before);expect((await client.query("SELECT * FROM claim_evidence WHERE claim_id=$1",[c])).rows).toEqual([]);
  expect((await client.query("SELECT id FROM events WHERE kind='claim.link' AND entity_id=$1",[c])).rows).toEqual([]);
  await client.query("DELETE FROM events WHERE id=$1",["old-unresolve-"+c]);
  expect(await writes.claimLink(ds,c,e1)).toEqual({status:"refuted",auto_promote:false});
 });
 it("parallel support/refute link serializes on claim; final state agrees with committed links",async()=>{
  const {c,e1,e2}=await fixture();await Promise.all([writes.claimLink(ds,c,e1,"supports"),writes.claimLink(ds,c,e2,"refutes")]);
  expect((await state(c)).status).toBe("contested");expect((await client.query("SELECT stance FROM claim_evidence WHERE claim_id=$1",[c])).rows).toHaveLength(2);
 });
 it("controlled deletion-first schedule fences a real concurrent link without a sleep race",async()=>{
  const {c,e1}=await fixture();const create=ds.createQueryRunner.bind(ds);
  let unlock!:()=>void,locked!:()=>void,attempted!:()=>void;
  const gate=new Promise<void>(r=>unlock=r),lockAcquired=new Promise<void>(r=>locked=r),linkAttempted=new Promise<void>(r=>attempted=r);
  const runners:any[]=[];let held=false;
  const spy=vi.spyOn(ds,"createQueryRunner").mockImplementation((...args:any[])=>{
    const runner=create(...args);runners.push(runner);const query=runner.query.bind(runner);
    runner.query=async(sql:string,params?:any[],structured?:boolean)=>{
      if(sql==="SELECT id FROM evidence WHERE id=$1 FOR UPDATE"&&params?.[0]===e1&&!held){held=true;const rows=await query(sql,params,structured);locked();await gate;return rows;}
      if(sql==="SELECT id FROM evidence WHERE id=$1 FOR SHARE"&&params?.[0]===e1&&held)attempted();
      return query(sql,params,structured);
    };return runner;
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("fixture barrier timed out")),10000);});
  let deletion:Promise<any>|undefined,link:Promise<any>|undefined;
  try{
    deletion=writes.evidenceRemove(ds,e1,true);await Promise.race([lockAcquired,deadline]);
    link=writes.claimLink(ds,c,e1).then(v=>({ok:true,value:v}),e=>({ok:false,error:e.message}));
    await Promise.race([linkAttempted,deadline]);unlock();
    const [d,l]=await Promise.race([Promise.all([deletion,link]),deadline]);expect(d.id).toBe(e1);expect(l.ok).toBe(false);expect(l.error).toContain("evidence not found");
    expect((await client.query("SELECT * FROM claim_evidence WHERE evidence_id=$1",[e1])).rows).toEqual([]);expect((await state(c)).status).toBe("unverified");
  }finally{unlock();if(timer)clearTimeout(timer);await Promise.allSettled([deletion,link].filter(Boolean) as Promise<any>[]);spy.mockRestore();}
 });
 it("shared-claim deletion cone locks ids deterministically and recomputes each affected claim once",async()=>{
  const {c,e1,e2}=await fixture();const other=(await writes.claimAdd(ds,project,"shared-cone-"+(++serial))).row.id;
  await writes.claimLink(ds,c,e1);await writes.claimLink(ds,c,e2,"refutes");await writes.claimLink(ds,other,e1);
  const source=(await client.query("SELECT source_id FROM evidence WHERE id=$1",[e1])).rows[0].source_id;
  const result=await writes.sourceRemove(ds,source,true);expect(result.claims_recomputed).toBe(2);expect(result.evidence_removed).toBe(2);
  expect((await state(c)).status).toBe("unverified");expect((await state(other)).status).toBe("unverified");
 });
 it("event failure rolls back link and resolve; missing required column is named before mutations",async()=>{
  const {c,e1}=await fixture();const before=await state(c);
  await client.query("CREATE FUNCTION b8_state_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('claim.link','claim.resolve') THEN RAISE EXCEPTION 'fixture state event'; END IF; RETURN NEW; END $$");
  await client.query("CREATE TRIGGER b8_state_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_state_abort()");
  try{await expect(writes.claimLink(ds,c,e1)).rejects.toThrow();await expect(writes.claimResolve(ds,c,"supported")).rejects.toThrow();expect(await state(c)).toEqual(before);expect((await client.query("SELECT * FROM claim_evidence WHERE claim_id=$1",[c])).rows).toEqual([]);}
  finally{await client.query("DROP TRIGGER b8_state_abort ON events");await client.query("DROP FUNCTION b8_state_abort()");}
  await client.query("ALTER TABLE claims RENAME COLUMN channel TO hidden_channel");
  try{await expect(writes.claimResolve(ds,c,"supported")).rejects.toThrow("claims.channel");expect(await state(c)).toEqual(before);}
  finally{await client.query("ALTER TABLE claims RENAME COLUMN hidden_channel TO channel");}
 });
});
