import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const ROOT=resolve(__dirname,'../../../..');
function fixture(mode:string){
 mkdirSync(join(ROOT,'tmp'),{recursive:true});const base=mkdtempSync(join(ROOT,'tmp/g1 temp-')),repo=join(base,'source');
 mkdirSync(join(repo,'scripts'),{recursive:true});writeFileSync(join(repo,'scripts/offline-gate.sh'),readFileSync(join(ROOT,'scripts/offline-gate.sh')));
 const trace=join(base,'trace.log');
 const chain=[
  'G1_REPO="$(cd "$G1_REPO" && pwd -P)"; export G1_REPO;',
  'git() { printf "git %s\n" "$*" >> "$G1_TRACE"; case "$1" in rev-parse) printf "%s\n" "$G1_REPO";; clone) [[ "$4" == "$G1_REPO/tmp/offline-gate."*/repo ]] || return 91; command mkdir -p -- "$4";; -C) return 0;; *) return 92;; esac; };',
  'rm() { printf "rm %s\n" "$*" >> "$G1_TRACE"; [[ "${*: -1}" == "$G1_REPO/tmp/offline-gate."* ]] || return 93; command rm "$@"; };',
  'env() { printf "env install/test\n" >> "$G1_TRACE"; return 0; };',
  ...(mode==='fail'?['mktemp() { printf "forced allocation failure\n" >&2; return 1; }; export -f mktemp;']:mode==='empty'?['mktemp() { return 0; }; export -f mktemp;']:mode==='unsafe'?['mktemp() { printf "/repo\n"; }; export -f mktemp;']:[]),
  'export -f git rm env; bash "$G1_REPO/scripts/offline-gate.sh"'
 ].join(String.fromCharCode(10));
 try{
  expect(existsSync(join(repo,'tmp'))).toBe(false);
  const r=spawnSync(process.execPath,[join(ROOT,'scripts/run-sh.mjs'),chain],{cwd:ROOT,env:{...process.env,G1_REPO:repo.replaceAll('\\','/'),G1_TRACE:trace},encoding:'utf8',timeout:10000});
  expect(r.error).toBeUndefined();expect(r.signal).toBeNull();
  return {status:r.status,out:r.stdout+r.stderr,trace:existsSync(trace)?readFileSync(trace,'utf8'):'',parentCreated:existsSync(join(repo,'tmp'))};
 }finally{rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
}
describe('#136 G1 scratch allocation safety',()=>{
 it('creates the missing tmp parent and reaches install/test in an exported fresh tree',()=>{const r=fixture('normal');expect(r.status,r.out).toBe(0);expect(r.parentCreated).toBe(true);expect(r.trace).toContain('git clone');expect(r.trace).toContain('env install/test');expect(r.trace).toContain('rm -rf -- ');expect(r.trace).not.toContain('git clone -q /repo');});
 it('mktemp failure stops before clone or cleanup',()=>{const r=fixture('fail');expect(r.status).toBe(1);expect(r.out).toMatch(/cannot create.*work|work.*allocat/i);expect(r.trace).toBe('');});
 it('successful mktemp with empty output stops before clone or cleanup',()=>{const r=fixture('empty');expect(r.status).toBe(1);expect(r.out).toMatch(/invalid.*work|empty.*work/i);expect(r.trace).toBe('');});
 it('an unexpected allocation path cannot become a clone or deletion target',()=>{const r=fixture('unsafe');expect(r.status).toBe(1);expect(r.out).toMatch(/invalid.*work/i);expect(r.trace).toBe('');});
 it('runs real clone and checkout from a synthetic fresh repository without tmp',()=>{
  mkdirSync(join(ROOT,'tmp'),{recursive:true});const base=mkdtempSync(join(ROOT,'tmp/g1-real-')),repo=join(base,'source'),trace=join(base,'install-test.log');
  try{
   mkdirSync(join(repo,'scripts'),{recursive:true});writeFileSync(join(repo,'scripts/offline-gate.sh'),readFileSync(join(ROOT,'scripts/offline-gate.sh')));
   const git=(args:string[])=>{const r=spawnSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,encoding:'utf8',timeout:10000});expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);};
   git(['init','-q']);git(['add','scripts/offline-gate.sh']);git(['commit','-qm','synthetic gate fixture']);expect(existsSync(join(repo,'tmp'))).toBe(false);
   const chain='env() { echo install-test >> "$G1_TRACE"; return 0; }; export -f env; bash "$G1_REPO/scripts/offline-gate.sh"';
   const r=spawnSync(process.execPath,[join(ROOT,'scripts/run-sh.mjs'),chain],{cwd:ROOT,env:{...process.env,G1_REPO:repo.replaceAll('\\','/'),G1_TRACE:trace},encoding:'utf8',timeout:15000});
   expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);expect(r.stdout).toContain('clean under env -i');expect(readFileSync(trace,'utf8').trim().split(/\r?\n/)).toHaveLength(2);
   expect(existsSync(join(repo,'tmp'))).toBe(true);expect(require('node:fs').readdirSync(join(repo,'tmp'))).toEqual([]);
  }finally{rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
 });
});
