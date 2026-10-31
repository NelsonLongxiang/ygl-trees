import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const ROOT=resolve(__dirname,'../../../..'),BIN=join(ROOT,'dist/bundle/bin.cjs');
let home='',sequence=0;const snapshots:Record<string,string>={};
function cli(args:string[],rc=0){
 const env={...process.env,YGL_HOME:home,YGL_SESSION:'group-archive',YGL_TEST:'1',YGL_NO_UPDATE_CHECK:'1',TEMP:join(home,'tmp'),TMPDIR:join(home,'tmp')};
 for(const key of ['YGL_DB_URL','YGL_PG_URL','YGL_PROJECT','YGL_DB','NODE_OPTIONS'])delete env[key];
 const r=spawnSync(process.execPath,[BIN,...args,'--json'],{cwd:home,env,encoding:'utf8',timeout:30000});
 expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(rc);return JSON.parse(r.stdout);
}
function prepare(extra:any={}){
 const file=join(home,'tree-'+(++sequence)+'.json');
 writeFileSync(file,JSON.stringify({tree_spec_version:1,root:'root',nodes:[{id:'root',kind:'group',aggregate:'all_pass',children:['a','b']},{id:'a',kind:'leaf',spec_id:'spec_group_fixture'},{id:'b',kind:'leaf',spec_id:'spec_group_fixture'}],...extra}));
 const material=cli(['verify','submit','--title','group projection fixture','--text',file,'--meta-repo',ROOT]);return cli(['verify','tree','prepare',material.material_id]).tree_spec_id;
}
function rootReport(tree:any){const n=tree.nodes.find((x:any)=>x.node_id==='root');expect(n.archive_error).toBeUndefined();return JSON.parse(readFileSync(join(home,'verify/reports',n.report_id+'.json'),'utf8'));}
function verifyAll(tree:any){for(const n of tree.nodes){expect(n.archive_path).toBeTruthy();expect(cli(['verify','archive','verify',n.archive_path]).ok).toBe(true);}}
describe('#140 group ordinary reports and archive fold agree',()=>{
 beforeAll(()=>{
  mkdirSync(join(ROOT,'tmp'),{recursive:true});home=mkdtempSync(join(ROOT,'tmp/group-archive-'));mkdirSync(join(home,'tmp'));cli(['db','init']);
  const specDir=join(home,'verify/specs/spec_group_fixture'),materialDir=join(home,'verify/materials/mat_group_fixture');mkdirSync(specDir,{recursive:true});mkdirSync(materialDir,{recursive:true});
  writeFileSync(join(materialDir,'material.txt'),'S1 values must be nonnegative.');writeFileSync(join(materialDir,'material.json'),JSON.stringify({material_id:'mat_group_fixture',title:'fixture',created:'2000-01-01T00:00:00Z',text_path:'material.txt',files:[]}));
  writeFileSync(join(specDir,'prepare.json'),JSON.stringify({material_id:'mat_group_fixture'}));
  writeFileSync(join(specDir,'spec.json'),JSON.stringify({contract_version:'1.2',spec_id:'spec_group_fixture',spec_version:1,title:'group leaf',domain:'general',created:'2000-01-01T00:00:00Z',runtime_min:'',verifier:{engine_version:'0.117.1',corpus_version:'1.2'},as_of:{kind:'snapshot',value:'2000-01-01T00:00:00Z'},vu:[{id:'V1',role:'assert',title:'nonnegative',severity:'S3',source_clause:'S1 values must be nonnegative.',expected_from:{quote:'S1 values must be nonnegative.',locator:'material.txt#S1'},checker:{type:'sql',sql:'SELECT id FROM records WHERE value < 0',fail_when:'rows>0'}}],attachments:[],sealed:{review:false}}));
  for(const [kind,sql]of Object.entries({good:'CREATE TABLE records(id INTEGER,value INTEGER);INSERT INTO records VALUES(1,1);',bad:'CREATE TABLE records(id INTEGER,value INTEGER);INSERT INTO records VALUES(1,-1);',empty:'CREATE TABLE records(id INTEGER,value INTEGER);',schema:'CREATE TABLE unrelated(id INTEGER);'})){
   const dir=join(home,kind);mkdirSync(dir);const file=join(dir,'ledger.sqlite');const db=new DatabaseSync(file);try{db.exec(sql);}finally{db.close();}snapshots[kind]=file;
  }
 });
 afterAll(()=>{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 it('all STALE retains PASS leaf results but projects both ordinary VUs to ERROR',()=>{
  const tid=prepare({target:{kind:'sqlite-snapshot',id:'other.sqlite'}}),tree=cli(['verify','tree','run',tid,'--db',snapshots.good]);
  expect(tree.verdict).toBe('STALE');expect(tree.nodes.filter((n:any)=>n.kind==='leaf').map((n:any)=>[n.verdict,n.report_verdict,!!n.stale_reason])).toEqual([['STALE','PASS',true],['STALE','PASS',true]]);
  const report=rootReport(tree);expect(report.tree.verdict).toBe('STALE');expect(report.vu.map((v:any)=>v.verdict)).toEqual(['ERROR','ERROR']);expect(report.summary).toEqual({pass:0,fail:0,needs_material:0,error:2});expect(report.overall).toBe('ERROR');verifyAll(tree);
 });
 it('PASS plus INFRA_BLOCKED is ordinary ERROR, never a bare PASS',()=>{
  const tid=prepare(),tree=cli(['verify','tree','run',tid,'--db','a='+snapshots.good,'--db','b='+snapshots.empty]);
  expect(tree.verdict).toBe('INFRA_BLOCKED');expect(tree.nodes.find((n:any)=>n.node_id==='b').report_verdict).toBe('NEEDS-MATERIAL');
  const report=rootReport(tree);expect(report.tree.verdict).toBe('INFRA_BLOCKED');expect(report.vu.map((v:any)=>v.verdict)).toEqual(['PASS','ERROR']);expect(report.summary).toEqual({pass:1,fail:0,needs_material:0,error:1});expect(report.overall).toBe('ERROR');verifyAll(tree);
 });
 it('FAIL plus INFRA_BLOCKED preserves business FAIL in the ordinary and tree report',()=>{
  const tid=prepare(),tree=cli(['verify','tree','run',tid,'--db','a='+snapshots.bad,'--db','b='+snapshots.empty]);expect(tree.verdict).toBe('FAIL');
  const report=rootReport(tree);expect(report.vu.map((v:any)=>v.verdict)).toEqual(['FAIL','ERROR']);expect(report.summary).toEqual({pass:0,fail:1,needs_material:0,error:1});expect(report.overall).toBe('FAIL');verifyAll(tree);
 });
 it('schema errors remain leaf ERROR and tree INFRA_BLOCKED while generated archives verify',()=>{
  const tid=prepare(),tree=cli(['verify','tree','run',tid,'--db',snapshots.schema]);expect(tree.verdict).toBe('INFRA_BLOCKED');expect(tree.nodes.filter((n:any)=>n.kind==='leaf').map((n:any)=>n.report_verdict)).toEqual(['ERROR','ERROR']);
  const report=rootReport(tree);expect(report.summary.error).toBe(2);expect(report.overall).toBe('ERROR');verifyAll(tree);
 });
 it('a corrupt pinned archive is still rejected and neutralizes only that subtree',()=>{
  const baseline=cli(['verify','tree','run',prepare(),'--db',snapshots.good]);verifyAll(baseline);const a=baseline.nodes.find((n:any)=>n.node_id==='a');
  const tid=prepare({pinned:{a:a.archive_sha256}});const bytes=readFileSync(a.archive_path);bytes[0]^=255;writeFileSync(a.archive_path,bytes);expect(cli(['verify','archive','verify',a.archive_path],1).ok).toBe(false);
  const tree=cli(['verify','tree','run',tid,'--db',snapshots.good]);expect(tree.verdict).toBe('NEUTRALIZED');expect(tree.nodes.find((n:any)=>n.node_id==='a').verdict).toBe('NEUTRALIZED');expect(tree.nodes.find((n:any)=>n.node_id==='b').verdict).toBe('PASS');
  const report=rootReport(tree);expect(report.tree.verdict).toBe('NEUTRALIZED');expect(report.overall).toBe('ERROR');expect(report.summary).toEqual({pass:1,fail:0,needs_material:0,error:1});expect(cli(['verify','archive','verify',tree.nodes.find((n:any)=>n.node_id==='root').archive_path]).ok).toBe(true);
 });
 it('nested group reports project tree-only states at every level without losing the tree verdict',()=>{
  const tid=prepare({nodes:[{id:'root',kind:'group',aggregate:'all_pass',children:['inner','c']},{id:'inner',kind:'group',aggregate:'all_pass',children:['a','b']},...['a','b','c'].map(id=>({id,kind:'leaf',spec_id:'spec_group_fixture'}))]});
  const tree=cli(['verify','tree','run',tid,'--db','a='+snapshots.good,'--db','b='+snapshots.empty,'--db','c='+snapshots.good]);expect(tree.verdict).toBe('INFRA_BLOCKED');
  for(const n of tree.nodes.filter((x:any)=>x.kind==='group')){expect(n.verdict).toBe('INFRA_BLOCKED');const report=JSON.parse(readFileSync(join(home,'verify/reports',n.report_id+'.json'),'utf8'));expect(report.tree.verdict).toBe('INFRA_BLOCKED');expect(report.overall).toBe('ERROR');expect(report.summary).toEqual({pass:1,fail:0,needs_material:0,error:1});expect(report.vu.every((v:any)=>['PASS','ERROR'].includes(v.verdict))).toBe(true);}
  verifyAll(tree);
 });
});
