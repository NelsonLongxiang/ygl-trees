/** Rebuildable verifier list index. JSON reports/sidecars remain authoritative. */
// @ts-ignore — existing runtime dependency has no in-repo type declarations.
import Sqlite from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReportRow, ArchiveRow } from "./verify-web";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const text = (v: unknown, n = 1024) => String(v ?? "").slice(0, n);
export const listIndexPath = (root: string) => join(root, ".list-index.sqlite");
function open(root: string) {
  mkdirSync(root, { recursive: true });
  const db = new Sqlite(listIndexPath(root));
  try {
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS files(kind TEXT NOT NULL,id TEXT NOT NULL,stamp TEXT NOT NULL,PRIMARY KEY(kind,id));" +
    "CREATE TABLE IF NOT EXISTS reports(run_id TEXT PRIMARY KEY,spec_id TEXT NOT NULL,finished TEXT NOT NULL,overall TEXT NOT NULL,row_json TEXT NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS report_spec ON reports(spec_id,finished DESC,run_id DESC);" +
    "CREATE INDEX IF NOT EXISTS report_order ON reports(finished DESC,run_id DESC);" +
    "CREATE TABLE IF NOT EXISTS archives(run_id TEXT NOT NULL,entry_key TEXT NOT NULL,created TEXT NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(run_id,entry_key));" +
    "CREATE INDEX IF NOT EXISTS archive_order ON archives(created DESC,entry_key DESC);" +
    "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
  return db;
  } catch (e) { db.close(); throw e; }
}
export function reportSummary(r: any): ReportRow | null {
  if (typeof r?.run_id !== "string" || !ID.test(r.run_id)) return null;
  return { run_id:r.run_id,spec_id:text(r.spec_id,128),spec_version:Number(r.verifier?.spec_version??r.spec_version??0),overall:text(r.overall,64),reason:text(r.reason),
    summary:{pass:Number(r.summary?.pass??0),fail:Number(r.summary?.fail??0),needs_material:Number(r.summary?.needs_material??0),error:Number(r.summary?.error??0)},
    started:text(r.started,64),finished:text(r.finished,64),mode:text(r.verifier?.mode,64),binary_sha256:text(r.verifier?.binary_sha256,128),archived:0,semantic_scope:typeof r.semantic_scope==="string"?text(r.semantic_scope,64):null };
}
function replace(db: any, kind: string, id: string, value: any, stamp: string) {
  if (kind === "reports") {
    db.prepare("DELETE FROM reports WHERE run_id=?").run(id);
    const r = reportSummary(value);
    if (r && r.run_id === id) db.prepare("INSERT INTO reports VALUES(?,?,?,?,?)").run(id,r.spec_id,r.finished,r.overall,JSON.stringify(r));
  } else {
    db.prepare("DELETE FROM archives WHERE run_id=?").run(id);
    const insert = db.prepare("INSERT OR REPLACE INTO archives VALUES(?,?,?,?)");
    for (const a of Array.isArray(value?.archives)?value.archives:[]) {
      const row:ArchiveRow={run_id:id,archive_id:text(a?.archive_id,128),filename:text(a?.filename,512),archive_sha256:text(a?.archive_sha256,128),zip_sha256:text(a?.zip_sha256,128),created:text(a?.created,64),with:Array.isArray(a?.with)?a.with.slice(0,32).map((v:unknown)=>text(v,128)):[]};
      const key=id+":"+row.archive_id+":"+row.filename;
      insert.run(id,key,row.created,JSON.stringify(row));
    }
  }
  db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?)").run(kind,id,stamp);
}
export function updateListIndex(file: string, value: unknown): void {
  const kind=basename(dirname(file)),id=basename(file,".json");
  if (!["reports","archives"].includes(kind)||!ID.test(id)) return;
  const root=dirname(dirname(file));
  if (!existsSync(listIndexPath(root))) return;
  let db: any;
  try {
    db=open(root);
    db.transaction(()=>replace(db,kind,id,value,"hook:"+process.pid+":"+Date.now()+":"+Math.random()))();
  } catch {
    // Source JSON is already committed. Refuse cache reads until explicit preparation repairs it.
    writeFileSync(join(root,".list-index-dirty"),process.pid+":"+Date.now()+":"+Math.random());
    process.stderr.write("verifier list index update failed; source report retained; restart webui to reconcile\n");
  } finally { db?.close(); }
}
async function fileStamp(path:string) { try {const s=await stat(path);return s.mtimeMs+":"+s.ctimeMs+":"+s.size;}catch(e:any){if(e.code==="ENOENT")return "missing";throw e;} }
async function readRecord(root:string,kind:string,name:string) {
  const path=join(root,kind,name),stamp=await fileStamp(path);
  let value=null;
  if(stamp!=="missing"){try{value=JSON.parse(await readFile(path,"utf8"));}catch(e:any){if(e.code!=="ENOENT"&&!(e instanceof SyntaxError))throw e;}}
  return {kind,id:name.slice(0,-5),stamp,value};
}
/** Legacy import/recovery runs before server readiness, never on a list request. */
export async function prepareListIndex(home:string):Promise<void> {
  const root=join(home,"verify"),db=open(root),dirtyFile=join(root,".list-index-dirty");
  const dirty=existsSync(dirtyFile)?readFileSync(dirtyFile,"utf8"):null;
  try {
    for(const kind of ["reports","archives"]){
      mkdirSync(join(root,kind),{recursive:true});
      const names=(await readdir(join(root,kind))).filter(f=>f.endsWith(".json")&&ID.test(f.slice(0,-5)));
      const prior=new Map<string,string>(db.prepare("SELECT id,stamp FROM files WHERE kind=?").all(kind).map((r:any)=>[r.id,r.stamp]));
      const present=new Set(names.map(n=>n.slice(0,-5)));
      db.transaction(()=>{for(const id of prior.keys())if(!present.has(id)){
        const current=(db.prepare("SELECT stamp FROM files WHERE kind=? AND id=?").get(kind,id) as any)?.stamp;
        if(current===prior.get(id))replace(db,kind,id,null,"missing");
      }})();
      for(let i=0;i<names.length;i+=32){
        const rows=await Promise.all(names.slice(i,i+32).map(async n=>{
          const s=await fileStamp(join(root,kind,n));if(!dirty&&prior.get(n.slice(0,-5))===s)return null;
          return readRecord(root,kind,n);
        }));
        db.transaction(()=>{for(const row of rows)if(row){
          const current=(db.prepare("SELECT stamp FROM files WHERE kind=? AND id=?").get(kind,row.id) as any)?.stamp;
          if(current===prior.get(row.id))replace(db,row.kind,row.id,row.value,row.stamp);
        }})();
      }
    }
    db.prepare("INSERT OR REPLACE INTO metadata VALUES('ready','1')").run();
    if(dirty&&existsSync(dirtyFile)&&readFileSync(dirtyFile,"utf8")===dirty)unlinkSync(dirtyFile);
  }finally{db.close();}
}
export function readListIndex<T>(home:string,read:(db:any)=>T):T {
  const root=join(home,"verify");
  if(existsSync(join(root,".list-index-dirty")))throw new Error("verifier list index needs reconciliation");
  if(!existsSync(listIndexPath(root)))throw new Error("verifier list index not prepared");
  const db=new Sqlite(listIndexPath(root),{readonly:true});
  try {db.pragma("busy_timeout = 5000");if(!(db.prepare("SELECT value FROM metadata WHERE key='ready'").get() as any)?.value)throw new Error("verifier list index not ready");return db.transaction(()=>read(db)).deferred();}finally{db.close();}
}
/** External edits are reconciled by filename events, without a periodic full-directory stat loop. */
export function watchListIndex(home:string) {
  const root=join(home,"verify"),watchers:FSWatcher[]=[];
  let chain=Promise.resolve(),closed=false,fault:unknown;
  const enqueue=(kind:string,name:string|null)=>{
    chain=chain.then(async()=>{
      if(closed)return;
      if(!name)throw new Error("verifier list watcher lost filename; restart to reconcile index");
      if(!name.endsWith(".json")||!ID.test(name.slice(0,-5)))return;
      const before=open(root);let revision;try{revision=(before.prepare("SELECT stamp FROM files WHERE kind=? AND id=?").get(kind,name.slice(0,-5)) as any)?.stamp;}finally{before.close();}
      const row=await readRecord(root,kind,name);if(closed)return;
      const db=open(root);try{db.transaction(()=>{
        const current=(db.prepare("SELECT stamp FROM files WHERE kind=? AND id=?").get(kind,row.id) as any)?.stamp;
        if(current===revision)replace(db,kind,row.id,row.value,row.stamp);
      })();}finally{db.close();}
    }).catch(e=>{fault=e;});
  };
  for(const kind of ["reports","archives"]){mkdirSync(join(root,kind),{recursive:true});const w=watch(join(root,kind),(_event,file)=>enqueue(kind,file?.toString()??null));w.unref();w.on("error",e=>{fault=e;});watchers.push(w);}
  return { async settled(){
    await new Promise<void>(r=>setImmediate(r));
    let pending;do{pending=chain;await pending;await new Promise<void>(r=>setImmediate(r));}while(pending!==chain);
    if(fault)throw fault;
  }, async close(){closed=true;for(const w of watchers)w.close();await chain;} };
}
