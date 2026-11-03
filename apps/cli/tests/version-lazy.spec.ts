/** Run after build; the CJS preload rejects accidental eager TypeORM loading. */
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
const ROOT=resolve(__dirname,"../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let home="",preload="";
beforeAll(()=>{
 mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/version-lazy-"));preload=join(home,"reject-orm.cjs");
 writeFileSync(preload,'const m=require("node:module"),load=m._load;m._load=function(id,...args){if(id==="typeorm")throw new Error("metadata-only command loaded TypeORM");return load.call(this,id,...args);};');
});
afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
describe("metadata-only commands do not load domain dependencies",()=>{
 it.each([["--version"],["version"],["research","predict","score","--help"],["llms","--json"]])("runs %j without loading TypeORM",(...args:string[])=>{
  const r=spawnSync(process.execPath,["--require",preload,BIN,...args],{cwd:home,env:{...process.env,YGL_HOME:home,YGL_TEST:"1",YGL_NO_UPDATE_CHECK:"1"},encoding:"utf8",timeout:30000});
  expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);
  if(args[0]==="--version"||args[0]==="version")expect(r.stdout.trim()).toBe(JSON.parse(readFileSync(join(ROOT,"package.json"),"utf8")).version);
  else if(args[0]==="llms")expect(JSON.parse(r.stdout).sections).toBeTruthy();
  else expect(r.stdout).toContain("predict score");
 });
});
