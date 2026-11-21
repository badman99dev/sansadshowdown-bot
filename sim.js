'use strict';
// Headless port of Sansad Showdown's fight simulation (see main.beauty.js:
// fighter.update/integrate/applyHit/applyBlock, box hit check e_/Kg/qg, match s_).
//
// The online HOST is authoritative: it simulates both fighters and publishes
// snapshots. To let the bot *create* a room it must therefore run this sim.
// All frame data comes from the game itself (moves.json).

const MOVES = require('./moves.json');

const DT = 1 / 60;
const GRAVITY = 24;          // this.vy -= 24 * Ye
const HALF_W = 6.5;          // j
const START_X = 1.3;         // rt / 2
const BLOCK_DMG_MUL = 0.15;  // tt
const COUNTER_MUL = 1.2;     // nt
const COMBO_SCALE = [1, 0.9, 0.78, 0.66, 0.54, 0.44];
const COMBO_FALLBACK = 0.35; // Zg
const KNOCKDOWN_FRAMES = 48;
const GETUP_FRAMES = 24;
const SUPER_BUFFER = 6;
const METER_MAX = 100;
const GRAB_RANGE = 1.05;
const KO_VX = 3.4;
const KO_VY = 6.5;

const STATE_NAMES = [
  'idle', 'walk', 'crouch', 'jump', 'attack', 'hitstun', 'blockstun',
  'knockdown', 'getup', 'ko', 'super', 'frozen', 'victory', 'intro',
];

// reach (end value) per move id, from the bundle's `Ou` clip table.
const REACH = {
  jab: 0.95, cross: 0.8, kick: 1.4, uppercut: 1.2, roundhouse: 1.9, finisher: 1.5,
  lowJab: 1.5, sweep: 1.6, special1: 1.5, special2: 1.5,
  airPunch: 1.1, airKick: 1.3, grab: GRAB_RANGE, landing: 0, super: 1.5,
};

// synthetic super move (the real one is a scripted cinematic; we approximate)
const SUPER = { id: 'super', startup: 12, active: 8, recovery: 34, damage: 30, height: 'mid', hitstun: 46, blockstun: 24, knockdown: true, launch: 6, push: 3.5, lunge: 1.2 };

// playable roster — identical stats (the game gives online fighters no per-char AI)
const ROSTER = ['modi', 'rahul', 'didi', 'trump', 'yogi', 'nitin', 'ravi', 'lalu', 'amit', 'dhruv', 'mbapu'];
const CHARS = {};
for (const id of ROSTER) CHARS[id] = { id, walkFwd: 2.2, walkBack: 1.7, jumpV: 7.6, jumpVx: 2.5, damageMul: 1, hp: 100 };
CHARS.didi.walkFwd = 2.4; CHARS.didi.walkBack = 1.85;
CHARS.trump.walkFwd = 2.1; CHARS.trump.walkBack = 1.65;
CHARS.mbapu.walkFwd = 2.35;

function moveDuration(def) { return def.startup + def.active + def.recovery; }

// Eu: button + crouch + forward -> move id
function selectMove(button, crouching, forward) {
  if (button === 'grab') return 'grab';
  if (crouching) return button === 'punch' ? 'lowJab' : 'sweep';
  if (forward) return button === 'punch' ? 'special1' : 'special2';
  return button === 'punch' ? 'jab' : 'kick';
}

// Iu: chain into the next move if the move chains and the button matches
function chainNext(def, button) {
  return def && def.chains ? def.chains[button] || null : null;
}

function moveDef(id) { return id === 'super' ? SUPER : MOVES[id]; }

class Fighter {
  constructor(side, char, x) {
    this.side = side;
    this.char = char;
    this.x = x;
    this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = side === 0 ? 1 : -1;
    this.maxHp = char.hp || 100;
    this.hp = this.maxHp;
    this.meter = 0;
    this.state = 'idle'; this.stateFrames = 0;
    this.attack = null;
    this.crouching = false; this.holdingBack = false;
    this.moveRel = 0; this.stun = 0; this.buffer = null; this.superBuffer = 0;
    this.comboHits = 0; this.lastHitHeight = 'mid'; this.walkDistance = 0;
    this.wantsSuper = false; this.airAttackUsed = false;
    this.downFrames = 0; this.grounded = true;
    this.isBoss = false; this.power = 1; this.attackSpeed = 1; this.attackCarry = 0;
    this.blocked = false;
  }

  reset(x) {
    this.x = x; this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = this.side === 0 ? 1 : -1;
    this.hp = this.maxHp; this.meter = 0;
    this.attack = null; this.crouching = false; this.holdingBack = false;
    this.moveRel = 0; this.stun = 0; this.buffer = null; this.superBuffer = 0;
    this.comboHits = 0; this.downFrames = 0; this.grounded = true;
    this.wantsSuper = false; this.airAttackUsed = false;
    this.enter('idle');
  }

  // --- getters mirroring the real Fighter class ---
  get attackPhase() {
    const a = this.attack;
    if (!a) return null;
    if (a.frame <= a.def.startup) return 'startup';
    if (a.frame <= a.def.startup + a.def.active) return 'active';
    return 'recovery';
  }
  get isAttackActive() {
    const a = this.attack;
    return a ? a.frame > a.def.startup && a.frame <= a.def.startup + a.def.active : false;
  }
  get canBlock() {
    return this.state === 'idle' || this.state === 'walk' || this.state === 'crouch' || this.state === 'blockstun';
  }
  get airborne() { return this.y > 0.001 || this.vy > 0; }
  get actionable() { return this.state === 'idle' || this.state === 'walk' || this.state === 'crouch'; }
  get invulnerable() { return this.state === 'knockdown' || this.state === 'getup' || this.state === 'ko'; }
  get isLow() { return this.state === 'crouch' || (this.state === 'blockstun' && this.crouching) || !!(this.attack && this.attack.def.crouching); }

  enter(s) { if (this.state !== s) { this.state = s; this.stateFrames = 0; } }
  forceState(s) { this.state = s; this.stateFrames = 0; }

  addMeter(v) { this.meter = Math.min(METER_MAX, Math.max(0, this.meter + v)); }
  consumeBuffer() { if (!this.buffer) return null; const b = this.buffer.button; this.buffer = null; return b; }

  startAttack(id) {
    this.attack = { def: moveDef(id), frame: 0, hasHit: false, blocked: false, id };
    this.enter('attack'); this.stateFrames = 0;
  }
  startJump(dir) {
    this.vy = this.char.jumpV;
    this.vx = dir * this.char.jumpVx * this.facing;
    this.crouching = false; this.airAttackUsed = false; this.attack = null;
    this.grounded = false; this.enter('jump');
  }

  update(inp, oppX) {
    this.wantsSuper = false;
    this.stateFrames++;
    if (inp.grab || inp.punch || inp.kick) this.buffer = { button: inp.grab ? 'grab' : inp.kick ? 'kick' : 'punch', frames: 9 };
    else if (this.buffer) { this.buffer.frames--; if (this.buffer.frames <= 0) this.buffer = null; }
    if (inp.super) this.superBuffer = SUPER_BUFFER; else if (this.superBuffer > 0) this.superBuffer--;

    if (this.state === 'super' || this.state === 'frozen') { this.integrate(); return; }

    const dir = oppX >= this.x ? 1 : -1;
    switch (this.state) {
      case 'idle': case 'walk': case 'crouch':
        this.comboHits = 0;
        this.updateActionable(inp, dir);
        break;
      case 'attack':
        this.updateAttack();
        break;
      case 'jump':
        if (!this.airAttackUsed && this.buffer && this.buffer.button !== 'grab') {
          const b = this.consumeBuffer();
          this.attack = { def: moveDef(b === 'kick' ? 'airKick' : 'airPunch'), frame: 0, hasHit: false, blocked: false, id: b === 'kick' ? 'airKick' : 'airPunch' };
          this.airAttackUsed = true;
        }
        if (this.attack) this.attack.frame++;
        break;
      case 'hitstun':
        this.stun--; this.vx *= 0.86; if (this.stun <= 0) this.enter('idle');
        break;
      case 'blockstun':
        this.holdingBack = inp.moveX * this.facing < 0;
        this.crouching = inp.down;
        this.stun--; this.vx *= 0.82;
        if (this.stun <= 0) this.enter(this.crouching ? 'crouch' : 'idle');
        break;
      case 'knockdown':
        if (this.grounded) { this.vx *= 0.8; this.downFrames++; if (this.downFrames >= KNOCKDOWN_FRAMES) this.enter('getup'); }
        break;
      case 'getup':
        this.vx = 0;
        if (this.stateFrames >= GETUP_FRAMES) { this.facing = dir; this.enter('idle'); }
        break;
      case 'ko':
        if (this.grounded) { this.vx *= 0.85; this.downFrames++; }
        break;
    }
    this.integrate();
  }

  updateActionable(inp, dir) {
    this.facing = dir;
    const n = inp.moveX * this.facing;
    this.moveRel = n; this.holdingBack = n < 0;
    if (this.superBuffer > 0 && this.meter >= METER_MAX) {
      this.superBuffer = 0; this.wantsSuper = true; this.vx = 0;
      return;
    }
    if (inp.up && !inp.down) { this.startJump(n); return; }
    this.crouching = inp.down;
    const b = this.consumeBuffer();
    if (b) this.startAttack(selectMove(b, this.crouching, n > 0));
    else if (this.crouching) { this.enter('crouch'); this.vx = 0; }
    else if (n === 0) { this.enter('idle'); this.vx = 0; }
    else { this.enter('walk'); this.vx = n > 0 ? this.char.walkFwd * this.facing : -this.char.walkBack * this.facing; }
  }

  updateAttack() {
    const e = this.attack;
    if (!e) { this.enter('idle'); return; }
    e.frame++;
    const t = e.def;
    if (e.frame <= t.startup + t.active) this.vx = (t.lunge || 0) * this.facing;
    else this.vx *= 0.75;
    if (t.chains && e.hasHit && !e.blocked && this.buffer && e.frame >= t.startup + t.active) {
      const next = chainNext(t, this.buffer.button);
      if (next) { this.buffer = null; this.startAttack(next); return; }
    }
    if (e.frame >= moveDuration(t)) {
      this.attack = null;
      this.crouching = !!t.crouching;
      this.enter(t.crouching ? 'crouch' : 'idle');
    }
  }

  integrate() {
    const air = this.y > 0 || this.vy !== 0;
    if (air) this.vy -= GRAVITY * DT;
    this.x += this.vx * DT;
    this.y += this.vy * DT;
    if (this.state === 'walk') this.walkDistance += Math.abs(this.vx) * DT;
    this.x = Math.max(-HALF_W, Math.min(HALF_W, this.x));
    if (this.y <= 0 && air && this.vy <= 0) { this.y = 0; this.vy = 0; this.onLand(); }
  }

  onLand() {
    this.grounded = true;
    if (this.state === 'jump') {
      const e = this.attack;
      this.attack = null; this.vx = 0;
      if (e && (!e.hasHit || e.blocked)) this.startAttack('landing');
      else this.enter('idle');
    } else if (this.state === 'hitstun') this.vx *= 0.5;
  }

  applyBlock(def, dir) {
    this.attack = null;
    this.forceState('blockstun');
    this.stun = def.blockstun;
    this.vx = dir * def.push * 0.75;
  }

  applyHit(def, dmg, dir) {
    this.hp = Math.max(0, this.hp - dmg);
    this.attack = null;
    this.comboHits++;
    this.lastHitHeight = def.height;
    this.crouching = false;
    if (this.hp <= 0) this.knockOut(dir, KO_VX, KO_VY);
    else if (def.knockdown || this.airborne) {
      this.forceState('knockdown');
      this.vx = dir * (def.push + 0.8);
      this.vy = Math.max(def.launch || 0, 4.2);
      this.downFrames = 0; this.grounded = false;
    } else {
      this.forceState('hitstun');
      this.stun = def.hitstun;
      this.vx = dir * def.push;
    }
  }

  knockOut(dir, vx, vy) {
    this.hp = 0; this.attack = null;
    this.forceState('ko');
    this.vx = dir * vx; this.vy = vy;
    this.grounded = false; this.downFrames = 0;
  }
}

// --- hit resolution (qg / Kg / Jg / $g) ---
function attackHeight(f) { return f.attack ? (f.attack.def.air ? 'mid' : f.attack.def.height) : null; }

function hitOverlap(att, def) {
  const a = att.attack;
  if (!a) return false;
  const r = (def.x - att.x) * att.facing;
  if (r < -0.15) return false;
  if (a.def.grab) return r <= GRAB_RANGE;
  const h = attackHeight(att);
  if (def.y > 0.25 && h === 'low') return false;   // low whiffs on airborne
  if (def.isLow && h === 'high') return false;      // high whiffs on crouching
  const reach = REACH[a.id] ?? 1.2;
  return r <= reach + 0.1;
}

function blocks(defender, height) {
  if (!defender.canBlock || !defender.holdingBack || defender.airborne) return false;
  return defender.crouching ? height === 'low' : (height === 'high' || height === 'mid');
}

// returns hit descriptor or null
function resolveHit(att, def) {
  const a = att.attack;
  if (!a || a.hasHit || !att.isAttackActive || def.invulnerable) return null;
  const h = attackHeight(att);
  if (a.def.grab && (def.state === 'hitstun' || def.airborne || def.y > 0.01)) return null;
  if (!hitOverlap(att, def)) return null;

  a.hasHit = true;
  const dir = att.facing;

  if (a.def.grab) {
    const dmg = damage(att, def, 14);
    def.applyHit({ height: 'mid', hitstun: 30, knockdown: true, launch: 5.5, push: 3 }, dmg, dir);
    att.addMeter(dmg * 0.9 + 2); def.addMeter(dmg * 0.6);
    return { moveId: 'grab', blocked: false, damage: dmg, ko: def.hp <= 0 };
  }

  if (blocks(def, h)) {
    a.blocked = true;
    const dmg = Math.min(Math.round(a.def.damage * att.char.damageMul * BLOCK_DMG_MUL), Math.max(0, Math.ceil(def.hp) - 1));
    if (dmg > 0) def.hp -= dmg;
    def.applyBlock(a.def, dir);
    att.addMeter(2); def.addMeter(3);
    return { moveId: a.id, blocked: true, damage: Math.max(0, dmg), ko: false };
  }

  const counter = def.attackPhase === 'startup';
  const dmg = damage(att, def, a.def.damage * (counter ? COUNTER_MUL : 1));
  def.applyHit(a.def, dmg, dir);
  att.addMeter(dmg * 0.9 + 2); def.addMeter(dmg * 0.6);
  return { moveId: a.id, blocked: false, damage: dmg, ko: def.hp <= 0 };
}

function damage(att, def, base) {
  const scale = COMBO_SCALE[def.comboHits] ?? COMBO_FALLBACK;
  return Math.max(1, Math.round(base * att.char.damageMul * att.power * scale));
}

// --- remote input queue (host applies the guest's frames) ---
class RemoteInput {
  constructor() { this.frames = new Map(); this.next = -1; this.newest = -1; this.ack = 0; }
  push(seq, frameBytes) {
    for (let i = 0; i < frameBytes.length; i++) {
      const s = seq - (frameBytes.length - 1 - i);
      if (s < 0) continue;
      if (this.next >= 0 && s < this.next) continue;
      if (this.frames.has(s)) continue;
      this.frames.set(s, frameBytes[i]);
    }
    this.newest = Math.max(this.newest, seq);
    if (this.next < 0 && this.frames.size) this.next = Math.min(...this.frames.keys());
  }
  take() {
    if (this.next < 0) return 0;
    while (this.newest - this.next > 30) this.skip();
    const v = this.frames.has(this.next) ? this.frames.get(this.next) : 0;
    this.frames.delete(this.next);
    this.ack = this.next;
    this.next++;
    return v;
  }
  skip() { this.frames.delete(this.next); this.next++; }
}

module.exports = {
  DT, GRAVITY, HALF_W, START_X, STATE_NAMES, ROSTER, CHARS, MOVES, SUPER,
  Fighter, RemoteInput, resolveHit, attackHeight, moveDuration, selectMove,
};
