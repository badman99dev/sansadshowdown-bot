'use strict';
// CPU brain, ported 1:1 from the game bundle (class a_ + profiles i_).
// think(me, opp, dt) -> input object. Same code that drives the in-game CPU.

const { emptyInput, attackHeight, isHoldingBlock } = require('./proto');

const PROFILES = {
  easy: { breakChance: 0.08, reaction: 0.42, blockChance: 0.18, punishChance: 0.2, aggression: 0.45, superChance: 0.35, bossRead: 0.2 },
  normal: { breakChance: 0.3, reaction: 0.26, blockChance: 0.45, punishChance: 0.5, aggression: 0.65, superChance: 0.7, bossRead: 0.35 },
  hard: { breakChance: 0.6, reaction: 0.14, blockChance: 0.75, punishChance: 0.85, aggression: 0.8, superChance: 1, bossRead: 0.8, bossReaction: 0.06 },
};

class Bot {
  constructor(level = 'hard', rng = Math.random, overrides = {}) {
    this.rng = rng;
    this.profile = { ...(PROFILES[level] || PROFILES.hard), ...overrides };
    this.plan = { kind: 'wait', time: 0, buttons: [] };
    this.elapsed = 0;
    this.sinceDecision = 99;
    this.read = null;
    this.readIt = false;
  }

  think(me, opp, dt) {
    this.elapsed += dt;
    this.sinceDecision += dt;
    if (me.isBoss && this.readAttack(me, opp)) return this.execute(me, opp);
    const r = me.isBoss && this.profile.bossReaction != null
      ? this.profile.bossReaction
      : this.profile.reaction;
    if (this.sinceDecision >= r || this.elapsed >= this.plan.time) this.decide(me, opp);
    return this.execute(me, opp);
  }

  readAttack(me, opp) {
    const dist = Math.abs(opp.x - me.x);
    const atk = opp.attack;
    const jumping = !atk && opp.state === 'jump' && opp.y > 0.1;
    if (jumping ? dist > 2.3 : (!atk || opp.attackPhase === 'recovery' || dist > 1.9)) {
      if (!atk && !jumping) this.read = null;
      return false;
    }
    const target = atk || opp;
    if (this.read !== target) {
      this.read = target;
      this.readIt = this.rng() < this.profile.bossRead;
    }
    if (!this.readIt) return false;
    const busy = me.state === 'attack' && me.attackPhase !== 'active';
    if (!me.canBlock && !busy) return false;
    if (atk && atk.def.grab) {
      if (this.plan.buttons.length === 0) this.setPlan('attack', 0.2, [{ at: 0, button: 'grab' }]);
      return true;
    }
    if (jumping && dist > 0.8 && dist < 1.8 && me.actionable && this.rng() < 0.02) {
      this.setPlan('attack', 0.4, [{ at: 0, button: 'punch', forward: true }]);
      return true;
    }
    const low = !jumping && attackHeight(opp) === 'low';
    this.setPlan(low ? 'lowBlock' : 'block', 0.12);
    return true;
  }

  setPlan(kind, time, buttons = []) {
    this.plan = { kind, time, buttons };
    this.elapsed = 0;
  }

  decide(me, opp) {
    this.sinceDecision = 0;
    const rng = this.rng;
    const prof = me.char.id === 'mbapu'
      ? { ...this.profile, aggression: 0.9, blockChance: 0.72, punishChance: 0.95, breakChance: 0.9, superChance: 0.9 }
      : this.profile;
    const dist = Math.abs(opp.x - me.x);

    if (this.plan.kind === 'attack' && this.elapsed < this.plan.time && me.state === 'attack') return;

    if (me.meter >= 100 && opp.state !== 'knockdown' && opp.state !== 'getup' && !isHoldingBlock(opp) && rng() < prof.superChance) {
      this.setPlan('super', 0.1);
      return;
    }
    if (me.char.id === 'mbapu' && dist < 1.9 && rng() < 0.75) {
      this.planMbapuAttack(dist);
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
      if (rng() < prof.blockChance) { this.setPlan('block', 0.45); return; }
      if (dist < 1.5 && rng() < prof.punishChance) { this.setPlan('attack', 0.35, [{ at: 0, button: 'punch' }]); return; }
    }
    if (dist < 1.7 && (phase === 'recovery' || opp.state === 'getup') && rng() < prof.punishChance) {
      me.isBoss ? this.planMbapuAttack(dist) : this.planAttack(dist);
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

  planMbapuAttack(dist) {
    const t = this.rng();
    if (dist > 1.15) {
      if (t < 0.4) this.setPlan('attack', 0.65, [{ at: 0, button: 'punch', forward: true }]);
      else if (t < 0.75) this.setPlan('attack', 0.65, [{ at: 0, button: 'kick', forward: true }]);
      else this.setPlan('jumpIn', 0.85, [{ at: 0.25, button: 'kick' }]);
    } else if (t < 0.3) this.setPlan('attack', 0.8, [{ at: 0, button: 'punch' }, { at: 0.18, button: 'punch' }, { at: 0.38, button: 'punch' }]);
    else if (t < 0.55) this.setPlan('attack', 0.8, [{ at: 0, button: 'kick' }, { at: 0.28, button: 'kick' }]);
    else if (t < 0.75) this.setPlan('attack', 0.65, [{ at: 0, button: 'kick', down: true }]);
    else if (t < 0.9) this.setPlan('attack', 0.75, [{ at: 0, button: 'punch', forward: true }, { at: 0.32, button: 'kick' }]);
    else this.setPlan('attack', 0.6, [{ at: 0, button: 'grab' }]);
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

module.exports = { Bot, PROFILES };
