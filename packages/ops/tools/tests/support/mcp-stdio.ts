import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { stopMcp, trackMcp } from './mcp-process';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = { [key: string]: Json };
type Reply = { jsonrpc: '2.0'; id: number; result?: Json; error?: { code: number; message: string } };
type Receipt = { id: number; method: string; requestLine: string; responseLine?: string; elapsedMs?: number; failure?: string };
type Pending = {
  receipt: Receipt;
  started: number;
  timer: NodeJS.Timeout;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
};

/** Use a fresh test-owned directory for both the workspace and the OS home. */
export function offlineMcpEnv(home: string): NodeJS.ProcessEnv {
  if (!isAbsolute(home)) throw new Error('MCP fixture home must be absolute');
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    YGL_HOME: home,
    YGL_DB_URL: '',
    YGL_EVAL_OFFLINE: '1',
    YGL_NO_UPDATE_CHECK: '1',
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Starts the release entry point under the shared IPC process observer. */
export async function startStdio({ bundle, home, timeoutMs = 30_000 }: {
  bundle: string;
  home: string;
  timeoutMs?: number;
}) {
  if (!isAbsolute(bundle)) throw new Error('MCP bundle entry must be absolute');
  const child = trackMcp(spawn(process.execPath, ['--require', join(__dirname, 'mcp-process.cjs'), bundle, 'mcp'], {
    cwd: home,
    env: offlineMcpEnv(home),
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }));
  const receipts: Receipt[] = [];
  const pending = new Map<number, Pending>();
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  let nextId = 0;
  let terminal: Error | undefined;
  let closing: Promise<void> | undefined;
  let stderrBytes = 0;
  child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });

  function settle(id: number, reply?: Reply, responseLine?: string, failure?: Error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.receipt.elapsedMs = performance.now() - entry.started;
    if (responseLine !== undefined) entry.receipt.responseLine = responseLine;
    if (failure) {
      entry.receipt.failure = failure.message;
      entry.reject(failure);
    } else {
      entry.resolve(reply!);
    }
  }

  function end(error: Error) {
    terminal ??= error;
    for (const [id, entry] of pending) {
      settle(id, undefined, undefined, new Error(entry.receipt.method + ' #' + id + ': ' + terminal.message));
    }
  }

  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      end(new Error('MCP stdout is not newline-delimited JSON'));
      return;
    }
    if (!object(message) || message.jsonrpc !== '2.0') {
      end(new Error('MCP stdout contains an invalid JSON-RPC envelope'));
      return;
    }
    if (typeof message.id !== 'number' || !pending.has(message.id)) return;
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && (!object(message.error) ||
        typeof message.error.code !== 'number' || typeof message.error.message !== 'string'))) {
      const method = pending.get(message.id)!.receipt.method;
      settle(message.id, undefined, line, new Error(method + ' #' + message.id + ': invalid JSON-RPC response'));
      return;
    }
    settle(message.id, message as Reply, line);
  });
  child.on('error', end);
  child.stdin!.on('error', end);
  child.once('close', (code, signal) => {
    end(new Error('MCP fixture closed (code ' + code + ', signal ' + signal + ', stderr ' + stderrBytes + ' bytes)'));
    lines.close();
  });

  function request(method: string, params?: Json, limitMs = timeoutMs): Promise<Reply> {
    if (terminal) return Promise.reject(terminal);
    if (!Number.isFinite(limitMs) || limitMs <= 0) return Promise.reject(new Error('MCP request timeout must be positive'));
    const id = ++nextId;
    const requestLine = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const receipt = { id, method, requestLine };
    receipts.push(receipt);
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        settle(id, undefined, undefined, new Error(method + ' #' + id + ' timed out after ' + limitMs + 'ms'));
      }, limitMs);
      pending.set(id, { receipt, started, timer, resolve, reject });
      child.stdin!.write(requestLine + '\n', (error) => {
        if (error) settle(id, undefined, undefined, error);
      });
    });
  }

  function close(): Promise<void> {
    end(new Error('MCP fixture is closing'));
    return closing ??= stopMcp(child);
  }

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ygl-stdio-test', version: '1' },
    });
    if (!object(init.result) || typeof init.result.protocolVersion !== 'string') {
      throw new Error('MCP initialize did not return a protocol version');
    }
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { request, close, initialized: init.result, receipts: receipts as readonly Receipt[] };
  } catch (error) {
    try { await close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'MCP initialization and shutdown both failed');
    }
    throw error;
  }
}

export type StdioCase = {
  name: string;
  tool: string;
  arguments: Fields;
  timeoutMs?: number;
  expect?: { isError?: boolean; rc?: number; fields?: Fields };
};

function field(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** JSON cases use dot-separated payload fields, including array indices. A timeout is reported per case. */
export async function runStdioCases(client: Awaited<ReturnType<typeof startStdio>>, cases: readonly StdioCase[]) {
  const results: { name: string; receipt?: Receipt; payload?: Json; errors: string[] }[] = [];
  for (const test of cases) {
    const errors: string[] = [];
    let payload: Json | undefined;
    let receipt: Receipt | undefined;
    try {
      const receiptIndex = client.receipts.length;
      const pending = client.request('tools/call', { name: test.tool, arguments: test.arguments }, test.timeoutMs);
      receipt = client.receipts[receiptIndex];
      const response = await pending;
      if (response.error) throw new Error('JSON-RPC error ' + response.error.code + ': ' + response.error.message);
      const text = field(response.result, 'content.0.text');
      if (typeof text !== 'string' || field(response.result, 'content.0.type') !== 'text') {
        throw new Error('Expected MCP text content');
      }
      payload = JSON.parse(text);
      const expected = test.expect ?? {};
      if ((field(response.result, 'isError') ?? false) !== (expected.isError ?? false)) errors.push('Unexpected MCP isError');
      if (expected.rc !== undefined) {
        // Successful calls have an implicit rc=0; errors must report their actual CLI rc.
        const rc = field(payload, 'rc') ?? (field(response.result, 'isError') ? undefined : 0);
        if (rc !== expected.rc) errors.push('Unexpected CLI rc');
      }
      for (const [path, expectedValue] of Object.entries(expected.fields ?? {})) {
        if (!isDeepStrictEqual(field(payload, path), expectedValue)) errors.push('Unexpected payload field: ' + path);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    results.push({ name: test.name, receipt, payload, errors });
  }
  return results;
}
