/** #124: release gate cannot count env-skipped or partial PG suites as passed. */
import {describe,it,expect} from "vitest";
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {resolve, join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const loadGate=()=>import(pathToFileURL(resolve(__dirname,"../../../../scripts/dual-backend-matrix.mjs")).href);
const root=resolve(__dirname,"../../../..");
describe("#124 B8 release gate wiring",()=>{
 it("G7 supplies its own container admin URL and runs B8 before the matrix",()=>{
  const s=readFileSync(resolve(root,"scripts/pg-gate.sh"),"utf8");
  expect(s).toContain("B8_TEST_PG_ADMIN_URL");expect(s).toContain("POSTGRES_DB=ygl");
  expect(s.indexOf("node scripts/dual-backend-matrix.mjs")).toBeGreaterThan(0);
  expect(s.indexOf("node scripts/dual-backend-matrix.mjs --b8-pg-only")).toBeLessThan(s.indexOf("node scripts/dual-backend-matrix.mjs --strict"));
 });
 it("matrix keeps every step's full output on disk and prints the tail of a failing step",()=>{
  const m=readFileSync(resolve(root,"scripts/dual-backend-matrix.mjs"),"utf8");
  expect(m).toMatch(/const LOG_DIR = join\(ROOT, "tmp", "dual-backend-matrix-"/);
  expect(m).toMatch(/writeFileSync\(log, /);
  expect(m.match(/sh\(cmd\[0\], cmd\.slice\(1\), \{ \.\.\.opts, leg: "(sqlite|pg)", name \}\)/g)?.length).toBe(2);
  expect(m).toMatch(/full log: \$\{relative\(ROOT, s\.log\)\}/);
  expect(m).toMatch(/s\.tail\.split\("\\n"\)\.slice\(-30\)/);
 });
 it("matrix child environments isolate backend URLs from the caller",()=>{
  mkdirSync(join(root,"tmp"),{recursive:true});
  const dir=mkdtempSync(join(root,"tmp/g7-environment-")),preload=join(dir,"capture.cjs");
  const capture=[
   'const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),assert=require("node:assert/strict");',
   'const dir=process.env.G7_ENV_FIXTURE,root=process.cwd(),mkdir=fs.mkdirSync,write=fs.writeFileSync,mkdtemp=fs.mkdtempSync;let logs;',
   'fs.mkdirSync=function(p,...args){if(String(p).startsWith(path.join(root,"tmp","dual-backend-matrix-"))){logs=String(p);return mkdir.call(this,path.join(dir,"logs"),...args);}return mkdir.call(this,p,...args);};',
   'fs.writeFileSync=function(p,...args){if(logs&&path.dirname(String(p))===logs)p=path.join(dir,"logs",path.basename(String(p)));return write.call(this,p,...args);};',
   'fs.mkdtempSync=function(prefix,...args){assert.equal(path.basename(String(prefix)),"ygl-b6-");return mkdtemp.call(this,path.join(dir,"home-"),...args);};',
   'cp.spawnSync=function(cmd,argv,options){const env=options.env;fs.appendFileSync(path.join(dir,"children.jsonl"),JSON.stringify({cmd,argv,db:env.YGL_DB_URL,pg:env.YGL_PG_URL,sentinel:env.G7_ENV_SENTINEL})+"\\n");return {status:argv[1]==="db"&&argv[2]==="init"&&env.YGL_DB_URL?2:0,signal:null,stdout:"",stderr:""};};',
   'require("node:module").syncBuiltinESMExports();',
  ].join("\n");
  writeFileSync(preload,capture);
  const callerPG="postgres://pg-input@127.0.0.1:1/unused",callerDB="postgres://db-input@127.0.0.1:1/unused";
  try{
   for(const [name,pg,db,selected]of [["pg-wins",callerPG,callerDB,callerPG],["db-fallback","",callerDB,callerDB],["no-target","","",""]]){
    const fixture=join(dir,name);mkdirSync(fixture);
    const r=spawnSync(process.execPath,["--require",preload,resolve(root,"scripts/dual-backend-matrix.mjs"),"--strict","--json"],{
     cwd:root,encoding:"utf8",timeout:15000,
     env:{...process.env,YGL_PG_URL:pg,YGL_DB_URL:db,G7_ENV_FIXTURE:fixture,G7_ENV_SENTINEL:"keep-me"},
    });
    expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(selected?0:1);
    const report=JSON.parse(r.stdout),children=readFileSync(join(fixture,"children.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(children).toHaveLength(selected?10:5);
    for(const child of children.slice(0,5))expect(child).toMatchObject({db:"",pg:"",sentinel:"keep-me"});
    expect(report.legs[0].status).toBe("pass");
    if(selected){
     for(const index of [5,6,8])expect(children[index]).toMatchObject({db:selected,pg:"",sentinel:"keep-me"});
     for(const index of [7,9])expect(children[index]).toMatchObject({db:"",pg:"",sentinel:"keep-me"});
     expect(report.legs[1].status).toBe("pass");expect(report.overall).toBe("pass");
    }else{expect(report.legs[1].status).toBe("skipped");expect(report.overall).toBe("fail");}
   }
  }finally{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it("G7 builds the checked-out head after PG is ready and before any suite runs (no stale dist)",()=>{
  const g=readFileSync(resolve(root,"scripts/pg-gate.sh"),"utf8");
  const ready=g.lastIndexOf("pg_isready"),build=g.indexOf("pnpm build >"),b8=g.indexOf("dual-backend-matrix.mjs --b8-pg-only");
  expect(ready).toBeGreaterThan(-1);expect(build).toBeGreaterThan(ready);expect(b8).toBeGreaterThan(build);
  expect(g).toMatch(/pnpm build > tmp\/pg-gate-build\.log 2>&1 \|\| \{[^}]*exit 1; \}/);
 });
 it("release documentation requires actual B8 passed/skipped counts",()=>{
  const s=readFileSync(resolve(root,"docs/release.md"),"utf8");expect(s).toContain("b8_pg");expect(s).toContain("0 skipped");
 });
 it("discovers all real PG spec files without including its own gate regression",async()=>{const {pgSpecs}=await loadGate();const specs=pgSpecs();expect(specs).toHaveLength(10);expect(specs).toContain("packages/ops/tools/tests/b8-pg-claim-scope.spec.ts");expect(specs).toContain("packages/ops/tools/tests/b8-pg-upgrade.spec.ts");expect(specs).toContain("packages/ops/tools/tests/b8-pg-techtree.spec.ts");expect(specs.every((s:string)=>!s.endsWith("/b8-pg-gate.spec.ts"))).toBe(true);});
 it("counting rejects skips, failures, missing suites and empty real-PG reports",async()=>{
  const {countPgReport}=await loadGate();const spec="packages/x/tests/b8-pg-x.spec.ts";const row=(status:string)=>({name:root+"/"+spec,assertionResults:[{status,ancestorTitles:["real PG"]}]});
  expect(countPgReport({success:true,testResults:[row("passed")]},[spec])).toMatchObject({passed:1,skipped:0});
  for(const status of ["pending","skipped","failed","todo"]){expect(()=>countPgReport({success:true,testResults:[row(status)]},[spec])).toThrow();}
  expect(()=>countPgReport({success:true,testResults:[]},[spec])).toThrow();expect(()=>countPgReport({success:false,testResults:[row("passed")]},[spec])).toThrow();
  const offline=row("passed");offline.assertionResults[0].ancestorTitles=["B8 PG primitives"];expect(()=>countPgReport({success:true,testResults:[offline]},[spec])).toThrow();
 });
 it("unconfigured and unreachable PG are errors, never successful skipped gates",()=>{
  for(const url of ["","postgres://vrfyuser:vrfypass@127.0.0.1:1/no-db"]){const r=spawnSync(process.execPath,[resolve(root,"scripts/dual-backend-matrix.mjs"),"--b8-pg-only"],{cwd:root,env:{...process.env,B8_TEST_PG_ADMIN_URL:url},encoding:"utf8",timeout:10000});expect(r.status).toBe(1);expect(r.stderr).toContain("b8_pg: FAIL");expect(r.stdout+r.stderr).not.toMatch(/vrfyuser|vrfypass/);}
 });
 it("G7 cannot silently fall back when Docker is absent",()=>{
  const r=spawnSync(process.execPath,[resolve(root,"scripts/run-sh.mjs"),"docker() { return 127; }; export -f docker; bash scripts/pg-gate.sh"],{cwd:root,encoding:"utf8",timeout:10000});expect(r.status).toBe(1);expect(r.stdout+r.stderr).toContain("docker unavailable");
 });
 it("failed docker creation never removes an existing same-name container",()=>{
  mkdirSync(join(root,"tmp"),{recursive:true});const dir=mkdtempSync(join(root,"tmp/g7-ownership-")),trace=join(dir,"docker.log");
  try{
   const r=spawnSync(process.execPath,[resolve(root,"scripts/run-sh.mjs"),'docker() { printf "%s\n" "$*" >> "$G7_TEST_TRACE"; case "$1" in info) return 0;; run) return 1;; rm) return 0;; esac; }; export -f docker; bash scripts/pg-gate.sh'],{cwd:root,env:{...process.env,G7_TEST_TRACE:trace},encoding:"utf8",timeout:10000});
   expect(r.status).toBe(1);const log=readFileSync(trace,"utf8");expect(log).toContain("run -d --name");expect(log).not.toContain("rm -f");
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it("cleanup after successful create uses its immutable container ID, not a reusable name",()=>{
  mkdirSync(join(root,"tmp"),{recursive:true});const dir=mkdtempSync(join(root,"tmp/g7-ownership-")),trace=join(dir,"docker.log"),id="a".repeat(64);
  try{
   const r=spawnSync(process.execPath,[resolve(root,"scripts/run-sh.mjs"),'docker() { printf "%s\n" "$*" >> "$G7_TEST_TRACE"; case "$1" in info) return 0;; run) printf "%s\n" "$G7_TEST_ID"; return 0;; exec) return 1;; rm) return 0;; esac; }; sleep() { :; }; export -f docker sleep; bash scripts/pg-gate.sh'],{cwd:root,env:{...process.env,G7_TEST_TRACE:trace,G7_TEST_ID:id},encoding:"utf8",timeout:10000});
   expect(r.status).toBe(1);const log=readFileSync(trace,"utf8");expect(log).toContain("rm -f "+id);expect(log).not.toMatch(/rm -f ygl-pg-gate-/);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it("B8 direct invocation rejects external targets before contacting PostgreSQL",()=>{
  const r=spawnSync(process.execPath,[resolve(root,"scripts/dual-backend-matrix.mjs"),"--b8-pg-only"],{cwd:root,env:{...process.env,B8_TEST_PG_ADMIN_URL:"postgres://vrfyuser:vrfypass@no-pg-target.invalid/postgres"},encoding:"utf8",timeout:10000});
  expect(r.status).toBe(1);expect(r.stderr).toContain("isolated loopback");expect(r.stdout+r.stderr).not.toMatch(/vrfyuser|vrfypass|no-pg-target/);
 });
 it("target parser accepts explicit numeric loopback admin endpoints",async()=>{
  const {b8TestTarget}=await loadGate();
  for(const u of ["postgres://u:p@127.0.0.1:54321/postgres","postgresql://u:p@[::1]:54321/postgres"]){expect(b8TestTarget(u)).toBe(u);}
 });
 it("target parser rejects redirects, alternate databases and ambiguous destinations",async()=>{
  const {b8TestTarget}=await loadGate();
  for(const u of ["postgres://localhost:54321/postgres","postgres://127.0.0.1/postgres","postgres://127.0.0.1:54321/live","postgres://127.0.0.1:54321/postgres?host=remote.invalid","postgres://127.0.0.1:54321/postgres?hostaddr=192.0.2.1","postgres://127.0.0.1:54321/postgres?service=live","postgres://127.0.0.1:54321/postgres#remote","not a URL"]){expect(()=>b8TestTarget(u)).toThrow(/isolated loopback/);}
 });
});
