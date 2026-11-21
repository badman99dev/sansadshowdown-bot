'use strict';
// A single bot session: joins a room by code and plays it with the CPU brain.
// Shared by the CLI (index.js) and the HTTP service (server.js).

const { joinRoom, normalizeCode } = require('./net');
const { Bot } = require('./ai');
const proto = require('./proto');

let counter = 0;
const ts = () => new Date().toISOString().slice(11, 19);

function startSession(opts = {}) {
  const id = 's' + (++counter) + '-' + Math.random().toString(36).slice(2, 7);
  const cfg = {
    code: opts.code,
    char: opts.char || 'modi',
    diff: opts.diff || 'hard',
    name: opts.name || 'neta',
    url: (opts.url || 'https://fightkaro.com').replace(/\/$/, ''),
    duration: Number(opts.duration) || 0,
    predict: opts.predict !== false,
  };
  const log = opts.log || (() => {});
  const lines = [];
  const say = (m) => { const l = `[${ts()}] ${m}`; lines.push(l); if (lines.length > 200) lines.shift(); log(l); };

  const state = {
    id, cfg, status: 'connecting', error: null,
    ourPick: cfg.char, ourChar: cfg.char, oppChar: null, hostPick: null,
    started: false, snap: null, timer: null, ourHp: 100, oppHp: 100,
    round: 1, packets: 0, rtt: null, ended: false, at: Date.now(), lines,
  };
  const bot = new Bot(cfg.diff, Math.random, {});
  let room = null, sendTimer = null, loop = null, statusTimer = null;

  function finish(status) {
    if (state.ended) return;
    state.ended = true;
    state.status = status || 'ended';
    clearInterval(sendTimer); clearInterval(loop); clearInterval(statusTimer);
    try { room && room.close(); } catch {}
    say(`session ${id} ended (${state.status})`);
  }

  function sendLobby() {
    if (!room) return;
    const msg = { t: 'lobby', pick: state.ourPick, ready: true };
    if (cfg.name) msg.name = cfg.name;
    room.send(msg);
    say(`lobby sent (pick=${state.ourPick}, ready=true)`);
  }

  (async () => {
    try {
      const norm = normalizeCode(cfg.code);
      if (!norm) throw new Error('Invalid room code (need 4 letters/digits)');
      cfg.code = norm;
      room = await joinRoom({ baseUrl: cfg.url, code: norm, log: say });
      state.status = 'connected';

      room.onCtrl = (m) => {
        switch (m.t) {
          case 'lobby':
            state.hostPick = m.pick;
            say(`host lobby (pick=${m.pick}, ready=${!!m.ready})`);
            break;
          case 'start':
            state.ourChar = m.guest || state.ourPick;
            state.oppChar = m.host || state.hostPick;
            state.started = true;
            state.status = 'fighting';
            say(`FIGHT! we=${state.ourChar} vs host=${state.oppChar} (stage ${m.stage})`);
            break;
          case 'ev':
            if (m.e === 'round') { state.round++; say(`round ${state.round}`); }
            else if (m.e === 'ko') say('KO!');
            else if (m.e === 'roundEnd') say(`round end: winner=${m.outcome} timeUp=${m.timeUp}`);
            break;
          case 'away': say(`host ${m.on ? 'away' : 'back'}`); break;
          case 'bye': say('host left the room'); finish('host-left'); break;
        }
      };
      room.onInput = (data) => {
        if (typeof data !== 'string') return;
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m && m.t === 's') {
          state.snap = m;
          state.timer = m.m ? m.m[3] : null;
        }
      };
      room.onClose = (why) => { say('connection closed: ' + why); finish('closed'); };

      sendTimer = setInterval(() => { if (!state.started) sendLobby(); }, 1500);
      sendLobby();

      const recent = [];
      let seq = 0;
      const DT = 1 / 60;
      loop = setInterval(() => {
        if (!state.started || state.ended) return;
        const snap = state.snap;
        if (!snap || !snap.f || snap.f.length < 2) return;
        const rtt = room.latency();
        const predict = cfg.predict && rtt ? Math.min(12, Math.round((rtt / 2) / (1000 / 60))) : 0;
        const me = proto.fighterFromSnap(snap.f[1], state.ourChar, 0);
        const opp = proto.fighterFromSnap(snap.f[0], state.oppChar || 'modi', predict);
        state.ourHp = me.hp; state.oppHp = opp.hp;
        const input = bot.think(me, opp, DT);
        recent.push(proto.encodeInput(input));
        if (recent.length > 8) recent.shift();
        room.sendInput(proto.encodeInputPacket(seq++, recent));
      }, 1000 / 60);

      statusTimer = setInterval(() => {
        state.rtt = room.latency();
        if (state.started) say(`hp ${state.ourHp.toFixed(0)} vs ${state.oppHp.toFixed(0)} | timer ${state.timer ?? '-'} | rtt ${state.rtt ?? '-'}ms`);
      }, 1000);

      if (cfg.duration > 0) setTimeout(() => finish('duration'), cfg.duration * 1000);
    } catch (e) {
      state.error = e && e.message ? e.message : String(e);
      state.status = 'error';
      say('ERROR: ' + state.error);
      finish('error');
    }
  })();

  return {
    id,
    state,
    stop: () => finish('stopped'),
    status: () => ({
      id, code: cfg.code, char: state.ourChar, opp: state.oppChar, status: state.status,
      error: state.error, round: state.round, ourHp: state.ourHp, oppHp: state.oppHp,
      timer: state.timer, rtt: state.rtt, started: state.started, ended: state.ended,
      ageSec: Math.round((Date.now() - state.at) / 1000),
    }),
    lines: () => lines.slice(),
  };
}

module.exports = { startSession };
