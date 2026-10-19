/**
 * 内容寻址 blob 仓（M13-2 第二批）——验证器附件的唯一写入面。
 *
 * 为什么只有一个写入函数：CLI `verify submit --attach` 与 HTTP 上传必须落同一
 * 存储、走同一份 mime/size 策略、算同一套 sha256。两处各写一套，迟早出现「HTTP
 * 存的文件 CLI 找不到」或「容量上限一处 64MB 一处无限制」。
 *
 * 布局：`$YGL_HOME/verify/blobs/<前两位>/<sha256>`（两级分片，避免单目录爆量）。
 * 同内容同键——重复上传是幂等的，不占第二份磁盘。
 *
 * 上传路径：字节先落 `blobs/.incoming/<random>.part`，边收边算哈希，收完再
 * `rename` 进最终路径。半截文件永远出现在 `.incoming/` 下，清洁逻辑只清那里——
 * 不会有一条「写了一半的 blob」被当成完整附件。
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** 单个附件上限。同一份数字由 CLI 与 HTTP 共用，改这里就是改全部。 */
export const BLOB_LIMIT = 64 * 1024 * 1024;

export interface BlobRef {
  sha256: string;
  size: number;
  /** 服务端按扩展名定的类型（不看客户端声明）。 */
  mime: string;
  /** 客户端自述的 Content-Type/参数——只记录，不作任何判定依据（fdc757f6 骑士①）。 */
  client_mime?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".sqlite": "application/vnd.sqlite3",
  ".db": "application/vnd.sqlite3",
};

export function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** 客户端声明的 mime 只做记录；非法/过长一律丢弃，避免它变成事实源。 */
export function clientMimeOf(hint?: string): string | undefined {
  if (!hint) return undefined;
  const v = String(hint).trim();
  if (!v || v.length > 200 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+/.test(v)) return undefined;
  return v;
}

export function blobPath(verifyRoot: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`blob sha256 must be 64 lowercase hex chars: ${sha256}`);
  return join(verifyRoot, "blobs", sha256.slice(0, 2), sha256);
}

export function hasBlob(verifyRoot: string, sha256: string): boolean {
  return existsSync(blobPath(verifyRoot, sha256));
}

export function readBlob(verifyRoot: string, sha256: string): Buffer {
  return readFileSync(blobPath(verifyRoot, sha256));
}

/** 拿字节写入 blob 仓。同内容已存在则直接返回（幂等）。 */
export function putBlob(verifyRoot: string, bytes: Buffer | Uint8Array, name: string, mimeHint?: string): BlobRef {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length > BLOB_LIMIT) {
    throw new Error(`blob too large: ${buf.length} bytes > ${BLOB_LIMIT} byte limit (${name})`);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const dest = blobPath(verifyRoot, sha256);
  if (!existsSync(dest)) {
    mkdirSync(join(dest, ".."), { recursive: true });
    const tmp = join(verifyRoot, "blobs", ".incoming", `${sha256}-${randomBytes(4).toString("hex")}.part`);
    mkdirSync(join(verifyRoot, "blobs", ".incoming"), { recursive: true });
    writeFileSync(tmp, buf);
    try {
      renameSync(tmp, dest);
    } catch (e) {
      // 并发上传同内容：别人先落位也算成功。
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (!existsSync(dest)) throw e;
    }
  }
  return { sha256, size: buf.length, mime: mimeFor(name), client_mime: clientMimeOf(mimeHint) };
}

/** 从磁盘文件写入 blob 仓（CLI `--attach` 与测试夹具共用）。 */
export function putBlobFromFile(verifyRoot: string, filePath: string, mimeHint?: string): BlobRef {
  const st = statSync(filePath);
  if (st.size > BLOB_LIMIT) {
    throw new Error(`blob too large: ${st.size} bytes > ${BLOB_LIMIT} byte limit (${filePath})`);
  }
  return putBlob(verifyRoot, readFileSync(filePath), basename(filePath), mimeHint);
}

/**
 * 流式收取上传：边收边算哈希、边写临时文件（不在内存里攒整份），收完
 * `rename` 进仓。供 HTTP `PUT /api/verify/blob` 使用；超限时由调用方
 * `destroy()` 连接再调 `abort()`。
 */
export function createBlobSink(verifyRoot: string): {
  write(chunk: Buffer): boolean;
  finish(name: string, mimeHint?: string): BlobRef;
  abort(): void;
  overflowed(): boolean;
} {
  const incoming = join(verifyRoot, "blobs", ".incoming");
  mkdirSync(incoming, { recursive: true });
  const tmp = join(incoming, `${Date.now()}-${randomBytes(6).toString("hex")}.part`);
  const hash = createHash("sha256");
  let size = 0;
  let overflow = false;
  let fd: number | null = openSync(tmp, "w");
  return {
    write(chunk: Buffer): boolean {
      if (overflow) return false;
      size += chunk.length;
      if (size > BLOB_LIMIT) { overflow = true; return false; }
      hash.update(chunk);
      if (fd === null) throw new Error("blob sink already closed");
      writeSync(fd, chunk);
      return true;
    },
    finish(name: string, mimeHint?: string): BlobRef {
      if (overflow) throw new Error(`blob too large: > ${BLOB_LIMIT} byte limit (${name})`);
      if (fd === null) throw new Error("blob sink already closed");
      closeSync(fd);
      fd = null;
      const sha256 = hash.digest("hex");
      const dest = blobPath(verifyRoot, sha256);
      if (!existsSync(dest)) {
        mkdirSync(join(dest, ".."), { recursive: true });
        renameSync(tmp, dest);
      } else {
        rmSync(tmp, { force: true });
      }
      return { sha256, size, mime: mimeFor(name), client_mime: clientMimeOf(mimeHint) };
    },
    abort(): void {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } fd = null; }
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    },
    overflowed(): boolean {
      return overflow;
    },
  };
}

/**
 * 清理 `blobs/.incoming` 里的孤儿临时文件（fdc757f6 骑士②：客户端断连或超限被
 * destroy 后，.part 不能永久留在盘上——否则磁盘填充面只是从 blobs/ 搬到了 .incoming/）。
 * 服务启动时扫一遍、每次上传前顺手扫一遍即可，不需要常驻任务。
 */
export function pruneIncoming(verifyRoot: string, maxAgeMs = 6 * 60 * 60 * 1000): number {
  const dir = join(verifyRoot, "blobs", ".incoming");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); removed += 1; }
    } catch { /* 竞态：别人刚删 */ }
  }
  return removed;
}

/** 只读流（归档时按需读取，避免一次性载入大附件；当前归档仍读全量）。 */
export function openBlob(verifyRoot: string, sha256: string) {
  return createReadStream(blobPath(verifyRoot, sha256));
}
