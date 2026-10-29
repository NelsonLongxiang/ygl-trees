/** #119: real HTTP + child CLI proofs; isolated workspace, no live credentials. */
import {describe,it,expect,beforeAll,afterAll,beforeEach,vi} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import * as http from "node:http";
import {once} from "node:events";
import {serveMcpHttp,buildTools} from "../src/mcp";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let home="",port=0,server:http.Server,oldEnv:NodeJS.ProcessEnv,oldArgv:string;
const writes:string[]=[];let environment:NodeJS.ProcessEnv;
const childInvocations:{argv:string[];env:NodeJS.ProcessEnv}[]=[];const childOutput:string[]=[];let spawnSpy:any;
function boot(args:string[],session="startup"){const r=spawnSync(process.execPath,[BIN,...args,"--json"],{cwd:ROOT,encoding:"utf8",env:{...process.env,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:session,YGL_NO_UPDATE_CHECK:"1"},timeout:60000});expect(r.status,r.stdout+r.stderr).toBe(0);return JSON.parse(r.stdout);}
function request(body:unknown,session?:string){return new Promise<any>((resolve,reject)=>{const data=JSON.stringify(body);const req=http.request({host:"127.0.0.1",port,path:"/mcp",method:"POST",headers:{"content-type":"application/json",...(session?{"x-ygl-session":session}:{})}},res=>{let out="";res.on("data",d=>out+=d);res.on("end",()=>{try{resolve(JSON.parse(out));}catch(e){reject(e);}});});req.on("error",reject);req.setTimeout(15000,()=>req.destroy(new Error("MCP request timeout")));req.end(data);});}
async function call(tool:string,args:Record<string,unknown>,session?:string){const r=await request({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:tool,arguments:args}},session);expect(r.error,JSON.stringify(r)).toBeUndefined();return r.result;}
async function good(tool:string,args:Record<string,unknown>,session?:string){const r=await call(tool,args,session);expect(r.isError,JSON.stringify(r)).toBeFalsy();return JSON.parse(r.content[0].text);}
function partial(session:string,tool="read",args:Record<string,unknown>={domain:"project",action:"show"}){let resolve!:(r:any)=>void,reject!:(e:any)=>void;const result=new Promise<any>((r,j)=>{resolve=r;reject=j;});const req=http.request({host:"127.0.0.1",port,path:"/mcp",method:"POST",headers:{"content-type":"application/json","x-ygl-session":session}},res=>{let out="";res.on("data",d=>out+=d);res.on("end",()=>{try{resolve(JSON.parse(out));}catch(e){reject(e);}});});req.on("error",reject);req.setTimeout(15000,()=>req.destroy(new Error("partial MCP request timeout")));const data=JSON.stringify({jsonrpc:"2.0",id:session,method:"tools/call",params:{name:tool,arguments:args}});req.write(data.slice(0,20));return {req,result,tail:data.slice(20)};}

describe("#119 MCP argv and request-session safety",()=>{
 beforeAll(async()=>{
  mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/mcp-safety-"));
  boot(["db","init"]);boot(["project","new","startup-project"]);boot(["project","new","alpha"],"s-A");boot(["project","new","beta"],"s-B");
  oldEnv=process.env;oldArgv=process.argv[1];process.argv[1]=BIN;
  environment={...oldEnv,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:"startup",YGL_NO_UPDATE_CHECK:"1",PGUSER:"vrfyuser",PGPASSWORD:"vrfypass"};
  process.env=new Proxy(environment,{set(target,key,value){writes.push(String(key));target[String(key)]=String(value);return true;},deleteProperty(target,key){writes.push(String(key));delete target[String(key)];return true;}});
  const cp=require("node:child_process");const realSpawn=cp.spawn;spawnSpy=vi.spyOn(cp,"spawn").mockImplementation((cmd:any,argv:any,opts:any)=>{childInvocations.push({argv:[...argv],env:{...opts.env}});const child=realSpawn(cmd,argv,opts);child.stdout?.on("data",(d:Buffer)=>childOutput.push(d.toString()));child.stderr?.on("data",(d:Buffer)=>childOutput.push(d.toString()));return child;});
  server=serveMcpHttp("0.117.0",0);await once(server,"listening");port=(server.address() as any).port;
 },120000);
 beforeEach(()=>{environment.YGL_SESSION="startup";writes.length=0;childInvocations.length=0;childOutput.length=0;});
 afterAll(async()=>{if(server){await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});}spawnSpy?.mockRestore();if(oldEnv)process.env=oldEnv;if(oldArgv)process.argv[1]=oldArgv;if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 it("kb add routes title+body and title+file to successful CLI writes",async()=>{
  const r=await good("write",{domain:"kb",action:"add",name:"MCP body",body:"body text"});expect(r).toMatchObject({title:"MCP body",body:"body text",verified:true});
  const file=join(home,"note.md");writeFileSync(file,"file text");expect(await good("write",{domain:"kb",action:"add",name:"MCP file",file})).toMatchObject({title:"MCP file",body:"file text"});
 });
 it("rel attach maps typed endpoints to real rel add with the requested relation",async()=>{
  await good("write",{domain:"tree",action:"tree-new",tree:"relations"});const n=await good("write",{domain:"tree",action:"node-add",tree:"relations",key:"node-a"});
  const note=await good("write",{domain:"kb",action:"add",name:"linked-note",body:"reference"});
  const r=await good("write",{domain:"rel",action:"attach",node:"relations/node-a",type:"evidenced-by",target:"kb:"+note.id});expect(r).toMatchObject({src:"node:"+n.id,dst:"kb:"+note.id,rel:"evidenced-by"});
 });
 it("node-cond exposes op/value and creates a gate that can actually be satisfied",async()=>{
  await good("write",{domain:"tree",action:"tree-new",tree:"gates"});await good("write",{domain:"tree",action:"node-add",tree:"gates",key:"b"});
  const c=await good("write",{domain:"tree",action:"node-cond",tree:"gates",key:"b",name:"budget",kind:"resource",op:">=",value:"2"});expect(c).toMatchObject({name:"budget",op:">=",value:"2"});
  expect(await good("read",{domain:"node",action:"can",tree:"gates",key:"b",state:"budget=2"})).toMatchObject({ok:true});
 });
 it("node condition missing op/value fails closed before storing an unusable gate",async()=>{
  const r=await call("write",{domain:"tree",action:"node-cond",tree:"gates",key:"b",name:"incomplete"});expect(r.isError).toBe(true);expect(JSON.parse(r.content[0].text)).toMatchObject({rc:2,error:expect.stringMatching(/op|value/)});
 });
 it("context is forwarded for can/ready/unlock without changing the default context",async()=>{
  await good("write",{domain:"tree",action:"node-add",tree:"gates",key:"ctx-node"});await good("write",{domain:"tree",action:"node-add",tree:"gates",key:"ctx-child"});await good("write",{domain:"tree",action:"node-link",tree:"gates",key:"ctx-node",child:"ctx-child"});
  const unlocked=await good("write",{domain:"tree",action:"node-unlock",tree:"gates",key:"ctx-node",context:"c1"});expect(unlocked).toMatchObject({context:"c1"});
  expect(await good("read",{domain:"node",action:"can",tree:"gates",key:"ctx-child",context:"c1"})).toMatchObject({ok:true});
  expect(await good("read",{domain:"node",action:"can",tree:"gates",key:"ctx-child",context:"c2"})).toMatchObject({ok:false});
  const ready=await good("read",{domain:"node",action:"ready",tree:"gates",context:"c1"});expect(JSON.stringify(ready)).not.toContain('"key":"ctx-node"');
 });
 it("interleaved request bodies preserve both caller sessions and never assign process.env",async()=>{
  let seen=once(server,"request");const a=partial("s-A");await seen;
  seen=once(server,"request");const b=partial("s-B");await seen;
  a.req.end(a.tail);b.req.end(b.tail);const [ra,rb]=await Promise.all([a.result,b.result]);
  const ja=JSON.parse(ra.result.content[0].text),jb=JSON.parse(rb.result.content[0].text);expect(ja.project.name).toBe("alpha");expect(jb.project.name).toBe("beta");expect(writes).toEqual([]);expect(process.env.YGL_SESSION).toBe("startup");
  expect(childInvocations.map(c=>c.env.YGL_SESSION).sort()).toEqual(["s-A","s-B"]);for(const c of childInvocations){expect(c.env.PGUSER).toBe("vrfyuser");expect(c.env.PGPASSWORD).toBe("vrfypass");expect(c.argv.join(" ")).not.toMatch(/vrfyuser|vrfypass/);}expect(JSON.stringify([ra,rb])).not.toMatch(/vrfyuser|vrfypass/);
 });
 it("interleaved writes land in the caller project without cross-request data leakage",async()=>{
  let seen=once(server,"request");const a=partial("s-A","write",{domain:"research",action:"query-add",text:"only-alpha"});await seen;
  seen=once(server,"request");const b=partial("s-B","write",{domain:"research",action:"query-add",text:"only-beta"});await seen;
  b.req.end(b.tail);const rb=await b.result;a.req.end(a.tail);const ra=await a.result;expect(ra.result.isError).toBeFalsy();expect(rb.result.isError).toBeFalsy();
  const alpha=await good("read",{domain:"research",action:"query-list"},"s-A"),beta=await good("read",{domain:"research",action:"query-list"},"s-B");expect(alpha.map((q:any)=>q.text)).toContain("only-alpha");expect(alpha.map((q:any)=>q.text)).not.toContain("only-beta");expect(beta.map((q:any)=>q.text)).toContain("only-beta");expect(beta.map((q:any)=>q.text)).not.toContain("only-alpha");expect(writes).toEqual([]);
 });
 it("headerless request after a headed request uses the startup session, not a sticky caller",async()=>{
  expect((await good("read",{domain:"project",action:"show"},"s-A")).project.name).toBe("alpha");
  environment.YGL_SESSION="later-global-change";
  expect((await good("read",{domain:"project",action:"show"})).project.name).toBe("startup-project");expect(writes).toEqual([]);expect(childInvocations.map(c=>c.env.YGL_SESSION)).toEqual(["s-A","startup"]);
 });
 it("schemas expose context and explicit condition inputs without adding lock/path mutation tools",async()=>{
  const list=await request({jsonrpc:"2.0",id:2,method:"tools/list"});const tools=list.result.tools;const read=tools.find((t:any)=>t.name==="read"),write=tools.find((t:any)=>t.name==="write");expect(read.inputSchema.properties.context.type).toBe("string");expect(write.inputSchema.properties.context.type).toBe("string");expect(write.inputSchema.properties.op.enum).toContain(">=");expect(write.inputSchema.properties.value).toBeDefined();expect(write.inputSchema.properties.action.enum).not.toContain("node-lock");
 });
 it("PG credentials stay in the controlled child env, never argv or error output",async()=>{
  const url="postgres://vrfyuser:vrfypass@127.0.0.1:1/no-db?password=vrfypass";
  const tools=buildTools({...environment,YGL_HOME:join(home,"pg-failure"),YGL_DB_URL:url});const tool=tools.find(t=>t.name==="write")!;
  let error:any;try{await tool.execute({domain:"kb",action:"add",name:"PG fail",body:"x"});}catch(e){error=e;}
  expect(error?.rc).toBe(1);expect(childInvocations).toHaveLength(1);expect(childInvocations[0].env.YGL_DB_URL).toBe(url);expect(childInvocations[0].argv.join(" ")).not.toMatch(/vrfyuser|vrfypass|postgres:\/\//);expect(JSON.stringify(error.json)+error.message).not.toMatch(/vrfyuser|vrfypass/);expect(childOutput.join("")).not.toMatch(/vrfyuser|vrfypass/);expect(writes).toEqual([]);
 });
});
