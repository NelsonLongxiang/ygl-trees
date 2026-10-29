/** #120: install the shipped demo and drive the real plugin dispatcher, not a hand-written args object. */
import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {parse} from "../../../core/database/src/types";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");let home="";
function cli(args:string[]){const env={...process.env,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:"plugin-args",YGL_NO_UPDATE_CHECK:"1"};const r=spawnSync(process.execPath,[BIN,...args],{cwd:ROOT,env,encoding:"utf8",timeout:60000});return {rc:r.status,out:r.stdout||"",text:(r.stdout||"")+(r.stderr||"")};}
function greet(args:string[]){const r=cli(["demo","greet",...args,"--json"]);expect(r.rc,r.text).toBe(0);return JSON.parse(r.out);}
describe("plugin args current implementation (unstable details)",()=>{
 beforeAll(()=>{mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/plugin-args-"));for(const args of [["db","init","--json"],["plugin","install",join(ROOT,"examples/plugin-demo"),"--json"]]){const r=cli(args);expect(r.rc,r.text).toBe(0);}},120000);
 afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 it("reads --name from args.flags through actual CLI installation",()=>{expect(greet(["--name","Ada"])).toEqual({plugin:"ygl-plugin-demo",greeting:"Hello, Ada",name:"Ada"});});
 it("accepts inline flags and ordinary repeated flag takes its last value",()=>{expect(greet(["--name=Grace"])).toMatchObject({name:"Grace"});expect(greet(["--name","Ada","--name","Grace"])).toMatchObject({name:"Grace"});});
 it("rest excludes action and positional name is a fallback, with flag precedence",()=>{expect(greet(["Ada"])).toMatchObject({name:"Ada"});expect(greet(["Ada","--name=Grace"])).toMatchObject({name:"Grace"});expect(greet([])).toMatchObject({name:"world"});});
 it("bare or empty --name is rejected rather than rendered as true",()=>{for(const args of [["--name"],["--name="]]){const r=cli(["demo","greet",...args,"--json"]);expect(r.rc,r.text).toBe(2);expect(JSON.parse(r.out).error).toContain("--name");}});
 it("-- ends flag parsing and the remaining option-looking token is positional",()=>{const r=cli(["demo","greet","--json","--","--literal"]);expect(r.rc,r.text).toBe(0);expect(JSON.parse(r.out)).toMatchObject({name:"--literal"});});
 it("records fixed boolean names, inline strings and current repeatable keys without freezing them",()=>{
  expect(parse(["demo","greet","Ada","--name=Grace","--json"])).toEqual({_: ["demo","greet","Ada"],flags:{name:"Grace",json:true}});
  expect(parse(["demo","greet","--toggle","value","--json=false"])).toEqual({_: ["demo","greet"],flags:{toggle:"value",json:"false"}});
  expect(parse(["demo","greet","--toggle","--json"])).toEqual({_: ["demo","greet"],flags:{toggle:true,json:true}});
  expect(parse(["demo","greet","--attach=a","--attach=b","--db=a.db","--db=b.db"])).toEqual({_: ["demo","greet"],flags:{attach:["a","b"],db:["a.db","b.db"]}});
 });
});
