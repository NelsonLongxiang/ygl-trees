import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let home="",source="";const ids:Record<string,string>={};
function cli(args:string[],json=true,rc=0){
 const env={...process.env,YGL_HOME:home,YGL_SESSION:"predict-score-158",YGL_TEST:"1",YGL_EVAL_OFFLINE:"1",YGL_NO_UPDATE_CHECK:"1",NO_COLOR:"1"};
 for(const key of ["YGL_DB_URL","YGL_PG_URL","YGL_PROJECT","YGL_DB"])delete env[key];
 const r=spawnSync(process.execPath,[BIN,...args,...(json?["--json"]:[])],{cwd:home,env,encoding:"utf8",timeout:30000});
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(rc);
 return json?JSON.parse(r.stdout):r.stdout;
}
function snapshot(){const db=new DatabaseSync(join(home,"ygl-trees.db"),{readOnly:true});try{return db.prepare("SELECT id,text,confidence,channel,status,updated FROM claims ORDER BY id").all();}finally{db.close();}}
beforeAll(()=>{
 mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/predict-score-"));
 cli(["db","init"]);cli(["project","new","alpha"]);
 for(const [key,p,status] of [["hit","0.8","supported"],["miss","0.6","refuted"],["nd","0.7","contested"]]){
  const row=cli(["research","claim","add","[预测·30天] 2027-01-01 前 "+key,"--confidence",p,"--channel","ch-a","-p","alpha"]);ids[key]=row.id;
  cli(["research","claim","resolve",row.id,"--as",status,"--note","repro","-p","alpha"]);
 }
 const src=cli(["research","source","add","--title","score fixture","--url","https://example.invalid/score","-p","alpha"]);source=src.id;
 const ev=cli(["research","evidence","add",source,"--quote","settlement fixture","--note","outcome=1, brier=0.9, settler=fixture","-p","alpha"]);
 cli(["research","claim","link",ids.hit,ev.id,"-p","alpha"]);
 const db=new DatabaseSync(join(home,"ygl-trees.db"));
 try{
  const insert=db.prepare("INSERT INTO claims(id,project_id,text,status,confidence,channel,created,updated,content_hash) SELECT ?,id,?,?,?,?,?,?,? FROM projects WHERE name=?");
  for(const [id,status,confidence,channel,project] of [["no-p","refuted","A","unknown","alpha"],["no-p-nd","contested","B","unknown","alpha"],["pending","unverified","0.8","pending","alpha"],["undecided","contested","0.9","pending","alpha"],["unlabelled","supported","0.8","","alpha"],["percent","refuted","20%","percent","alpha"]])insert.run(id,"[预测·30天] 2027-01-01 前 "+id,status,confidence,channel,"2026-01-01","2026-01-01","fixture-"+id,project);
 }finally{db.close();}
 cli(["project","new","beta"]);
 const beta=cli(["research","claim","add","[预测·30天] 2027-01-01 前 beta","--confidence","0.2","--channel","ch-a","-p","beta"]);
 cli(["research","claim","resolve",beta.id,"--as","refuted","--note","repro","-p","beta"]);ids.beta=beta.id;
},120000);
afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
describe("#158 prediction score CLI",()=>{
 it("adds probability and calculated score without changing the handwritten brier field",()=>{
  const before=snapshot(),rows=cli(["research","predict","list","--all"]);
  expect(rows.find((r:any)=>r.claim_id===ids.hit)).toMatchObject({p:0.8,outcome:"1",brier:"0.9",brier_calc:0.04,brier_mismatch:true,settler:"fixture"});
  expect(rows.find((r:any)=>r.claim_id===ids.miss)).toMatchObject({p:0.6,outcome:"0",brier:null,brier_calc:0.36,brier_mismatch:false});
  expect(rows.find((r:any)=>r.claim_id===ids.nd)).toMatchObject({p:0.7,outcome:"ND",brier_calc:null});
  expect(rows.find((r:any)=>r.claim_id==="percent")).toMatchObject({p:0.2,brier_calc:0.04});
  expect(rows.find((r:any)=>r.claim_id==="no-p")).toMatchObject({p:null,brier_calc:null});
  expect(snapshot()).toEqual(before);
 });
 it("matches the issue fixture and computes channel means from engine values, not settlement notes",()=>{
  expect(cli(["research","predict","score","-p","alpha","--channel","ch-a"])).toEqual([{channel:"ch-a",settled:2,nd:1,open:0,no_p:0,hit_rate:0.5,brier_mean:0.2}]);
 });
 it("excludes ND, open and unknown probabilities, returning null instead of zero",()=>{
  const rows=cli(["research","predict","score","-p","alpha"]);
  expect(rows.find((r:any)=>r.channel==="pending")).toEqual({channel:"pending",settled:0,nd:1,open:1,no_p:0,hit_rate:null,brier_mean:null});
  expect(rows.find((r:any)=>r.channel==="unknown")).toEqual({channel:"unknown",settled:1,nd:1,open:0,no_p:2,hit_rate:null,brier_mean:null});
  expect(rows.find((r:any)=>r.channel==="")).toMatchObject({settled:1,hit_rate:1,brier_mean:0.04});
 });
 it("uses workspace scope only with --all and supports exact channel filtering without selection",()=>{
  const db=new DatabaseSync(join(home,"ygl-trees.db"));try{db.prepare("DELETE FROM meta WHERE key LIKE 'current_project%'").run();}finally{db.close();}
  expect(cli(["research","predict","score","--all","--channel","ch-a"])).toEqual([{channel:"ch-a",settled:3,nd:1,open:0,no_p:0,hit_rate:0.666666666667,brier_mean:0.146666666667}]);
  expect(cli(["research","predict","score"],true,2).error).toMatch(/ambiguous project/);
 });
 it("renders the discrepancy marker and human channel table",()=>{
  const list=cli(["research","predict","list","--all"],false);expect(list).toContain("≠");expect(list).toContain("brier_calc");
  const score=cli(["research","predict","score","-p","alpha"],false);expect(score).toContain("hit_rate");expect(score).toContain("no_p");expect(score).toContain("ch-a");
 });
 it("returns empty channel results and rejects missing/unknown/unsupported flags with one JSON error",()=>{
  expect(cli(["research","predict","score","-p","alpha","--channel","absent"])).toEqual([]);
  for(const flags of [["--channel"],["--due"],["--bogus"]])expect(cli(["research","predict","score","-p","alpha",...flags],true,2).error).toMatch(/channel|unknown flag/);
  expect(cli(["research","predict","list","-p","alpha","--channel","ch-a"],true,2).error).toMatch(/unknown flag/);
  for(const action of ["toString","constructor","__proto__"])expect(cli(["research","predict",action,"-p","alpha"],true,2).error).toMatch(/usage/);
  const full=cli(["research","predict","list","--all"]);
  expect(cli(["research","predict","list","--all","--due=false"])).toEqual(full);
 });
 it("allows read-only scoring on archived projects without changing stored claims",()=>{
  cli(["project","rm","alpha"]);const before=snapshot();
  expect(cli(["research","predict","score","-p","alpha","--channel","ch-a"])[0]).toMatchObject({settled:2,brier_mean:0.2});expect(snapshot()).toEqual(before);
 });
});
