#!/usr/bin/env node
/**
 * Reproducible npm tarball: same commit → same sha256 on any machine.
 *
 * `npm pack` stamps mtimes, ownership and gzip metadata from the packing host,
 * so the tarball hash changes on every run and cannot be used as a tamper
 * checksum for a release. This script builds the tarball itself:
 *
 *   - file list   = `npm pack --dry-run --json` (npm's own selection rules,
 *                   publishConfig/files/.npmignore all respected — we never
 *                   re-implement them)
 *   - entry order = sorted byte-wise by path
 *   - mtime       = 0, uid/gid = 0, uname/gname = "", mode = 0644
 *   - format      = ustar (no pax headers, no per-entry extras)
 *   - gzip        = level 9, no name, no mtime, OS byte fixed by zlib
 *
 * Usage: node scripts/pack-repro.mjs [--out <file>]
 * Prints the tarball path, byte size and sha256 (one JSON line with --json).
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";

const BLOCK = 512;

function octal(value, width) {
  // ustar numeric fields: zero padded octal + NUL terminator
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`field overflow: ${s}`);
  return s.padStart(width - 1, "0") + "\0";
}

function header(name, size) {
  const buf = Buffer.alloc(BLOCK, 0);
  // ustar splits long names into prefix (155) + name (100)
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const parts = name.split("/");
    base = parts.pop();
    prefix = parts.join("/");
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`path too long for ustar: ${name}`);
    }
  }
  buf.write(base, 0, 100, "utf8");
  buf.write(octal(0o644, 8), 100, 8, "ascii"); // mode
  buf.write(octal(0, 8), 108, 8, "ascii"); // uid
  buf.write(octal(0, 8), 116, 8, "ascii"); // gid
  buf.write(octal(size, 12), 124, 12, "ascii"); // size
  buf.write(octal(0, 12), 136, 12, "ascii"); // mtime
  buf.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  buf.write("0", 156, 1, "ascii"); // typeflag: regular file
  buf.write("ustar\0", 257, 6, "ascii"); // magic
  buf.write("00", 263, 2, "ascii"); // version
  buf.write(prefix, 345, 155, "utf8");
  // checksum: sum of all bytes with the checksum field as spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return Buffer.alloc(rem === 0 ? 0 : BLOCK - rem, 0);
}

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const asJson = args.includes("--json");
const root = resolve(process.cwd());

// Spawn npm's JS entrypoint through this node binary: .cmd shims need a shell,
// and a shell would reintroduce quoting differences across platforms.
//
// `npm_execpath` is only usable when the caller really is npm: under
// `pnpm run` it points at pnpm's own CLI, whose `pack` has neither
// `--dry-run --json` nor npm's selection flags — feeding it here made the
// reproducibility gate fail exactly when it was run through pnpm.
const npmCli = /\bnpm-cli\.js$/i.test(process.env.npm_execpath ?? "")
  ? process.env.npm_execpath
  : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const packed = JSON.parse(
  execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
)[0];
if (!packed?.filename || !Array.isArray(packed.files)) {
  throw new Error("npm pack --dry-run --json returned no file list");
}

const files = packed.files
  .map((f) => f.path)
  .filter((p) => !p.endsWith("/"))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const chunks = [];
for (const rel of files) {
  const data = readFileSync(join(root, rel));
  const name = `package/${rel}`;
  chunks.push(header(name, data.length), data, pad(data.length));
}
chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive: two zero blocks
const tgz = gzipSync(Buffer.concat(chunks), { level: 9 });
const out = outFlag >= 0 ? resolve(args[outFlag + 1]) : join(root, packed.filename);
writeFileSync(out, tgz);
const sha = createHash("sha256").update(tgz).digest("hex");
if (asJson) {
  console.log(JSON.stringify({ path: out, bytes: tgz.length, sha256: sha, files: files.length }));
} else {
  console.log(`${out}\n${tgz.length} bytes\nsha256: ${sha}`);
}
