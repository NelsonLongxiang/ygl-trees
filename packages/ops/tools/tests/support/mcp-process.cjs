// Test-only IPC observer: the published server and CLI code are unchanged.
const cp = require('node:child_process');
const http = require('node:http');
if (!process.send) throw new Error('MCP fixture needs IPC');
const active = new Set(), servers = new Set();
let draining = false;
const spawn = cp.spawn;
cp.spawn = function (...args) {
  if (draining) throw new Error('MCP fixture is draining');
  const child = spawn.apply(this, args);
  const entry = { child, closed: new Promise(resolve => child.once('close', () => { active.delete(entry); resolve(); })) };
  active.add(entry);
  return child;
};
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'listening') { servers.add(this); this.once('close', () => servers.delete(this)); }
  if (event === 'request' && process.connected) process.send({ type: 'accepted', session: String(args[0].headers['x-ygl-session'] || '') });
  return emit.call(this, event, ...args);
};
process.on('message', async message => {
  if (message?.type !== 'quiesce' || draining) return;
  draining = true;
  const closed = [...servers].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const children = [...active];
  for (const { child } of children) child.kill();
  await Promise.all([...closed, ...children.map(entry => entry.closed)]);
  if (process.connected) process.send({ type: 'quiescent', children: active.size });
});
