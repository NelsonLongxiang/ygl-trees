/** Independent published-bundle HTTP proof: complete B's body before A's, without sleeps. */
import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {spawn,spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import * as http from "node:http";
import {once} from "node:events";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let home="",port=0,child:ReturnType<typeof spawn>|undefined;
function boot(args:string[],sid:string){const r=spawnSync(process.execPath,[BIN,...args,"--json"],{encoding:"utf8",cwd:ROOT,env:{...process.env,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:sid,YGL_NO_UPDATE_CHECK:"1"},timeout:60000});expect(r.status,r.stdout+r.stderr).toBe(0);}
function startRequest(sid?:string,tool="read",args:Record<string,unknown>={domain:"project",action:"show"}){const data=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:tool,arguments:args}});let resolve!:(r:any)=>void,reject!:(e:any)=>void;const result=new Promise<any>((r,j)=>{resolve=r;reject=j;});const req=http.request({host:"127.0.0.1",port,path:"/mcp",method:"POST",headers:{"content-type":"application/json",...(sid?{"x-ygl-session":sid}:{})}},res=>{let out="";res.on("data",d=>out+=d);res.on("end",()=>{try{resolve(JSON.parse(out));}catch(e){reject(e);}});});req.on("error",reject);req.setTimeout(15000,()=>req.destroy(new Error("bundle request timeout")));req.write(data.slice(0,20));return{req,result,tail:data.slice(20)};}
const project=(r:any)=>{expect(r.result?.isError,JSON.stringify(r)).toBeFalsy();return JSON.parse(r.result.content[0].text).project.name;};
describe("#119 published bundle HTTP request isolation",()=>{
 beforeAll(async()=>{
  mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/mcp-bundle-session-"));boot(["db","init"],"startup");boot(["project","new","startup-project"],"startup");boot(["project","new","alpha"],"s-A");boot(["project","new","beta"],"s-B");
  const net=require("node:net");const probe=net.createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");port=probe.address().port;await new Promise<void>(r=>probe.close(()=>r()));
  child=spawn(process.execPath,[BIN,"mcp","--http","--port",String(port)],{cwd:ROOT,env:{...process.env,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:"startup",YGL_NO_UPDATE_CHECK:"1"},stdio:["ignore","pipe","pipe"]});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("MCP bundle startup timeout")),15000);const on=(b:Buffer)=>{if(b.toString().includes("HTTP server ready")){clearTimeout(timer);resolve();}};child!.stderr!.on("data",on);child!.on("error",e=>{clearTimeout(timer);reject(e);});});
 },120000);
 afterAll(async()=>{if(child&&child.exitCode===null){const exited=once(child,"close");child.kill();await exited;}if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 it("published mapping plus three controlled interleavings preserve A/B and startup selection",async()=>{
  const exec=async(tool:string,args:Record<string,unknown>)=>{const r=startRequest(undefined,tool,args);r.req.end(r.tail);const response=await r.result;expect(response.result.isError,JSON.stringify(response)).toBeFalsy();return JSON.parse(response.result.content[0].text);};
  const kb=await exec("write",{domain:"kb",action:"add",name:"bundle-note",body:"bundle body"});expect(kb.title).toBe("bundle-note");
  await exec("write",{domain:"tree",action:"tree-new",tree:"bundle-tree"});const node=await exec("write",{domain:"tree",action:"node-add",tree:"bundle-tree",key:"n"});
  const rel=await exec("write",{domain:"rel",action:"attach",node:"bundle-tree/n",type:"evidenced-by",target:"kb:"+kb.id});expect(rel.src).toBe("node:"+node.id);
  await exec("write",{domain:"tree",action:"node-cond",tree:"bundle-tree",key:"n",name:"budget",op:">=",value:2});expect(await exec("read",{domain:"node",action:"can",tree:"bundle-tree",key:"n",state:"budget=2"})).toMatchObject({ok:true});
  for(let i=0;i<3;i++){
   const a=startRequest("s-A");a.req.flushHeaders();
   const b=startRequest("s-B");b.req.end(b.tail);const rb=await b.result;
   a.req.end(a.tail);const ra=await a.result;
   expect(project(ra)).toBe("alpha");expect(project(rb)).toBe("beta");
   const noHeader=startRequest();noHeader.req.end(noHeader.tail);expect(project(await noHeader.result)).toBe("startup-project");
  }
 });
});
