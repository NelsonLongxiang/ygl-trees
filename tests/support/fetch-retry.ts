/**
 * 测试侧的连接级重试（vitest setupFiles）。
 *
 * 为什么需要：门禁要在干净检出上可复现。实测在干净 worktree（磁盘冷缓存 + 杀毒扫描 +
 * 全套 72 文件并行）里，同一份绿 commit 会偶发 `TypeError: fetch failed / read ECONNRESET`
 * ——服务端还没读到请求就被复位，隔离跑同一文件必绿。这是传输抖动，不是判据失败。
 *
 * 只重试「一个字节都没收到」的形态：
 *   - 收到任何 HTTP 状态码（4xx/5xx 也算）→ 原样返回，那是被测系统的回答；
 *   - 请求体必须是可重放的（string / Buffer / TypedArray / URLSearchParams / Blob）；
 *     流式 body 没有重放语义，直接抛。
 * 次数上限 3，退避 300/600ms。真实缺陷会稳定复现（三次都失败），不会被这条遮住。
 */
import { Buffer } from "node:buffer";

const REAL_FETCH = globalThis.fetch;
const MAX_ATTEMPTS = 3;
/** 只认「连接没建起来/被对端复位」这一类码。裸 `fetch failed` 太宽：DNS/TLS 失败也
 *  会被重试，白白多等 900ms 才报（K3 评审席反馈）——那些不是抖动，重试无意义。 */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

type Replayable = string | Buffer | Uint8Array | URLSearchParams | Blob | ArrayBuffer | null;

function replayable(body: BodyInit | null | undefined): body is Replayable {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof Buffer ||
    body instanceof Uint8Array ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  );
}

async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  // GET/HEAD 天然可重放；带 body 的方法要求 body 可重放（Request 对象无法安全二次读取 body）
  const safeBody = input instanceof Request ? method === "GET" || method === "HEAD" : replayable(init?.body);

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await REAL_FETCH(input, init);
    } catch (err) {
      lastErr = err;
      const code = String((err as any)?.cause?.code ?? (err as any)?.code ?? "");
      if (!RETRYABLE_CODES.has(code) || !safeBody) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

globalThis.fetch = retryingFetch as typeof globalThis.fetch;
