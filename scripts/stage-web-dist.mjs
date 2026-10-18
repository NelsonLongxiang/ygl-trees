// 0.88 工单单3: stage the React client into the published unit.
// apps/web/dist (vite build output) → dist/apps/web/dist, so the npm package
// (files: ["dist", …]) ships the client and resolveDistRoot() finds it from
// dist/bundle by walking up (candidate <repo>/dist/apps/web/dist).
// Cross-platform node copy — no cp -r (Windows), no xcopy (Unix).
import * as fs from "node:fs";
import * as path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const src = path.join(repo, "apps", "web", "dist");
const dst = path.join(repo, "dist", "apps", "web", "dist");

if (!fs.existsSync(path.join(src, "index.html"))) {
  console.error(`stage-web-dist: ${src} has no index.html — run pnpm --filter @ygl/web build first`);
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dst), { recursive: true });

let files = 0, bytes = 0;
const copy = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, ent.name);
    const t = path.join(to, ent.name);
    if (ent.isDirectory()) copy(f, t);
    else { fs.copyFileSync(f, t); files++; bytes += fs.statSync(f).size; }
  }
};
copy(src, dst);
const kb = (bytes / 1024).toFixed(1);
console.log(`stage-web-dist: ${files} files (${kb} KB) → ${path.relative(repo, dst)}`);
