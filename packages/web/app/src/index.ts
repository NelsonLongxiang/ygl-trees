/**
 * Web-app static resolver for the React rich client (apps/web/dist,
 * workspace knowledge — never user config). 0.86 (Cordis P0-2): the
 * WebAppService shell is deleted — webui calls openStatic() directly and
 * nobody consumed ctx.webApp; what remains is the pure resolver the HTTP
 * surface owns.
 *
 * @module @ygl/web-app
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Resolve the built client dist (workspace knowledge). Pure: safe to call
 *  from short-lived CLI processes without betting on async plugin timing.
 *
 *  Probe by REPO MARKER, not by counting levels from __dirname: under the
 *  tsdown single-file build __dirname collapses to dist/bundle, so any
 *  fixed-depth relative path misses. Walking up to the repo root (the dir
 *  holding ygl.bundle.json) works from every layout — tsc tree, bundle,
 *  and a run straight from src/. */
export function resolveDistRoot(from: string = __dirname): string | null {
  const candidates: string[] = [];
  let dir = from;
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
    candidates.push(path.join(dir, "apps", "web", "dist"));
    if (fs.existsSync(path.join(dir, "ygl.bundle.json"))) break; // repo root reached
  }
  candidates.push(path.resolve(process.cwd(), "apps", "web", "dist"));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export interface StaticFile {
  body: Buffer;
  mime: string;
}

/** URL → dist 静态文件（SPA 回落 index.html；路径遍历安全）。纯函数。 */
export function openStatic(urlPath: string): StaticFile | null {
  const root = resolveDistRoot();
  if (!root) return null;
  const clean = urlPath.split("?")[0].replace(/^\/+/, "");
  let file = path.resolve(root, clean === "" ? "index.html" : clean);
  // 0.90.1 P3-4 (review direct-a35d58ae): prefix guard must include the
  // separator — a bare startsWith(root) would admit sibling dist-* dirs.
  if (!file.startsWith(root + path.sep) && file !== root) file = path.join(root, "index.html"); // traversal → shell
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, "index.html"); // SPA fallback
    if (!fs.existsSync(file)) return null;
  }
  const ext = path.extname(file).toLowerCase();
  return { body: fs.readFileSync(file), mime: MIME[ext] || "application/octet-stream" };
}
