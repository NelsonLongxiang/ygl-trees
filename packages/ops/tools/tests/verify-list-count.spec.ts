import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
const ROOT=resolve(__dirname,'../../../..'),BIN=join(ROOT,'dist/bundle/bin.cjs');
function fixture(check:(f:{home:string;spec:(id:string)=>void;report:(id:string,spec:string,finished:string,overall:string)=>void;list:()=>any[]})=>void){
 mkdirSync(join(ROOT,'tmp'),{recursive:true});const home=mkdtempSync(join(ROOT,'tmp/verify-list-count-'));
 const env={...process.env,YGL_HOME:home,YGL_SESSION:'list-count',YGL_TEST:'1',YGL_NO_UPDATE_CHECK:'1'};
 for(const key of ['YGL_DB_URL','YGL_PG_URL','YGL_DB','YGL_PROJECT','YGL_TREE','NODE_OPTIONS'])delete env[key];
 const cli=(args:string[])=>{const r=spawnSync(process.execPath,[BIN,...args,'--json'],{cwd:home,env,encoding:'utf8',timeout:30000});expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);return JSON.parse(r.stdout);};
 const spec=(id:string)=>{const dir=join(home,'verify/specs',id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'spec.json'),JSON.stringify({spec_id:id,spec_version:1,title:id,vu:[{id:'V1'}]}));writeFileSync(join(dir,'prepare.json'),JSON.stringify({material_id:'mat_'+id}));};
 const report=(id:string,sid:string,finished:string,overall:string)=>{mkdirSync(join(home,'verify/reports'),{recursive:true});writeFileSync(join(home,'verify/reports',id+'.json'),JSON.stringify({run_id:id,spec_id:sid,finished,overall}));};
 const bytes=()=>{const result:Record<string,string>={};const visit=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())visit(file);else result[relative(home,file)]=readFileSync(file).toString('hex');}};visit(join(home,'verify'));return result;};
 const list=()=>{const before=bytes(),rows=cli(['verify','list']);expect(bytes()).toEqual(before);return rows;};
 try{cli(['db','init']);check({home,spec,report,list});}finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
}
describe('#141 verify list count preserves latest selection',()=>{
 for(const count of [0,1,3])it('reports '+count+' runs without removing the latest one',()=>fixture(({spec,report,list})=>{
  spec('spec_a');for(let n=0;n<count;n++)report('run_'+n,'spec_a','2026-10-'+String(20+n).padStart(2,'0')+'T00:00:00Z',n===count-1?'FAIL':'PASS');
  const rows=list();expect(rows).toHaveLength(1);expect(rows[0]).toEqual({spec_id:'spec_a',version:1,title:'spec_a',units:1,material:'mat_spec_a',runs:count,last_overall:count?'FAIL':'',last_run:count?'run_'+(count-1):''});expect(list()).toEqual(rows);
 }));
 it('keeps counts and latest timestamps scoped to each spec, not filename order',()=>fixture(({spec,report,list})=>{
  spec('spec_a');spec('spec_b');spec('spec_empty');report('run_z_old','spec_a','2026-10-20','PASS');report('run_a_new','spec_a','2026-10-25','FAIL');report('run_b','spec_b','2026-10-31','ERROR');
  const rows=list();expect(rows.find(r=>r.spec_id==='spec_a')).toMatchObject({runs:2,last_run:'run_a_new',last_overall:'FAIL'});expect(rows.find(r=>r.spec_id==='spec_b')).toMatchObject({runs:1,last_run:'run_b',last_overall:'ERROR'});expect(rows.find(r=>r.spec_id==='spec_empty')).toMatchObject({runs:0,last_run:'',last_overall:''});expect(rows.reduce((n,r)=>n+r.runs,0)).toBe(3);
 }));
 it('retains existing stable file-order tie behavior and source bytes across repeat reads',()=>fixture(({home,spec,report,list})=>{
  spec('spec_tie');report('run_z','spec_tie','2026-10-31T00:00:00Z','FAIL');report('run_a','spec_tie','2026-10-31T00:00:00Z','PASS');
  const names=readdirSync(join(home,'verify/reports')).filter(n=>n.endsWith('.json'));const expected=JSON.parse(readFileSync(join(home,'verify/reports',names.at(-1)!),'utf8'));
  const first=list();expect(first[0]).toMatchObject({runs:2,last_run:expected.run_id,last_overall:expected.overall});expect(list()).toEqual(first);
 }));
});
