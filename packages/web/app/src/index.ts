/**
 * WebAppPlugin — provides ctx.webApp: serves the built React client
 * (apps/web/dist, workspace knowledge — never user config) over the
 * dashboard server. Pattern follows DSH packages/bundle/web-app: the app
 * entry builds with vite, this runtime-glue plugin resolves the dist and
 * hands static-file serving to whoever owns the HTTP surface.
 *
 * @module @ygl/web-app
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The React rich client this process can serve; dist-missing → null
     *  methods report unavailability and the caller falls back to the
     *  embedded zero-dep dashboard. */
    webApp: WebAppService;
  }
}

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
  if (!file.startsWith(root)) file = path.join(root, "index.html"); // traversal → shell
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, "index.html"); // SPA fallback
    if (!fs.existsSync(file)) return null;
  }
  const ext = path.extname(file).toLowerCase();
  return { body: fs.readFileSync(file), mime: MIME[ext] || "application/octet-stream" };
}

export class WebAppService extends Service {
  constructor(ctx: Context) {
    super(ctx, "webApp");
  }

  /** Whether a built client exists to serve. */
  available(): boolean {
    return resolveDistRoot() !== null;
  }

  /** Delegates to the pure resolver — short-lived CLI callers may use the
   *  standalone openStatic() without waiting on plugin timing. */
  open(urlPath: string): StaticFile | null {
    return openStatic(urlPath);
  }
}

export function apply(ctx: Context) {
  new WebAppService(ctx);
}
