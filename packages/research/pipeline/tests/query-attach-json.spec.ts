/** #114: parse the entire CLI stdout; keep duplicate and human output semantics. */
import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let home="",query="",source="";
function cli(args:string[]){const env={...process.env,YGL_HOME:home,YGL_DB_URL:"",YGL_SESSION:"query-json",YGL_NO_UPDATE_CHECK:"1"};const r=spawnSync(process.execPath,[BIN,...args],{cwd:ROOT,env,encoding:"utf8",timeout:20000});return{rc:r.status,out:r.stdout||"",err:r.stderr||""};}
function good(args:string[]){const r=cli([...args,"--json"]);expect(r.rc,r.out+r.err).toBe(0);return JSON.parse(r.out);}
describe("#114 query attach JSON contract",()=>{
 beforeAll(()=>{mkdirSync(join(ROOT,"tmp"),{recursive:true});home=mkdtempSync(join(ROOT,"tmp/query-json-"));good(["db","init"]);good(["project","new","query-json"]);query=good(["research","query","add","query text"]).id;source=good(["research","source","add","--title","source title","--url","session://query-json"]).id;},60000);
 afterAll(()=>{if(home)rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 it("success stdout is exactly one JSON object matching the existing PG receipt shape",()=>{const r=cli(["research","query","attach",query,source,"--json"]);expect(r.rc,r.out+r.err).toBe(0);expect(JSON.parse(r.out)).toEqual({query,source});expect(r.err).toBe("");});
 it("duplicate succeeds with duplicate true and does not duplicate link/event",()=>{expect(good(["research","query","attach",query,source])).toEqual({query,source,duplicate:true});const rows=good(["research","query","list"]);expect(rows.find((q:any)=>q.id===query).sources).toBe(1);const audit=good(["db","sql","SELECT COUNT(*) AS n FROM events WHERE kind='query.attach'"]);expect(audit[0].n).toBe(1);});
 it("human success and duplicate text stays unchanged",()=>{const q=good(["research","query","add","human query"]).id;const a=cli(["research","query","attach",q,source,"--no-color"]);expect(a.rc).toBe(0);expect(a.out).toBe('  ✓ attached: source title → "human query"\n');const b=cli(["research","query","attach",q,source,"--no-color"]);expect(b.rc).toBe(0);expect(b.out).toBe('  ! already attached: '+source+'\n');});
 it("usage and missing references retain one JSON error and rc category",()=>{for(const [args,rc,message]of [[["research","query","attach"],2,"usage:"],[["research","query","attach","missing-query",source],1,"query not found"],[["research","query","attach",query,"missing-source"],1,"source not found"]] as const){const r=cli([...args,"--json"]);expect(r.rc,r.out+r.err).toBe(rc);expect(JSON.parse(r.out)).toEqual({error:expect.stringContaining(message)});}});
});
