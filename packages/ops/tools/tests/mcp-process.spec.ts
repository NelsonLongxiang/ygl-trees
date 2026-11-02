import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stopMcp, messageFrom, trackMcp } from './support/mcp-process';

const ROOT = resolve(__dirname, '../../../..');
describe('#170 MCP fixture quiescence', () => {
  it('waits for owned CLI close before killing the parent', async () => {
    const calls: string[] = [];
    const child: any = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, connected: true });
    child.send = (message: any) => { calls.push(message.type); queueMicrotask(() => { calls.push('cli.close'); child.emit('message', { type: 'quiescent', children: 0 }); }); };
    child.kill = () => { calls.push('parent.kill'); queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); return true; };
    trackMcp(child);
    await stopMcp(child);
    calls.push('remove');
    expect(calls).toEqual(['quiesce', 'cli.close', 'parent.kill', 'remove']);
  });

  it('waits for stdio close even after the parent exit event', async () => {
    const child: any = new EventEmitter();
    Object.assign(child, { exitCode: 0, signalCode: null });
    trackMcp(child);
    let removed = false;
    const stopped = stopMcp(child).then(() => { removed = true; });
    await Promise.resolve();
    expect(removed).toBe(false);
    child.emit('close', 0);
    await stopped;
    expect(removed).toBe(true);
  });

  it('closes a real owned CLI handle before removing its scratch directory', async () => {
    mkdirSync(join(ROOT, 'tmp'), { recursive: true });
    const home = mkdtempSync(join(ROOT, 'tmp/mcp-quiesce-'));
    const marker = join(home, 'cli-closed');
    const program = String.raw`
      const cp = require('node:child_process'), fs = require('node:fs');
      const child = cp.spawn(process.execPath, ['-e', "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');process.on('disconnect',()=>{fs.closeSync(fd);process.exit(0)});process.send({type:'ready'});", process.argv[1]], {stdio:['ignore','ignore','ignore','ipc']});
      child.on('message', () => process.send({type:'ready'}));
      child.on('close', () => fs.writeFileSync(process.argv[2], 'closed'));
    `;
    const child = trackMcp(spawn(process.execPath, ['--require', join(__dirname, 'support/mcp-process.cjs'), '-e', program, join(home, 'held'), marker], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    child.stdout!.resume(); child.stderr!.resume();
    try {
      await messageFrom(child, 'ready');
      await stopMcp(child);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await stopMcp(child);
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
