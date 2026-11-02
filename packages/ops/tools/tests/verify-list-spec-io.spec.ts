import {describe,it,expect,vi,afterEach} from "vitest";
import * as fs from "node:fs/promises";
import {basename,dirname} from "node:path";
import {specRows} from "../src/verify-list";
vi.mock("node:fs/promises",()=>({readdir:vi.fn(),readFile:vi.fn()}));
vi.mock("../src/verify-list-index",()=>({readListIndex:(_home:string,read:any)=>read({prepare:()=>({all:()=>[{spec_id:"a",runs:2}],get:()=>({run_id:"r2",overall:"PASS"})})})}));
afterEach(()=>vi.resetAllMocks());
const dir=(name:string,isDirectory=true)=>({name,isDirectory:()=>isDirectory});
const payload=(file:string)=>basename(file)==="prepare.json"?"{}":JSON.stringify({spec_id:basename(dirname(file)),title:basename(dirname(file)),vu:[]});
describe("#156 spec summary I/O",()=>{
 it("overlaps bounded directory batches and keeps sorted order despite reverse completion",async()=>{
  const names=Array.from({length:35},(_,i)=>"s"+String(i).padStart(2,"0"));
  vi.mocked(fs.readdir).mockResolvedValue([...names].reverse().map(n=>dir(n)) as any);
  let active=0,peak=0,draining=false;
  const pending:Array<{file:string;resolve:(text:string)=>void}>=[];
  vi.mocked(fs.readFile).mockImplementation(((file:string)=>{
   if(draining)return Promise.resolve(payload(file));
   active++;peak=Math.max(peak,active);
   return new Promise<string>(resolve=>pending.push({file,resolve})).finally(()=>active--);
  }) as any);
  const request=specRows({home:"fixture"} as any);
  const release=(start:number)=>{for(const r of pending.slice(start).reverse())r.resolve(payload(r.file));};
  try{
   await Promise.resolve();
   expect(pending).toHaveLength(32);expect(active).toBe(32);
   release(0);await vi.waitFor(()=>expect(pending).toHaveLength(64));
   expect(active).toBe(32);release(32);await vi.waitFor(()=>expect(pending).toHaveLength(70));
   expect(active).toBe(6);release(64);
   expect((await request).map(r=>r.spec_id)).toEqual(names);expect(peak).toBe(32);
  }finally{draining=true;release(0);await request;}
 });
 it("retains filtering, malformed-file handling, optional prepare defaults and indexed counts",async()=>{
  vi.mocked(fs.readdir).mockResolvedValue([dir("z"),dir("broken"),dir("a"),dir("missing"),dir("bad.name"),dir("plain",false)] as any);
  vi.mocked(fs.readFile).mockImplementation((async(file:string)=>{
   const name=basename(dirname(file));
   if(name==="missing"||basename(file)==="prepare.json")throw Object.assign(new Error("missing"),{code:"ENOENT"});
   if(name==="broken")return "{";
   return JSON.stringify({spec_id:name,title:name,spec_version:"2",vu:[{}]});
  }) as any);
  const rows=await specRows({home:"fixture"} as any);
  expect(rows.map(r=>r.spec_id)).toEqual(["a","z"]);
  expect(rows[0]).toMatchObject({spec_version:2,units:1,runs:2,last_run:"r2",last_overall:"PASS",verdict:"",rounds:0,material:""});
  expect(rows[1]).toMatchObject({runs:0,last_run:"",last_overall:""});
  expect(vi.mocked(fs.readFile).mock.calls.every(c=>!String(c[0]).includes("bad.name")&&!String(c[0]).includes("plain"))).toBe(true);
 });
});
