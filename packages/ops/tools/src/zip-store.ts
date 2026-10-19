/** 确定性 store-only zip —— 归档包的字节层实现（M13-1，verify archive）。
 *
 * 为什么不用 zlib/系统 zip：归档身份要求「同一输入 → 同一字节」。系统 zip 会写入
 * mtime、权限、OS 元数据、压缩器版本差异；这里把可变面全部钉死：
 * - 条目按路径字节序排序，无目录条目；
 * - mtime 固定 1980-01-01T00:00:00Z（DOS date 0x0021 / time 0）；
 * - 方法 0（store，不压缩），外部属性固定 0644，无 extra/comment 字段。
 * 于是 `zip_sha256` 跨平台可复算，归档包的哈希才有意义。
 */

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_DATE_1980 = 0x0021;
const DOS_TIME = 0;
const EXT_ATTR = 0o100644 << 16;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 归档路径必须已是安全的 ASCII POSIX 相对路径（由 archive.ts 消毒，这里只拒明显非法）。 */
function assertEntryPath(path: string): void {
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) throw new Error(`zip entry path is not portable ASCII: ${path}`);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`zip entry path is not a clean relative path: ${path}`);
  }
}

export function writeZipStore(entries: ZipEntry[]): Buffer {
  const seen = new Set<string>();
  for (const e of entries) {
    assertEntryPath(e.path);
    if (seen.has(e.path)) throw new Error(`duplicate zip entry: ${e.path}`);
    seen.add(e.path);
  }
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.path, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE_1980, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by (MS-DOS)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE_1980, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXT_ATTR >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(Buffer.concat([local, name, e.data]));
    centrals.push(Buffer.concat([central, name]));
    offset += local.length + name.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 读回条目并逐条校验 CRC 与长度；任何不完全形态直接抛错（fail-closed）。 */
export function readZipStore(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: end-of-central-directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error("corrupt zip archive: central directory out of bounds");
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("corrupt zip archive: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) throw new Error(`unsupported zip compression (method ${method}) for ${name}`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`corrupt zip archive: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    if (data.length !== usize || csize !== usize) throw new Error(`corrupt zip archive: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`corrupt zip archive: crc mismatch for ${name}`);
    out.push({ path: name, data: Buffer.from(data) });
  }
  return out;
}
