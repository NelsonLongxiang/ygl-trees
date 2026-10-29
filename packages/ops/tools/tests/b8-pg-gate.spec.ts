/** #124: release gate cannot count env-skipped or partial PG suites as passed. */
import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
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
 it("release documentation requires actual B8 passed/skipped counts",()=>{
  const s=readFileSync(resolve(root,"docs/release.md"),"utf8");expect(s).toContain("b8_pg");expect(s).toContain("0 skipped");
 });
 it("discovers all real PG spec files without including its own gate regression",async()=>{const {pgSpecs}=await loadGate();const specs=pgSpecs();expect(specs).toHaveLength(7);expect(specs.every((s:string)=>!s.endsWith("/b8-pg-gate.spec.ts"))).toBe(true);});
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
});
