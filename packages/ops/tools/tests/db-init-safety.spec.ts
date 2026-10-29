/** #115: init validation must run before opening or creating any workspace file. */
import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,rmSync,existsSync,readdirSync,writeFileSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
const ROOT=resolve(__dirname,"../../../.."),BIN=join(ROOT,"dist/bundle/bin.cjs");
let dir="",serial=0;
const pg="postgres://init-user:init-secret@127.0.0.1:1/not-a-database?password=query-secret";
function run(args:string[],home:string,pgUrl=""){
 const env:NodeJS.ProcessEnv={...process.env,YGL_HOME:home,YGL_SESSION:"init-safety",YGL_DB_URL:pgUrl,YGL_NO_UPDATE_CHECK:"1"};
 delete env.YGL_PG_URL;delete env.DSH_SESSION_ID;
 const r=spawnSync(process.execPath,[BIN,...args],{cwd:ROOT,env,encoding:"utf8",timeout:20000});
 return {rc:r.status,out:r.stdout||"",err:r.stderr||"",text:(r.stdout||"")+(r.stderr||"")};
}
const home=()=>join(dir,"home-"+(++serial));
function refusal(r:ReturnType<typeof run>){expect(r.rc,r.text).toBe(2);expect(JSON.parse(r.out)).toEqual({error:expect.any(String)});for(const s of ["init-secret","query-secret","init-user"])expect(r.text).not.toContain(s);}
describe("#115 db init fail-closed",()=>{
 beforeAll(()=>{mkdirSync(join(ROOT,"tmp"),{recursive:true});dir=mkdtempSync(join(ROOT,"tmp/init-safety-"));});
 afterAll(()=>rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 it("PG target refuses init before even creating a nonexistent home",()=>{const h=home();const r=run(["db","init","--json"],h,pg);refusal(r);expect(r.text).toContain("db migrate pg");expect(existsSync(h)).toBe(false);});
 it("PG init leaves an existing empty home empty",()=>{const h=home();mkdirSync(h);refusal(run(["db","init","--json"],h,pg));expect(readdirSync(h)).toEqual([]);});
 for(const target of ["",pg])for(const flag of [["--backend","pg"],["--backend=sqlite"],["--bogus-flag"],["--backend","sqlite","--bogus-flag"]]){
  it((target?"PG":"SQLite")+" rejects unknown init option "+flag.join(" ")+" without files",()=>{const h=home();const r=run(["db","init",...flag,"--json"],h,target);refusal(r);expect(r.text).toContain("unknown");expect(existsSync(h)).toBe(false);});
 }
 it("extra positional init arguments refuse without echoing URL credentials",()=>{const h=home();const r=run(["db","init",pg,"--json"],h);refusal(r);expect(existsSync(h)).toBe(false);});
 it("bare --home and --db refuse before side effects",()=>{for(const flag of ["--home","--db"]){const h=home();refusal(run(["db","init",flag,"--json"],h));expect(existsSync(h)).toBe(false);}});
 it("SQLite init is still supported with explicit home and DB path",()=>{const h=home(),file=join(dir,"explicit.sqlite");const r=run(["db","init","--home",h,"--db",file,"--json"] ,home());expect(r.rc,r.text).toBe(0);expect(JSON.parse(r.out).db).toBe(file);expect(existsSync(file)).toBe(true);});
 it("PG init never alters an existing workspace or explicit DB sentinel",()=>{const h=home(),file=join(dir,"sentinel.sqlite");mkdirSync(h);writeFileSync(join(h,"ygl-trees.db"),"original-home-bytes");writeFileSync(file,"explicit-db-bytes");refusal(run(["db","init","--db",file,"--json"],h,pg));expect(readFileSync(file,"utf8")).toBe("explicit-db-bytes");expect(readFileSync(join(h,"ygl-trees.db"),"utf8")).toBe("original-home-bytes");expect(readdirSync(h)).toEqual(["ygl-trees.db"]);});
 it("PG/SQLite conflict identifies the SQLite artifact but never its PG credentials",()=>{const h=home();mkdirSync(h);const file=join(h,"ygl-trees.db");writeFileSync(file,"sentinel");const r=run(["kb","add","--title","refuse","--body","x","--json"],h,pg);refusal(r);expect(r.text).toContain("SQLite file");expect(JSON.parse(r.out).error).toContain(file);expect(readFileSync(file,"utf8")).toBe("sentinel");});
 it("PG refusal no longer advertises db init as a PG-direct face",()=>{const r=run(["project","restore","x","--json"],home(),pg);refusal(r);expect(r.text).not.toContain("| db init |");});
 it("matrix expects PG init refusal and still validates real PG stats",()=>{const source=readFileSync(join(ROOT,"scripts/dual-backend-matrix.mjs"),"utf8");const init=source.split("\n").find(l=>l.includes('["init-pg-refused"'));expect(init).toContain("expectedRc: 2");expect(init).toContain("noFilesUnder: pgHome");expect(init).toContain("YGL_DB_URL: pgUrl");const stats=source.split("\n").find(l=>l.includes('["pg-stats"'));expect(stats).toContain("YGL_DB_URL: pgUrl");expect(stats).not.toContain("expectedRc: 2");expect(source).toContain('YGL_DB_URL: "", ...(opts.env || {})');});
 it("help remains DB-free even under a PG environment",()=>{const h=home();const r=run(["db","init","--help","--json"],h,pg);expect(r.rc,r.text).toBe(0);expect(JSON.parse(r.out).help).toBeTypeOf("string");expect(existsSync(h)).toBe(false);});
});
