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

describe("doctor relation_orphans 检查（K3 0.106.0）", () => {
  it("dangling relation → warn；清理后 → pass", async () => {
    const mod = await import("../src/doctor");
    const check = () => {
      const lines: string[] = [];
      const ctx: any = { json: true, color: false, quiet: false };
      const origLog = console.log;
      console.log = (s: string) => lines.push(String(s));
      try {
        mod.run({ ctx, db, store: null } as any, "", [], {});
        return JSON.parse(lines.join("")).find((c: any) => c.name === "relation_orphans");
      } finally {
        console.log = origLog;
      }
    };
    db.run(
      "INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight,created) VALUES(?,?,?,?,?,?,?,?)",
      ["r_dangling", "node", "n_missing", "claim", "c_missing", "related", 1, now]
    );
    const warned = check();
    expect(warned.status).toBe("warn");
    expect(warned.detail).toContain("rel prune");
    db.run("DELETE FROM relations WHERE id='r_dangling'");
    expect(check().status).toBe("pass");
  });
});

describe("doctor session_identity 检查（K3 0.106.0）", () => {
  it("无 session 身份 + 多项目 → warn；设置 YGL_SESSION 后消失", async () => {
    const mod = await import("../src/doctor");
    const capture = () => {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (s: string) => lines.push(String(s));
      try {
        mod.run({ ctx: { json: true, color: false, quiet: false }, db, store: null } as any, "", [], {});
        return JSON.parse(lines.join("")) as any[];
      } finally {
        console.log = origLog;
      }
    };
    db.run("INSERT INTO projects(id,name,question,status,created,updated) VALUES(?,?,?,?,?,?)", ["p_sid1", "sid-one", "", "active", now, now]);
    db.run("INSERT INTO projects(id,name,question,status,created,updated) VALUES(?,?,?,?,?,?)", ["p_sid2", "sid-two", "", "active", now, now]);
    const prevSid = process.env.YGL_SESSION;
    const prevDsh = process.env.DSH_SESSION_ID;
    delete process.env.YGL_SESSION;
    delete process.env.DSH_SESSION_ID;
    try {
      const warned = capture().find((c) => c.name === "session_identity");
      expect(warned?.status).toBe("warn");
      expect(warned?.detail).toContain("default");
      process.env.YGL_SESSION = "spec-doctor";
      expect(capture().find((c) => c.name === "session_identity")).toBeUndefined();
    } finally {
      if (prevSid === undefined) delete process.env.YGL_SESSION; else process.env.YGL_SESSION = prevSid;
      if (prevDsh === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = prevDsh;
      db.run("DELETE FROM projects WHERE id IN ('p_sid1','p_sid2')");
    }
  });
});

describe("doctor skill_versions 审计 (#85)", () => {
  it("major/minor 落后 CLI 的技能被点名；新版本不误报；无 semver 单列", async () => {
    const mod = await import("../src/doctor");
    const root = path.join(dir, "skill-root");
    fs.mkdirSync(path.join(root, "skills", "old-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "new-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "bad-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
    fs.writeFileSync(path.join(root, "skills", "old-skill", "SKILL.md"), "---\nname: old-skill\nversion: 0.26.0\n---\n", "utf8");
    fs.writeFileSync(path.join(root, "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\nversion: 1.0.0\n---\n", "utf8");
    fs.writeFileSync(path.join(root, "skills", "bad-skill", "SKILL.md"), "---\nname: bad-skill\n---\n", "utf8");
    const audit = mod.auditSkillVersions("0.114.31", root)!;
    expect(audit.total).toBe(3);
    expect(audit.lagging.map((s) => s.name)).toEqual(["old-skill"]);
    expect(audit.lagging[0].version).toBe("0.26.0");
    expect(audit.malformed).toEqual(["bad-skill"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
