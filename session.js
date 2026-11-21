'use strict';
// A single bot session: joins a room by code and plays it with the CPU brain.
// Shared by the CLI (index.js) and the control service (server.js).
//
// Live controls (used by the WebSocket controller):
//   pause() / resume() / toggle() / setLevel(diff, overrides) / setChar(c) / setHz(n)

const { joinRoom, normalizeCode } = require('./net');
const { Bot, LEVELS, DEFAULT_LEVEL } = require('./ai');
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
    hz: Number(opts.hz) || 60,
  };
  const log = opts.log || (() => {});
  const subs = new Set();
  const lines = [];

  const state = {
    id, cfg, status: 'connecting', error: null,
    ourPick: cfg.char, ourChar: cfg.char, oppChar: null, hostPick: null,
    started: false, paused: false, snap: null, timer: null, ourHp: 100, oppHp: 100,
    round: 1, packets: 0, rtt: null, ended: false, at: Date.now(), lines,
    level: cfg.diff, char: cfg.char, hz: cfg.hz,
  };

  const say = (m) => {
    const l = `[${ts()}] ${m}`;
    lines.push(l); if (lines.length > 300) lines.shift();
    log(l);
    emit({ t: 'log', id, line: l });
  };
  function emit(ev) { for (const fn of subs) { try { fn(ev); } catch {} } }

  const bot = new Bot(cfg.diff, Math.random, {});
  bot.setChar(cfg.char);
  let room = null, sendTimer = null, loop = null, statusTimer = null, durationTimer = null;

  function finish(status) {
    if (state.ended) return;
    state.ended = true;
    state.status = status || 'ended';
    clearInterval(sendTimer); clearInterval(loop); clearInterval(statusTimer); clearTimeout(durationTimer);
    try { room && room.close(); } catch {}
    say(`session ${id} ended (${state.status})`);
    emit({ t: 'over', id, status: state.status });
  }

  function sendLobby() {
    if (!room) return;
    const msg = { t: 'lobby', pick: state.ourPick, ready: true };
    if (cfg.name) msg.name = cfg.name;
    room.send(msg);
    say(`lobby sent (pick=${state.ourPick}, ready=true)`);
  }

  // --- 60 Hz decision loop (restartable so the rate can change live) ---
  const recent = [];
  let seq = 0;
  const DT = 1 / 60;
  function tick() {
    if (!room || state.ended) return;
    // paused: feed neutral frames so the fighter idles and the host stays alive
    if (state.paused) {
      recent.push(0);
      if (recent.length > 8) recent.shift();
      room.sendInput(proto.encodeInputPacket(seq++, recent));
      return;
    }
    if (!state.started || !state.snap) return;
    const snap = state.snap;
    if (!snap.f || snap.f.length < 2) return;
    const rtt = room.latency();
    const predict = cfg.predict && rtt ? Math.min(12, Math.round((rtt / 2) / (1000 / 60))) : 0;
    const me = proto.fighterFromSnap(snap.f[1], state.ourChar, 0);
    const opp = proto.fighterFromSnap(snap.f[0], state.oppChar || 'modi', predict);
    state.ourHp = me.hp; state.oppHp = opp.hp;
    const input = bot.think(me, opp, DT);
    recent.push(proto.encodeInput(input));
    if (recent.length > 8) recent.shift();
    room.sendInput(proto.encodeInputPacket(seq++, recent));
    state.packets++;
  }

  function startLoop() {
    clearInterval(loop);
    loop = setInterval(tick, Math.max(5, Math.round(1000 / state.hz)));
  }

  (async () => {
    try {
      const norm = normalizeCode(cfg.code);
      if (!norm) throw new Error('Invalid room code (need 4 letters/digits)');
      cfg.code = norm;
      room = await joinRoom({ baseUrl: cfg.url, code: norm, log: say });
      state.status = 'connected';
      emit({ t: 'status', id, status: state.status });

      room.onCtrl = (m) => {
        switch (m.t) {
          case 'lobby':
            state.hostPick = m.pick;
            say(`host lobby (pick=${m.pick}, ready=${!!m.ready})`);
            // The host returns to the lobby after a match ends. Drop back into the
            // lobby phase and re-send our readies so a rematch can start.
            if (state.started) {
              state.started = false;
              state.round = 1;
              state.ourHp = 100; state.oppHp = 100;
              state.status = state.paused ? 'paused' : 'connected';
              emit({ t: 'status', id, status: state.status });
              say('match over — back in lobby, re-readying for rematch');
              sendLobby();
            }
            break;
          case 'start':
            state.ourChar = m.guest || state.ourPick;
            state.oppChar = m.host || state.hostPick;
            state.started = true;
            state.round = 1;
            state.ourHp = 100; state.oppHp = 100;
            state.status = state.paused ? 'paused' : 'fighting';
            emit({ t: 'status', id, status: state.status });
            say(`FIGHT! we=${state.ourChar} vs host=${state.oppChar} (stage ${m.stage})`);
            break;
          case 'ev':
            if (m.e === 'round') { state.round++; say(`round ${state.round}`); }
            else if (m.e === 'ko') say('KO!');
            else if (m.e === 'roundEnd') say(`round end: winner=${m.outcome} perfect=${m.perfect} timeUp=${m.timeUp} (score ${m.score ? m.score.join('-') : '?'})`);
            else if (m.e === 'phase') say(`phase -> ${m.p}`);
            else if (m.e === 'matchEnd') {
              say(`match over: winner=${m.winner} (score ${m.score ? m.score.join('-') : '?'})`);
              // Match finished — drop back to the lobby phase and re-ready so a
              // rematch can start the moment the host returns to the lobby.
              if (state.started) {
                state.started = false;
                state.round = 1;
                state.status = state.paused ? 'paused' : 'connected';
                emit({ t: 'status', id, status: state.status });
                say('re-readying for rematch');
                sendLobby();
              }
            }
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

      sendTimer = setInterval(() => { if (!state.started && !state.paused) sendLobby(); }, 1500);
      sendLobby();
      startLoop();

      statusTimer = setInterval(() => {
        state.rtt = room.latency();
        if (state.started && !state.paused) {
          say(`hp ${state.ourHp.toFixed(0)} vs ${state.oppHp.toFixed(0)} | timer ${state.timer ?? '-'} | rtt ${state.rtt ?? '-'}ms`);
        }
      }, 1000);

      if (cfg.duration > 0) durationTimer = setTimeout(() => finish('duration'), cfg.duration * 1000);
      emit({ t: 'status', id, status: state.status });
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

    pause() {
      if (state.ended || state.paused) return false;
      state.paused = true;
      if (state.started) state.status = 'paused';
      say('⏸ paused');
      emit({ t: 'status', id, status: state.status, paused: true });
      return true;
    },
    resume() {
      if (state.ended || !state.paused) return false;
      state.paused = false;
      if (state.started) state.status = 'fighting';
      say('▶ resumed');
      emit({ t: 'status', id, status: state.status, paused: false });
      return true;
    },
    toggle() { return state.paused ? this.resume() : this.pause(); },

    setLevel(diff, overrides) {
      const lvl = bot.setLevel(diff, overrides);
      state.level = lvl;
      say(`level -> ${lvl}${overrides ? ' ' + JSON.stringify(overrides) : ''}`);
      emit({ t: 'status', id, level: lvl });
      return lvl;
    },
    setChar(c) {
      state.ourPick = c;
      bot.setChar(c);
      state.char = c;
      if (!state.started) sendLobby();
      say(`char -> ${c}`);
      return c;
    },
    setHz(hz) {
      state.hz = Math.max(10, Math.min(120, Number(hz) || 60));
      startLoop();
      say(`input rate -> ${state.hz} Hz`);
      return state.hz;
    },
    setPredict(on) { cfg.predict = !!on; return cfg.predict; },

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    lines: () => lines.slice(),
    status: () => ({
      id, code: cfg.code, char: state.ourChar, opp: state.oppChar, status: state.status,
      error: state.error, round: state.round, ourHp: state.ourHp, oppHp: state.oppHp,
      timer: state.timer, rtt: state.rtt, started: state.started, ended: state.ended,
      paused: state.paused, level: state.level, hz: state.hz, packets: state.packets,
      ageSec: Math.round((Date.now() - state.at) / 1000),
    }),
  };
}

module.exports = { startSession, LEVELS, DEFAULT_LEVEL };
