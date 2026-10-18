/**
 * @file app/worker/sim/ground.js
 * 持ち主: W1（シミュレータ）
 * 役割: 地面（全体の ground・砂の区域・坂・池・登れない斜面）の効果を出す。
 * SPEC: 6.3（上り坂の遅れ・横向きの坂で流される）・6.4（地面の表）
 *
 * refsim.py の ground_at・_ground_step の坂の式と同じ計算（53 面の模範解答はこの物理で確かめ済み）:
 *   - 砂の区域に入ると speed に区域の speed（既定 0.6）を掛け、slip は大きい方（既定 0.02）。重なれば掛け合わせる
 *   - 坂の区域は全体の坂より優先（後に書いた区域が勝つ）
 *   - 池の区域は「入った」（pond）。登れない斜面（hill）は sim.js がぶつかる物として扱う
 */

import { pointInShape, shapeBounds, dcos, dsin, DEG } from './geometry.js';

/** 区域を速く調べるための形（区域を囲む四角を先に見る）。 */
function compileArea(a, index) {
  const shape = a.rect ? { rect: a.rect } : a.circle ? { circle: a.circle } : a.poly ? { poly: a.poly } : {};
  const b = shapeBounds(shape);
  return {
    id: a.id ?? `area${index}`, kind: a.kind, shape, x0: b[0], y0: b[1], x1: b[2], y1: b[3],
    speed: a.speed ?? 0.6, slip: a.slip ?? 0.02, deg: Number(a.deg ?? 0), down: Number(a.down ?? 0), src: a,
  };
}

/** 点が区域の中か（囲む四角で先にふるう）。 */
export function inArea(ca, x, y) {
  if (x < ca.x0 || x > ca.x1 || y < ca.y0 || y > ca.y1) return false;
  return pointInShape(ca.shape, x, y);
}

/**
 * 1 つの世界の地面。sim.js が 1 刻みごとに at(x, y) を呼ぶ（物を作らず、自分のフィールドに書く）。
 */
export class Ground {
  /** @param {object} world 世界（6.10） */
  constructor(world) {
    const g = world.ground || {};
    this.baseSpeed = g.speed ?? 1.0;
    this.baseSlip = g.slip ?? 0.0;
    this.baseTurn = g.turn ?? 1.0;
    this.globalSlope = world.slope ? { deg: Number(world.slope.deg ?? 0), down: Number(world.slope.down ?? 0) } : null;
    const areas = (world.objects || []).filter((o) => o && o.type === 'area');
    this.areas = areas.map(compileArea);
    // 地面の効果に関わる区域（砂・坂・池）だけを順に見る
    this.effectAreas = this.areas.filter((a) => a.kind === 'sand' || a.kind === 'slope' || a.kind === 'pond');
    this.hills = this.areas.filter((a) => a.kind === 'hill');
    // at() の答え
    this.speed = this.baseSpeed;
    this.slip = this.baseSlip;
    this.turn = this.baseTurn;
    this.slopeDeg = 0;
    this.slopeDown = 0;
    this.hasSlope = false;
    /** @type {object|null} 入っている池の区域（compileArea の形。.id） */
    this.pond = null;
  }

  /**
   * その場所の地面の効果を調べて、自分のフィールド（speed・slip・turn・hasSlope・slopeDeg・slopeDown・pond）に書く。
   * @param {number} x @param {number} y
   */
  at(x, y) {
    let speed = this.baseSpeed, slip = this.baseSlip;
    let hasSlope = !!this.globalSlope;
    let deg = hasSlope ? this.globalSlope.deg : 0, down = hasSlope ? this.globalSlope.down : 0;
    let pond = null;
    const areas = this.effectAreas;
    for (let i = 0; i < areas.length; i++) {
      const a = areas[i];
      if (!inArea(a, x, y)) continue;
      if (a.kind === 'sand') {
        speed *= a.speed;
        if (a.slip > slip) slip = a.slip;
      } else if (a.kind === 'slope') {
        hasSlope = true; deg = a.deg; down = a.down;
      } else if (a.kind === 'pond') {
        pond = a;
      }
    }
    this.speed = speed; this.slip = slip; this.turn = this.baseTurn;
    this.hasSlope = hasSlope; this.slopeDeg = deg; this.slopeDown = down; this.pond = pond;
    return this;
  }

  /** 登れない斜面の区域に中心が入るか（refsim と同じく機体の中心で見る）。入っていればその区域。 */
  hillAt(x, y) {
    const hs = this.hills;
    for (let i = 0; i < hs.length; i++) if (inArea(hs[i], x, y)) return hs[i];
    return null;
  }
}

/**
 * その場所の地面の効果（Ground を作らずに 1 回だけ調べる時。テストと画面用）。
 * @param {object} world 世界（6.10）
 * @param {number} x @param {number} y
 * @returns {{speed: number, slip: number, turn: number, slope: {deg: number, down: number}|null, pond: string|null, hill: string|null}}
 *   speed・slip・turn は全体の ground と砂の区域を合わせた値。pond・hill は入っている区域の id
 */
export function groundAt(world, x, y) {
  const g = new Ground(world).at(x, y);
  const hill = g.hillAt(x, y);
  return {
    speed: g.speed, slip: g.slip, turn: g.turn,
    slope: g.hasSlope ? { deg: g.slopeDeg, down: g.slopeDown } : null,
    pond: g.pond ? g.pond.id : null, hill: hill ? hill.id : null,
  };
}

/**
 * 上り坂で目標の速さに掛ける数（6.3 の 2。refsim と同じ: up = 坂の度 × cos(向き − 上りの向き)。
 * 進む向き（fwd の符号）と上りが同じ向きなら max(0, 1 − |up| / 13)。13° で止まる）。
 * @param {number} slopeDeg 坂の度 @param {number} downDeg 下りの向き（度） @param {number} headingDeg 機体の向き（度）
 * @param {number} [fwd=1] 進む向きの符号（前へ進むなら正、後ろへなら負。さかさまは反対）
 * @returns {number} 0〜1
 */
export function uphillFactor(slopeDeg, downDeg, headingDeg, fwd = 1) {
  const up = slopeDeg * dcos((headingDeg - (downDeg + 180)) * DEG);
  if ((fwd > 0 && up > 0) || (fwd < 0 && up < 0)) {
    const f = 1 - Math.abs(up) / 13.0;
    return f > 0 ? f : 0;
  }
  return 1;
}

/**
 * 横向きの坂で下り側へ流される回る速さ rad/s（6.3 の 6: 2.0 × 坂の度 × |v| × sin(下りの向き − 向き)、度/s を rad/s に）。
 * @param {number} slopeDeg @param {number} downDeg @param {number} headingDeg @param {number} v 進む速さ m/s
 * @returns {number}
 */
export function slopeYawRate(slopeDeg, downDeg, headingDeg, v) {
  return 2.0 * slopeDeg * Math.abs(v) * dsin((downDeg - headingDeg) * DEG) * DEG;
}
