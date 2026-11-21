'use strict';
// WS control-channel test, driven by real status transitions.
// welcome -> join -> (fight starts) -> pause -> resume -> level easy -> level hard+overrides -> stop
const WebSocket = require('ws');
const url = process.env.WS || 'ws://127.0.0.1:8099/ws';
const code = process.argv[2] || 'ZZZZ';
const ws = new WebSocket(url);
let sid = null, startedAt = 0, scheduled = false;
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const step = (o) => ws.send(JSON.stringify(o));

function schedule() {
  if (scheduled) return; scheduled = true;
  setTimeout(() => sid && step({ t: 'pause', id: sid }), 2000);
  setTimeout(() => sid && step({ t: 'resume', id: sid }), 4500);
  setTimeout(() => sid && step({ t: 'level', id: sid, diff: 'easy' }), 6500);
  setTimeout(() => sid && step({ t: 'level', id: sid, diff: 'hard', overrides: { aggression: 0.5, reaction: 0.3 } }), 7500);
  setTimeout(() => sid && step({ t: 'stop', id: sid }), 9500);
  setTimeout(() => { log('done'); process.exit(0); }, 11000);
}

ws.on('open', () => log('ws open'));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'welcome') { log('welcome, levels=', m.levels.join('/')); step({ t: 'join', code, char: 'modi', diff: 'ultimate', hz: 60 }); return; }
  if (m.t === 'joined') { sid = m.id; log('JOINED', sid, m.status); return; }
  if (m.t === 'sessions') {
    if (!sid) return;
    const s = m.sessions.find((x) => x.id === sid);
    if (s) { log(`status=${s.status} paused=${s.paused} lvl=${s.level} pkt=${s.packets}`); if (s.status === 'fighting') { if (!startedAt) startedAt = Date.now(); schedule(); } }
    return;
  }
  if (m.t === 'log') { if (process.env.V) log('  log:', m.line); return; }
  if (m.t === 'ok') { log('OK <-', m.action); return; }
  if (m.t === 'error') { log('ERR <-', m.message); return; }
});
ws.on('close', () => log('ws closed'));
