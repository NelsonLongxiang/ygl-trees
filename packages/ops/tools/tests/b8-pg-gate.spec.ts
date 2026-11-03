/** #124: release gate cannot count env-skipped or partial PG suites as passed. */
import {describe,it,expect} from "vitest";
import {readFileSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
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
 it("G7 builds the checked-out head after PG is ready and before any suite runs (no stale dist)",()=>{
  const g=readFileSync(resolve(root,"scripts/pg-gate.sh"),"utf8");
  const ready=g.lastIndexOf("pg_isready"),build=g.indexOf("pnpm build >"),b8=g.indexOf("dual-backend-matrix.mjs --b8-pg-only");
  expect(ready).toBeGreaterThan(-1);expect(build).toBeGreaterThan(ready);expect(b8).toBeGreaterThan(build);
  expect(g).toMatch(/pnpm build > tmp\/pg-gate-build\.log 2>&1 \|\| \{[^}]*exit 1; \}/);
 });
 it("release documentation requires actual B8 passed/skipped counts",()=>{
  const s=readFileSync(resolve(root,"docs/release.md"),"utf8");expect(s).toContain("b8_pg");expect(s).toContain("0 skipped");
 });
 it("discovers all real PG spec files without including its own gate regression",async()=>{const {pgSpecs}=await loadGate();const specs=pgSpecs();expect(specs).toHaveLength(9);expect(specs).toContain("packages/ops/tools/tests/b8-pg-upgrade.spec.ts");expect(specs).toContain("packages/ops/tools/tests/b8-pg-techtree.spec.ts");expect(specs.every((s:string)=>!s.endsWith("/b8-pg-gate.spec.ts"))).toBe(true);});
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
