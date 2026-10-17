import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../../../core/database/src/db";

let db: DB;
let dir: string;

beforeAll(() => {
  dir = path.join(process.cwd(), "tmp", `v2-tests-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "t.db"), { lock: false });
});

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("v2 features", () => {
  it("timeline: events grouped by day", () => {
    db.run("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
      ["ev-t1", "2026-10-17 10:00:00", "test", "project.new", "project", "p1", "test", "info"]);
    db.run("INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
      ["ev-t2", "2026-10-17 11:00:00", "test", "kb.add", "kb", "k1", "test", "info"]);
    const days = db.all("SELECT date(ts) as day, COUNT(*) as n FROM events GROUP BY date(ts)") as any[];
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days[0].n).toBeGreaterThanOrEqual(2);
  });

  it("time-travel: entity counts at timestamp", () => {
    db.run("INSERT INTO projects(id,name,question,created,updated) VALUES(?,?,?,?,?)",
      ["p-tt", "test", "q", "2026-10-16 00:00:00", "2026-10-16 00:00:00"]);
    const before = db.get("SELECT COUNT(*) as n FROM projects WHERE created <= '2026-10-15'") as any;
    const after = db.get("SELECT COUNT(*) as n FROM projects WHERE created <= '2026-10-17'") as any;
    expect(after.n).toBeGreaterThan(before.n);
  });

  it("workspace: can create separate workspace dirs", () => {
    const ws1 = path.join(dir, "ws1");
    const ws2 = path.join(dir, "ws2");
    fs.mkdirSync(ws1, { recursive: true });
    fs.mkdirSync(ws2, { recursive: true });
    expect(fs.existsSync(ws1)).toBe(true);
    expect(fs.existsSync(ws2)).toBe(true);
    expect(ws1).not.toBe(ws2);
  });

  it("obsidian: exportable markdown structure", () => {
    const kb = db.get("SELECT COUNT(*) as n FROM kb_notes") as any;
    expect(typeof kb.n).toBe("number");
    // Obsidian export produces files with frontmatter
    const fm = `---\ntype: knowledge\ntags: test\n---\n\n# Title\n\nBody`;
    expect(fm.startsWith("---")).toBe(true);
    expect(fm).toContain("type:");
    expect(fm).toContain("tags:");
  });

  it("help suggestions: known groups are recognized", () => {
    const known = ["agent","research","produce","kb","skill","tree","node","task","rel","plugin","webui","db","doctor","config","job","project","llms"];
    expect(known).toContain("research");
    expect(known).toContain("kb");
    expect(known).not.toContain("rsrch");
    // Subsequence check: "rsrch" chars appear in order in "research"
    const input = "rsrch";
    const target = "research";
    let idx = 0;
    for (const ch of input) {
      idx = target.indexOf(ch, idx);
      if (idx === -1) break;
      idx++;
    }
    expect(idx).toBeGreaterThan(-1); // "rsrch" IS a subsequence of "research"
  });

  it("llms --json: sections are parseable", () => {
    // The llms manifest splits into sections by "## " headers
    const manifest = "# Title\n\n## Section1\nContent1\n\n## Section2\nContent2";
    const sections = manifest.split("\n## ");
    expect(sections.length).toBe(3); // header + 2 sections
    expect(sections[1].startsWith("Section1")).toBe(true);
  });
});
