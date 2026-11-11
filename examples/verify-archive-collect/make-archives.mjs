#!/usr/bin/env node
// Builds the #232 case archives byte-exactly (a minimal ustar writer, no system tar), so the example and its tests
// run the same inputs on every machine. Usage: node examples/verify-archive-collect/make-archives.mjs <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

function header(name, size, type, badChecksum) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  if (badChecksum) h[148] = 0x37;
  return h;
}

/** members: [{ name, data?, type? ("0" file, "5" dir, "2" symlink), badChecksum? }] → tar bytes with end marker */
export function tar(members, end = true) {
  const parts = [];
  for (const m of members) {
    const data = Buffer.from(m.data ?? "", "utf8");
    const type = m.type ?? "0";
    const payload = type === "0" ? data : Buffer.alloc(0);
    parts.push(header(m.name, payload.length, type, m.badChecksum));
    if (payload.length) parts.push(payload, Buffer.alloc((512 - (payload.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const GOOD = [
  { name: "package/", type: "5" },
  { name: "package/package.json", data: '{"name":"demo"}' },
  { name: "package/index.js", data: "module.exports = 1;\n" },
];

/** The #232 cases: name → { bytes, expect } where expect names the clauses that must FAIL (others must not PASS
 *  when the collector records errors; see README). */
export function cases() {
  const gz = (members) => gzipSync(tar(members), { level: 9 });
  const big = gzipSync(tar([...GOOD, { name: "package/big.bin", data: "y".repeat(5000) }]), { level: 9 });
  return {
    good: gz(GOOD),
    "hash-differs": gz([GOOD[0], GOOD[1], { name: "package/index.js", data: "evil();\n" }]),
    "missing-path": gz([GOOD[0], GOOD[1]]),
    "extra-path": gz([...GOOD, { name: "package/.npmrc", data: "token" }]),
    duplicate: gz([...GOOD, { name: "package/index.js", data: "again" }]),
    "empty-file": Buffer.alloc(0),
    "empty-archive": gz([]),
    "dotdot-path": gz([...GOOD, { name: "package/../evil.js", data: "x" }]),
    "absolute-path": gz([...GOOD, { name: "/etc/passwd", data: "x" }]),
    "backslash-path": gz([...GOOD, { name: "package\\win.js", data: "x" }]),
    "control-char-path": gz([...GOOD, { name: "package/a\u0007b", data: "x" }]),
    "outside-package": gz([...GOOD, { name: "other/x.js", data: "x" }]),
    "empty-segment": gz([...GOOD, { name: "package//x.js", data: "x" }]),
    symlink: gz([...GOOD, { name: "package/link", type: "2" }]),
    "bad-checksum": gz([GOOD[0], { ...GOOD[1], badChecksum: true }, GOOD[2]]),
    truncated: big.subarray(0, big.length - 20),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node make-archives.mjs <out-dir>");
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(cases())) writeFileSync(join(dir, `${name}.tgz`), bytes);
  console.log(Object.keys(cases()).join("\n"));
}
