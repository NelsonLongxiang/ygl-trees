import type { ChildProcess } from 'node:child_process';

const closures = new WeakMap<ChildProcess, Promise<void>>();
export function trackMcp<T extends ChildProcess>(child: T): T {
  closures.set(child, new Promise(resolve => child.once('close', () => resolve())));
  return child;
}

export function messageFrom(child: ChildProcess, type: string, session?: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); child.off('message', onMessage); child.off('close', onClose); child.off('error', onError); };
    const onMessage = (message: any) => { if (message?.type === type && (session === undefined || message.session === session)) { clear(); resolve(message); } };
    const onClose = () => { clear(); reject(new Error('MCP fixture exited before ' + type)); };
    const onError = (error: Error) => { clear(); reject(error); };
    const timer = setTimeout(() => { clear(); reject(new Error('MCP fixture did not send ' + type)); }, timeoutMs);
    child.on('message', onMessage); child.once('close', onClose); child.once('error', onError);
  });
}

export async function stopMcp(child: ChildProcess): Promise<void> {
  const closed = closures.get(child);
  if (!closed) throw new Error('MCP fixture close was not tracked at spawn');
  if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
  try {
    const quiescent = messageFrom(child, 'quiescent');
    child.send({ type: 'quiesce' });
    const result = await quiescent;
    if (result.children !== 0) throw new Error('MCP fixture still owns CLI children');
  } finally {
    child.kill();
    await closed;
  }
}
