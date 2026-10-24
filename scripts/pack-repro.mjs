#!/usr/bin/env node
/**
 * Reproducible release tarball: same commit → same sha256 on any machine.
 *
 * `pnpm pack` already does the part we must NOT re-implement — rewriting
 * `workspace:` dependencies to real versions and applying the package's
 * `files`/`.npmignore` selection — but it stamps host mtimes, ownership and
 * gzip metadata, so its hash changes per machine and cannot be a tamper
 * checksum. The 0.105.0 incident is the other half of this contract: a
 * hand-assembled tarball from the repo's raw package.json shipped
 * `workspace:~` deps to npm and every fresh `npm install` failed. Release
 * bytes must be the *resolved* bytes.
 *
 * So: take pnpm's tarball as the source of content, then re-emit it
 * deterministically:
 *
 *   - entries      = pnpm pack's own file list (post-rewrite, post-selection)
 *   - entry order  = sorted byte-wise by path
 *   - metadata     = mtime 0, uid/gid 0, uname/gname "", mode 0644, ustar
 *   - gzip         = level 9, no name, no mtime, OS byte pinned to 255 so the
 *                    hash does not depend on the host zlib's OS_CODE (issue #5)
 *
 * Usage: node scripts/pack-repro.mjs [--out <file>] [--json]
 * Prints the tarball path, byte size and sha256.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirtyPaths, assertCleanTree } from "./lib/pack-guard.mjs";

const BLOCK = 512;

function octal(value, width) {
  const s = value.toString(8);
  if (s.length > width - 1) throw new Error(`field overflow: ${s}`);
  return s.padStart(width - 1, "0") + "\0";
}

function header(name, size) {
  const buf = Buffer.alloc(BLOCK, 0);
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
  buf.write("        ", 148, 8, "ascii"); // checksum placeholder
  buf.write("0", 156, 1, "ascii"); // regular file
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  buf.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return Buffer.alloc(rem === 0 ? 0 : BLOCK - rem, 0);
}

/** Minimal ustar reader: enough for a pnpm-produced release tarball. */
function readTarGz(tgz) {
  const buf = gunzipSync(tgz);
  const entries = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const rawName = h.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(h.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const path = prefix ? `${prefix}/${rawName}` : rawName;
    const start = off + BLOCK;
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / BLOCK) * BLOCK;
    // '0'/'\0' = regular file; skip pax/gnu extended headers and directories.
    if ((type === "0" || type === "\0" || h[156] === 0) && !path.endsWith("/")) entries.push({ path, data });
  }
  return entries;
}

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const asJson = args.includes("--json");
const allowDirty = args.includes("--allow-dirty");
const checkDirty = args.includes("--check-dirty");
const root = resolve(process.cwd());

// 0.110.0 incident: bytes must not depend on local dirt. Guard the input face
// before anything is packed; --check-dirty exposes the same judge for tests/CI.
try {
  const dirty = assertCleanTree(root, { allowDirty });
  if (checkDirty) {
    console.log(JSON.stringify({ dirty: false, files: [] }));
    process.exit(0);
  }
  if (dirty.length) console.error(`pack:repro: WARNING — sealing bytes with --allow-dirty (${dirty.length} path(s))`);
} catch (e) {
  if (checkDirty) {
    try {
      console.log(JSON.stringify({ dirty: true, files: dirtyPaths(root) }));
    } catch {
      console.log(JSON.stringify({ dirty: true, files: [] }));
    }
    process.exit(1);
  }
  console.error(String(e?.message || e));
  process.exit(1);
}

// Spawn pnpm's JS entrypoint through this node binary (no shell, no .cmd shim).
// 0.114.32: pnpm ≥10 installs may use pnpm.mjs instead of pnpm.cjs — probe both.
const pnpmBinCandidates = (base) => [
  join(base, "pnpm", "bin", "pnpm.cjs"),
  join(base, "pnpm", "bin", "pnpm.mjs"), // pnpm ≥10 layout change (release-seat report 0.114.31)
];
const pnpmCandidates = [
  /(^|[/\\])pnpm\.(c|m)js$/i.test(process.env.npm_execpath ?? "") ? process.env.npm_execpath : "",
  ...pnpmBinCandidates(join(dirname(process.execPath), "node_modules")),
  ...pnpmBinCandidates(join(dirname(process.execPath), "..", "lib", "node_modules")),
  // GitHub #10: standalone / Homebrew / npm-global installs are not reachable
  // through the two node-relative guesses above. Probe the known global layouts
  // and each PATH entry's sibling node_modules (the Windows npm shim lives next
  // to its package). Never spawn the .cmd shim: on Windows that needs a shell
  // and re-introduces quoting.
  ...(process.env.APPDATA ? pnpmBinCandidates(join(process.env.APPDATA, "npm", "node_modules")) : []),
  ...pnpmBinCandidates("/opt/homebrew/lib/node_modules"),
  ...pnpmBinCandidates("/usr/local/lib/node_modules"),
  ...(process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((d) => join(d, "node_modules", "pnpm", "bin", "pnpm.cjs")),
].filter(Boolean);
const pnpmCli = pnpmCandidates.find((p) => existsSync(p));
if (!pnpmCli) {
  throw new Error(
    "cannot locate pnpm: pack:repro must run pnpm's packer so workspace: deps are resolved before the bytes are sealed. " +
      `Tried: ${pnpmCandidates.slice(0, 6).join(", ")} … (${pnpmCandidates.length} candidates) and PATH/node_modules. ` +
      "Install pnpm (npm i -g pnpm / Homebrew / corepack enable) and retry.",
  );
}

const work = mkdtempSync(join(tmpdir(), "ygl-pack-repro-"));
try {
  execFileSync(process.execPath, [pnpmCli, "pack", "--pack-destination", work], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const produced = readdirSync(work).filter((f) => f.endsWith(".tgz"));
  if (produced.length !== 1) throw new Error(`pnpm pack produced ${produced.length} tarballs in ${work}`);
  const source = readFileSync(join(work, produced[0]));
  const entries = readTarGz(source);

  const manifest = entries.find((e) => e.path === "package/package.json");
  if (!manifest) throw new Error("pnpm tarball has no package/package.json");
  const manifestJson = JSON.parse(manifest.data.toString("utf8"));
  const deps = manifestJson.dependencies ?? {};
  const unresolved = Object.entries(deps).filter(([, v]) => String(v).startsWith("workspace:"));
  if (unresolved.length) {
    // Release integrity guard: never seal a tarball that npm cannot install.
    throw new Error(
      `refusing to seal unresolved workspace deps: ${unresolved.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }
  // pnpm rebuilds the dependency maps from the lockfile's resolution order,
  // which is NOT stable across runs (observed: same commit, same versions,
  // different key order → different hash). Canonicalize the sections whose
  // order we do not define; top-level key order is preserved.
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const map = manifestJson[section];
    if (map && typeof map === "object") {
      manifestJson[section] = Object.fromEntries(
        Object.keys(map).sort().map((k) => [k, map[k]]),
      );
    }
  }
  const canonicalManifest = JSON.stringify(manifestJson, null, 2) + String.fromCharCode(10);
  manifest.data = Buffer.from(canonicalManifest, "utf8");

  const files = entries
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks = [];
  for (const { path, data } of files) {
    chunks.push(header(path, data.length), data, pad(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tgz = gzipSync(Buffer.concat(chunks), { level: 9 });
  tgz[9] = 0xff; // gzip OS byte: pin to "unknown" (zlib's OS_CODE is host-specific)

  const out = outFlag >= 0 ? resolve(args[outFlag + 1]) : join(root, produced[0]);
  writeFileSync(out, tgz);
  const sha = createHash("sha256").update(tgz).digest("hex");
  if (asJson) {
    console.log(JSON.stringify({ path: out, bytes: tgz.length, sha256: sha, files: files.length }));
  } else {
    console.log(`${out}\n${tgz.length} bytes\nsha256: ${sha}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
