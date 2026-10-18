/**
 * @file app/worker/sim/drop.js
 * 持ち主: W1（シミュレータ）
 * 役割: 投下・降下・着地・分離・絡まり・引きずり（9・10 章）。
 * SPEC: 6.6（段の表）・6.10 の drop と parachute_on_ground・6.11 の events（release・chute_open・landed・crash・
 *       cut_in_air・separated・tangled）
 *
 * refsim.py の _air_step・nichrome・分離・絡まり・引きずりと同じ計算。違うのは時間の数え方だけで、
 * 「0.8 s 落ちたら開く」「2.0 s 焼いたら切れる」「着地の 0.5 s 後から絡まる」を、足し算をくり返した秒ではなく
 * 刻みの数で数える（6.1〔1.1〕。20 分でも端数の誤差でずれない）。
 * 機体の状態（x・y・h・車輪の速さ・指令など）は RoverSim が持ち、ここの関数がそれを読み書きする。
 */

import { dsin, dcos, dexp, dhypot, wrap2pi, DEG } from './geometry.js';

/** 6.6 の数（refsim と同じ）。 */
export const DROP_CONST = Object.freeze({
  g: 9.80665,          // 重力 m/s²
  fallS: 0.8,          // 自由落下の長さ s
  descentTau: 0.4,     // 降下の速さに近づく τ s
  windGain: 0.9,       // 水平の速さ = 0.9 × wind_speed
  windTau: 1.0,        // 風に近づく τ s
  crashV: 9.0,         // これを超える着地の速さで壊れる m/s
  shockClipS: 0.03,    // 着地から ±16 g で頭打ちの間 s
  shockDecayS: 0.3,    // 揺れが減っていく間 s
  accelClip: 16 * 9.80665, // ±16 g m/s²（156.9）
  tether: 1.6,         // パラとつながっている間に離れられる距離 m
  sepS: 2.0,           // 地上で流し続けると切れる時間 s
  tangleAfterS: 0.5,   // 着地からこの後に
  tangleR: 0.7,        // パラの中心からこの距離に入ると絡まる m
});

/** 段の番号（FRAME_FIELDS の mode）。 */
export const MODE = Object.freeze({ GROUND: 0, CARRIER: 1, FALL: 2, DESCENT: 3 });
const MODE_NAME = ['ground', 'carrier', 'fall', 'descent'];

export class DropModel {
  /**
   * @param {object|null} drop 世界の drop（height・release_t・wind_speed・wind_from・descent・inverted・land_heading・sep_fail_first・canopy_dist・drag）
   * @param {object|null} onGround 世界の parachute_on_ground（着地したところから始める面）
   * @param {{x:number, y:number, dt:number}} start スタートの位置と刻み
   */
  constructor(drop, onGround, start) {
    const dt = start.dt;
    this.dt = dt;
    this.cfg = drop || null;
    this.mode = MODE.GROUND;
    this.z = 0;
    this.vz = 0;
    this.fallN0 = 0;
    this.landedN = null;          // 着地した刻み（landed_t = landedN × dt）
    this.landedT = null;
    this.impactT = null;
    this.attached = false;
    this.separated = false;
    this.sepT = null;
    this.tangled = false;
    /** @type {number[]|null} パラの位置 [x, y] */
    this.canopy = null;
    this.burnOn = false;
    this.burnSteps = 0;
    this.burnAttempts = 0;
    this.sepFailFirst = 0;
    this.drag = 0;
    this.windTo = 0;
    this.motorBeforeLand = false;
    this.nichromeInAir = false;
    this.crashed = false;
    this.fallSteps = Math.round(DROP_CONST.fallS / dt);
    this.sepSteps = Math.round(DROP_CONST.sepS / dt);
    this.tangleSteps = Math.round(DROP_CONST.tangleAfterS / dt);
    this.descA = 1 - dexp(-dt / DROP_CONST.descentTau);
    this.windA = 1 - dexp(-dt / DROP_CONST.windTau);
    if (drop) {
      this.mode = MODE.CARRIER;
      this.z = Number(drop.height ?? 30);
      this.attached = true;
      this.windTo = (Number(drop.wind_from ?? 0) + 180) * DEG;
      this.sepFailFirst = Number(drop.sep_fail_first ?? 0);
      this.drag = Number(drop.drag ?? 0);
    }
    if (onGround) {
      this.attached = true;
      this.landedN = 0;
      this.landedT = 0;
      this.windTo = (Number(onGround.wind_from ?? 0) + 180) * DEG;
      const cd = Number(onGround.canopy_dist ?? 1.2);
      this.canopy = [start.x + cd * dsin(this.windTo), start.y + cd * dcos(this.windTo)];
      this.sepFailFirst = Number(onGround.sep_fail_first ?? 0);
      this.drag = Number(onGround.drag ?? 0);
    }
  }

  /** 今の段の名前（ground・carrier・fall・descent）。 */
  get modeName() { return MODE_NAME[this.mode]; }
  /** 地上か。 */
  get onGround() { return this.mode === MODE.GROUND; }

  /**
   * 空中の 1 刻み（つり下げ・落下・降下）。refsim の _air_step と同じ。sim は RoverSim（x・y・vx・vy・h・mL・mR・
   * distL・distR・cmdL・cmdR・inverted・stuck・n・t と event()・targetSpeed()）。
   */
  airStep(sim) {
    const dt = this.dt;
    const a = sim.wheelA;
    sim.mL += (sim.dutySpeed(sim.cmdL, 1) - sim.mL) * a;
    sim.mR += (sim.dutySpeed(sim.cmdR, 1) - sim.mR) * a;
    sim.distL += sim.mL * dt;
    sim.distR += sim.mR * dt;
    if ((sim.cmdL !== 0 || sim.cmdR !== 0) && !this.motorBeforeLand) {
      this.motorBeforeLand = true;
      sim.event('motor_before_land', {});
    }
    const d = this.cfg;
    if (this.mode === MODE.CARRIER) {
      if (sim.t >= Number(d.release_t ?? 5)) {
        this.mode = MODE.FALL;
        this.fallN0 = sim.n;
        sim.event('release', {});
      }
      return;
    }
    const wspd = Number(d.wind_speed ?? 0);
    if (this.mode === MODE.FALL) {
      this.vz -= DROP_CONST.g * dt;
      if (sim.n - this.fallN0 >= this.fallSteps && !this.crashed) {
        this.mode = MODE.DESCENT;
        sim.event('chute_open', {});
      }
    } else if (this.mode === MODE.DESCENT) {
      const target = -Number(d.descent ?? 4.8);
      this.vz += (target - this.vz) * this.descA;
    }
    let tvx = wspd * DROP_CONST.windGain * dsin(this.windTo);
    let tvy = wspd * DROP_CONST.windGain * dcos(this.windTo);
    if (this.mode === MODE.FALL && this.crashed) { tvx = 0; tvy = 0; }
    sim.vx += (tvx - sim.vx) * this.windA;
    sim.vy += (tvy - sim.vy) * this.windA;
    sim.x += sim.vx * dt;
    sim.y += sim.vy * dt;
    this.z += this.vz * dt;
    if (this.z <= 0) this.land(sim);
  }

  /** 着地（高さ 0）。 */
  land(sim) {
    const d = this.cfg;
    this.z = 0;
    const impactV = -this.vz;
    this.mode = MODE.GROUND;
    this.landedN = sim.n;
    this.landedT = sim.t;
    this.impactT = sim.t;
    sim.vx = 0; sim.vy = 0; this.vz = 0;
    sim.mL = 0; sim.mR = 0;
    sim.h = wrap2pi(Number(d.land_heading ?? 0) * DEG);
    sim.inverted = !!d.inverted;
    sim.event('landed', { v: Math.round(impactV * 100) / 100 });
    if (impactV > DROP_CONST.crashV) {
      this.crashed = true;
      sim.stuck = 'crash';
      sim.event('crash', {});
    }
    if (this.attached) {
      const cd = Number(d.canopy_dist ?? 1.2);
      this.canopy = [sim.x + cd * dsin(this.windTo), sim.y + cd * dcos(this.windTo)];
    }
  }

  /** 1 刻みのあと（時刻を進めた後）: 焼いている時間を数え、地上でつながっていれば 2.0 s で切れる。 */
  afterStep(sim) {
    if (!this.burnOn) return;
    this.burnSteps++;
    if (this.mode === MODE.GROUND && this.attached && this.burnSteps >= this.sepSteps &&
        this.burnAttempts > this.sepFailFirst) {
      this.attached = false;
      this.separated = true;
      this.sepT = sim.t;
      sim.event('separated', {});
    }
  }

  /**
   * ニクロム線（refsim の nichrome と同じ）。空中で流すとパラが切れる（cut_in_air、降下中なら落ち始める）。
   * 流し始めるたびに 1 回と数え、sep_fail_first 回目までは切れない。
   * @param {object} sim RoverSim @param {boolean} on
   */
  nichrome(sim, on) {
    if (on && this.mode !== MODE.GROUND) {
      this.nichromeInAir = true;
      if (this.attached) {
        this.attached = false;
        this.crashed = true;
        sim.event('cut_in_air', {});
        if (this.mode === MODE.DESCENT) {
          this.mode = MODE.FALL;
          this.fallN0 = sim.n;
        }
      }
    }
    if (on && !this.burnOn) {
      this.burnAttempts++;
      this.burnSteps = 0;
    }
    this.burnOn = on;
  }

  /** 引きずられているか（つながっていて、パラが地面にあって、drag > 0）。 */
  get dragging() { return this.attached && this.canopy !== null && this.drag > 0; }

  /** パラとつながっていて、その位置に行けないか（ひも 1.6 m）。 @param {number} x @param {number} y @returns {boolean} */
  tetherBlocks(x, y) {
    return this.attached && this.canopy !== null && dhypot(x - this.canopy[0], y - this.canopy[1]) > DROP_CONST.tether;
  }

  /** 着地の 0.5 s 後から、パラの中心の 0.7 m 以内に入ったら絡まる（地上の 1 刻みの中で、時刻を進める前に呼ぶ）。 */
  checkTangle(sim) {
    if (this.canopy === null || this.tangled || this.landedN === null) return;
    if (sim.n - this.landedN > this.tangleSteps && dhypot(sim.x - this.canopy[0], sim.y - this.canopy[1]) < DROP_CONST.tangleR) {
      this.tangled = true;
      sim.stuck = 'tangled';
      sim.event('tangled', {});
    }
  }

  /** パラの位置（無ければ null。FRAME_FIELDS の cx, cy）。 @returns {{x:number, y:number}|null} */
  get canopyPos() { return this.canopy ? { x: this.canopy[0], y: this.canopy[1] } : null; }
}
