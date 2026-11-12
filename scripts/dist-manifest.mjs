#!/usr/bin/env node
/**
 * Build bookends for #236 (see scripts/lib/dist-manifest.mjs).
 *
 *   node scripts/dist-manifest.mjs clean   # first step of `pnpm build`: empty dist/
 *   node scripts/dist-manifest.mjs write   # last step of `pnpm build`: record the built file set
 *   node scripts/dist-manifest.mjs check   # JSON {ok, manifest, extra, missing}; rc 1 when not ok
 */
import { resolve } from "node:path";
import { cleanDist, distDrift, writeManifest } from "./lib/dist-manifest.mjs";

const root = resolve(process.cwd());
const cmd = process.argv[2];

if (cmd === "clean") {
  cleanDist(root);
} else if (cmd === "write") {
  const { files } = writeManifest(root);
  console.log(`dist-manifest: ${files.length} files recorded`);
} else if (cmd === "check") {
  const d = distDrift(root);
  console.log(JSON.stringify(d));
  process.exit(d.ok ? 0 : 1);
} else {
  console.error("usage: node scripts/dist-manifest.mjs clean|write|check");
  process.exit(2);
}
