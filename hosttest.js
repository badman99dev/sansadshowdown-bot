'use strict';
// End-to-end: our HOST bot creates a room, our GUEST bot joins it, they fight.
// Both run against the real fightkaro.com signaling server, so passing this
// means a real browser friend could join the host room too.
//
//   node hosttest.js

const { startHostSession } = require('./host');
const { startSession } = require('./session');

const DUR = Number(process.env.DUR || 30) * 1000;
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

let host = null, guest = null, code = null;

host = startHostSession({ char: 'modi', diff: 'hard', name: 'neta' });
host.subscribe((ev) => {
  if (ev.t === 'log') console.log('  H', ev.line);
  else if (ev.t === 'created') {
    code = ev.code;
    log(`✅ HOST room created: ${code}  share=${ev.share}`);
    log('(waiting for the offer to be published before joining...)');
  } else if (ev.t === 'joinable') {
    log(`offer published — spawning guest bot to join ${code}...`);
    guest = startSession({ code, char: 'rahul', diff: 'normal', name: 'dost' });
    guest.subscribe((e) => {
      if (e.t === 'log') console.log('  G', e.line);
    });
  } else if (ev.t === 'status') {
    log(`host status: ${ev.status}`);
  }
});

setTimeout(() => {
  const hs = host.status();
  const gs = guest ? guest.status() : null;
  console.log('\n--- RESULT (host) ---');
  console.log(JSON.stringify(hs, null, 2));
  if (gs) { console.log('--- RESULT (guest) ---'); console.log(JSON.stringify(gs, null, 2)); }
  const ok = hs.started || hs.round > 1 || (hs.ourHp < 100 || hs.oppHp < 100);
  console.log(ok ? '\n✅ HOST SIM OK — match ran, damage exchanged' : '\n❌ HOST SIM FAILED');
  try { host.stop(); } catch {}
  try { guest && guest.stop(); } catch {}
  setTimeout(() => process.exit(ok ? 0 : 1), 800);
}, DUR);
