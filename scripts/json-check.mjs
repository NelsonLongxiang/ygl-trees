#!/usr/bin/env node
/**
 * JSON-channel checker for contract-audit.sh — reads a command's stdout on
 * stdin and reports one verdict word, so bash never has to embed a program:
 *
 *   OK               parses whole, no camelCase field, and (error mode) has a
 *                    non-empty string `error`
 *   EMPTY            nothing on stdout (a --json success must emit数据)
 *   NOT-JSON:<head>  stdout is not parseable as a whole
 *   CAMEL:<keys>     snake_case contract violated (camelCase field leaked)
 *   NO-ERROR-KEY     failure output parsed but carries no `error` string
 *
 * Usage: node scripts/json-check.mjs [--error]
 */
import { readFileSync } from "node:fs";

const errorMode = process.argv.includes("--error");
const raw = readFileSync(0, "utf8");

if (!raw.trim()) {
  console.log(errorMode ? "NO-ERROR-KEY" : "EMPTY");
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.log(`NOT-JSON:${raw.slice(0, 60).replace(/\s+/g, " ")}`);
  process.exit(0);
}

if (errorMode) {
  const ok = parsed && typeof parsed === "object" && typeof parsed.error === "string" && parsed.error.length > 0;
  console.log(ok ? "OK" : "NO-ERROR-KEY");
  process.exit(0);
}

const camel = new Set();
(function walk(value) {
  if (Array.isArray(value)) {
    for (const v of value) walk(v);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/[a-z][A-Z]/.test(k)) camel.add(k);
      walk(v);
    }
  }
})(parsed);

console.log(camel.size ? `CAMEL:${[...camel].join(",")}` : "OK");
