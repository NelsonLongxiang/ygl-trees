import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";
import { packEvalChoiceSpec, packEvalScoreSpec } from "../../../techtree/eval/src/eval";

let db: DB;
let dir: string;
const now = new Date().toISOString();

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true }); // scratch cleanup (user-flagged accumulation)
});

beforeAll(() => {
  dir = path.join(process.cwd(), "tmp", `doctor-unit-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "unit.db"));
  db.run("INSERT INTO trees(id,name,created) VALUES(?,?,?)", ["t1", "dt", now]);
  db.run(
    "INSERT INTO nodes(id,tree_id,key,name,kind,tier,cost,cost_unit,payload,tags,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ["n1", "t1", "g", "g", "tech", 0, 0, "", "", "", now]
  );
  const cond = (id: string, op: string, value: string) =>
    db.run(
      "INSERT INTO node_conditions(id,node_id,name,kind,expr,op,value,required,effect,weight,note) VALUES(?,?,?,?,?, ?,?,1,'gate',1,'')",
      [id, "n1", id, "quest", "", op, value]
    );
  // good
  cond("c_bool", "eval", "任务完成了吗");
  cond("c_choice", "eval-choice", packEvalChoiceSpec("选哪个", { a: "甲", b: "乙" }, "a"));
  cond("c_score", "eval-score", packEvalScoreSpec("如何", ["低", "高"], 1));
  // bad: choice with answer not in options
  cond("b_choice", "eval-choice", packEvalChoiceSpec("选哪个", { a: "甲" }, "zzz"));
  // bad: score with 1 level
  cond("b_score", "eval-score", packEvalScoreSpec("如何", ["仅一级"], 0));
  // bad: choice envelope with empty options
  cond("b_empty", "eval-choice", '{"q":"x","options":{},"answer":"a"}');
});

describe("doctor eval_envelopes 检查", () => {
  it("好信封 3 条 + 坏信封 3 条 → fail 且逐条点名", async () => {
    const mod = await import("../src/doctor");
    const lines: string[] = [];
    const ctx: any = {
      json: true,
      color: false,
      quiet: false,
      // capture JSON output
    };
    const origLog = console.log;
    console.log = (s: string) => lines.push(String(s));
    try {
      const rc = mod.run({ ctx, db, store: null } as any, "", [], {});
      const payload = JSON.parse(lines.join(""));
      const ev = payload.find((c: any) => c.name === "eval_envelopes");
      expect(rc).toBe(1); // other fails absent — eval_envelopes is the only fail
      expect(ev.status).toBe("fail");
      expect(ev.detail).toContain("b_choice(g)");
      expect(ev.detail).toContain("b_score(g)");
      expect(ev.detail).toContain("b_empty(g)");
    } finally {
      console.log = origLog;
    }
  });
});

describe("doctor stale_lock 自检", () => {
  it("own live lock is not warned; a foreign lock is", async () => {
    const mod = await import("../src/doctor");
    const lockDir = `${db.path}.ygllock`;
    const runDoctor = async (): Promise<string> => {
      const lines: string[] = [];
      const ctx: any = { json: true, color: false, quiet: false };
      const origLog = console.log;
      console.log = (s: string) => lines.push(String(s));
      try {
        await mod.run({ ctx, db, store: null } as any, "", [], {});
        const payload = JSON.parse(lines.join(""));
        return payload.find((c: any) => c.name === "stale_lock").status;
      } finally {
        console.log = origLog;
      }
    };
    // our own live lock (the process running doctor) → pass
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
    const own = await runDoctor();
    fs.rmSync(lockDir, { recursive: true, force: true });
    // a foreign holder → warn
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), "999999");
    const foreign = await runDoctor();
    fs.rmSync(lockDir, { recursive: true, force: true });
    expect(own).toBe("pass");
    expect(foreign).toBe("warn");
  });
});
