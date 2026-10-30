/** #125: a real 10k-report directory; warm budgets are regression gates, not production claims. */
import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,utimesSync} from "node:fs";
import {once} from "node:events";
import {createDashboardServer} from "../src/webui";
import {vi} from "vitest";
import {join} from "node:path";
import {handleVerifyApi} from "../src/verify-web";
import {prepareListIndex, updateListIndex} from "../src/verify-list-index";
const writeIndexed=(path:string,value:string)=>{writeFileSync(path,value);updateListIndex(path,JSON.parse(value));};
let home="",env:any;
const api=(path:string)=>Promise.resolve(handleVerifyApi(env,"GET",new URL("http://localhost"+path)));
describe("#125 ten-thousand report list regression",()=>{
 beforeAll(async()=>{mkdirSync("tmp",{recursive:true});home=mkdtempSync(join(process.cwd(),"tmp/verify-list-perf-"));env={home};for(const d of ["reports","archives","specs"])mkdirSync(join(home,"verify",d),{recursive:true});for(let i=0;i<20;i++){const id="spec_"+i;mkdirSync(join(home,"verify/specs",id));writeFileSync(join(home,"verify/specs",id,"spec.json"),JSON.stringify({spec_id:id,title:id,vu:[]}));}for(let i=0;i<10000;i++){const run="run_"+String(i).padStart(5,"0");writeFileSync(join(home,"verify/reports",run+".json"),JSON.stringify({run_id:run,spec_id:"spec_"+(i%20),overall:i%3?"PASS":"FAIL",finished:new Date(1800000000000+i*1000).toISOString(),reason:"x".repeat(1000),summary:{pass:1}}));writeFileSync(join(home,"verify/archives",run+".json"),JSON.stringify({archives:[{archive_id:"arc_"+i,created:new Date(1800000000000+i*1000).toISOString(),filename:run+".zip"}]}));}await prepareListIndex(home);},120000);
 afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 it("default bodies and pages are bounded and complete with stable cursors",async()=>{const a:any=(await api("/api/verify/reports")).body;expect(a.total).toBe(10000);expect(a.items).toHaveLength(200);expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThan(400000);expect(a.next_cursor).toBeTruthy();const b:any=(await api("/api/verify/reports?cursor="+encodeURIComponent(a.next_cursor))).body;expect(b.items).toHaveLength(200);expect(b.items.some((r:any)=>a.items.some((x:any)=>x.run_id===r.run_id))).toBe(false);const arc:any=(await api("/api/verify/archives")).body;expect(arc.total).toBe(10000);expect(arc.items).toHaveLength(200);});
 it("warm indexed spec/filter/report/archive endpoints stay under 200ms each",async()=>{await api("/api/verify/specs");for(const path of ["/api/verify/specs","/api/verify/reports","/api/verify/reports?spec=spec_3","/api/verify/archives"]){const start=performance.now();const r:any=await api(path);const elapsed=performance.now()-start;expect(r.status).toBe(200);expect(elapsed,path).toBeLessThan(200);if(path.includes("spec=spec_3")){expect(r.body.total).toBe(500);expect(r.body.items.every((x:any)=>x.spec_id==="spec_3")).toBe(true);}console.log(JSON.stringify({path,ms:elapsed,bytes:Buffer.byteLength(JSON.stringify(r.body))}));}},30000);
 it("a fresh request environment reads the prepared durable index",async()=>{env={home};const r:any=await api("/api/verify/reports");expect(r.body.total).toBe(10000);expect(r.body.items).toHaveLength(200);},60000);
 it("pagination validation rejects malformed and excessive parameters",async()=>{for(const q of ["limit=0","limit=501","limit=no","cursor=broken"]){expect((await api("/api/verify/reports?"+q)).status).toBe(400);}});
 it("cold HTTP list does not block another real API request",async()=>{
  const server=createDashboardServer({home,db:{get:()=>({n:0})},ctx:{json:true,color:false,quiet:true}} as any);
  server.listen(0,"127.0.0.1");await once(server,"listening");const base="http://127.0.0.1:"+(server.address() as any).port;
  try{let listDone=false;const seen=once(server,"request");const list=fetch(base+"/api/verify/reports").then(async r=>{await r.json();listDone=true;});await seen;
   const start=performance.now();const other=await fetch(base+"/api/node?tree=test");expect(other.status).toBe(400);expect(performance.now()-start).toBeLessThan(500);await list;
  }finally{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});}
 },60000);
 it("index refreshes additions, deletion, sidecar changes and in-place edits without stale counts",async()=>{
  const path=join(home,"verify/reports/run_added.json");writeIndexed(path,JSON.stringify({run_id:"run_added",spec_id:"spec_3",overall:"FAIL",finished:"2099-01-01"}));
  let r:any=(await api("/api/verify/reports?spec=spec_3")).body;expect(r.total).toBe(501);expect(r.items[0].run_id).toBe("run_added");
  writeIndexed(join(home,"verify/archives/run_added.json"),JSON.stringify({archives:[{archive_id:"a",created:"2099"}]}));r=(await api("/api/verify/reports?spec=spec_3")).body;expect(r.items[0].archived).toBe(1);
  writeIndexed(path,JSON.stringify({run_id:"run_added",spec_id:"spec_3",overall:"PASS",finished:"2099-01-01"}));
  const now=Date.now();const clock=vi.spyOn(Date,"now").mockReturnValue(now+6000);try{r=(await api("/api/verify/reports?spec=spec_3")).body;expect(r.items[0].overall).toBe("PASS");}finally{clock.mockRestore();}
  rmSync(path);updateListIndex(path,null);r=(await api("/api/verify/reports?spec=spec_3")).body;expect(r.total).toBe(500);
 },60000);
 it("filter cursor cannot be reused on another spec and only_bad is server-side",async()=>{
  const a:any=(await api("/api/verify/reports?spec=spec_3&only_bad=1&limit=2")).body;expect(a.total).toBeGreaterThan(2);expect(a.items.every((r:any)=>r.overall!=="PASS")).toBe(true);
  expect((await api("/api/verify/reports?spec=spec_4&cursor="+a.next_cursor)).status).toBe(400);
 });
 it("warm per-spec and spec-summary requests do not JSON-parse report files again",async()=>{
  await api("/api/verify/reports?spec=spec_3");const parse=JSON.parse;let reportReads=0;const spy=vi.spyOn(JSON,"parse").mockImplementation(((s:string,...args:any[])=>{if(typeof s==="string"&&s.includes('"run_id"')&&!s.includes('"archived"'))reportReads++;return (parse as any)(s,...args);}) as any);
  try{await api("/api/verify/reports?spec=spec_3");await api("/api/verify/specs");expect(reportReads).toBe(0);}finally{spy.mockRestore();}
 });
 it("keyset pagination survives equal timestamps and insertion before the cursor",async()=>{
  const same="2099-01-02";for(const run of ["run_equal_a","run_equal_b","run_equal_c"]){writeIndexed(join(home,"verify/reports",run+".json"),JSON.stringify({run_id:run,spec_id:"spec_equal",finished:same}));}
  const first:any=(await api("/api/verify/reports?spec=spec_equal&limit=1")).body;expect(first.items[0].run_id).toBe("run_equal_c");
  writeIndexed(join(home,"verify/reports/run_equal_new.json"),JSON.stringify({run_id:"run_equal_new",spec_id:"spec_equal",finished:"2100"}));
  const next:any=(await api("/api/verify/reports?spec=spec_equal&limit=2&cursor="+first.next_cursor)).body;expect(next.items.map((r:any)=>r.run_id)).toEqual(["run_equal_b","run_equal_a"]);expect(next.next_cursor).toBeNull();
 },60000);
 it("requests separated beyond five seconds keep the 10k budget with zero source-file stats",async()=>{
  for(let n=1;n<=3;n++){const clock=vi.spyOn(Date,"now").mockReturnValue(1800000000000+n*10000);try{for(const path of ["/api/verify/reports?spec=spec_3","/api/verify/specs","/api/verify/archives"]){const start=performance.now();const r=await api(path);expect(r.status).toBe(200);expect(performance.now()-start,path).toBeLessThan(200);}}finally{clock.mockRestore();}}
 });
});
