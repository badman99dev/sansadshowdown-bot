'use strict';
// A HOST bot session: creates the room (shares an invite link) and runs the
// authoritative fight simulation. The bot brain drives fighter 0 (host); the
// joining friend's raw inputs drive fighter 1 (guest). Everything is published
// to the guest as 60 Hz snapshots, exactly like the real game's host.
//
// Live controls match the guest session: pause/resume/toggle/setLevel/setChar/stop.

const { createRoom } = require('./net');
const { Bot, LEVELS, DEFAULT_LEVEL } = require('./ai');
const proto = require('./proto');
const {
  Fighter, RemoteInput, CHARS, ROSTER, START_X, DT, STATE_NAMES, resolveHit, moveDuration,
} = require('./sim');

const STAGE = 'sansad';
const BUFFER_BUTTONS = ['punch', 'kick', 'grab'];
const ROUNDS_TO_WIN = 2;
const ROUND_TIME = 60;
const SITE = 'https://fightkaro.com';

let counter = 0;
const ts = () => new Date().toISOString().slice(11, 19);
const r3 = (v) => Math.round(v * 1000) / 1000;
const NEUTRAL = { moveX: 0, up: false, down: false, punch: false, kick: false, grab: false, super: false };

function startHostSession(opts = {}) {
  const id = 'h' + (++counter) + '-' + Math.random().toString(36).slice(2, 7);
  const cfg = {
    char: opts.char || 'modi',
    diff: opts.diff || 'hard',
    name: opts.name || 'neta',
    url: (opts.url || SITE).replace(/\/$/, ''),
    duration: Number(opts.duration) || 0,
    hz: Number(opts.hz) || 60,
  };
  const log = opts.log || (() => {});
  const subs = new Set();
  const lines = [];

  const state = {
    id, role: 'host', cfg, status: 'creating', error: null, code: null,
    share: null, ourPick: cfg.char, ourChar: cfg.char, oppChar: null, friendPick: null,
    started: false, paused: false, timer: null, ourHp: 100, oppHp: 100,
    round: 1, wins: [0, 0], packets: 0, rtt: null, ended: false, at: Date.now(),
    lines, level: cfg.diff, char: cfg.char, hz: cfg.hz,
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

  let room = null, sendTimer = null, loop = null, durationTimer = null, started = false;
  let remote = new RemoteInput();
  let F0 = null, F1 = null, snapSeq = 0, friendReady = false, round = 1, wins = [0, 0], timer = ROUND_TIME;

  function finish(status) {
    if (state.ended) return;
    state.ended = true;
    state.status = status || 'ended';
    clearInterval(sendTimer); clearInterval(loop); clearTimeout(durationTimer);
    try { room && room.close(); } catch {}
    say(`session ${id} ended (${state.status})`);
    emit({ t: 'over', id, status: state.status });
  }

  function sendLobby() {
    if (!room) return;
    room.send({ t: 'lobby', pick: state.ourPick, ready: true, stage: STAGE });
  }

  // ---- fight sim ----
  function newRound() {
    F0.reset(-START_X); F1.reset(START_X);
    timer = ROUND_TIME;
    started = false; // armed in startMatch
  }

  function startMatch() {
    const hostChar = CHARS[state.ourPick] || CHARS.modi;
    const guestChar = CHARS[state.friendPick] || CHARS.rahul;
    F0 = new Fighter(0, hostChar, -START_X);
    F1 = new Fighter(1, guestChar, START_X);
    remote = new RemoteInput();
    snapSeq = 0; round = 1; wins = [0, 0]; timer = ROUND_TIME;
    state.ourChar = state.ourPick; state.oppChar = state.friendPick;
    state.ourHp = 100; state.oppHp = 100; state.round = 1; state.wins = wins;
    started = true;
    state.started = true;
    state.status = state.paused ? 'paused' : 'fighting';
    room.send({ t: 'start', host: state.ourPick, guest: state.friendPick, stage: STAGE });
    room.send({ t: 'ev', e: 'phase', p: 'fight' });
    emit({ t: 'status', id, status: state.status });
    say(`FIGHT! we=${state.ourPick} (host) vs friend=${state.friendPick} (guest)`);
  }

  function snap(f) {
    const flags = (f.crouching ? 1 : 0) | (f.holdingBack ? 2 : 0) | (f.grounded ? 4 : 0) |
      (f.attack && f.attack.hasHit ? 8 : 0) | (f.airAttackUsed ? 16 : 0);
    const aid = f.attack ? (f.attack.id === 'super' ? 'finisher' : f.attack.id) : '';
    return [
      r3(f.x), r3(f.y), r3(f.vx), r3(f.vy), f.facing, Math.round(f.hp), r3(f.meter),
      STATE_NAMES.indexOf(f.state), f.stateFrames, aid, f.attack ? f.attack.frame : 0, flags,
      f.moveRel, f.comboHits, r3(f.walkDistance), f.downFrames, f.stun,
      f.buffer ? BUFFER_BUTTONS.indexOf(f.buffer.button) + 1 : 0, f.buffer ? f.buffer.frames : 0,
    ];
  }

  function sendSnapshot() {
    room.sendInput(JSON.stringify({
      t: 's', n: ++snapSeq,
      m: [round, wins[0], wins[1], r3(timer)],
      f: [snap(F0), snap(F1)],
      a: remote.ack,
    }));
    state.packets++;
  }

  function step() {
    if (!room || state.ended || !started) return;
    if (state.paused) {
      // bot idles; the guest keeps playing against a frozen opponent
      F0.update(NEUTRAL, F1.x);
      if (F0.wantsSuper && F0.meter >= 100) { F0.meter = 0; F0.startAttack('super'); }
    } else {
      const inHost = bot.think(F0, F1, DT);
      F0.update(inHost, F1.x);
      if (F0.wantsSuper && F0.meter >= 100) { F0.meter = 0; F0.startAttack('super'); }
    }
    const guestByte = remote.take();
    const inGuest = proto.decodeInput(guestByte);
    F1.update(inGuest, F0.x);
    if (F1.wantsSuper && F1.meter >= 100) { F1.meter = 0; F1.startAttack('super'); }

    const hA = resolveHit(F0, F1);
    const hB = resolveHit(F1, F0);
    state.ourHp = F0.hp; state.oppHp = F1.hp; state.timer = timer;

    timer = Math.max(0, timer - DT);

    if (F0.hp <= 0 || F1.hp <= 0 || timer <= 0) { endRound(hA, hB); return; }
    sendSnapshot();
  }

  function endRound(hA, hB) {
    const timeUp = timer <= 0 && F0.hp > 0 && F1.hp > 0;
    let outcome;
    if (F0.hp <= 0 && F1.hp <= 0) outcome = 'draw';
    else if (F1.hp <= 0) outcome = 0;
    else if (F0.hp <= 0) outcome = 1;
    else outcome = F0.hp > F1.hp ? 0 : F1.hp > F0.hp ? 1 : 'draw';

    const winner = outcome === 'draw' ? null : outcome;
    const perfect = winner !== null && (winner === 0 ? F0.hp >= F0.maxHp : F1.hp >= F1.maxHp);
    if (outcome === 'draw') { wins[0]++; wins[1]++; } else wins[outcome]++;
    state.wins = wins;

    room.send({ t: 'ev', e: 'ko' });
    room.send({ t: 'ev', e: 'roundEnd', outcome, perfect, timeUp, score: [wins[0], wins[1]] });
    say(`round ${round} end: winner=${outcome} timeUp=${timeUp} (score ${wins[0]}-${wins[1]})`);

    if (wins[0] >= ROUNDS_TO_WIN || wins[1] >= ROUNDS_TO_WIN) {
      const matchWinner = wins[0] > wins[1] ? 0 : 1;
      room.send({ t: 'ev', e: 'matchEnd', winner: matchWinner, score: [wins[0], wins[1]] });
      say(`MATCH over: winner=${matchWinner} (score ${wins[0]}-${wins[1]})`);
      backToLobby();
    } else {
      round++; state.round = round;
      room.send({ t: 'ev', e: 'round' });
      say(`round ${round}`);
      newRound();
      started = true;
    }
  }

  function backToLobby() {
    started = false;
    state.started = false;
    state.status = state.paused ? 'paused' : 'lobby';
    F0 = null; F1 = null;
    emit({ t: 'status', id, status: state.status });
    say('back in lobby — re-readying for a rematch');
    sendLobby();
  }

  function maybeStart() {
    if (started || state.ended) return;
    if (state.ourPick && state.friendPick && state.friendPick === state.ourPick) {
      // the game refuses to start when both pick the same fighter — switch ours
      const alt = ROSTER.find((c) => c !== state.friendPick) || 'rahul';
      state.ourPick = alt; bot.setChar(alt); sendLobby();
      say(`friend picked ${state.friendPick}; switched ours to ${alt}`);
      return;
    }
    if (friendReady && state.friendPick) { say('both ready — starting'); startMatch(); }
  }

  (async () => {
    try {
      const { room: r, code } = await createRoom({
        baseUrl: cfg.url, log: say,
        onRoom: (info) => {
          state.code = info.code;
          state.share = `${SITE}/?room=${info.code}`;
          state.status = 'waiting';
          emit({ t: 'created', id, code: info.code, share: state.share, status: state.status });
          emit({ t: 'status', id, status: state.status });
        },
        onOffer: () => {
          state.joinable = true;
          emit({ t: 'joinable', id, code: state.code, share: state.share });
        },
      });
      room = r;
      state.status = 'connected';
      say('guest joined the room; handshaking...');
      emit({ t: 'status', id, status: state.status });

      room.onCtrl = (m) => {
        switch (m.t) {
          case 'lobby':
            state.friendPick = m.pick || state.friendPick;
            friendReady = !!m.ready;
            say(`guest lobby (pick=${m.pick}, ready=${!!m.ready})`);
            maybeStart();
            break;
          case 'away': say(`guest ${m.on ? 'away' : 'back'}`); break;
          case 'bye': say('guest left the room'); finish('guest-left'); break;
        }
      };
      room.onInput = (data) => {
        if (typeof data === 'string') {
          // guest might still send a snapshot-formatted packet; ignore
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const pkt = proto.decodeInputPacket(buf);
        if (pkt) remote.push(pkt.seq, pkt.frames);
      };
      room.onClose = (why) => { say('connection closed: ' + why); finish('closed'); };

      sendTimer = setInterval(() => { if (!started && !state.paused) sendLobby(); }, 1500);
      sendLobby();

      loop = setInterval(() => {
        try { step(); } catch (e) { say('sim error: ' + e.message); }
        state.rtt = room.latency();
      }, 1000 / 60);

      if (cfg.duration > 0) durationTimer = setTimeout(() => finish('duration'), cfg.duration * 1000);
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
      if (started) state.status = 'paused';
      say('⏸ paused (bot idles)');
      emit({ t: 'status', id, status: state.status, paused: true });
      return true;
    },
    resume() {
      if (state.ended || !state.paused) return false;
      state.paused = false;
      if (started) state.status = 'fighting';
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
      state.ourPick = c; bot.setChar(c); state.char = c;
      if (!started) sendLobby();
      say(`char -> ${c}`);
      return c;
    },
    setHz(hz) {
      state.hz = Math.max(10, Math.min(120, Number(hz) || 60));
      if (loop) { clearInterval(loop); loop = setInterval(() => { try { step(); } catch (e) { say('sim error: ' + e.message); } state.rtt = room.latency(); }, 1000 / state.hz); }
      return state.hz;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    lines: () => lines.slice(),
    status: () => ({
      id, role: 'host', code: state.code, share: state.share, char: state.ourChar, opp: state.oppChar,
      status: state.status, error: state.error, round: state.round, ourHp: state.ourHp, oppHp: state.oppHp,
      timer: state.timer, rtt: state.rtt, started: state.started, ended: state.ended, paused: state.paused,
      wins: state.wins, level: state.level, hz: state.hz, packets: state.packets,
      ageSec: Math.round((Date.now() - state.at) / 1000),
    }),
  };
}

module.exports = { startHostSession, LEVELS, DEFAULT_LEVEL };
