'use strict';
// CPU brain, ported 1:1 from the game bundle (class a_ + profiles i_).
// think(me, opp, dt) -> input object. Same code that drives the in-game CPU.

const { emptyInput, attackHeight, isHoldingBlock } = require('./proto');

// Difficulty profiles. easy/normal/hard come straight from the game (i_);
// extreme/ultimate are crafted on top of hard (snappier reaction + better
// defence/aggression). `reaction` is the decision interval in seconds — 0 means
// the bot re-decides on every 60 Hz tick (frame-perfect).
const PROFILES = {
  easy: { breakChance: 0.08, reaction: 0.42, blockChance: 0.18, punishChance: 0.2, aggression: 0.45, superChance: 0.35, bossRead: 0.2 },
  normal: { breakChance: 0.3, reaction: 0.26, blockChance: 0.45, punishChance: 0.5, aggression: 0.65, superChance: 0.7, bossRead: 0.35 },
  hard: { breakChance: 0.6, reaction: 0.14, blockChance: 0.75, punishChance: 0.85, aggression: 0.8, superChance: 1, bossRead: 0.8, bossReaction: 0.06 },
  extreme: { breakChance: 0.9, reaction: 0.03, blockChance: 0.97, punishChance: 0.98, aggression: 0.95, superChance: 1, bossRead: 0.97, bossReaction: 0.02 },
  ultimate: { breakChance: 1, reaction: 0, blockChance: 1, punishChance: 1, aggression: 1, superChance: 1, bossRead: 1, bossReaction: 0 },
};

const LEVELS = ['easy', 'normal', 'hard', 'extreme', 'ultimate'];
// The bot's default CPU level. Guest sessions run `ultimate` unless overridden —
// the host's browser is authoritative, so the bot sees the fight one round-trip
// late; it compensates by reading every snapshot instantly (reaction 0) and
// predicting the opponent forward (see session.js `predict`).
const DEFAULT_LEVEL = 'ultimate';

// All characters share this one brain. Behaviour is decided only by the chosen
// level plus any explicit `overrides` — there are no per-character differences.
function resolveProfile(level, overrides) {
  const base = PROFILES[level] || PROFILES[DEFAULT_LEVEL];
  return { ...base, ...(overrides || {}) };
}

class Bot {
  constructor(level = 'hard', rng = Math.random, overrides = {}) {
    this.rng = rng;
    this.level = PROFILES[level] ? level : 'hard';
    this.overrides = overrides || {};
    this.charId = null;
    this.profile = resolveProfile(this.level, this.overrides);
    this.plan = { kind: 'wait', time: 0, buttons: [] };
    this.elapsed = 0;
    this.sinceDecision = 99;
    this.read = null;
    this.readIt = false;
  }

  // swap difficulty (and/or custom tuning) mid-match
  setLevel(level, overrides) {
    if (level && PROFILES[level]) this.level = level;
    if (overrides !== undefined) this.overrides = overrides || {};
    this.profile = resolveProfile(this.level, this.overrides);
    return this.level;
  }

  // records which fighter we picked; does not change the brain
  setChar(charId) {
    this.charId = charId || null;
    return this.charId;
  }

  think(me, opp, dt) {
    this.elapsed += dt;
    this.sinceDecision += dt;
    // Instant reaction path. It runs on every tick regardless of the decision
    // interval, so the bot answers the freshest host snapshot with zero added
    // delay: block incoming attacks, anti-air jump-ins, punish whiffs.
    if (this.profile.bossRead > 0 && this.readAttack(me, opp)) return this.execute(me, opp);
    const r = me.isBoss && this.profile.bossReaction != null
      ? this.profile.bossReaction
      : this.profile.reaction;
    if (this.sinceDecision >= r || this.elapsed >= this.plan.time) this.decide(me, opp);
    return this.execute(me, opp);
  }

  // Instant reaction: runs on every tick. Reads the opponent directly from the
  // authoritative host snapshot (exact move, exact frame) and answers with no
  // decision-interval delay — perfect-height block vs an incoming attack,
  // anti-air vs a jump-in, and an immediate punish the moment an attack whiffs.
  readAttack(me, opp) {
    const dist = Math.abs(opp.x - me.x);
    const atk = opp.attack;
    const jumping = !atk && opp.state === 'jump' && opp.y > 0.1;
    if (!atk && !jumping) { this.read = null; return false; }

    const grab = atk && atk.def.grab;
    const inRange = grab ? dist <= 1.4 : jumping ? dist <= 2.3 : dist <= 1.9;
    if (!inRange) { if (atk && opp.attackPhase === 'recovery') this.read = null; return false; }

    const target = atk || opp;
    if (this.read !== target) {
      this.read = target;
      this.readIt = this.rng() < this.profile.bossRead;
    }
    if (!this.readIt) return false;
    const busy = me.state === 'attack' && me.attackPhase !== 'active';
    if (!me.canBlock && !busy) return false;

    // Already whiffed and in recovery -> punish it right away.
    if (atk && opp.attackPhase === 'recovery') {
      if (me.actionable && this.rng() < this.profile.punishChance) { this.planAttack(dist); return true; }
      return false;
    }
    if (grab) {
      if (this.plan.buttons.length === 0) this.setPlan('attack', 0.2, [{ at: 0, button: 'grab' }]);
      return true;
    }
    // Jump-in: anti-air uppercut when it lands close, otherwise block it.
    if (jumping && me.actionable) {
      if (dist > 0.7 && dist < 1.5 && this.rng() < this.profile.punishChance) {
        this.setPlan('attack', 0.45, [{ at: 0, button: 'punch', forward: true }]);
        return true;
      }
      if (this.rng() < this.profile.blockChance) { this.setPlan('block', 0.3); return true; }
      return false;
    }
    const low = !jumping && attackHeight(opp) === 'low';
    this.setPlan(low ? 'lowBlock' : 'block', 0.2);
    return true;
  }

  setPlan(kind, time, buttons = []) {
    this.plan = { kind, time, buttons };
    this.elapsed = 0;
  }

  decide(me, opp) {
    this.sinceDecision = 0;
    const rng = this.rng;
    const prof = this.profile;
    const dist = Math.abs(opp.x - me.x);

    if (this.elapsed < this.plan.time && (this.plan.kind !== 'attack' || me.state === 'attack')) return;

    // Wake-up defence: hold back for a beat, or reversal super if it's up.
    if (me.state === 'getup') {
      if (me.meter >= 100 && rng() < prof.superChance) { this.setPlan('super', 0.1); return; }
      this.setPlan('block', 0.3);
      return;
    }

    if (me.meter >= 100 && opp.state !== 'knockdown' && opp.state !== 'getup' && !isHoldingBlock(opp) && rng() < prof.superChance) {
      this.setPlan('super', 0.1);
      return;
    }
    const phase = opp.attackPhase;
    if (opp.attack && opp.attack.def.grab && phase === 'startup' && dist < 1.4 && rng() < prof.breakChance) {
      this.setPlan('attack', 0.2, [{ at: 0, button: 'grab' }]);
      return;
    }
    if (dist < 1.05 && (opp.state === 'blockstun' || (opp.holdingBack && opp.actionable && !opp.crouching)) && rng() < 0.3 * prof.aggression) {
      this.setPlan('attack', 0.6, [{ at: 0, button: 'grab' }]);
      return;
    }
    if (!me.isBoss && (phase === 'startup' || phase === 'active') && dist < 2.2 && rng() < prof.blockChance) {
      const low = attackHeight(opp) === 'low';
      this.setPlan(low ? 'lowBlock' : 'block', 0.45);
      return;
    }
    if (!me.isBoss && opp.state === 'jump' && opp.y > 0.1 && dist < 2.4 && me.canBlock) {
      if (dist < 1.5 && rng() < prof.punishChance) { this.setPlan('attack', 0.4, [{ at: 0, button: 'punch', forward: true }]); return; }
      if (rng() < prof.blockChance) { this.setPlan('block', 0.45); return; }
    }
    // Keep a combo going while the opponent is still reeling.
    if (opp.state === 'hitstun' && dist < 1.6 && rng() < prof.aggression) {
      this.planAttack(dist);
      return;
    }
    if (dist < 2.0 && (phase === 'recovery' || opp.state === 'getup') && rng() < prof.punishChance) {
      this.planAttack(dist);
      return;
    }
    if (dist > 1.4) {
      if (dist < 3.4 && rng() < 0.12 * prof.aggression) this.setPlan('jumpIn', 0.9, [{ at: 0.28, button: 'kick' }]);
      else if (rng() < 0.12 && this.plan.kind !== 'retreat') this.setPlan('wait', 0.25 + rng() * 0.3);
      else this.setPlan('approach', 0.3 + rng() * 0.4);
      return;
    }
    const o = rng();
    if (o < prof.aggression) this.planAttack(dist);
    else if (o < prof.aggression + 0.15) this.setPlan('retreat', 0.25 + rng() * 0.3);
    else if (o < prof.aggression + 0.25) this.setPlan('block', 0.3);
    else this.setPlan('wait', 0.2);
  }

  planAttack(dist) {
    const t = this.rng();
    if (dist > 1.05) {
      if (t < 0.5) this.setPlan('attack', 0.5, [{ at: 0, button: 'kick', forward: true }]);
      else if (t < 0.75) this.setPlan('attack', 0.5, [{ at: 0, button: 'kick', down: true }]);
      else this.setPlan('approach', 0.25);
    } else if (t < 0.18) this.setPlan('attack', 0.75, [{ at: 0, button: 'punch' }, { at: 0.2, button: 'punch' }, { at: 0.42, button: 'kick' }]);
    else if (t < 0.32) this.setPlan('attack', 0.75, [{ at: 0, button: 'punch' }, { at: 0.2, button: 'punch' }, { at: 0.42, button: 'punch' }]);
    else if (t < 0.44) this.setPlan('attack', 0.8, [{ at: 0, button: 'punch' }, { at: 0.2, button: 'kick' }, { at: 0.5, button: 'kick' }]);
    else if (t < 0.56) this.setPlan('attack', 0.7, [{ at: 0, button: 'kick' }, { at: 0.3, button: 'kick' }]);
    else if (t < 0.64) this.setPlan('attack', 0.45, [{ at: 0, button: 'kick' }]);
    else if (t < 0.74) this.setPlan('attack', 0.7, [{ at: 0, button: 'punch', forward: true }, { at: 0.32, button: 'kick' }]);
    else if (t < 0.84) this.setPlan('attack', 0.5, [{ at: 0, button: 'kick', down: true }]);
    else if (t < 0.88) this.setPlan('attack', 0.6, [{ at: 0, button: 'punch', down: true }, { at: 0.22, button: 'punch' }]);
    else if (t < 0.94) this.setPlan('attack', 0.6, [{ at: 0, button: 'grab' }]);
    else this.setPlan('attack', 0.55, [{ at: 0, button: 'kick', forward: true }]);
  }

  execute(me, opp) {
    const out = emptyInput();
    const dir = opp.x >= me.x ? 1 : -1;
    const plan = this.plan;
    switch (plan.kind) {
      case 'approach': out.moveX = dir; break;
      case 'retreat': out.moveX = -dir; break;
      case 'block': out.moveX = -dir; break;
      case 'lowBlock': out.moveX = -dir; out.down = true; break;
      case 'jumpIn': if (this.elapsed < 0.05) { out.up = true; out.moveX = dir; } break;
      case 'super': out.super = true; break;
    }
    for (let i = 0; i < plan.buttons.length; i++) {
      const b = plan.buttons[i];
      if (this.elapsed >= b.at) {
        out[b.button] = true;
        if (b.forward) out.moveX = dir;
        if (b.down) out.down = true;
        plan.buttons.splice(i, 1);
        break;
      }
    }
    if (plan.kind === 'jumpIn' && plan.buttons.length === 0 && me.state === 'jump') out.moveX = dir;
    return out;
  }
}

module.exports = { Bot, PROFILES, LEVELS, DEFAULT_LEVEL, resolveProfile };
