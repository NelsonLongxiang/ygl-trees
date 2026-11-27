import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #321 item 2-4: kb notes get the supersede semantics claims have (#241), plus
 * the commands that need only write access. A superseded / deprecated note is
 * kept but hidden from search, list and the brief (--all shows it, marked);
 * promote refuses it and names the replacement; the chain is guarded against
 * self-reference, a second replacement, cycles and scope crossing.
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-sup321-")) : "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: home, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
// the human (non-JSON) rendering of a command: same env, no --json
function runHuman(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home, encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const j = (r: { out: string }) => JSON.parse(r.out);
const text = (r: { out: string; err: string }) => r.out + "\n" + r.err;
const addNote = (title: string, body: string, scope?: string) =>
  j(run(["kb", "add", "--title", title, "--body", body, ...(scope ? ["--scope", scope] : [])]));
// a body that starts with `---` (promote frontmatter) must go through -f: as --body it parses as a flag
const addNoteFile = (title: string, body: string) => {
  const f = join(home, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(f, body);
  return j(run(["kb", "add", "--title", title, "-f", f]));
};
const ids = (rows: any[]) => rows.map((r) => r.id);

beforeAll(() => {
  if (!hasBundle) return;
  expect(run(["db", "init"]).rc).toBe(0);
});
afterAll(() => { if (home && existsSync(home)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe.skipIf(!hasBundle)("kb supersede / deprecate (#321)", () => {
  it("supersede hides the old note from search/list/brief, --all marks it, show names both ends, unsupersede restores", () => {
    const oldN = addNote("旧写法蓝鲸索引", "蓝鲸索引的旧写法，已经过时");
    const newN = addNote("新写法蓝鲸索引", "蓝鲸索引的新写法，现行");
    const before = j(run(["kb", "search", "蓝鲸索引"]));
    expect(ids(before)).toContain(oldN.id);

    const sup = run(["kb", "supersede", oldN.id, newN.id, "--reason", "重复条目"]);
    expect(sup.rc).toBe(0);
    expect(j(sup).new).toBe(newN.id);

    // default: only the live note
    expect(ids(j(run(["kb", "search", "蓝鲸索引"])))).toEqual([newN.id]);
    expect(ids(j(run(["kb", "list"])))).not.toContain(oldN.id);
    expect(ids(j(run(["kb", "list"])))).toContain(newN.id);
    // --all: both, the old one marked with its replacement
    const all = j(run(["kb", "search", "蓝鲸索引", "--all"]));
    expect(ids(all)).toEqual(expect.arrayContaining([oldN.id, newN.id]));
    expect(all.find((r: any) => r.id === oldN.id).retired).toContain(newN.id);
    expect(j(run(["kb", "list", "--all"])).find((r: any) => r.id === oldN.id).retired).toContain(newN.id);
    // show: both ends
    expect(j(run(["kb", "show", oldN.id])).superseded_by).toBe(newN.id);
    expect(j(run(["kb", "show", newN.id])).supersedes).toEqual([oldN.id]);
    // brief's recent notes skip the retired one
    expect(ids(j(run(["agent", "brief"])).recent_notes)).not.toContain(oldN.id);
    // the supersede left an event with the reason
    const log = text(run(["agent", "log", "--limit", "50"]));
    expect(log).toMatch(/kb\.supersede/);

    // undo
    expect(run(["kb", "unsupersede", oldN.id]).rc).toBe(0);
    expect(ids(j(run(["kb", "search", "蓝鲸索引"])))).toEqual(expect.arrayContaining([oldN.id, newN.id]));
    expect(j(run(["kb", "show", oldN.id])).superseded_by).toBeUndefined();
    // undoing twice names the problem
    expect(run(["kb", "unsupersede", oldN.id]).rc).toBe(1);
  }, 180000);

  it("--all keeps the live note inside --limit even when retired notes outrank it", () => {
    const a = addNote("限额探针 甲", "限额探针词 限额探针词 限额探针词");
    const b = addNote("限额探针 乙", "限额探针词");
    expect(run(["kb", "supersede", a.id, b.id]).rc).toBe(0);
    const one = j(run(["kb", "search", "限额探针", "--limit", "1"]));
    expect(ids(one)).toEqual([b.id]);
  }, 120000);

  it("promote refuses a superseded note and names the replacement; works again after unsupersede", () => {
    const oldN = addNoteFile("提升探针旧", "---\ncue: x\nlesson: y\nevidence: z\n---\n正文旧");
    const newN = addNoteFile("提升探针新", "---\ncue: x\nlesson: y2\nevidence: z\n---\n正文新");
    expect(run(["kb", "supersede", oldN.id, newN.id]).rc).toBe(0);
    const p = run(["kb", "promote", oldN.id, "--name", "promote-probe-old"]);
    expect(p.rc).not.toBe(0);
    expect(text(p)).toContain(newN.id);
    expect(text(p)).toMatch(/superseded/);
    expect(run(["kb", "unsupersede", oldN.id]).rc).toBe(0);
    expect(run(["kb", "promote", oldN.id, "--name", "promote-probe-old"]).rc).toBe(0);
  }, 120000);

  it("guards: self, a second replacement, cycles (direct and through rel add) and scope crossing all name the ids", () => {
    const a = addNote("链节点A", "链节点A正文");
    const b = addNote("链节点B", "链节点B正文");
    const c = addNote("链节点C", "链节点C正文");
    const self = run(["kb", "supersede", a.id, a.id]);
    expect(self.rc).toBe(2);
    expect(text(self)).toContain(a.id);

    expect(run(["kb", "supersede", a.id, b.id]).rc).toBe(0);
    // same pair again is idempotent
    expect(run(["kb", "supersede", a.id, b.id]).rc).toBe(0);
    const second = run(["kb", "supersede", a.id, c.id]);
    expect(second.rc).toBe(2);
    expect(text(second)).toContain(a.id);
    expect(text(second)).toContain(b.id);

    // b→c, then c→a would close a→b→c→a
    expect(run(["kb", "supersede", b.id, c.id]).rc).toBe(0);
    const cyc = run(["kb", "supersede", c.id, a.id]);
    expect(cyc.rc).toBe(2);
    expect(text(cyc)).toMatch(/cycle/);
    // the generic rel path is guarded the same way
    const cyc2 = run(["rel", "add", "kb:" + c.id, "kb:" + a.id, "--rel", "superseded-by"]);
    expect(cyc2.rc).toBe(2);
    expect(text(cyc2)).toMatch(/cycle/);
    const second2 = run(["rel", "add", "kb:" + a.id, "kb:" + c.id, "--rel", "superseded-by"]);
    expect(second2.rc).toBe(2);

    const s1 = addNote("范围甲", "范围甲正文", "dept:ops");
    const s2 = addNote("范围乙", "范围乙正文", "dept:sales");
    const cross = run(["kb", "supersede", s1.id, s2.id]);
    expect(cross.rc).toBe(2);
    expect(text(cross)).toContain(s1.id);
    expect(text(cross)).toContain(s2.id);
    expect(text(cross)).toMatch(/scope/);
  }, 240000);

  it("rel add kb:<old> kb:<new> --rel superseded-by is honoured by search like the command", () => {
    const o = addNote("关系入口旧", "关系入口探针词");
    const n = addNote("关系入口新", "关系入口探针词");
    expect(run(["rel", "add", "kb:" + o.id, "kb:" + n.id, "--rel", "superseded-by"]).rc).toBe(0);
    const hits = ids(j(run(["kb", "search", "关系入口探针词"])));
    expect(hits).toContain(n.id);
    expect(hits).not.toContain(o.id);
  }, 120000);

  it("deprecate retires a note with no replacement; needs a reason; undeprecate restores; rm still works", () => {
    const n = addNote("作废探针", "作废探针词正文");
    const noReason = run(["kb", "deprecate", n.id]);
    expect(noReason.rc).toBe(2);
    expect(run(["kb", "deprecate", n.id, "--reason", "结论已被推翻"]).rc).toBe(0);
    expect(ids(j(run(["kb", "search", "作废探针词"])))).not.toContain(n.id);
    const all = j(run(["kb", "search", "作废探针词", "--all"]));
    expect(all.find((r: any) => r.id === n.id).retired).toMatch(/作废/);
    expect(j(run(["kb", "show", n.id])).deprecated).toBe(true);
    expect(run(["kb", "promote", n.id, "--name", "deprecated-probe"]).rc).not.toBe(0);
    expect(run(["kb", "undeprecate", n.id]).rc).toBe(0);
    expect(ids(j(run(["kb", "search", "作废探针词"])))).toContain(n.id);
    expect(run(["kb", "undeprecate", n.id]).rc).toBe(1);
    expect(run(["kb", "rm", n.id]).rc).toBe(0);
  }, 180000);

  it("a skill promoted from a note retires with it: agent/skill match hide it by default, --all marks it, limit stays full, unsupersede brings it back", () => {
    const fm = (word: string) => `---\ncue: ${word}\nlesson: ${word}已过时\nevidence: z\n---\n${word}正文`;
    const oldN = addNoteFile("技能退役旧", fm("鲸脊零号"));
    const newN = addNoteFile("技能退役新", fm("鲸脊零号"));
    expect(run(["kb", "promote", oldN.id, "--name", "retire-probe-old"]).rc).toBe(0);
    expect(run(["kb", "promote", newN.id, "--name", "retire-probe-new"]).rc).toBe(0);
    const names = (r: { out: string }) => (j(r).matches ?? j(r)).map((m: any) => m.name);
    expect(names(run(["agent", "match", "鲸脊零号"]))).toEqual(expect.arrayContaining(["retire-probe-old", "retire-probe-new"]));

    expect(run(["kb", "supersede", oldN.id, newN.id]).rc).toBe(0);
    // default: only the live skill, in both commands
    expect(names(run(["agent", "match", "鲸脊零号"]))).toEqual(["retire-probe-new"]);
    expect(names(run(["skill", "match", "鲸脊零号"]))).toEqual(["retire-probe-new"]);
    // the limit is not eaten by the hidden one
    expect(names(run(["agent", "match", "鲸脊零号", "--limit", "1"]))).toEqual(["retire-probe-new"]);
    // --all: both, the retired one marked with the replacement
    const all = j(run(["agent", "match", "鲸脊零号", "--all"])).matches;
    expect(all.map((m: any) => m.name)).toEqual(expect.arrayContaining(["retire-probe-old", "retire-probe-new"]));
    expect(all.find((m: any) => m.name === "retire-probe-old").retired).toContain(newN.id);
    expect(all.find((m: any) => m.name === "retire-probe-new").retired).toBeUndefined();
    const allSkill = j(run(["skill", "match", "鲸脊零号", "--all"]));
    expect(allSkill.find((m: any) => m.name === "retire-probe-old").superseded_by).toBe(newN.id);
    // brief does not recommend the retired skill
    expect(j(run(["agent", "brief"])).top_skills.map((s: any) => s.name)).not.toContain("retire-probe-old");
    // review R4: the human rendering must agree with the JSON one
    const human = runHuman(["agent", "brief"]);
    expect(human.rc).toBe(0);
    expect(human.out).not.toContain("retire-probe-old");
    expect(human.out).toContain("retire-probe-new");

    // undo: the skill is back, nothing else to restore
    expect(run(["kb", "unsupersede", oldN.id]).rc).toBe(0);
    expect(names(run(["agent", "match", "鲸脊零号"]))).toEqual(expect.arrayContaining(["retire-probe-old", "retire-probe-new"]));

    // deprecate (no replacement) retires the skill too, marked deprecated under --all
    expect(run(["kb", "deprecate", oldN.id, "--reason", "结论被推翻"]).rc).toBe(0);
    expect(names(run(["agent", "match", "鲸脊零号"]))).toEqual(["retire-probe-new"]);
    expect(j(run(["skill", "match", "鲸脊零号", "--all"])).find((m: any) => m.name === "retire-probe-old").deprecated).toBe(true);
    expect(run(["kb", "undeprecate", oldN.id]).rc).toBe(0);
    expect(names(run(["agent", "match", "鲸脊零号"]))).toContain("retire-probe-old");
  }, 240000);

  it("a skill with a non-kb origin, or from a scoped note pair, is unaffected / retires within its scope", () => {
    // a skill whose origin is not a kb note never retires
    const f = join(home, "plain-skill.md");
    writeFileSync(f, "---\nname: plain-probe-skill\ndescription: 鳞甲贰号 描述\n---\n鳞甲贰号正文\n");
    expect(run(["skill", "import", f]).rc).toBe(0);
    expect(j(run(["skill", "match", "鳞甲贰号"])).map((m: any) => m.name)).toContain("plain-probe-skill");
    // a scoped note pair: the skill inherits the scope, retires with the note
    const fm = (w: string) => `---\ncue: ${w}\nlesson: l\nevidence: z\n---\n${w}正文`;
    const mk = (title: string, body: string) => {
      const bf = join(home, `scoped-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(bf, body);
      return j(run(["kb", "add", "--title", title, "-f", bf, "--scope", "dept:ops"]));
    };
    const o = mk("范围技能旧", fm("鳍骨壹号"));
    const n = mk("范围技能新", fm("鳍骨壹号"));
    expect(run(["kb", "promote", o.id, "--name", "scoped-old-skill"]).rc).toBe(0);
    expect(run(["kb", "supersede", o.id, n.id]).rc).toBe(0);
    expect(j(run(["skill", "match", "鳍骨壹号"])).map((m: any) => m.name)).not.toContain("scoped-old-skill");
    expect(j(run(["skill", "match", "鳍骨壹号", "--all"])).map((m: any) => m.name)).toContain("scoped-old-skill");
  }, 240000);

  it("review #325 R1: a replacement may not cross two known projects even inside one shared scope", () => {
    const mkNote = (project: string, title: string) => {
      expect(run(["project", "new", project, "-q", "探针问题"]).rc).toBe(0);
      const art = j(run(["produce", "section", title, "--body", `${title} 的正文`]));
      return j(run(["kb", "ingest", art.id, "--scope=bench:shared"]));
    };
    const a = mkNote("proj-r1-a", "跨项目探针甲");
    const b = mkNote("proj-r1-b", "跨项目探针乙");
    const viaCmd = run(["kb", "supersede", a.id, b.id]);
    expect(viaCmd.rc).toBe(2);
    expect(text(viaCmd)).toMatch(/project/);
    expect(text(viaCmd)).toContain(a.id);
    expect(text(viaCmd)).toContain(b.id);
    // the generic relation path is guarded the same way
    const viaRel = run(["rel", "add", "kb:" + a.id, "kb:" + b.id, "--rel", "superseded-by"]);
    expect(viaRel.rc).toBe(2);
    expect(text(viaRel)).toMatch(/project/);
    // two notes of ONE project (both ingested there) are fine, and so are notes with no known project
    expect(run(["project", "use", "proj-r1-a"]).rc).toBe(0);
    const a2 = j(run(["kb", "ingest", j(run(["produce", "section", "跨项目探针丙", "--body", "跨项目探针丙正文"])).id, "--scope=bench:shared"]));
    expect(run(["kb", "supersede", a.id, a2.id]).rc).toBe(0);
    const h1 = addNote("无项目甲", "无项目甲正文", "bench:shared");
    const h2 = addNote("无项目乙", "无项目乙正文", "bench:shared");
    expect(run(["kb", "supersede", h1.id, h2.id]).rc).toBe(0);
  }, 240000);

  it("review #325 R2: rescope may not split a superseded-by pair; undo the pair, rescope, supersede again", () => {
    const a = addNote("改范围甲", "改范围甲正文", "bench:alpha");
    const b = addNote("改范围乙", "改范围乙正文", "bench:alpha");
    expect(run(["kb", "supersede", a.id, b.id]).rc).toBe(0);
    for (const end of [a.id, b.id]) {
      const r = run(["kb", "rescope", end, "--scope=bench:beta"]);
      expect(r.rc).toBe(2);
      expect(text(r)).toContain(a.id);
      expect(text(r)).toContain(b.id);
      expect(text(r)).toMatch(/scope/);
    }
    // nothing moved: the live note is still in the original grant
    expect(ids(j(run(["kb", "list", "--scope=bench:alpha"])))).toContain(b.id);
    // rescoping a note that is in no pair is unchanged
    const lone = addNote("改范围独", "改范围独正文", "bench:alpha");
    expect(run(["kb", "rescope", lone.id, "--scope=bench:beta"]).rc).toBe(0);
    // the documented way out
    expect(run(["kb", "unsupersede", a.id]).rc).toBe(0);
    expect(run(["kb", "rescope", a.id, "--scope=bench:beta"]).rc).toBe(0);
    expect(run(["kb", "rescope", b.id, "--scope=bench:beta"]).rc).toBe(0);
    expect(run(["kb", "supersede", a.id, b.id]).rc).toBe(0);
  }, 240000);

  it("review #325 R3: deprecated retires a note only as the self-relation; generic non-self insertion is refused and reads nothing", () => {
    const a = addNote("泛关系甲", "泛关系甲正文", "bench:alpha");
    const b = addNote("泛关系乙", "泛关系乙正文", "bench:beta");
    const r = run(["rel", "add", "kb:" + a.id, "kb:" + b.id, "--rel", "deprecated"]);
    expect(r.rc).toBe(2);
    expect(text(r)).toMatch(/self-relation/);
    expect(text(r)).toContain(a.id);
    expect(j(run(["kb", "show", a.id])).deprecated).toBeUndefined();
    expect(ids(j(run(["kb", "list"])))).toContain(a.id);
    // the declared self-form through the generic path is the same state `kb deprecate` writes
    expect(run(["rel", "add", "kb:" + a.id, "kb:" + a.id, "--rel", "deprecated"]).rc).toBe(0);
    expect(j(run(["kb", "show", a.id])).deprecated).toBe(true);
    expect(ids(j(run(["kb", "list"])))).not.toContain(a.id);
    expect(run(["kb", "undeprecate", a.id]).rc).toBe(0);
  }, 240000);

  it("--all names the deprecate reason on notes, in show, and on a promoted skill in agent match / skill match", () => {
    const fm = (w: string) => `---\ncue: ${w}\nlesson: l\nevidence: z\n---\n${w}正文`;
    const n = addNoteFile("作废原因探针", fm("绯鲤叁号"));
    expect(run(["kb", "promote", n.id, "--name", "reason-probe-skill"]).rc).toBe(0);
    expect(run(["kb", "deprecate", n.id, "--reason", "结论被新数据推翻"]).rc).toBe(0);
    const note = j(run(["kb", "search", "绯鲤叁号", "--all"])).find((r: any) => r.id === n.id);
    expect(note.retired).toContain("结论被新数据推翻");
    expect(j(run(["kb", "show", n.id])).deprecated_reason).toBe("结论被新数据推翻");
    expect(j(run(["kb", "list", "--all"])).find((r: any) => r.id === n.id).retired).toContain("结论被新数据推翻");
    const agent = j(run(["agent", "match", "绯鲤叁号", "--all"])).matches.find((m: any) => m.name === "reason-probe-skill");
    expect(agent.retired).toContain("结论被新数据推翻");
    expect(j(run(["skill", "match", "绯鲤叁号", "--all"])).find((m: any) => m.name === "reason-probe-skill").deprecated_reason).toBe("结论被新数据推翻");
    // a note deprecated with no reason on record still reads as deprecated
    expect(run(["kb", "undeprecate", n.id]).rc).toBe(0);
    expect(run(["rel", "add", "kb:" + n.id, "kb:" + n.id, "--rel", "deprecated"]).rc).toBe(0);
    const bare = j(run(["agent", "match", "绯鲤叁号", "--all"])).matches.find((m: any) => m.name === "reason-probe-skill");
    expect(bare.retired).toBe("来源笔记已作废");
  }, 240000);

  it("unknown notes and missing arguments fail cleanly", () => {
    const real = addNote("存在的笔记", "存在的笔记正文");
    expect(run(["kb", "supersede", "nope-id", real.id]).rc).toBe(1);
    expect(run(["kb", "supersede", real.id, "nope-id"]).rc).toBe(1);
    expect(run(["kb", "supersede", real.id]).rc).toBe(2);
    expect(run(["kb", "unsupersede"]).rc).toBe(2);
    expect(run(["kb", "deprecate", "nope-id", "--reason", "x"]).rc).toBe(1);
  }, 120000);
});
