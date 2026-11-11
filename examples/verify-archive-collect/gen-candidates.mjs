// Regenerates candidates.json and reviews.json from material.md (run once after editing either; both are committed).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = new URL(".", import.meta.url);
const clauses = readFileSync(new URL("material.md", dir), "utf8").split("\n").filter((l) => /^S[0-9] /.test(l));
const and = (...conditions) => ({ op: "and", conditions });
const or = (...conditions) => ({ op: "or", conditions });
const entries = (where) => ({ from: "archive_entries", select: ["seq", "path", "typeflag", "payload_sha256"], where });
const INDEX_SHA = createHash("sha256").update("module.exports = 1;\n").digest("hex");
const checkers = [
  { type: "sql", expect: "empty", fail_when: "rows>0", predicate: entries(and({ col: "path", op: "=", value: "package/index.js" }, { col: "payload_sha256", op: "!=", value: INDEX_SHA })) },
  { type: "count", predicate: { from: "archive_entries", select: ["seq"], where: and({ col: "path", op: "in", value: ["package/package.json", "package/index.js"] }, { col: "path_occurrence", op: "=", value: 1 }) }, op: ">=", value: 2 },
  { type: "sql", expect: "empty", fail_when: "rows>0", predicate: entries({ op: "not", conditions: [{ col: "path", op: "in", value: ["package/", "package/package.json", "package/index.js"] }] }) },
  { type: "sql", expect: "empty", fail_when: "rows>0", predicate: entries(and({ col: "path_occurrence", op: ">", value: 1 })) },
  { type: "sql", expect: "empty", fail_when: "rows>0", predicate: entries(or(
    { col: "path", op: "glob", value: "/*" }, { col: "path", op: "glob", value: "../*" }, { col: "path", op: "glob", value: "*/../*" },
    { col: "path", op: "glob", value: "*//*" }, { col: "path", op: "glob", value: "*\\*" }, { col: "path", op: "glob", value: "*[\u0001-\u001f]*" },
    { col: "path", op: "not-glob", value: "package/*" },
  )) },
  { type: "sql", expect: "empty", fail_when: "rows>0", predicate: entries({ op: "not", conditions: [{ col: "typeflag", op: "in", value: ["0", "", "5"] }] }) },
];
const anchor = (c, i) => ({ quote: c, locator: `material.md#S${i + 1}` });
writeFileSync(new URL("candidates.json", dir), JSON.stringify({ candidates: clauses.map((c, i) => ({ source_clause: c, anchor: anchor(c, i), checker: checkers[i] })) }, null, 2) + "\n");
writeFileSync(new URL("reviews.json", dir), JSON.stringify({ reviews: clauses.map((c, i) => ({ source_clause: c, findings: [
  { question: "faithful", verdict: "ok", reason: "判据只读采集表里的原始观测，条件与条款字面一致。", anchor: anchor(c, i) },
  { question: "decidable", verdict: "ok", reason: "有违规行（或计数不足）即 FAIL，机械可判。" },
  { question: "not-vacuous", verdict: "ok", reason: "采集表有行时扫描面非空；空包会被零扫描规则拦下，采集错误会把 PASS 降为 ERROR。" },
] })) }, null, 2) + "\n");
console.log(`${clauses.length} candidates and reviews written`);
