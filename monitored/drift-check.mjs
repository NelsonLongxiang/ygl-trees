#!/usr/bin/env node
// monitored/ 漂移检测（发版席死人开关）——比对 MANIFEST.md 基线 sha256
import { createHash } from "node:crypto";
import fs from "node:fs";
const files = ["gh-delta-watch.cjs", "gh-deepview.cjs", "gh-watch-state.json"];
const manifest = fs.readFileSync(new URL("./MANIFEST.md", import.meta.url), "utf8");
let bad = 0;
for (const f of files) {
  const p = new URL("./" + f, import.meta.url);
  if (!fs.existsSync(p)) { console.log("MISSING:", f); bad++; continue; }
  const sha = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  if (!manifest.includes(sha.slice(0, 16))) { console.log("DRIFT:", f, sha.slice(0, 16) + "…"); bad++; }
}
console.log(bad === 0 ? "monitored/ drift check: 0 drift (baseline ok)" : "monitored/ drift check: " + bad + " problem(s)");
process.exit(bad === 0 ? 0 : 1);
