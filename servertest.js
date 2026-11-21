'use strict';
// Full-server integration test: boots server.js, drives it through the /ws
// control socket exactly like the dashboard does.
//
//   1. client A sends {t:'create'}  -> expects a 'created' event with {code, share}
//   2. client B sends {t:'join'}    -> guest bot joins that code
//   3. after DUR seconds, both sessions are inspected via {t:'list'}
//
//   node servertest.js

process.env.PORT = process.env.PORT || '8791';
process.env.MAX_SESSIONS = process.env.MAX_SESSIONS || '3';

const { server } = require('./server');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT);
const DUR = Number(process.env.DUR || 45) * 1000;
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

function client(name, onOpen) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('open', () => { log(`${name} control socket open`); if (onOpen) onOpen(); });
  ws.on('close', () => log(`${name} control socket closed`));
  ws.on('error', (e) => log(`${name} control socket error: ${e.message}`));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    log(`${name} <- ${m.t}`);
    if (m.t === 'log') { console.log(`  ${name}| ${m.line}`); return; }
    if (m.t === 'sessions') { last.sessions = m.sessions; return; }
    if (m.t === 'welcome' || m.t === 'hello') { last.sessions = m.sessions; return; }
    handlers.forEach((h) => h(m, name));
  });
  return { ws, name };
}
const handlers = [];
const onMsg = (fn) => handlers.push(fn);
const last = { sessions: [] };
const send = (c, o) => c.ws.send(JSON.stringify(o));

server.on('listening', () => {
  log(`server up on :${PORT} (max ${process.env.MAX_SESSIONS})`);
  const A = client('A', () => send(A, { t: 'create', char: 'modi', diff: 'hard' }));
  const B = client('B');

  onMsg((m, name) => {
    if (m.t === 'created' && name === 'A') {
      log(`✅ A created room: ${m.code}  share=${m.share}`);
      log('waiting for offer to be published (joinable) before B joins...');
    }
    if (m.t === 'joinable' && name === 'A') {
      log('offer published — B joining as guest bot...');
      send(B, { t: 'join', code: m.code, char: 'rahul', diff: 'normal' });
    }
    if (m.t === 'error') log(`⚠ ${name} error: ${m.message}`);
  });

  setTimeout(() => {
    const rows = last.sessions || [];
    const host = rows.find((r) => r.role === 'host');
    const guest = rows.find((r) => r.role !== 'host' && !r.ended);
    log('\n--- sessions ---');
    for (const r of rows) log(`${r.id} [${r.role || 'guest'}] code=${r.code} status=${r.status} hp ${r.ourHp} vs ${r.oppHp} started=${r.started} ended=${r.ended}`);

    const hostOk = host && (host.started || host.round > 1 || host.oppHp < 100);
    const guestOk = guest && (guest.started || guest.round > 1 || guest.ourHp < 100);
    if (hostOk && guestOk) log('\n✅ SERVER E2E OK — host created room, guest joined, match ran');
    else if (hostOk) log('\n⚠ host ran but guest session not visible');
    else log('\n❌ SERVER E2E FAILED');

    for (const id of rows.map((r) => r.id)) send(A, { t: 'stop', id });
    setTimeout(() => process.exit(hostOk ? 0 : 1), 800);
  }, DUR);
});
