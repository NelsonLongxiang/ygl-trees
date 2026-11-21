import {describe,it,expect} from "vitest";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {DB,SCHEMA_VERSION} from "../src/db";
describe("claim project/text lookup index",()=>{
 it("covers fresh and already-current databases without changing schema version or business data",()=>{
  mkdirSync(join(process.cwd(),"tmp"),{recursive:true});const home=mkdtempSync(join(process.cwd(),"tmp/claim-lookup-index-")),file=join(home,"workspace.db");let db:DB|undefined;
  try{
   db=new DB(file,{managed:true});expect(db.all("PRAGMA index_list(claims)").some((r:any)=>r.name==="idx_claims_project_text")).toBe(true);
   db.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')");db.run("INSERT INTO claims(id,project_id,text,content_hash,created,updated) VALUES('c','p','ruling','hash','old','old')");
   const before=db.all("SELECT * FROM claims");db.run("DROP INDEX idx_claims_project_text");db.closeStrict();db=undefined;
   db=new DB(file,{managed:true});expect(db.get("PRAGMA user_version")).toEqual({user_version:SCHEMA_VERSION});expect(db.all("SELECT * FROM claims")).toEqual(before);
   expect(db.all("EXPLAIN QUERY PLAN SELECT id FROM claims WHERE project_id=? AND text=?",["p","ruling"]).map((r:any)=>r.detail).join(" ")).toContain("idx_claims_project_text");
   expect(db.all("PRAGMA index_info(idx_claims_project_text)").map((r:any)=>r.name)).toEqual(["project_id","text"]);
  }finally{db?.closeStrict();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
 });
});
