/**
 * @file app/worker/sim/sensors.js
 * 持ち主: W1（シミュレータ）
 * 役割: センサの値を作る（LiDAR・方位・GNSS・カメラ・AR マーカー・気圧の高さ・加速度・故障）。
 *       読む時間（COST）を進めるのと、events への記録と calls の数は sim.js が受け持つ。
 * SPEC: 6.7（センサの表）・6.9（乱数の流れ: GNSS は別の流れ、他は読んだ順に主の流れ）・6.10 の sensor
 *
 * 計算は refsim.py の lidar・heading・gnss・camera・marker・altitude・accel と同じ（53 面はこの式で確かめ済み）。
 * refsim と違う所（SPEC にそろえた・決めた所）:
 *   - LiDAR は 1 cm、方位は 0.1° に丸める（6.7〔1.1〕。W4 の refsim の写しも同じ）
 *   - 測れない時は 0 ではなく null（5 章。Python では None）
 *   - GNSS の「その回だけのばらつき」（white・さかさまの追加・speed・course の誤差）も GNSS の流れから、
 *     整数の秒ごとに決まった数（8 個）を引く。なので生徒が gnss() を何回読んでも、ずれも値も変わらない（6.9）
 *   - AR マーカーは空中では見えない・さかさまで angle の符号が反対・カメラ故障の世界では使えない（カメラと同じ。
 *     refsim には無い。53 面にこの 3 つが重なる世界は無い）
 */

import { gauss } from './rng.js';
import { dsin, dcos, datan2, dexp, dhypot, wrap180, wrap360, rayCircle, raySeg, M_PER_DEG_LAT, mPerDegLon, DEG } from './geometry.js';
import { DROP_CONST, MODE } from './drop.js';

const G0 = DROP_CONST.g;
const SAT = DROP_CONST.accelClip;

/** 1 cm に丸める（Python の round(x, 2) とほぼ同じ。どのエンジンでも同じ答え）。 */
const round2 = (x) => Math.round(x * 100) / 100;
/** 0.1 に丸める。 */
const round1 = (x) => Math.round(x * 10) / 10;

export class Sensors {
  /**
   * @param {object} sim RoverSim（x・y・h・vx・vy・inverted・drop・t・n と、compile した cones・rocks・walls・markers）
   * @param {object} cfg SENSOR_DEFAULTS に world.sensor を重ねたもの
   * @param {() => number} rand 主の乱数の流れ
   * @param {() => number} gnssRand GNSS のずれの流れ（整数の秒ごとに決まった数だけ進める）
   * @param {object} spec ROVER_SPEC
   */
  constructor(sim, cfg, rand, gnssRand, spec) {
    this.sim = sim;
    this.cfg = cfg;
    this.rand = rand;
    this.gnssRand = gnssRand;
    this.spec = spec;
    // GNSS（ガウス・マルコフ。refsim と同じく、最初のずれは σ の正規分布から）
    const sig = Number(cfg.gnss_sigma);
    this.gerr = [gauss(gnssRand) * sig, gauss(gnssRand) * sig];
    const tau = Number(cfg.gnss_tau);
    this.ga = tau > 0 ? dexp(-1.0 / tau) : 0;
    this.gk = Math.sqrt(1 - this.ga * this.ga) * sig;
    /** 整数の秒ごとの測位（添え字 = 秒） */
    this.fixes = [];
    const o = sim.origin;
    this.mLon = mPerDegLon(o.lat);
  }

  /** LiDAR: 前 0.10 m・高さ 0.08 m から 1 本。σ 0.02・1 cm 丸め・0.05〜12 m。空中・故障は null。 @returns {{v: number|null, truth: number|null}} */
  lidar() {
    const s = this.sim, sp = this.spec.lidar;
    if (this.cfg.lidar_broken) return { v: null, truth: null };
    if (s.drop.mode !== MODE.GROUND) return { v: null, truth: null };
    const dx = dsin(s.h), dy = dcos(s.h);
    const ox = s.x + dx * sp.forward, oy = s.y + dy * sp.forward;
    let best = Infinity;
    for (const c of s.cones) best = Math.min(best, rayCircle(ox, oy, dx, dy, c.x, c.y, c.lidarR));
    for (const r of s.rocks) {
      if (r.h < sp.height) continue;
      best = Math.min(best, rayCircle(ox, oy, dx, dy, r.x, r.y, r.r));
    }
    for (const w of s.walls) best = Math.min(best, raySeg(ox, oy, dx, dy, w.x1, w.y1, w.x2, w.y2));
    if (best > sp.max) return { v: null, truth: best === Infinity ? null : best };
    const v = Math.max(sp.min, best + gauss(this.rand) * Number(this.cfg.lidar_noise));
    return { v: round2(v), truth: best };
  }

  /** 方位: 本当の向き（heading_latency 秒前）＋かたより＋σ 1.5°、0.1° 丸め。故障は null。 @returns {{v: number|null, truth: number}} */
  heading() {
    const s = this.sim, c = this.cfg;
    const truth = wrap360(s.h / DEG);
    if (c.heading_broken) return { v: null, truth };
    const hs = s.hSensed ?? s.h;   // heading_latency 秒前の向き（遅れの無い世界では今の向き）
    let v = round1(wrap360(hs / DEG + Number(c.heading_bias) + gauss(this.rand) * Number(c.heading_noise)));
    if (v >= 360) v = 0;
    return { v, truth };
  }

  /**
   * GNSS を整数の秒ごとに測位して覚える（読むかどうかに関係なく。gnssFixes の元）。sim が 0 s と整数の秒の刻みで呼ぶ。
   * GNSS の流れから毎回 8 個引く: ずれ x・y、white x・y、さかさまの追加 x・y、speed、course。
   */
  gnssTick() {
    const s = this.sim, c = this.cfg, r = this.gnssRand;
    const k = this.fixes.length;
    this.gerr[0] = this.ga * this.gerr[0] + this.gk * gauss(r);
    this.gerr[1] = this.ga * this.gerr[1] + this.gk * gauss(r);
    const white = Number(c.gnss_white);
    const wx = gauss(r) * white, wy = gauss(r) * white;
    const ix = gauss(r) * white * 2, iy = gauss(r) * white * 2;
    const ns = gauss(r), nc = gauss(r);
    const t = s.t;
    const sp = dhypot(s.vx, s.vy);
    const speed = Math.max(0, sp + ns * Number(c.gnss_speed_noise));
    const course = wrap360(datan2(s.vx, s.vy) / DEG + nc * (speed > 0.3 ? 3 : 60));
    const out = c.gnss_outage;
    const valid = k >= Number(c.gnss_ttff) && !(out && out[0] <= t && t <= out[1]);
    const inv = s.inverted;
    this.fixes.push({
      t, x: s.x, y: s.y, ex: this.gerr[0], ey: this.gerr[1], wx, wy, ix, iy, speed, course, valid,
      mx: s.x + this.gerr[0] + wx + (inv ? ix : 0), my: s.y + this.gerr[1] + wy + (inv ? iy : 0),
    });
  }

  /**
   * 今読める GNSS（遅れ 0.3 s・ttff・outage。refsim の gnss と同じ見分け方）。
   * @returns {{valid:boolean, lat:number|null, lon:number|null, speed:number|null, course:number|null, t:number|null, fix?:object}}
   */
  gnss() {
    const s = this.sim, c = this.cfg;
    const t = s.t;
    const k = Math.floor(t - Number(c.gnss_latency) + 1e-9);
    const bad = { valid: false, lat: null, lon: null, speed: null, course: null, t: null };
    if (k < Number(c.gnss_ttff) || k >= this.fixes.length || k < 0) return bad;
    const out = c.gnss_outage;
    if (out && out[0] <= t && t <= out[1]) return bad;
    const f = this.fixes[k];
    // さかさまの追加のばらつきは、読んだ時にさかさまかで決める（refsim と同じ）
    const gx = f.x + f.ex + f.wx + (s.inverted ? f.ix : 0);
    const gy = f.y + f.ey + f.wy + (s.inverted ? f.iy : 0);
    const o = s.origin;
    return {
      valid: true, lat: o.lat + gy / M_PER_DEG_LAT, lon: o.lon + gx / this.mLon,
      speed: f.speed, course: f.course, t: f.t, fix: f, gx, gy,
    };
  }

  /**
   * カメラを撮る（±31.1°・0.15〜20 m・岩に隠れる・miss・false・size の式・さかさまで angle が反対）。
   * 呼んだ時の状態で撮る（0.4 s 進めるのは sim.js）。
   * @returns {{found:boolean, angle:number|null, size:number|null, truth:number|null}}
   */
  camera() {
    const s = this.sim, c = this.cfg, sp = this.spec;
    let found = false, ang = 0, size = 0, truth = null;
    if (s.drop.mode === MODE.GROUND && s.cones.length) {
      const cone = s.cones[0];
      const dx = cone.x - s.x, dy = cone.y - s.y;
      const dist = dhypot(dx, dy);
      const rel = wrap180(datan2(dx, dy) / DEG - s.h / DEG);
      truth = s.inverted ? -rel : rel;
      found = Math.abs(rel) <= sp.camera.hfov / 2 && dist > 0.15 && dist <= Number(c.cam_range);
      if (found) {
        const ux = dx / dist, uy = dy / dist;
        for (const r of s.rocks) {
          if (r.h < sp.camera.height) continue;
          if (rayCircle(s.x, s.y, ux, uy, r.x, r.y, r.r) < dist) { found = false; break; }
        }
      }
      if (found && this.rand() < Number(c.cam_miss)) found = false;
      if (found) {
        ang = rel + gauss(this.rand) * Number(c.cam_angle_noise);
        const vf = sp.camera.vfov * DEG;
        const hc = sp.cone.height, hcam = sp.camera.height;
        size = Math.min(1.0, (datan2(hc - hcam, dist) + datan2(hcam, dist)) / vf);
      } else if (this.rand() < Number(c.cam_false)) {
        const fd = c.cam_false_dir;
        if (fd === null || fd === undefined) {
          found = true;
          ang = -30 + 60 * this.rand();
          size = 0.04;
        } else {
          // 見まちがえやすい物（オレンジの看板など）が、北から fd 度の向きの遠くにある。画面に入っている時だけ見まちがえる
          const relD = wrap180(Number(fd) - s.h / DEG);
          const jit = -2 + 4 * this.rand();
          if (Math.abs(relD) <= sp.camera.hfov / 2) { found = true; ang = relD + jit; size = 0.04; }
        }
      }
      if (s.inverted) ang = -ang;
    }
    if (!found) return { found: false, angle: null, size: null, truth };
    return { found: true, angle: ang, size, truth };
  }

  /**
   * AR マーカー（4 m 以内・画角の中の一番近いもの。angle σ 1°・dist σ 3%）。refsim の marker と同じ。
   * @returns {{found:boolean, id:number|null, angle:number|null, dist:number|null, truthAngle:number|null, truthDist:number|null}}
   */
  marker() {
    const s = this.sim, sp = this.spec;
    let best = null;
    if (s.drop.mode === MODE.GROUND) {
      for (const m of s.markers) {
        const dx = m.x - s.x, dy = m.y - s.y;
        const dist = dhypot(dx, dy);
        const rel = wrap180(datan2(dx, dy) / DEG - s.h / DEG);
        if (dist <= 4.0 && Math.abs(rel) <= sp.camera.hfov / 2 && (best === null || dist < best[0])) best = [dist, rel, m];
      }
    }
    if (best === null) return { found: false, id: null, angle: null, dist: null, truthAngle: null, truthDist: null };
    const [d, rel, m] = best;
    let angle = rel + gauss(this.rand) * 1.0;
    const dist = d * (1 + gauss(this.rand) * 0.03);
    if (s.inverted) angle = -angle;
    return { found: true, id: m.code, angle, dist, truthAngle: s.inverted ? -rel : rel, truthDist: d };
  }

  /** 気圧の高さ（本当の高さ＋σ 0.1 m）。 @returns {{v: number, truth: number}} */
  altitude() {
    const z = this.sim.drop.z;
    return { v: z + gauss(this.rand) * Number(this.cfg.alt_noise), truth: z };
  }

  /** 加速度（段ごと 6.6。地上は (0, 0, ±9.8)＋速さに比例した揺れ。着地の衝撃。±16 g で頭打ち）。refsim の accel と同じ。 @returns {number[]} */
  accel() {
    const s = this.sim, d = s.drop, r = this.rand;
    let ax, ay, az;
    if (d.mode === MODE.CARRIER) {
      ax = gauss(r) * 0.05; ay = gauss(r) * 0.05; az = G0 + gauss(r) * 0.05;
    } else if (d.mode === MODE.FALL) {
      ax = gauss(r) * 0.2; ay = gauss(r) * 0.2; az = gauss(r) * 0.3;
    } else if (d.mode === MODE.DESCENT) {
      ax = gauss(r) * 0.6; ay = gauss(r) * 0.6; az = G0 + gauss(r) * 0.8;
    } else {
      const since = d.impactT !== null ? s.t - d.impactT : 99;
      const sgn = s.inverted ? -1 : 1;
      if (since < DROP_CONST.shockClipS) {
        ax = gauss(r) * 20; ay = gauss(r) * 20; az = SAT * sgn;
      } else if (since < DROP_CONST.shockDecayS) {
        const amp = 60 * dexp(-(since - 0.03) / 0.08);
        ax = gauss(r) * (amp / 2); ay = gauss(r) * (amp / 2); az = sgn * G0 + gauss(r) * amp;
      } else {
        const n = 0.05 + 0.3 * Math.abs(dhypot(s.vx, s.vy));
        ax = gauss(r) * n; ay = gauss(r) * n; az = sgn * G0 + gauss(r) * n;
      }
    }
    const clip = (a) => (a < -SAT ? -SAT : a > SAT ? SAT : a);
    return [clip(ax), clip(ay), clip(az)];
  }
}
