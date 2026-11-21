'use strict';
// Wire protocol for Sansad Showdown (fightkaro.com) online play.
// Reverse-engineered from the client bundle (rooms-*.js + main-*.js).

const STATE_NAMES = [
  'idle', 'walk', 'crouch', 'jump', 'attack', 'hitstun', 'blockstun',
  'knockdown', 'getup', 'ko', 'super', 'frozen', 'victory', 'intro',
];

// fighterSnap flag bits
const FLAG = { crouching: 1, holdingBack: 2, grounded: 4, attackHasHit: 8, airAttackUsed: 16 };
const BUFFER_BUTTONS = ['punch', 'kick', 'grab'];

const YE = 1 / 60;

// Move catalog (extracted verbatim from the bundle). Only the fields the AI needs.
const MOVES = require('./moves.json');

// --- input bitmask codec (jg / Mg) -----------------------------------------
// bits 0-1: moveX (-1 => 1, 0 => 0, 1 => 2), bit2 up, bit3 down,
// bit4 punch, bit5 kick, bit6 grab, bit7 super
function encodeInput(i) {
  return (
    (i.moveX === -1 ? 1 : i.moveX === 1 ? 2 : 0) |
    (i.up ? 4 : 0) |
    (i.down ? 8 : 0) |
    (i.punch ? 16 : 0) |
    (i.kick ? 32 : 0) |
    (i.grab ? 64 : 0) |
    (i.super ? 128 : 0)
  );
}

function decodeInput(b) {
  const t = b & 3;
  return {
    moveX: t === 1 ? -1 : t === 2 ? 1 : 0,
    up: !!(b & 4),
    down: !!(b & 8),
    punch: !!(b & 16),
    kick: !!(b & 32),
    grab: !!(b & 64),
    super: !!(b & 128),
  };
}

function emptyInput() {
  return { moveX: 0, up: false, down: false, punch: false, kick: false, grab: false, super: false };
}

// --- input datagram codec (Ng / Pg) ----------------------------------------
// [u8 version=1][u32 seq][u8 count][count x u8 frameBytes]  (big-endian)
function encodeInputPacket(seq, frameBytes) {
  const n = Math.min(frameBytes.length, 8);
  const buf = Buffer.alloc(6 + n);
  buf.writeUInt8(1, 0);
  buf.writeUInt32BE(seq >>> 0, 1);
  buf.writeUInt8(n, 5);
  for (let i = 0; i < n; i++) buf.writeUInt8(frameBytes[frameBytes.length - n + i] & 0xff, 6 + i);
  return buf;
}

function decodeInputPacket(buf) {
  if (buf.byteLength < 6) return null;
  const dv = new DataView(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
  if (dv.getUint8(0) !== 1) return null;
  const n = dv.getUint8(5);
  if (buf.byteLength < 6 + n) return null;
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(dv.getUint8(6 + i));
  return { seq: dv.getUint32(1), frames };
}

// --- snapshot -> fighter adapter -------------------------------------------
// fighterSnap => [x,y,vx,vy,facing,hp,meter,stateIdx,stateFrames,attackId,
//                 attackFrame,flags,moveRel,comboHits,walkDistance,downFrames,
//                 stun,bufferBtnIdx,bufferFrames]
function fighterFromSnap(s, charId, predict = 0) {
  const flags = s[11] | 0;
  const attackId = s[9];
  const def = attackId ? MOVES[attackId] : null;
  const dtn = predict ? predict / 60 : 0;
  const attack = def
    ? { def, frame: s[10] + predict, hasHit: !!(flags & FLAG.attackHasHit) }
    : null;
  const state = STATE_NAMES[s[7]] || 'idle';
  const crouching = !!(flags & FLAG.crouching);
  const buffBtn = s[17] ? BUFFER_BUTTONS[s[17] - 1] : null;

  let attackPhase = null;
  if (attack) {
    if (attack.frame <= attack.def.startup) attackPhase = 'startup';
    else if (attack.frame <= attack.def.startup + attack.def.active) attackPhase = 'active';
    else attackPhase = 'recovery';
  }

  return {
    x: s[0] + (s[2] || 0) * dtn, y: Math.max(0, s[1] + (s[3] || 0) * dtn), vx: s[2], vy: s[3], facing: s[4],
    hp: s[5], meter: s[6], state, stateFrames: s[8],
    attack, attackPhase,
    crouching, holdingBack: !!(flags & FLAG.holdingBack), grounded: !!(flags & FLAG.grounded),
    moveRel: s[12], comboHits: s[13], walkDistance: s[14], downFrames: s[15], stun: s[16] || 0,
    buffer: buffBtn ? { button: buffBtn, frames: s[18] || 0 } : null,
    airAttackUsed: !!(flags & FLAG.airAttackUsed),
    char: { id: charId },
    isBoss: false,
    // derived getters (mirror the real Fighter class)
    get airborne() { return this.y > 0.001 || this.vy > 0; },
    get actionable() { return this.state === 'idle' || this.state === 'walk' || this.state === 'crouch'; },
    get invulnerable() { return this.state === 'knockdown' || this.state === 'getup' || this.state === 'ko'; },
    get isLow() { return this.state === 'crouch' || (this.state === 'blockstun' && this.crouching) || !!(this.attack && this.attack.def.crouching); },
    get isAttackActive() { const a = this.attack; return a ? a.frame > a.def.startup && a.frame <= a.def.startup + a.def.active : false; },
    get canBlock() { return this.state === 'idle' || this.state === 'walk' || this.state === 'crouch' || this.state === 'blockstun'; },
  };
}

// attack height helper (Ug)
function attackHeight(f) {
  if (!f.attack) return null;
  return f.attack.def.air ? 'mid' : f.attack.def.height;
}

// blocking helper (Yg)
function isHoldingBlock(f) {
  return f.canBlock && f.holdingBack && !f.airborne;
}

module.exports = {
  STATE_NAMES, FLAG, BUFFER_BUTTONS, YE, MOVES,
  encodeInput, decodeInput, emptyInput,
  encodeInputPacket, decodeInputPacket,
  fighterFromSnap, attackHeight, isHoldingBlock,
};
