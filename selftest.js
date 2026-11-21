'use strict';
// Self-test harness: stands up a fake HOST (werift) against the real game
// server, prints the room code, then runs the guest bot against it and checks
// the whole pipeline (join -> lobby -> start -> 60Hz inputs -> pings).
//
//   node selftest.js
//
// It also doubles as a reference implementation of the host side.

const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const { RTCPeerConnection } = require('werift');
const proto = require('./proto');

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

async function startHost({ ourChar, oppChar }) {
  const sig = await openSignaling();
  log(`room created: ${sig.code} (secret ${sig.secret.slice(0, 6)}…)`);
  const pc = new RTCPeerConnection({ iceServers: (sig.ice && sig.ice.iceServers) || [] });
  pc.onconnectionstatechange = () => log('connection:', pc.connectionState);
  const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  const input = pc.createDataChannel('input', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

  await pc.setLocalDescription(await pc.createOffer());
  const t0 = Date.now();
  while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < 6000) await sleep(100);
  sig.ws.send(JSON.stringify({ t: 'offer', desc: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }));
  log('offer sent; waiting for guest answer...');

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

// ---- protocol helpers on the host side ----
function attach(host, state) {
  host.ctrl.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    state.lastCtrl = Date.now();
    if (m.t === 'ping') { host.ctrl.send(JSON.stringify({ t: 'pong', id: m.id, sent: m.sent, at: performance.now() })); return; }
    if (m.t === 'lobby') {
      state.guestPick = m.pick;
      log(`guest lobby: pick=${m.pick} ready=${!!m.ready}`);
      if (!state.started) start();
    }
  };
  host.input.onmessage = (ev) => {
    const data = ev.data;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const pkt = proto.decodeInputPacket(buf);
    if (!pkt) return;
    state.packets++;
    state.lastInputAt = Date.now();
    const last = pkt.frames[pkt.frames.length - 1];
    state.lastDecoded = proto.decodeInput(last);
    state.lastBits = last;
    if (state.lastBits) state.nonZero += (last !== 0 ? 1 : 0);
  };
}

let hostRef = null;
function start() {
  if (!hostRef || hostRef.state.started) return;
  hostRef.state.started = true;
  log('sending START');
  hostRef.host.ctrl.send(JSON.stringify({ t: 'start', host: hostRef.oppChar, guest: hostRef.ourChar, stage: 'sansad' }));
  beginSnapshots();
}

function beginSnapshots() {
  const st = hostRef.state;
  const Z = (v) => Math.round(v * 1000) / 1000;
  // [x,y,vx,vy,facing,hp,meter,stateIdx,stateFrames,attackId,attackFrame,flags,moveRel,comboHits,walkDist,downFrames,stun,bufBtn,bufFrames]
  const IDX = { idle: 0, walk: 1, crouch: 2, jump: 3, attack: 4, hitstun: 5, blockstun: 6, knockdown: 7, getup: 8, ko: 9 };
  let meX = -1.3, oppX = 1.3, t = 0, frame = 0, attackFrame = 0, attackId = '';
  st.snapTimer = setInterval(() => {
    t += 1 / 60; frame++;
    // opponent (host, f[0]) walks toward guest and pokes
    oppX += (-0.9 - oppX) * 0.02;
    let oppState = IDX.walk, oAttFrame = 0, oAttId = '';
    if (frame % 90 > 60) { oAttId = 'jab'; attackFrame++; oppState = IDX.attack; oAttFrame = (frame % 90) - 60; }
    else oAttId = ''; 

    // our fighter (f[1]) drifts with the last received input (rough)
    const mv = st.lastDecoded ? st.lastDecoded.moveX : 0;
    meX += mv * 0.02;
    const meState = mv !== 0 ? IDX.walk : IDX.idle;

    const opp = [Z(oppX), 0, 0, 0, -1, Z(st.oppHp), 30, oppState, 3, oAttId, oAttFrame, 4, 0, 0, 0, 0, 0, 0, 0];
    const me = [Z(meX), 0, 0, 0, 1, Z(st.meHp), 40, meState, 2, '', 0, 4, 0, 0, 0, 0, 0, 0, 0];
    const snap = { t: 's', n: ++st.snapSeq, m: [1, st.wins0, st.wins1, Z(60 - t)], f: [opp, me], a: st.packets - 1 };
    hostRef.host.input.send(JSON.stringify(snap));
    if (t > 30) st.meHp = 100, t = 0;
  }, 1000 / 60);
}

(async () => {
  const ourChar = process.argv[2] || 'modi';
  const oppChar = process.argv[3] || 'rahul';
  const host = await startHost({ ourChar, oppChar });
  const state = {
    started: false, packets: 0, nonZero: 0, snapSeq: 0, lastDecoded: null, lastBits: 0,
    guestPick: null, meHp: 100, oppHp: 100, wins0: 0, wins1: 0, lastInputAt: 0, lastCtrl: 0,
  };
  hostRef = { host, state, ourChar, oppChar };
  attach(host, state);

  if (process.env.FK_HOST_ONLY) {
    log(`HOST_ONLY: room code = ${host.code}`);
    log(`run:  node index.js --code ${host.code} --char ${ourChar}`);
    const stat = setInterval(() => {
      if (!state.started) return;
      log(`recv ${state.packets} pkts | last bits=${state.lastBits} => ${JSON.stringify(state.lastDecoded)}`);
    }, 1000);
    setTimeout(() => { clearInterval(stat); log(`host-only window closed; total pkts=${state.packets}, nonZero=${state.nonZero}`); process.exit(0); }, 120000);
    return;
  }

  // run the bot as a child process, pointed at this room
  log('spawning guest bot...');
  const bot = spawn(process.execPath, [path.join(__dirname, 'index.js'), '--code', host.code, '--char', ourChar, '--diff', 'hard', '--duration', '18'], { stdio: 'inherit' });

  setTimeout(() => {
    log(`--- RESULT ---`);
    log(`started: ${state.started}  input packets received: ${state.packets}  non-zero: ${state.nonZero}`);
    const rate = (state.packets / 18).toFixed(1);
    log(`packet rate ≈ ${rate}/s (expect ~60)`);
    log(`last decoded input: ${JSON.stringify(state.lastDecoded)}`);
    clearInterval(state.snapTimer);
    try { host.pc.close(); } catch {}
    bot.kill('SIGINT');
    setTimeout(() => process.exit(0), 800);
  }, 19000);
})().catch((e) => { console.error('SELFTEST FAILED:', e.message); process.exit(1); });
