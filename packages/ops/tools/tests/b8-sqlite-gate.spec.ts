import {describe,it,expect} from 'vitest';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const loadGate=()=>import(pathToFileURL(resolve(__dirname,'../../../../scripts/dual-backend-matrix.mjs')).href);
import {resolve} from 'node:path';
const root=resolve(__dirname,'../../../..');
describe('#132 required SQLite golden release gate',()=>{
 it('G7 invokes the golden entry before strict matrix',()=>{const s=readFileSync(resolve(root,'scripts/pg-gate.sh'),'utf8');expect(s).toContain('--b8-sqlite-only');expect(s.indexOf('node scripts/dual-backend-matrix.mjs --b8-sqlite-only')).toBeLessThan(s.indexOf('node scripts/dual-backend-matrix.mjs --strict'));});
 it('release record requires baseline version,sha256 and zero-skip line',()=>{expect(readFileSync(resolve(root,'docs/release.md'),'utf8')).toContain('b8_sqlite_golden:');});
 it('counts exactly one passed golden case and rejects skipped,failed,missing and extra reports',async()=>{
  const {goldenReport}=await loadGate();const file='packages/ops/tools/tests/b8-sqlite-golden.spec.ts';const row=(status:string)=>({name:root+'/'+file,assertionResults:[{status}]});
  expect(goldenReport({success:true,testResults:[row('passed')]})).toEqual({passed:1,skipped:0});
  for(const status of ['pending','skipped','failed','todo'])expect(()=>goldenReport({success:true,testResults:[row(status)]})).toThrow();
  for(const testResults of [[],[row('passed'),row('passed')],[{name:file,assertionResults:[]}]])expect(()=>goldenReport({success:true,testResults})).toThrow();
  expect(()=>goldenReport({success:false,testResults:[row('passed')]})).toThrow();
 });
 it('baseline pin is exact npm version plus tarball and bundle sha256; changed bytes fail',async()=>{
  const {SQLITE_BASELINE,goldenHash}=await loadGate();expect(SQLITE_BASELINE.version).toBe('0.117.1');expect(SQLITE_BASELINE.url).toBe('https://registry.npmjs.org/ygl-trees/-/ygl-trees-0.117.1.tgz');
  expect(SQLITE_BASELINE.tar_sha256).toMatch(/^[0-9a-f]{64}$/);expect(SQLITE_BASELINE.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
  const {createHash}=await import('node:crypto');const bytes=Buffer.from('verified');const sha=createHash('sha256').update(bytes).digest('hex');expect(goldenHash(bytes,sha)).toBe(sha);expect(()=>goldenHash(Buffer.from('changed'),sha)).toThrow(/mismatch/);
 });
 it('unavailable and corrupted baseline paths fail rather than producing a skipped green gate',()=>{
  mkdirSync(resolve(root,'tmp'),{recursive:true});const dir=mkdtempSync(resolve(root,'tmp/sqlite-gate-negative-'));
  try{writeFileSync(resolve(dir,'bad.tgz'),'not a tarball');for(const filename of ['missing.tgz','bad.tgz']){const r=spawnSync(process.execPath,[resolve(root,'scripts/dual-backend-matrix.mjs'),'--b8-sqlite-only','--baseline-tgz',resolve(dir,filename)],{cwd:root,encoding:'utf8',timeout:10000});expect(r.status).toBe(1);expect(r.stderr).toContain('b8_sqlite_golden: FAIL');expect(r.stdout).not.toContain('1 passed');}}finally{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
 it('#135 exported golden specs exist and identify exactly the reports accepted by the gate',async()=>{
  const {goldenSpecs,goldenReport}=await loadGate();const specs=goldenSpecs();expect(specs).toEqual(['packages/ops/tools/tests/b8-sqlite-golden.spec.ts']);
  for(const spec of specs){expect(existsSync(resolve(root,spec))).toBe(true);for(const name of [spec,root+'/'+spec,(root+'/'+spec).replaceAll('/','\\')])expect(goldenReport({success:true,testResults:[{name,assertionResults:[{status:'passed'}]}]})).toEqual({passed:1,skipped:0});}
  expect(()=>goldenReport({success:true,testResults:[{name:'unrelated.spec.ts',assertionResults:[{status:'passed'}]}]})).toThrow();
 });
 it('#135 actual golden argv targets only the exported list and stores the path literal once',async()=>{
  const {goldenSpecs,goldenArgv}=await loadGate();const argv=goldenArgv('result.json');expect(argv).toEqual(['node_modules/vitest/vitest.mjs','run',...goldenSpecs(),'--maxWorkers=1','--reporter=json','--outputFile=result.json']);
  const source=readFileSync(resolve(root,'scripts/dual-backend-matrix.mjs'),'utf8');expect(source.split('b8-sqlite-golden.spec.ts')).toHaveLength(2);expect(source).toContain('spawnSync(process.execPath, goldenArgv(');
 });
});
