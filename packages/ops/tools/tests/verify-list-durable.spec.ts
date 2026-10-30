import {describe,it,expect,vi} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import * as nativeFs from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import Sqlite from 'better-sqlite3';
import {handleVerifyApi} from '../src/verify-web';
import {prepareListIndex,updateListIndex,watchListIndex,listIndexPath} from '../src/verify-list-index';
import {writeJson} from '../src/verify-cmds';
import {appendRegistry} from '../src/archive';
import * as fsp from 'node:fs/promises';
vi.mock('node:fs/promises',{spy:true});
vi.mock('node:fs',{spy:true});
describe('#125 durable index requirements',()=>{
 it('idle requests never reparse every report after five seconds',async()=>{mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-red-'));try{for(const d of ['reports','archives'])mkdirSync(join(home,'verify',d),{recursive:true});for(let i=0;i<100;i++)writeFileSync(join(home,'verify/reports','r'+i+'.json'),JSON.stringify({run_id:'r'+i,spec_id:'s'+(i%2)}));await prepareListIndex(home);const env={home}as any;const call=()=>handleVerifyApi(env,'GET',new URL('http://local/api/verify/reports?spec=s0'));await call();vi.mocked(fsp.stat).mockClear();let parsed=0;const parse=JSON.parse,spy=vi.spyOn(JSON,'parse').mockImplementation(((s:string)=>{if(s.includes('spec_id')&&!s.includes('archived'))parsed++;return parse(s);})as any),clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+10000);try{await call();expect(parsed).toBe(0);expect(vi.mocked(fsp.stat).mock.calls.filter(c=>String(c[0]).endsWith('.json'))).toHaveLength(0);}finally{spy.mockRestore();clock.mockRestore();}}finally{rmSync(home,{recursive:true,force:true});}});
 it('fresh environments and changed specs read durable summaries without raw report IO',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-restart-'));
  try{
   for(const d of ['reports','archives'])mkdirSync(join(home,'verify',d),{recursive:true});
   for(let n=0;n<100;n++)writeFileSync(join(home,'verify/reports','r'+n+'.json'),JSON.stringify({run_id:'r'+n,spec_id:'s'+n%2,vu:[{large:'raw-marker'}]}));
   await prepareListIndex(home);await prepareListIndex(home);
   vi.mocked(fsp.readFile).mockClear();vi.mocked(fsp.stat).mockClear();
   const row=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s1&limit=10'));
   expect((row.body as any).total).toBe(50);expect((row.body as any).items).toHaveLength(10);
   expect(vi.mocked(fsp.readFile).mock.calls.filter(c=>String(c[0]).includes('reports'))).toHaveLength(0);
   expect(vi.mocked(fsp.stat).mock.calls.filter(c=>String(c[0]).includes('reports'))).toHaveLength(0);
   writeJson(join(home,'verify/reports/new.json'),{run_id:'new',spec_id:'s0',finished:'2099'});
   appendRegistry(join(home,'verify'),'new',{id:'s0',version:1},{archive_id:'a',filename:'a.zip',created:'2099',path:'a.zip',archive_sha256:'x',zip_sha256:'y',with:[]}as any);
   vi.mocked(fsp.readFile).mockClear();
   const changed=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s0&limit=10'));
   expect((changed.body as any).total).toBe(51);expect((changed.body as any).items[0]).toMatchObject({run_id:'new',archived:1});
   expect(vi.mocked(fsp.readFile).mock.calls.filter(c=>String(c[0]).includes('reports'))).toHaveLength(0);
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('filename watcher maintains external edits and deletions and closes without handles',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-watch-'));let watcher:ReturnType<typeof watchListIndex>|undefined;
  try{
   await prepareListIndex(home);watcher=watchListIndex(home);const path=join(home,'verify/reports/external.json');
   writeFileSync(path,JSON.stringify({run_id:'external',spec_id:'watched',overall:'FAIL'}));
   await vi.waitFor(async()=>{await watcher!.settled();const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=watched'));expect(r.body.total).toBe(1);},{timeout:3000,interval:20});
   writeFileSync(path,JSON.stringify({run_id:'external',spec_id:'watched',overall:'PASS'}));
   await vi.waitFor(async()=>{await watcher!.settled();const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=watched'));expect(r.body.items[0].overall).toBe('PASS');},{timeout:3000,interval:20});
   rmSync(path);
   await vi.waitFor(async()=>{await watcher!.settled();const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=watched'));expect(r.body.total).toBe(0);},{timeout:3000,interval:20});
  }finally{await watcher?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('legacy preparation is explicit; missing index never silently scans in a list request',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-missing-'));
  try{await expect(handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'))).rejects.toThrow('not prepared');}finally{rmSync(home,{recursive:true,force:true});}
 });
 it('a new process can filter an already prepared index with source file IO disabled',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-process-'));
  try{
   await prepareListIndex(home);writeJson(join(home,'verify/reports/restart.json'),{run_id:'restart',spec_id:'s_restart',finished:'2099'});
   const code="const fsp=require('node:fs/promises');for(const key of ['readFile','stat','readdir']){const old=fsp[key];fsp[key]=function(p,...args){if(String(p).includes('reports')||String(p).includes('archives'))throw new Error('source report IO forbidden');return old.call(this,p,...args);};}const {reportPage}=require('./dist/packages/ops/tools/src/verify-list.js');reportPage({home:process.env.VERIFY_INDEX_TEST_HOME},new URLSearchParams({spec:'s_restart'})).then(r=>{if(r.total!==1||r.items[0].run_id!=='restart')throw new Error('wrong index projection');console.log(JSON.stringify({total:r.total,source_io:0}));}).catch(e=>{console.error(e.message);process.exitCode=1;});";
   const r=spawnSync(process.execPath,['-e',code],{cwd:process.cwd(),env:{...process.env,VERIFY_INDEX_TEST_HOME:home},encoding:'utf8',timeout:20000});expect(r.status,r.stdout+r.stderr).toBe(0);expect(JSON.parse(r.stdout)).toEqual({total:1,source_io:0});
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('derived index update failure preserves the committed source and refuses stale cache reads until reconciliation',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-failure-'));let lock:any;
  try{
   await prepareListIndex(home);lock=new Sqlite(listIndexPath(join(home,'verify')));lock.exec('DROP TABLE reports');lock.close();lock=null;
   const file=join(home,'verify/reports/retained.json');
   // A corrupt derived schema is detected by its impossible insert, not by changing source success semantics.
   lock=new Sqlite(listIndexPath(join(home,'verify')));lock.exec('CREATE TABLE reports(run_id TEXT PRIMARY KEY)');lock.close();lock=null;
   const warning=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
   try{expect(()=>writeJson(file,{run_id:'retained',spec_id:'s'})).not.toThrow();expect(warning).toHaveBeenCalled();}finally{warning.mockRestore();}
   expect(JSON.parse(require('node:fs').readFileSync(file,'utf8')).run_id).toBe('retained');
   await expect(handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'))).rejects.toThrow('reconciliation');
   lock=new Sqlite(listIndexPath(join(home,'verify')));lock.exec('DROP TABLE reports');lock.close();lock=null;
   await prepareListIndex(home);const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'));expect(r.body.total).toBe(1);
  }finally{lock?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('preparation failure does not expose an apparently ready server list',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-corrupt-'));
  try{mkdirSync(join(home,'verify'),{recursive:true});writeFileSync(listIndexPath(join(home,'verify')),'not sqlite');await expect(prepareListIndex(home)).rejects.toThrow();await expect(handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'))).rejects.toThrow();}finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('startup reconciliation cannot overwrite a newer official write while reading an old report',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-race-'));
  try{
   await prepareListIndex(home);const file=join(home,'verify/reports/racing.json');writeFileSync(file,JSON.stringify({run_id:'racing',spec_id:'s',overall:'FAIL'}));
   const original=fsp.readFile;let release!:(v:void)=>void,read!:(v:void)=>void;
   const paused=new Promise<void>(r=>read=r),resume=new Promise<void>(r=>release=r);
   vi.mocked(fsp.readFile).mockImplementationOnce((async(...args:any[])=>{const bytes=await (original as any)(...args);read();await resume;return bytes;})as any);
   const preparation=prepareListIndex(home);await paused;
   writeJson(file,{run_id:'racing',spec_id:'s',overall:'PASS'});release();await preparation;
   const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'));expect(r.body.items[0].overall).toBe('PASS');
  }finally{vi.mocked(fsp.readFile).mockRestore();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('one create event plus a partial read never settles an absent report when no second event arrives',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-partial-'));let watcher:ReturnType<typeof watchListIndex>|undefined;
  const callbacks:((event:string,file:string)=>void)[]=[];
  try{
   await prepareListIndex(home);
   const watchSpy=vi.mocked(nativeFs.watch).mockImplementation(((_dir:any,callback:any)=>{callbacks.push(callback);return {unref(){},on(){return this;},close(){}};})as any);
   watcher=watchListIndex(home);watchSpy.mockRestore();
   const file=join(home,'verify/reports/partial.json');writeFileSync(file,JSON.stringify({run_id:'partial',spec_id:'s',overall:'PASS'}));
   vi.mocked(fsp.readFile).mockResolvedValueOnce('' as any);
   callbacks[0]('rename','partial.json');await watcher.settled();
   const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'));expect(r.body.items[0]).toMatchObject({run_id:'partial',overall:'PASS'});
  }finally{vi.mocked(fsp.readFile).mockRestore();await watcher?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('invalid JSON is visible and cannot erase the last valid projection or become a settled file revision',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-unsettled-'));let watcher:ReturnType<typeof watchListIndex>|undefined;
  const callbacks:((event:string,file:string)=>void)[]=[];
  try{
   await prepareListIndex(home);const file=join(home,'verify/reports/partial.json');writeJson(file,{run_id:'partial',spec_id:'s',overall:'PASS'});
   const watchSpy=vi.mocked(nativeFs.watch).mockImplementation(((_dir:any,callback:any)=>{callbacks.push(callback);return {unref(){},on(){return this;},close(){}};})as any);
   watcher=watchListIndex(home);watchSpy.mockRestore();writeFileSync(file,'{"run_id":');callbacks[0]('change','partial.json');
   await expect(watcher.settled()).rejects.toThrow(/unsettled|incomplete/);
   const db=new Sqlite(listIndexPath(join(home,'verify')),{readonly:true});try{expect(JSON.parse((db.prepare('SELECT row_json FROM reports WHERE run_id=?').get('partial')as any).row_json).overall).toBe('PASS');expect((db.prepare('SELECT stamp FROM files WHERE kind=? AND id=?').get('reports','partial')as any).stamp).toMatch(/^hook:/);}finally{db.close();}
   await expect(handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'))).rejects.toThrow(/unsettled|incomplete/);
   writeFileSync(file,JSON.stringify({run_id:'partial',spec_id:'s',overall:'FAIL'}));callbacks[0]('change','partial.json');await watcher.settled();
   const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'));expect(r.body.items[0].overall).toBe('FAIL');
  }finally{await watcher?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('a valid JSON read from a file replaced during the read is retried, never committed with the new stamp',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-replaced-'));let watcher:ReturnType<typeof watchListIndex>|undefined;
  const callbacks:((event:string,file:string)=>void)[]=[];
  try{
   await prepareListIndex(home);const file=join(home,'verify/reports/replaced.json');writeJson(file,{run_id:'replaced',spec_id:'s',overall:'PASS'});
   const watchSpy=vi.mocked(nativeFs.watch).mockImplementation(((_dir:any,callback:any)=>{callbacks.push(callback);return {unref(){},on(){return this;},close(){}};})as any);
   watcher=watchListIndex(home);watchSpy.mockRestore();
   const read=fsp.readFile;vi.mocked(fsp.readFile).mockImplementationOnce((async(...args:any[])=>{const old=await (read as any)(...args);writeFileSync(file,JSON.stringify({run_id:'replaced',spec_id:'s',overall:'FAIL',reason:'newer data has different length'}));return old;})as any);
   callbacks[0]('change','replaced.json');await watcher.settled();
   const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/reports?spec=s'));expect(r.body.items[0].overall).toBe('FAIL');
  }finally{vi.mocked(fsp.readFile).mockRestore();await watcher?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('a partially written archive sidecar is retried without dropping committed archive rows',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-side-partial-'));let watcher:ReturnType<typeof watchListIndex>|undefined;
  const callbacks:((event:string,file:string)=>void)[]=[];
  try{
   await prepareListIndex(home);const file=join(home,'verify/archives/r.json');writeFileSync(file,JSON.stringify({archives:[{archive_id:'a',filename:'a.zip',created:'2099'}]}));
   const watchSpy=vi.mocked(nativeFs.watch).mockImplementation(((_dir:any,callback:any)=>{callbacks.push(callback);return {unref(){},on(){return this;},close(){}};})as any);
   watcher=watchListIndex(home);watchSpy.mockRestore();vi.mocked(fsp.readFile).mockResolvedValueOnce('{"archives":' as any);
   callbacks[1]('rename','r.json');await watcher.settled();
   const r:any=await handleVerifyApi({home}as any,'GET',new URL('http://local/api/verify/archives'));expect(r.body.total).toBe(1);expect(r.body.items[0].archive_id).toBe('a');
  }finally{vi.mocked(fsp.readFile).mockRestore();await watcher?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('startup preparation cannot mark malformed JSON ready or store its stamp',async()=>{
  mkdirSync('tmp',{recursive:true});const home=mkdtempSync(join(process.cwd(),'tmp/durable-start-partial-'));
  try{
   mkdirSync(join(home,'verify/reports'),{recursive:true});writeFileSync(join(home,'verify/reports/r.json'),'{"run_id":');
   await expect(prepareListIndex(home)).rejects.toThrow(/unsettled|incomplete/);
   const db=new Sqlite(listIndexPath(join(home,'verify')),{readonly:true});try{expect(db.prepare('SELECT * FROM files WHERE kind=? AND id=?').get('reports','r')).toBeUndefined();expect(db.prepare("SELECT * FROM metadata WHERE key='ready'").get()).toBeUndefined();}finally{db.close();}
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
});
