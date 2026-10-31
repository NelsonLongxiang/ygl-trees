import {describe,it,expect,vi} from 'vitest';
import {measureCriterion,auditPredictions} from '../src/predict';
const F88_CRITERION='adoption 树 ≥4/6 叶节点解锁（自我可控项：showcase-gif/npm-seo/launch-post/issues-channel/mcp-refresh 至少完成 4；cold-user-test 依赖外部用户不计入）';
const F88_TEXT='[预测·14天] 2026-10-31 前 '+F88_CRITERION;
describe('#139 explicit prediction metrics',()=>{
 it('rejects the stored f88 criterion and reviewer subject-qualified tree examples',()=>{
  const get=vi.fn(()=>({c:38}));
  for(const text of [F88_CRITERION,'adoption 树 ≥ 4/6 叶','採纳树≥4/6','某树 ≥ 4 个采纳叶','adoption 叶 ≥ 4/6'])expect(measureCriterion(text,{get}),text).toBeNull();
  expect(get).not.toHaveBeenCalled();
 });
 it('rejects qualified kb prose rather than counting all workspace notes',()=>{
  const get=vi.fn(()=>({c:38}));
  for(const text of ['adoption kb ≥4/6 叶节点','专题kb≥4','某项目 kb≥4','kb≥4 篇特定笔记','kb≥4且尚须人工核验'])expect(measureCriterion(text,{get}),text).toBeNull();
  expect(get).not.toHaveBeenCalled();
 });
 it('never truncates a fraction or malformed number, including with state counters supplied',()=>{
  const db={get:()=>({c:38})},state={downloads:38,树:38,kb:38};
  for(const key of ['树','kb','downloads'])for(const need of ['4/6','4 / 6','4／6','4.5','4e2','-4','4abc','9007199254740993'])expect(measureCriterion(key+'≥'+need,db,state),key+'≥'+need).toBeNull();
 });
 it('keeps explicit workspace counts and complete 或/且 metric combinations',()=>{
  const db={get:(sql:string)=>({c:sql.includes('kb_notes')?30:13})};
  expect(measureCriterion(' 树 ≥ 13 ',db)).toEqual({actual:'trees=13/13',hit:true});
  expect(measureCriterion('kb≥31',db)).toEqual({actual:'kb=30/31',hit:false});
  expect(measureCriterion('树≥13 或 kb≥31',db)).toMatchObject({hit:true});
  expect(measureCriterion('树≥13 且 kb≥31',db)).toMatchObject({hit:false});
  expect(measureCriterion('树≥20 且 树≥1',db)).toMatchObject({hit:false});
 });
 it('does not discard an unmeasurable clause or assign precedence to mixed operators',()=>{
  const db={get:()=>({c:38})};
  for(const text of ['树≥1 且 unknown≥2','树≥1 或 unknown≥2','kb≥1 或 人工验收','树≥1 且 kb≥1 或 users≥2','树≥1 或','树≥1; kb≥1'])expect(measureCriterion(text,db,{users:5}),text).toBeNull();
 });
 it('retains explicit state exact/suffix binding without letting a matching suffix recover prose',()=>{
  const db={get:()=>({c:13})};
  expect(measureCriterion('y_imported≥12 或 树≥99',db,{'counts.y_imported':14})).toMatchObject({hit:true});
  expect(measureCriterion('树≥13',db,{树:0})).toEqual({actual:'trees=13/13',hit:true});
  expect(measureCriterion('adoption 树≥4/6',db,{'adoption.树':38})).toBeNull();
  expect(measureCriterion('prefix y_imported≥12',db,{'counts.y_imported':14})).toBeNull();
 });
 it('audits the full stored claim as manual without mutating input or auto-resolving',async()=>{
  const claims=[{id:'f88d986ef6',text:F88_TEXT,status:'unverified',created:'2026-10-17 23:26:32',updated:'2026-10-17 23:26:32'},{id:'resolved',text:'[预测·14天] 2026-10-31 前 树≥4',status:'refuted',created:'2026-10-17',updated:'2026-10-29'}];
  const before=JSON.stringify(claims);const rows=await auditPredictions({claims,db:{get:()=>({c:38})},today:'2026-10-31',npmProbe:false});
  expect(rows[0]).toMatchObject({claim_id:'f88d986ef6',criterion:F88_CRITERION,actual:'—',verdict:'manual',days_left:0});expect(rows[1].verdict).toBe('resolved');expect(JSON.stringify(claims)).toBe(before);
 });
 it('does not turn an unsupported tree/npm composite or a fraction into a partial registry verdict',async()=>{
  const fetchImpl=vi.fn();const claims=['树≥999 或 npm 再发≥1个版本','npm 再发≥1/2个版本'].map((criterion,i)=>({id:String(i),text:'[预测·7天] 2000-01-01 前 '+criterion,status:'unverified'}));
  const rows=await auditPredictions({claims,db:{get:()=>({c:38})},today:'2026-10-31',fetchImpl:fetchImpl as any});expect(rows.every(r=>r.verdict==='manual')).toBe(true);expect(fetchImpl).not.toHaveBeenCalled();
 });
 it('keeps the complete npm metric and its offline fallback without external requests',async()=>{
  const fetchImpl=vi.fn().mockResolvedValue({ok:true,json:async()=>({time:{created:'2000-01-01',modified:'2099-01-01','1.0.0':'2026-10-05T00:00:00Z'}})});
  const claims=[1,2].map(n=>({id:String(n),text:'[预测·7天] 2026-10-10 前 npm 再发 ≥'+n+' 个版本——基线 pkg@2026-10-01',status:'unverified',created:'2026-10-01'}));
  const db={get:()=>({c:38})};const rows=await auditPredictions({claims,db,today:'2026-10-31',fetchImpl:fetchImpl as any});expect(rows.map(r=>r.verdict)).toEqual(['hit','miss']);expect(fetchImpl).toHaveBeenCalledTimes(2);
  fetchImpl.mockClear();const offline=await auditPredictions({claims,db,today:'2026-10-31',npmProbe:false,fetchImpl:fetchImpl as any});expect(offline.every(r=>r.verdict==='manual')).toBe(true);expect(fetchImpl).not.toHaveBeenCalled();
 });
});
