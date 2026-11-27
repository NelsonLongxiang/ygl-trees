import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { offlineMcpEnv, runStdioCases, startStdio, type StdioCase } from './support/mcp-stdio';

const bundle = resolve(__dirname, '../../../../dist/bundle/bin.cjs');

async function withHome(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-stdio-'));
  try { await run(home); } finally { rmSync(home, { recursive: true, maxRetries: 10, retryDelay: 100 }); }
}

function boot(home: string, args: string[]) {
  const child = spawnSync(process.execPath, [bundle, ...args, '--json'], {
    cwd: home, env: offlineMcpEnv(home), encoding: 'utf8', timeout: 30_000,
  });
  expect(child.status, child.stderr).toBe(0);
}

function stubBundle(home: string) {
  const entry = join(home, 'bin.cjs');
  writeFileSync(entry, [
    'const { createInterface } = require("node:readline");',
    'const { spawn } = require("node:child_process");',
    'const respond = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));',
    'createInterface({ input: process.stdin }).on("line", line => {',
    '  const { id, method } = JSON.parse(line);',
    '  if (method === "initialize") respond(id, { protocolVersion: "2024-11-05" });',
    '  if (method === "ping") respond(id, {});',
    '  if (method === "start-fixture-child") {',
    '    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '    respond(id, {});',
    '  }',
    '  if (method === "exit-fixture") process.exit(7);',
    '});',
  ].join('\n'), { flag: 'wx' });
  return entry;
}

describe('offline MCP stdio test support', () => {
  it('runs JSON cases against the release bundle with an isolated environment and raw receipts', async () => {
    await withHome(async (home) => {
      vi.stubEnv('YGL_MCP_SOURCE_FETCH', '1');
      vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-test-sentinel');
      try {
        const env = offlineMcpEnv(home);
        expect(env).toMatchObject({ HOME: home, YGL_HOME: home, YGL_DB_URL: '', YGL_EVAL_OFFLINE: '1', TMPDIR: home });
        expect(env.YGL_MCP_SOURCE_FETCH).toBeUndefined();
        expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
        boot(home, ['db', 'init']);
        boot(home, ['project', 'new', 'stdio-example']);
        const client = await startStdio({ bundle, home });
        try {
          expect(client.initialized).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'ygl-trees' } });
          expect((await client.request('tools/list')).result).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: 'trees' })]) });
          expect((await client.request('tools/call', { name: 'missing-test-tool' })).error?.code).toBe(-32602);
          const cases: StdioCase[] = JSON.parse(JSON.stringify([
            { name: 'project', tool: 'read', arguments: { domain: 'project', action: 'show' }, expect: { rc: 0, fields: { 'project.name': 'stdio-example' } } },
            { name: 'add note', tool: 'write', arguments: { domain: 'kb', action: 'add', name: 'stdio-note', body: 'synthetic body' }, expect: { rc: 0, fields: { title: 'stdio-note' } } },
            { name: 'unknown action', tool: 'trees', arguments: { domain: 'kb', action: 'missing-action', params: {} }, expect: { rc: 2, isError: true } },
            { name: 'source fetch disabled', tool: 'trees', arguments: { domain: 'research', action: 'source-fetch', params: { url: 'https://example.invalid/' } }, expect: { rc: 2, isError: true } },
            { name: 'intentional mismatch', tool: 'read', arguments: { domain: 'project', action: 'show' }, expect: { rc: 2, fields: { 'project.name': 'unexpected' } } },
          ]));
          const results = await runStdioCases(client, cases);
          expect(results.map((r) => r.errors)).toEqual([[], [], [], [], ['Unexpected CLI rc', 'Unexpected payload field: project.name']]);
          expect(results[3].payload).toMatchObject({ error: expect.stringContaining('disabled by default') });
          for (const { receipt } of results) {
            expect(JSON.parse(receipt!.requestLine)).toMatchObject({ id: receipt!.id, method: 'tools/call' });
            expect(JSON.parse(receipt!.responseLine!)).toMatchObject({ id: receipt!.id, jsonrpc: '2.0' });
          }
        } finally { await client.close(); }
      } finally { vi.unstubAllEnvs(); }
    });
  });

  it('records an unanswered request by ID and keeps later replies usable', async () => {
    await withHome(async (home) => {
      const client = await startStdio({ bundle: stubBundle(home), home });
      try {
        const [result] = await runStdioCases(client, [{ name: 'unanswered', tool: 'test', arguments: {}, timeoutMs: 50 }]);
        expect(result.errors).toEqual(['tools/call #2 timed out after 50ms']);
        expect(result.receipt).toMatchObject({ id: 2, failure: 'tools/call #2 timed out after 50ms' });
        expect(result.receipt?.responseLine).toBeUndefined();
        expect(await client.request('ping')).toMatchObject({ id: 3, result: {} });
      } finally { await client.close(); }
    });
  });

  it('rejects pending requests on exit and drains CLI children on explicit shutdown', async () => {
    await withHome(async (home) => {
      const bundle = stubBundle(home);
      const exited = await startStdio({ bundle, home });
      try {
        await expect(exited.request('exit-fixture')).rejects.toThrow('exit-fixture #2: MCP fixture closed (code 7');
      } finally { await exited.close(); }
      const running = await startStdio({ bundle, home });
      try {
        await running.request('start-fixture-child');
        const waiting = expect(running.request('unanswered')).rejects.toThrow('MCP fixture is closing');
        const closed = running.close();
        expect(running.close()).toBe(closed);
        await Promise.all([waiting, closed]);
      } finally { await running.close(); }
    });
  });
});
