'use strict';
// Rematch test: fake host + real bot session. Plays match 1, ends it, returns
// to the lobby, and checks the guest re-readies and match 2 can start.
//
//   node rematchtest.js
//
// Uses the live game signaling server (same as selftest.js).

const WebSocket = require('ws');
const { RTCPeerConnection } = require('werift');
const proto = require('./proto');
const { startSession } = require('./session');

const BASE = process.env.FK_URL || 'https://fightkaro.com';
const WSURL = BASE.replace(/^http/, 'ws') + '/api/room/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('«host»', ...m);

function openSignaling() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL);
    const to = setTimeout(() => reject(new Error('signaling timeout')), 10000);
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === 'room') { clearTimeout(to); resolve({ ws, ...m }); }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function startHost() {
  const sig = await openSignaling();
  log(`room created: ${sig.code}`);
  const pc = new RTCPeerConnection({ iceServers: (sig.ice && sig.ice.iceServers) || [] });
  pc.onconnectionstatechange = () => log('connection:', pc.connectionState);
  const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  const input = pc.createDataChannel('input', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

  await pc.setLocalDescription(await pc.createOffer());
  const t0 = Date.now();
  while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < 6000) await sleep(100);
  sig.ws.send(JSON.stringify({ t: 'offer', desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }));

  const answer = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('answer timeout')), 60000);
    sig.ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === 'answer') { clearTimeout(to); resolve(m.desc); }
      if (m.t === 'close') { clearTimeout(to); reject(new Error('signaling closed')); }
    });
  });
  await pc.setRemoteDescription(answer);
  sig.ws.send(JSON.stringify({ t: 'sid', sid: sig.secret }));

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('channels timeout')), 45000);
    const check = () => { if (ctrl.readyState === 'open' && input.readyState === 'open') { clearTimeout(to); resolve(); } };
    ctrl.onopen = check; input.onopen = check; check();
  });
  log('guest connected ✓');
  return { pc, ctrl, input, code: sig.code };
}

function snapshots(host, st) {
  const Z = (v) => Math.round(v * 1000) / 1000;
  const IDX = { idle: 0, walk: 1, attack: 4 };
  let t = 0, frame = 0;
  return setInterval(() => {
    t += 1 / 60; frame++;
    const opp = [Z(0.9), 0, 0, 0, -1, 100, 30, IDX.walk, 3, '', 0, 4, 0, 0, 0, 0, 0, 0, 0];
    const me = [Z(-0.9), 0, 0, 0, 1, 100, 40, IDX.idle, 2, '', 0, 4, 0, 0, 0, 0, 0, 0, 0];
    host.input.send(JSON.stringify({ t: 's', n: ++st.snapSeq, m: [1, 0, 0, Z(60 - t)], f: [opp, me], a: st.packets - 1 }));
    if (t > 30) t = 0;
  }, 1000 / 60);
}

(async () => {
  const host = await startHost();
  const st = { packets: 0, snapSeq: 0, matchNo: 0, snapTimer: null, lobbyAfterEnd: 0, starts: [] };

  host.ctrl.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'ping') { host.ctrl.send(JSON.stringify({ t: 'pong', id: m.id, sent: m.sent, at: performance.now() })); return; }
    if (m.t === 'lobby') {
      log(`guest lobby: pick=${m.pick} ready=${!!m.ready}`);
      if (st.matchNo === 0) beginMatch();
      else if (st.matchNo === 1 && st.ended) { st.lobbyAfterEnd++; if (st.lobbyAfterEnd === 1) beginMatch(); }
    }
  };
  host.input.onmessage = (ev) => {
    const data = ev.data;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (proto.decodeInputPacket(buf)) st.packets++;
  };

  function beginMatch() {
    st.matchNo++;
    st.starts.push(Date.now());
    log(`sending START (match ${st.matchNo})`);
    host.ctrl.send(JSON.stringify({ t: 'start', host: 'rahul', guest: 'modi', stage: 'sansad' }));
    if (!st.snapTimer) st.snapTimer = snapshots(host, st);
  }

  // bot session
  const sess = startSession({ baseUrl: BASE, code: host.code, char: 'modi', diff: 'ultimate', name: 'neta', hz: 60 });
  sess.subscribe((ev) => { if (ev.t === 'log') console.log('  [bot]', ev.line); else console.log('  [bot status]', ev.status, ev.level || ''); });

  await sleep(3000);
  if (st.matchNo !== 1) { console.log('❌ match 1 did not start'); process.exit(1); }
  const pktsM1 = st.packets;

  // end match 1 and go back to lobby
  await sleep(3000);
  log('--- ending match 1, sending matchEnd + lobby ---');
  host.ctrl.send(JSON.stringify({ t: 'ev', e: 'matchEnd', winner: 0, score: [2, 1] }));
  host.ctrl.send(JSON.stringify({ t: 'lobby', pick: 'rahul', ready: false }));

  await sleep(5000);
  const rematch = st.starts.length >= 2;
  console.log('\n--- RESULT ---');
  console.log('match 1 started :', st.matchNo >= 1);
  console.log('packets match 1 :', pktsM1);
  console.log('rematch started :', rematch, st.starts.length >= 2 ? `(total starts=${st.starts.length})` : '');
  console.log('packets total   :', st.packets);
  console.log(rematch ? '\n✅ REMATCH OK — bot re-readied and match 2 started' : '\n❌ REMATCH FAILED — no second start');

  clearInterval(st.snapTimer);
  try { sess.stop(); } catch {}
  try { host.pc.close(); } catch {}
  setTimeout(() => process.exit(rematch ? 0 : 1), 800);
})().catch((e) => { console.error('REMATCH TEST FAILED:', e.message); process.exit(1); });
