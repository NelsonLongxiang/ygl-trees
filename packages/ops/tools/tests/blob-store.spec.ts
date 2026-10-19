import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BLOB_LIMIT,
  blobPath,
  clientMimeOf,
  createBlobSink,
  hasBlob,
  mimeFor,
  pruneIncoming,
  putBlob,
  putBlobFromFile,
  readBlob,
} from "../src/blob-store";

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ygl-blob-"));
}

describe("blob 仓：内容寻址与幂等", () => {
  it("同一内容两次写入落同一个键，第二次幂等不报错", () => {
    const r = root();
    const a = putBlob(r, Buffer.from("bills-2026-07"), "bills.xlsx");
    const b = putBlob(r, Buffer.from("bills-2026-07"), "copy-of-bills.xlsx");
    expect(a.sha256).toBe(b.sha256);
    expect(a.size).toBe(13);
    expect(hasBlob(r, a.sha256)).toBe(true);
    expect(readBlob(r, a.sha256).toString()).toBe("bills-2026-07");
    // 分片目录只有一份文件（去重，不占第二份磁盘）
    const shard = path.join(r, "blobs", a.sha256.slice(0, 2));
    expect(fs.readdirSync(shard).filter((f) => f === a.sha256)).toHaveLength(1);
  });

  it("mime 由服务端按扩展名定；客户端声明只记录且非法即弃", () => {
    const r = root();
    const ref = putBlob(r, Buffer.from("x"), "statement.xlsx", "application/whatever");
    expect(ref.mime).toContain("spreadsheetml");
    expect(ref.client_mime).toBe("application/whatever");
    expect(clientMimeOf("not a mime")).toBeUndefined();
    expect(clientMimeOf("a".repeat(300))).toBeUndefined();
    expect(mimeFor("photo.png")).toBe("image/png");
    expect(mimeFor("mystery.bin")).toBe("application/octet-stream");
  });

  it("超过上限的文件拒收（按服务端实际字节数，不信 Content-Length）", () => {
    const r = root();
    const big = path.join(r, "big.bin");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, BLOB_LIMIT + 1);
    fs.closeSync(fd);
    expect(() => putBlobFromFile(r, big)).toThrow(/too large/);
    expect(hasBlob(r, "0".repeat(64))).toBe(false);
  });

  it("流式 sink：写一半中断会清理临时文件，不产生半个 blob", () => {
    const r = root();
    const sink = createBlobSink(r);
    sink.write(Buffer.from("partial"));
    sink.abort();
    const incoming = path.join(r, "blobs", ".incoming");
    const left = fs.existsSync(incoming) ? fs.readdirSync(incoming) : [];
    expect(left).toHaveLength(0);
  });

  it("流式 sink 正常收尾：哈希与落盘一致", () => {
    const r = root();
    const sink = createBlobSink(r);
    sink.write(Buffer.from("hello "));
    sink.write(Buffer.from("world"));
    const ref = sink.finish("note.txt");
    expect(ref.size).toBe(11);
    expect(readBlob(r, ref.sha256).toString()).toBe("hello world");
  });

  it("孤儿 .part 按 mtime 清理（启动/上传前顺手扫）", () => {
    const r = root();
    const incoming = path.join(r, "blobs", ".incoming");
    fs.mkdirSync(incoming, { recursive: true });
    const stale = path.join(incoming, "stale.part");
    const fresh = path.join(incoming, "fresh.part");
    fs.writeFileSync(stale, "old");
    fs.writeFileSync(fresh, "new");
    const old = Date.now() - 7 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(old), new Date(old));
    expect(pruneIncoming(r)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("同内容并发收尾：dest 已被别人落位时 finish 仍幂等成功（不是 500）", () => {
    const r = root();
    const body = Buffer.from("duplicate-upload-body");
    const a = createBlobSink(r);
    a.write(body);
    const first = a.finish("a.csv");
    // 第二个 sink 同一内容：rename 会撞 dest，必须回同一 ref 而非抛错
    const b = createBlobSink(r);
    b.write(body);
    const second = b.finish("b.csv");
    expect(second.sha256).toBe(first.sha256);
    expect(readBlob(r, first.sha256).toString()).toBe("duplicate-upload-body");
    const incoming = path.join(r, "blobs", ".incoming");
    const left = fs.existsSync(incoming) ? fs.readdirSync(incoming).filter((f) => f.endsWith(".part")) : [];
    expect(left).toHaveLength(0);
  });

  it("非法 sha256 拼路径直接拒绝（防穿越）", () => {
    const r = root();
    expect(() => blobPath(r, "../../etc/passwd")).toThrow(/64 lowercase hex/);
    expect(() => blobPath(r, "A".repeat(64))).toThrow(/64 lowercase hex/);
  });
});
