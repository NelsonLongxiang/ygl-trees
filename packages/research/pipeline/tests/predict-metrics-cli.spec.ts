import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const ROOT=resolve(__dirname,'../../../..'),BIN=join(ROOT,'dist/bundle/bin.cjs');
it('#139 official CLI returns manual for stored prose and never rewrites prediction fields',()=>{
 mkdirSync(join(ROOT,'tmp'),{recursive:true});const home=mkdtempSync(join(ROOT,'tmp/predict-metric-cli-'));
 const env={...process.env,YGL_HOME:home,YGL_TEST:'1',YGL_NO_UPDATE_CHECK:'1',YGL_SESSION:'metric-regression'};
 for(const key of ['YGL_DB_URL','YGL_PG_URL','YGL_DB','YGL_PROJECT','YGL_TREE','NODE_OPTIONS'])delete env[key];
 const cli=(args:string[])=>{const r=spawnSync(process.execPath,[BIN,...args,'--json'],{cwd:ROOT,env,encoding:'utf8',timeout:30000});expect(r.error).toBeUndefined();expect(r.signal).toBeNull();expect(r.status,r.stdout+r.stderr).toBe(0);return JSON.parse(r.stdout);};
 const text='[预测·14天] 2026-10-31 前 adoption 树 ≥4/6 叶节点解锁（自我可控项：showcase-gif/npm-seo/launch-post/issues-channel/mcp-refresh 至少完成 4；cold-user-test 依赖外部用户不计入）';
 let db:DatabaseSync|undefined;
 try{
  cli(['db','init']);cli(['project','new','prediction-metric-fixture']);db=new DatabaseSync(join(home,'ygl-trees.db'));
  const project=(db.prepare('SELECT id FROM projects WHERE name=?').get('prediction-metric-fixture')as any).id;
  const statement=db.prepare('INSERT INTO claims(id,project_id,text,status,created,updated,content_hash) VALUES(?,?,?,?,?,?,?)');
  const insert={run:(...args:any[])=>statement.run(...args,'fixture-'+args[0])};
  insert.run('f88d986ef6',project,text,'unverified','2026-10-17 23:26:32','2026-10-17 23:26:32');
  insert.run('explicit',project,'[预测·7天] 2000-01-01 前 树≥0','unverified','1999-12-25','1999-12-25');
  insert.run('kb-prose',project,'[预测·7天] 2000-01-01 前 专题kb≥0 篇笔记','unverified','1999-12-25','1999-12-25');
  insert.run('human-locked',project,'[预测·7天] 2000-01-01 前 树≥0','refuted','1999-12-25','2000-01-02');
  const select=()=>db!.prepare('SELECT id,text,status,updated FROM claims ORDER BY id').all();const before=select();db.close();db=undefined;
  const rows=cli(['research','predict','audit','--project','prediction-metric-fixture','--offline']);
  expect(rows.find((r:any)=>r.claim_id==='f88d986ef6')).toMatchObject({criterion:text.split(' 前 ')[1],actual:'—',verdict:'manual'});
  expect(rows.find((r:any)=>r.claim_id==='kb-prose')).toMatchObject({actual:'—',verdict:'manual'});expect(rows.find((r:any)=>r.claim_id==='explicit').verdict).toBe('hit');expect(rows.find((r:any)=>r.claim_id==='human-locked').verdict).toBe('resolved');
  db=new DatabaseSync(join(home,'ygl-trees.db'),{readOnly:true});expect(select()).toEqual(before);
 }finally{db?.close();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
