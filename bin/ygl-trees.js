#!/usr/bin/env node
"use strict";
// main() returns the process exit code — do NOT override it, agents rely on
// rc≠0 to detect failures (2 usage error, 1 runtime error, 0 ok).
process.exitCode = require("../dist/cli").main(process.argv.slice(2));
