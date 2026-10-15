#!/usr/bin/env node
"use strict";
// main() returns the process exit code (or a promise of it) — do NOT
// override it; agents rely on rc≠0 to detect failures (2 usage, 1 runtime).
Promise.resolve(require("../dist/apps/cli/index.js").main(process.argv.slice(2))).then(
  (rc) => { if (typeof rc === "number") process.exitCode = rc; },
  () => { process.exitCode = 1; }
);
