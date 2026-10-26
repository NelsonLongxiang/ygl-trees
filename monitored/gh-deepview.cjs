#!/usr/bin/env node
// gh-deepview.cjs — GitHub 深扫（v2 重建 2026-10-26，原件同窗被删）
// 每 8 监护轮一代（240m 层）：close velocity 24h/48h、open age/stale>3d、作者分布。
// 字段白名单（非法字段炸整条调用——reopenedAt 教训）；gh 断→exit 1 大声。
"use strict";
const { execFileSync } = require("node:child_process");
const REPO = "NelsonLongxiang/ygl-trees";
const OPEN_FIELDS = ["number", "title", "author", "createdAt", "updatedAt"];
const CLOSED_FIELDS = ["number", "title", "author", "closedAt"];

function gh(args, fields) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60000, stdio: ["ignore","pipe","pipe"] }));
  } catch (e) {
    process.stderr.write("GH-DEEPVIEW-UNAVAILABLE :: " + ((e.stderr||e.message)+"").replace(/\s+/g," ").slice(0,140) + "\n");
    process.exit(1);
  }
}

const open = gh(["issue","list","-R",REPO,"--state","open","--json",OPEN_FIELDS.join(","),"--limit","200"]);
const closed = gh(["issue","list","-R",REPO,"--state","closed","--json",CLOSED_FIELDS.join(","),"--limit","100"]);
const now = Date.now();
const h = 3600e3;
const v24 = closed.filter(i => now - new Date(i.closedAt) < 24*h).length;
const v48 = closed.filter(i => now - new Date(i.closedAt) < 48*h).length;
const stale = open.filter(i => now - new Date(i.updatedAt) > 3*24*h).map(i => "#"+i.number);
const byAuthor = {};
for (const i of open) byAuthor[i.author?.login || "?"] = (byAuthor[i.author?.login || "?"] || 0) + 1;
const oldest = open.slice().sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).slice(0,3).map(i=>"#"+i.number+"("+Math.round((now-new Date(i.createdAt))/h/24)+"d)");
console.log("GH-DEEPVIEW open=" + open.length + " close-velocity 24h=" + v24 + " 48h=" + v48 + " stale>3d=" + JSON.stringify(stale) + " oldest=" + JSON.stringify(oldest));
console.log("  authors: " + Object.entries(byAuthor).map(([a,n])=>a+"="+n).join(" "));
