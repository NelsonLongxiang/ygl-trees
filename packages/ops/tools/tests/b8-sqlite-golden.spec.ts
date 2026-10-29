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
  const sf=join(dir,"source.json"), cf=join(dir,"claim.json"), ef=join(dir,"quote.txt");
  const sb=join(dir,"sources.jsonl"), cb=join(dir,"claims.jsonl"), eb=join(dir,"evidence.jsonl"), bad=join(dir,"bad.jsonl");
  const commands = [
    ["project","new","golden-project","-q","中文 question","--json"],
    ["project","new","golden-project","-q","中文 question","--json"],
    ["project","show","--json"], ["project","list","--json"],
    ["kb","add","--title","KB 黄金","--body","line1 中文","--json"],
    ["kb","add","--title","KB 黄金","--body","line1 中文","--json"],
    ["kb","show","KB 黄金","--json"], ["kb","list","--json"],
    ["kb","add","--title","Human","--body","human output"],
    ["project","new","human-project","-q","human output"],
    ["project","use","golden-project","--json"],
    ["research","source","add","--title","Golden source","--url","https://example.test/golden","--content","golden 中文","--json"],
    ["research","source","add","--title","Golden source","--url","https://example.test/golden","--content","golden 中文","--json"],
    ["research","source","show","$source","--json"], ["research","source","list","--json"],
    ["research","evidence","add","$source","--quote","Golden quote 中文","--json"],
    ["research","evidence","add","$source","--quote","Golden quote 中文","--json"],
    ["research","evidence","show","$evidence","--json"], ["research","evidence","list","--json"],
    ["research","claim","add","Golden claim 中文","--json"],
    ["research","claim","add","Golden claim 中文","--json"],
    ["research","claim","show","$claim","--json"], ["research","claim","list","--json"],
    ["research","source","add","--file",sf,"--json"],
    ["research","claim","add","--file",cf,"--json"],
    ["research","evidence","add","$source","--file",ef,"--json"],
    ["research","source","add","--batch",sb,"--json"],
    ["research","claim","add","--batch",cb,"--json"],
    ["research","evidence","add","--batch",eb,"--json"],
    ["research","source","add","--batch",bad,"--json"],
    ["research","claim","show","missing","--json"],
    ["research","evidence","add","missing","--quote","bad reference","--json"],
    ["research","source","add","--relevance","0.3","--title","bad","--json"],
    ["research","claim","add","--file",cf,"--text","conflict","--json"],
  ];
  const collect = (bin: string) => {
    rmSync(home, {recursive:true,force:true}); mkdirSync(home);
    const init = spawnSync(process.execPath,["--require",hook,bin,"db","init"],{cwd:ROOT,env:{...env,B8_CLOCK_MILLIS:"1893553445000"},encoding:"utf8",timeout:20000});
    expect(init.status,init.stdout+init.stderr).toBe(0);
    writeFileSync(sf,JSON.stringify({title:"File source",url:"https://example.test/file",extra:"visible"}));
    writeFileSync(cf,JSON.stringify({text:"File claim",confidence:"A"}));writeFileSync(ef,"File quote 中文");
    writeFileSync(sb,[{title:"Batch source",url:"https://example.test/batch"},{title:"Batch source",url:"https://example.test/batch"}].map(r=>JSON.stringify(r)).join(String.fromCharCode(10)));
    writeFileSync(cb,[{text:"Batch claim"},{text:"Batch claim"}].map(r=>JSON.stringify(r)).join(String.fromCharCode(10)));
    writeFileSync(bad,[{title:"Must not land",url:"https://example.test/bad"},{title:"Invalid row",relevance:0.3}].map(r=>JSON.stringify(r)).join(String.fromCharCode(10)));
    const ids:Record<string,string>={};
    return commands.map((template,i) => {
      const args=template.map(v=>ids[v]||v);
      if(args.includes(eb)) writeFileSync(eb,[{source_id:ids.$source,quote:"Batch quote"},{source_id:ids.$source,quote:"Batch quote"}].map(r=>JSON.stringify(r)).join(String.fromCharCode(10)));
      const r=spawnSync(process.execPath,["--require",hook,bin,...args],{cwd:ROOT,env:{...env,B8_CLOCK_MILLIS:String(1893553445000+(i+1)*1000)},encoding:"utf8",timeout:20000});
      const expected=args.includes(bad)||args.includes("0.3")||args.includes("conflict")?2:args.includes("missing")?1:0;
      expect(r.status,r.stdout+r.stderr).toBe(expected);
      if(args[0]==="research"&&args[2]==="add"&&r.status===0&&args.includes("--json")){const row=JSON.parse(r.stdout);if(row.id&&!ids["$"+args[1]])ids["$"+args[1]]=row.id;}
      return {args,rc:r.status,out:r.stdout,err:r.stderr};
    });
  };
  try { expect(collect(join(ROOT,"dist/bundle/bin.cjs"))).toEqual(collect(resolve(baseline))); }
  finally { rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}, 180000);
