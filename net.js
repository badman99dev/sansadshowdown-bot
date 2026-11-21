'use strict';
// Online-room client for Sansad Showdown, pure Node (no browser).
// Mirrors the guest side of the game's rooms module (class M / Room) on top of
// werift's RTCPeerConnection.

const { RTCPeerConnection } = require('werift');
const WebSocket = require('ws');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// werift's default gathering wait is 5s (STUN) + 8s (TURN) → setLocalDescription
// took ~13-25s against the game's servers before it resolved, delaying the whole
// handshake. Every candidate actually arrives in <1s, so cap the waits: enough
// time for the TURN allocations we need, none for the long tail.
const ICE_TUNING = { iceStunGatherTimeout: 1, iceTurnConnectTimeout: 3 };

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length !== 4) return null;
  for (const ch of t) if (!CODE_ALPHABET.includes(ch)) return null;
  return t;
}

function pct(s) {
  if (!s) return 'no candidates';
  const all = [...s.matchAll(/a=candidate:.* typ (\w+)/g)].map((m) => m[1]);
  const n = (k) => all.filter((x) => x === k).length;
  return `${all.length} candidates: host ${n('host')}, srflx ${n('srflx')}, relay ${n('relay')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

class Room {
  constructor(pc, ctrl, input, opts) {
    this.pc = pc;
    this.ctrl = ctrl;
    this.input = input;
    this.log = opts.log || (() => {});
    this.onCtrl = opts.onCtrl || (() => {});
    this.onInput = opts.onInput || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.closed = false;
    this.sid = null;
    this._pingSeq = 0;
    this._pings = new Map();

    ctrl.onopen = () => this.log('ctrl channel open');
    input.onopen = () => this.log('input channel open');
    ctrl.onmessage = (ev) => this._onCtrl(ev.data);
    input.onmessage = (ev) => {
      try { this.onInput(ev.data); } catch (e) { this.log('onInput error: ' + e.message); }
    };
    ctrl.onclose = () => this._end('ctrl closed');
    input.onclose = () => this._end('input closed');

    this._pingTimer = setInterval(() => this._ping(), 500);
  }

  _ping() {
    if (this.closed) return;
    const id = ++this._pingSeq;
    this._pings.set(id, performance.now());
    if (this._pings.size > 50) this._pings.delete(this._pings.keys().next().value);
    this.send({ t: 'ping', id });
  }

  latency() {
    if (!this._rtts || !this._rtts.length) return null;
    const s = [...this._rtts].sort((a, b) => a - b);
    return Math.round(s[Math.floor(s.length / 2)]);
  }

  _onCtrl(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m) return;
    if (m.t === 'ping') { this.send({ t: 'pong', id: m.id, sent: m.sent, at: performance.now() }); return; }
    if (m.t === 'pong') {
      const sent = this._pings.get(m.id);
      if (sent !== undefined) {
        this._pings.delete(m.id);
        this._rtts = this._rtts || [];
        this._rtts.push(performance.now() - sent);
        if (this._rtts.length > 40) this._rtts.shift();
      }
      return;
    }
    if (m.t === 'sid') { this.sid = m.sid; return; }
    this.onCtrl(m);
  }

  send(obj) {
    if (this.closed) return;
    if (this.ctrl.readyState !== 'open') return;
    try { this.ctrl.send(JSON.stringify(obj)); } catch (e) { this.log('send ctrl error: ' + e.message); }
  }

  sendInput(buf) {
    if (this.closed || this.input.readyState !== 'open') return;
    if (this.input.bufferedAmount >= 16384) return;
    try { this.input.send(buf); } catch (e) { this.log('send input error: ' + e.message); }
  }

  _end(why) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._pingTimer);
    this.log('room ended: ' + why);
    this.onClose(why);
  }

  close() { this._end('local close'); try { this.ctrl.close(); this.input.close(); this.pc.close(); } catch {} }
}

async function joinRoom({ baseUrl, code, iceUrl, log = () => {} }) {
  const norm = normalizeCode(code);
  if (!norm) throw new Error('Invalid room code (4 letters/digits)');

  log(`joining room ${norm} ...`);
  let data;
  try {
    data = await fetchJson(`${baseUrl}/api/room/join?code=${encodeURIComponent(norm)}`);
  } catch (e) {
    if (e.status === 404) throw new Error('Room not found or expired. Ask the host for a fresh code.');
    if (e.status === 409) throw new Error('Room is already full.');
    throw e;
  }
  const offer = data.offer;
  const ice = data.ice || (await fetchJson(`${baseUrl}/api/ice`).catch(() => null));
  const iceServers = (ice && ice.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }];
  log(`ICE: ${iceServers.length} server(s)${ice && ice.relay ? ' (with TURN relay)' : ' (STUN only)'}`);
  log(`host offer: ${pct(offer.sdp)}`);

  const pc = new RTCPeerConnection({ iceServers, ...ICE_TUNING });
  pc.onconnectionstatechange = () => log(`connection: ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => log(`ice: ${pc.iceConnectionState}`);

  const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  const input = pc.createDataChannel('input', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

  await pc.setRemoteDescription({ type: offer.type || 'offer', sdp: offer.sdp });
  const answer = await pc.createAnswer();

  // Same trick as the host side: send the answer as soon as candidates exist
  // instead of waiting for werift's gather "complete" (ICE_TUNING caps it).
  const cands = [];
  pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
  pc.setLocalDescription(answer).catch(() => {}); // deliberate: not awaited

  let lastCount = -1, quiet = 0;
  for (let i = 0; i < 60; i++) { // min 300ms, max 3s
    if (cands.length !== lastCount) { lastCount = cands.length; quiet = 0; } else quiet++;
    if (cands.length > 0 && quiet >= 6 && i >= 6) break;
    await sleep(50);
  }
  const local = { type: 'answer', sdp: answer.sdp.trimEnd() + '\r\n' + cands.map((c) => 'a=' + c).join('\r\n') + '\r\n' };
  log(`our answer: ${pct(local.sdp)}`);

  const room = new Room(pc, ctrl, input, { log });
  await fetchJson(`${baseUrl}/api/room/answer?code=${encodeURIComponent(norm)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: { type: local.type, sdp: local.sdp } }),
  });
  log('answer sent, waiting for peer...');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not connect (relay/TURN may be required)')), 45000);
    const check = () => {
      if (ctrl.readyState === 'open' && input.readyState === 'open') { clearTimeout(timer); resolve(); }
    };
    ctrl.onopen = () => { log('ctrl open'); check(); };
    input.onopen = () => { log('input open'); check(); };
    check();
  });
  log('connected to host ✓');
  return room;
}

// --- host side: create a room and wait for a guest --------------------------
// Mirrors the game's host role: open the signaling socket, receive {code,secret,
// ice}, publish a fresh offer, take the guest's answer, then open the channels.
async function createRoom({ baseUrl, log = () => {}, onRoom = () => {}, onOffer = () => {} }) {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/room/ws';
  log(`creating room via ${wsUrl} ...`);

  const sig = await new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('signaling timeout')), 15000);
    w.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === 'room') { clearTimeout(timer); resolve({ w, ...m }); }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
    w.on('close', () => { clearTimeout(timer); reject(new Error('signaling closed before room created')); });
  });

  const code = sig.code;
  log(`room created: ${code}`);
  onRoom({ code, secret: sig.secret });
  const iceServers = (sig.ice && sig.ice.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }];
  log(`ICE: ${iceServers.length} server(s)${sig.ice && sig.ice.relay ? ' (with TURN relay)' : ' (STUN only)'}`);

  const pc = new RTCPeerConnection({ iceServers, ...ICE_TUNING });
  pc.onconnectionstatechange = () => log(`connection: ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => log(`ice: ${pc.iceConnectionState}`);

  const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  const input = pc.createDataChannel('input', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

  // Publish the offer as soon as candidates exist rather than waiting for
  // werift's gather to report "complete" (ICE_TUNING caps that wait, but this
  // still gets a joinable room out in well under a second). Collect candidates
  // from onicecandidate and append them to the base SDP ourselves — the base
  // has one m-line and no candidate lines, so appending is safe.
  const cands = [];
  pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };

  const offer = await pc.createOffer();
  pc.setLocalDescription(offer).catch(() => {}); // deliberate: not awaited

  let lastCount = -1, quiet = 0;
  for (let i = 0; i < 60; i++) { // min 300ms, max 3s
    if (cands.length !== lastCount) { lastCount = cands.length; quiet = 0; } else quiet++;
    if (cands.length > 0 && quiet >= 6 && i >= 6) break;
    await sleep(50);
  }
  const sdp = offer.sdp.trimEnd() + '\r\n' + cands.map((c) => 'a=' + c).join('\r\n') + '\r\n';
  sig.w.send(JSON.stringify({ t: 'offer', desc: { type: 'offer', sdp } }));
  log(`offer published in ${cands.length} candidates (${pct(sdp)}); waiting for a guest...`);
  onOffer({ code });

  const answer = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no guest joined (offer timeout)')), 30 * 60 * 1000);
    sig.w.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === 'answer') { clearTimeout(timer); resolve(m.desc); }
      if (m.t === 'close') { clearTimeout(timer); reject(new Error('signaling closed before a guest joined')); }
    });
  });
  log('answer received from signaling');
  const tsr = Date.now();
  await pc.setRemoteDescription({ type: answer.type || 'answer', sdp: answer.sdp });
  sig.w.send(JSON.stringify({ t: 'sid', sid: sig.secret }));
  log(`guest answered; completing handshake (remote desc ${Date.now() - tsr}ms)`);

  const room = new Room(pc, ctrl, input, { log });
  room.signaling = sig.w;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not connect to guest (relay/TURN may be required)')), 45000);
    const check = () => { if (ctrl.readyState === 'open' && input.readyState === 'open') { clearTimeout(timer); resolve(); } };
    ctrl.onopen = () => { log('ctrl open'); check(); };
    input.onopen = () => { log('input open'); check(); };
    check();
  });
  log('guest connected ✓');
  return { room, code };
}

module.exports = { joinRoom, createRoom, normalizeCode, Room };
