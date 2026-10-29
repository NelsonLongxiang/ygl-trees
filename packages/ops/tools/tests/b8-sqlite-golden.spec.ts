/** Exact stdout/stderr/rc comparison with a preserved pre-B8 bundle. Fixed clock/random remove generated-field noise, not output fields. */
import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const ROOT = resolve(__dirname, "../../../..");
const baseline = process.env.B8_SQLITE_BASELINE_BIN || "";
it.skipIf(!baseline)("B8 SQLite CLI bytes remain identical to the pre-B8 bundle", () => {
  const dir = mkdtempSync(join(ROOT, "tmp/b8-golden-"));
  const home = join(dir, "home");
  const hook = join(dir, "clock.cjs");
  writeFileSync(hook, "const D=Date,T=Number(process.env.B8_CLOCK_MILLIS); global.Date=class extends D {constructor(...a){super(...(a.length?a:[T]))}static now(){return T}}; let seed=123456; Math.random=()=>{seed=(seed*1664525+1013904223)>>>0; return seed/4294967296};");
  const env = { ...process.env, YGL_HOME: home, YGL_SESSION: "golden", YGL_TEST: "1", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" };
  for (const key of ["YGL_DB_URL","YGL_PG_URL","YGL_PROJECT","DSH_SESSION_ID","NODE_OPTIONS"]) delete (env as any)[key];
  const commands = [
    ["project","new","golden-project","-q","中文 question","--json"],
    ["project","new","golden-project","-q","中文 question","--json"],
    ["project","show","--json"], ["project","list","--json"],
    ["kb","add","--title","KB 黄金","--body","line1 中文","--json"],
    ["kb","add","--title","KB 黄金","--body","line1 中文","--json"],
    ["kb","show","KB 黄金","--json"], ["kb","list","--json"],
    ["kb","add","--title","Human","--body","human output"],
    ["project","new","human-project","-q","human output"],
  ];
  const collect = (bin: string) => {
    rmSync(home, {recursive:true,force:true}); mkdirSync(home);
    const init = spawnSync(process.execPath,["--require",hook,bin,"db","init"],{cwd:ROOT,env:{...env,B8_CLOCK_MILLIS:"1893553445000"},encoding:"utf8",timeout:20000});
    expect(init.status,init.stdout+init.stderr).toBe(0);
    return commands.map((args,i) => {
      const r=spawnSync(process.execPath,["--require",hook,bin,...args],{cwd:ROOT,env:{...env,B8_CLOCK_MILLIS:String(1893553445000+(i+1)*1000)},encoding:"utf8",timeout:20000});
      expect(r.status,r.stdout+r.stderr).toBe(0);
      return {args,rc:r.status,out:r.stdout,err:r.stderr};
    });
  };
  try { expect(collect(join(ROOT,"dist/bundle/bin.cjs"))).toEqual(collect(resolve(baseline))); }
  finally { rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}, 120000);
