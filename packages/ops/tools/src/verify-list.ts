/** Bounded HTTP projections backed by the prepared durable verifier summary index. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Env } from "../../../core/database/src/types";
import type { ArchiveRow, ReportRow, SpecRow } from "./verify-web";
import { readListIndex } from "./verify-list-index";
export interface VerifyPage<T> { items: T[]; total: number; next_cursor: string | null }
const id = /^[A-Za-z0-9_-]{1,128}$/;
async function json(path:string):Promise<any>{try{return JSON.parse(await readFile(path,"utf8"));}catch{return null;}}
export class VerifyListUsageError extends Error {}
function pagination(q:URLSearchParams,scope:string) {
  const raw=q.get("limit")??"200";
  if(!/^[0-9]+$/.test(raw)||Number(raw)<1||Number(raw)>500)throw new VerifyListUsageError("limit must be an integer from 1 to 500");
  let after:string[]|undefined;const cursor=q.get("cursor");
  if(cursor){
    if(cursor.length>4096)throw new VerifyListUsageError("invalid cursor for this list");
    let k:any;try{k=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}catch{}
    if(!Array.isArray(k)||k.length!==3||k[0]!==scope||typeof k[1]!=="string"||typeof k[2]!=="string")throw new VerifyListUsageError("invalid cursor for this list");
    after=k.slice(1);
  }
  return {limit:Number(raw),after};
}
function result<T>(rows:T[],total:number,limit:number,scope:string,key:(r:T)=>string[]):VerifyPage<T>{
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items,total,next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify([scope,...key(last)])).toString("base64url"):null};
}
export async function reportPage(env:Env,q:URLSearchParams):Promise<VerifyPage<ReportRow>>{
  const spec=q.get("spec")||"",bad=q.get("only_bad")==="1",scope="reports:"+spec+":"+bad,{limit,after}=pagination(q,scope);
  return readListIndex(env.home,db=>{
    const clauses:string[]=[],params:string[]=[];
    if(spec){clauses.push("r.spec_id=?");params.push(spec);}if(bad)clauses.push("r.overall!='PASS'");
    const where=clauses.length?" WHERE "+clauses.join(" AND "):"";
    const total=db.prepare("SELECT COUNT(*) n FROM reports r"+where).get(...params).n;
    if(after){clauses.push("(r.finished,r.run_id)<(?,?)");params.push(...after);}
    const rows=db.prepare("SELECT r.row_json,(SELECT COUNT(*) FROM archives a WHERE a.run_id=r.run_id) archived FROM reports r"+(clauses.length?" WHERE "+clauses.join(" AND "):"")+" ORDER BY r.finished DESC,r.run_id DESC LIMIT ?").all(...params,limit+1).map((r:any)=>({...JSON.parse(r.row_json),archived:r.archived}));
    return result<ReportRow>(rows,total,limit,scope,r=>[r.finished,r.run_id]);
  });
}
export async function archivePage(env:Env,q:URLSearchParams):Promise<VerifyPage<ArchiveRow>>{
  const scope="archives",{limit,after}=pagination(q,scope);
  return readListIndex(env.home,db=>{
    const total=db.prepare("SELECT COUNT(*) n FROM archives").get().n;
    const rows=db.prepare("SELECT row_json FROM archives"+(after?" WHERE (created,entry_key)<(?,?)":"")+" ORDER BY created DESC,entry_key DESC LIMIT ?").all(...(after||[]),limit+1).map((r:any)=>JSON.parse(r.row_json));
    return result<ArchiveRow>(rows,total,limit,scope,r=>[r.created,r.run_id+":"+r.archive_id+":"+r.filename]);
  });
}
export async function specRows(env:Env):Promise<SpecRow[]>{
  const counts=readListIndex(env.home,db=>new Map<string,any>(db.prepare("SELECT spec_id,COUNT(*) runs FROM reports GROUP BY spec_id").all().map((r:any)=>[r.spec_id,{runs:r.runs,last:db.prepare('SELECT run_id,overall FROM reports WHERE spec_id=? ORDER BY finished DESC,run_id DESC LIMIT 1').get(r.spec_id)}])));
  const root=join(env.home,"verify","specs");let dirs;
  try{dirs=(await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&id.test(d.name));}catch(e:any){if(e.code==="ENOENT")return [];throw e;}
  const rows:SpecRow[]=[];
  for(const d of dirs.sort((a,b)=>a.name.localeCompare(b.name))){
    const [s,prep]=await Promise.all([json(join(root,d.name,"spec.json")),json(join(root,d.name,"prepare.json"))]);if(!s)continue;
    const n=counts.get(s.spec_id);
    rows.push({spec_id:String(s.spec_id),spec_version:Number(s.spec_version??0),title:String(s.title??""),domain:String(s.domain??""),created:String(s.created??""),units:Array.isArray(s.vu)?s.vu.length:0,verdict:String(prep?.verdict??""),rounds:Number(prep?.rounds??0),material:String(prep?.material_id??""),runs:n?.runs||0,last_overall:n?.last?.overall||"",last_run:n?.last?.run_id||""});
  }
  return rows;
}
