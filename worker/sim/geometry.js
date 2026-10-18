/**
 * @file app/worker/sim/geometry.js
 * 持ち主: W1（シミュレータ）
 * 役割: ① どのブラウザでも同じ答えになる三角関数・指数・対数（d で始まる関数）
 *       ② 当たり判定と光線の計算・区域の形・緯度経度と m の変換（sim の中だけで使う）。
 * SPEC: 6.1（座標: 東 x・北 y、向きは北 0・時計回り）・6.4（区域の形）・6.5（ぶつかる）・6.7（LiDAR の光線・
 *       〔1.1〕ブラウザによる違い）・6.10（origin）・12 章（3 つのブラウザで同じ記録）
 *
 * ◆ 決めたこと（W1）: JS の Math.sin・cos・atan2・exp・log・hypot は、仕様で「近似でよい」とされていて、
 *   Chrome（V8）・Firefox・Safari で最後の桁が違うことがある（SPEC 6.7〔1.1〕）。sim はこれらを使わず、
 *   下の d〜 の関数だけを使う。中身は fdlibm（FreeBSD の libm）の式を写したもので、使う演算は
 *   + − × ÷ と Math.sqrt・Math.abs・Math.round・Math.trunc（どれも IEEE 754 で答えが 1 つに決まる）だけ。
 *   なので同じ種なら、どのブラウザ・Node でも記録が 1 ビットも違わない（6.9・13.2 W1 ⑩）。
 *   精度は 1 ulp ほど（tests/sim.test.mjs で Math の値と比べて確かめる）。
 */

// ---------------------------------------------------------------- ビットの読み書き
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LITTLE = (() => { F64[0] = 1; return U32[1] === 0x3ff00000; })();
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;
/** 上位 32 ビット（符号つき）。 */
function hiWord(x) { F64[0] = x; return U32[HI] | 0; }
/** 上位 32 ビットを入れかえた数。 */
function withHi(x, hi) { F64[0] = x; U32[HI] = hi >>> 0; return F64[0]; }
/** 2^k（−1022 ≤ k ≤ 1023）。 */
function pow2(k) { U32[HI] = ((0x3ff + k) << 20) >>> 0; U32[LO] = 0; return F64[0]; }

// ---------------------------------------------------------------- 決まった答えの数学（fdlibm）
export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const DEG = PI / 180;

/** √(x² + y²)（Math.hypot はエンジンで答えが違うことがあるので使わない）。 */
export function dhypot(x, y) { return Math.sqrt(x * x + y * y); }

const EXP_P1 = 1.66666666666666019037e-01, EXP_P2 = -2.77777777770155933842e-03,
  EXP_P3 = 6.61375632143793436117e-05, EXP_P4 = -1.65339022054652515390e-06,
  EXP_P5 = 4.13813679705723846039e-08;
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;

/** e^x（fdlibm e_exp.c）。 */
export function dexp(x) {
  if (x !== x) return x;
  if (x > 7.09782712893383973096e+02) return Infinity;
  if (x < -7.45133219101941108420e+02) return 0;
  const ax = Math.abs(x);
  let hi = 0, lo = 0, k = 0;
  if (ax > 0.34657359027997264) {            // |x| > ln2 / 2
    if (ax < 1.0397207708399179) {           // |x| < 1.5 ln2
      if (x > 0) { hi = x - LN2_HI; lo = LN2_LO; k = 1; } else { hi = x + LN2_HI; lo = -LN2_LO; k = -1; }
    } else {
      k = Math.trunc(INV_LN2 * x + (x > 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (ax < 3.725290298461914e-09) {   // |x| < 2^-28
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (EXP_P1 + t * (EXP_P2 + t * (EXP_P3 + t * (EXP_P4 + t * EXP_P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  if (k >= -1021) return k > 1023 ? y * pow2(1023) * pow2(k - 1023) : y * pow2(k);
  return y * pow2(k + 1000) * pow2(-1000);
}

const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01,
  LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01,
  LG7 = 1.479819860511658591e-01;
const TWO54 = 1.80143985094819840000e+16;

/** 自然対数（fdlibm e_log.c）。 */
export function dlog(x) {
  let hx = hiWord(x);
  let k = 0;
  if (hx < 0x00100000) {                     // x < 2^-1022（0・負・非正規化数）
    if (x === 0) return -Infinity;
    if (x < 0 || x !== x) return NaN;
    k -= 54; x *= TWO54; hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i ^ 0x3ff00000));      // x か x/2 を [√2/2, √2) に
  k += i >> 20;
  const f = x - 1;
  const dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {         // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - ((R - dk * LN2_LO) - f);
  }
  const s = f / (2 + f);
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function ksin(x, y, iy) {
  const z = x * x, w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
function kcos(x, y) {
  const z = x * x;
  let w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  w = 1 - hz;
  return w + (((1 - w) - hz) + (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
let RY0 = 0, RY1 = 0;
/** x を n × π/2 ＋ (RY0 + RY1) に分ける（fdlibm e_rem_pio2.c の中くらいの大きさの道）。n を返す。 */
function remPio2(x) {
  if (!(Math.abs(x) < 1.6e6)) {
    // とても大きい角度（sim では起きない）。答えは粗いが、どのエンジンでも同じ。
    if (x !== x || x === Infinity || x === -Infinity) { RY0 = NaN; RY1 = 0; return 0; }
    x -= Math.round(x / TWO_PI) * TWO_PI;
  }
  const fn = Math.round(x * INV_PIO2);
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T;
  const j = (hiWord(x) >> 20) & 0x7ff;
  RY0 = r - w;
  let i = j - ((hiWord(RY0) >> 20) & 0x7ff);
  if (i > 16) {
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    RY0 = r - w;
    i = j - ((hiWord(RY0) >> 20) & 0x7ff);
    if (i > 49) {
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      RY0 = r - w;
    }
  }
  RY1 = (r - RY0) - w;
  return fn;
}

/** sin（fdlibm s_sin.c）。 */
export function dsin(x) {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) {            // |x| ≤ π/4
    if (ax < 7.450580596923828e-09) return x; // 2^-27
    return ksin(x, 0, 0);
  }
  const n = remPio2(x) & 3;
  if (n === 0) return ksin(RY0, RY1, 1);
  if (n === 1) return kcos(RY0, RY1);
  if (n === 2) return -ksin(RY0, RY1, 1);
  return -kcos(RY0, RY1);
}

/** cos（fdlibm s_cos.c）。 */
export function dcos(x) {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) {
    if (ax < 7.450580596923828e-09) return 1;
    return kcos(x, 0);
  }
  const n = remPio2(x) & 3;
  if (n === 0) return kcos(RY0, RY1);
  if (n === 1) return -ksin(RY0, RY1, 1);
  if (n === 2) return -kcos(RY0, RY1);
  return ksin(RY0, RY1, 1);
}

/** sin と cos を一度に（[sin, cos] を out に書く。物を作らないので速い）。 */
export function dsincos(x, out) {
  const ax = Math.abs(x);
  if (ax <= 0.7853981633974483) {
    if (ax < 7.450580596923828e-09) { out[0] = x; out[1] = 1; return out; }
    out[0] = ksin(x, 0, 0); out[1] = kcos(x, 0); return out;
  }
  const n = remPio2(x) & 3;
  const s = ksin(RY0, RY1, 1), c = kcos(RY0, RY1);
  if (n === 0) { out[0] = s; out[1] = c; } else if (n === 1) { out[0] = c; out[1] = -s; } else if (n === 2) { out[0] = -s; out[1] = -c; } else { out[0] = -c; out[1] = s; }
  return out;
}

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT0 = 3.33333333333329318027e-01, AT1 = -1.99999999998764832476e-01, AT2 = 1.42857142725034663711e-01,
  AT3 = -1.11111104054623557880e-01, AT4 = 9.09088713343650656196e-02, AT5 = -7.69187620504482999495e-02,
  AT6 = 6.66107313738753120669e-02, AT7 = -5.83357013379057348645e-02, AT8 = 4.97687799461593236017e-02,
  AT9 = -3.65315727442169155270e-02, AT10 = 1.62858201153657823623e-02;

/** atan（fdlibm s_atan.c）。 */
export function datan(x) {
  if (x !== x) return x;
  const neg = x < 0;
  let ax = Math.abs(x);
  if (ax >= 7.378697629483821e19) {          // 2^66
    const z = ATAN_HI[3] + ATAN_LO[3];
    return neg ? -z : z;
  }
  let id;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-09) return x;
    id = -1;
    ax = x;                                    // 符号つきのまま
  } else if (ax < 1.1875) {
    if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); } else { id = 1; ax = (ax - 1) / (ax + 1); }
  } else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); } else { id = 3; ax = -1 / ax; }
  const z = ax * ax, w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return ax - ax * (s1 + s2);
  const r = ATAN_HI[id] - ((ax * (s1 + s2) - ATAN_LO[id]) - ax);
  return neg ? -r : r;
}

const PI_LO = 1.2246467991473531772e-16, PI_O_2 = 1.5707963267948965580e+00, PI_O_4 = 7.8539816339744827900e-01;

/** atan2(y, x)（fdlibm e_atan2.c）。 */
export function datan2(y, x) {
  if (x !== x || y !== y) return x + y;
  if (x === 1) return datan(y);
  const yneg = y < 0 || Object.is(y, -0);
  const xneg = x < 0 || Object.is(x, -0);
  const m = (yneg ? 1 : 0) | (xneg ? 2 : 0);
  if (y === 0) {
    if (m === 0 || m === 1) return y;
    return m === 2 ? PI : -PI;
  }
  if (x === 0) return yneg ? -PI_O_2 : PI_O_2;
  if (x === Infinity || x === -Infinity) {
    if (y === Infinity || y === -Infinity) return [PI_O_4, -PI_O_4, 3 * PI_O_4, -3 * PI_O_4][m];
    return [0, -0, PI, -PI][m];
  }
  if (y === Infinity || y === -Infinity) return yneg ? -PI_O_2 : PI_O_2;
  const q = Math.abs(y / x);
  let z;
  let mm = m;
  if (q > 1.152921504606847e18) { z = PI_O_2 + 0.5 * PI_LO; mm &= 1; } // |y/x| > 2^60
  else if (xneg && q < 8.673617379884035e-19) z = 0;                     // |y/x| < 2^-60
  else z = datan(q);
  if (mm === 0) return z;
  if (mm === 1) return -z;
  if (mm === 2) return PI - (z - PI_LO);
  return (z - PI_LO) - PI;
}

/** 角度（度）を −180 以上 180 未満に。 */
export function wrap180(a) {
  let r = (a + 180) % 360;
  if (r < 0) r += 360;
  return r - 180;
}
/** 角度（度）を 0 以上 360 未満に（Python の % と同じ）。 */
export function wrap360(a) {
  let r = a % 360;
  if (r < 0) r += 360;
  if (r >= 360) r -= 360;
  return r;
}
/** 角度（rad）を 0 以上 2π 未満に（Python の % と同じ）。 */
export function wrap2pi(a) {
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  if (r >= TWO_PI) r -= TWO_PI;
  return r;
}

// ---------------------------------------------------------------- 緯度経度
/** 北 1° の長さ m（6.10）。 */
export const M_PER_DEG_LAT = 110950;
/** 東 1° の長さ m（緯度で変わる。111320 × cos(緯度)、6.10）。 @param {number} latDeg @returns {number} */
export function mPerDegLon(latDeg) { return 111320 * dcos(latDeg * DEG); }

/** 世界の x, y（m）を緯度経度に。 @param {{lat:number, lon:number}} origin @param {number} x @param {number} y @returns {{lat:number, lon:number}} */
export function xyToLatLon(origin, x, y) {
  return { lat: origin.lat + y / M_PER_DEG_LAT, lon: origin.lon + x / mPerDegLon(origin.lat) };
}
/** 緯度経度を世界の x, y（m）に。 @param {{lat:number, lon:number}} origin @param {number} lat @param {number} lon @returns {{x:number, y:number}} */
export function latLonToXY(origin, lat, lon) {
  return { x: (lon - origin.lon) * mPerDegLon(origin.lat), y: (lat - origin.lat) * M_PER_DEG_LAT };
}

// ---------------------------------------------------------------- 光線と当たり
/**
 * 光線（点 o・単位方向 d）と円の一番近い交点までの距離（円の中から撃ったら 0、当たらなければ Infinity）。
 * refsim の ray_circle と同じ。
 */
export function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx, fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = -b - s;
  if (t1 >= 0) return t1;
  return -b + s >= 0 ? 0 : Infinity;
}

/** 光線と線分の交点までの距離（当たらなければ Infinity）。refsim の ray_seg と同じ。 */
export function raySeg(ox, oy, dx, dy, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const qx = x1 - ox, qy = y1 - oy;
  const t = (qx * ey - qy * ex) / den;
  const u = (qx * dy - qy * dx) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/**
 * 光線（点 o から向き h）と円の一番近い交点までの距離。当たらなければ null。
 * @param {number} ox @param {number} oy @param {number} hRad 向き（北 0・時計回り、rad）
 * @param {number} cx @param {number} cy @param {number} r
 * @returns {number|null}
 */
export function rayToCircle(ox, oy, hRad, cx, cy, r) {
  const d = rayCircle(ox, oy, dsin(hRad), dcos(hRad), cx, cy, r);
  return d === Infinity ? null : d;
}

/** 光線と線分（壁）の交点までの距離。当たらなければ null。 @returns {number|null} */
export function rayToSegment(ox, oy, hRad, x1, y1, x2, y2) {
  const d = raySeg(ox, oy, dsin(hRad), dcos(hRad), x1, y1, x2, y2);
  return d === Infinity ? null : d;
}

/** 点と線分の距離 m（壁との当たり・max_offset に使う）。refsim の pt_seg と同じ。 @returns {number} */
export function distToSegment(px, py, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const L2 = ex * ex + ey * ey || 1e-12;
  let u = ((px - x1) * ex + (py - y1) * ey) / L2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return dhypot(px - (x1 + u * ex), py - (y1 + u * ey));
}

/**
 * 点が区域の形の中か（6.4: rect [x0, y0, x1, y1]・circle [cx, cy, r]・poly [[x, y], …] のどれか）。refsim の in_area と同じ。
 * @param {{rect?: number[], circle?: number[], poly?: number[][]}} shape
 * @param {number} x @param {number} y
 * @returns {boolean}
 */
export function pointInShape(shape, x, y) {
  if (shape.rect) {
    const [x0, y0, x1, y1] = shape.rect;
    return Math.min(x0, x1) <= x && x <= Math.max(x0, x1) && Math.min(y0, y1) <= y && y <= Math.max(y0, y1);
  }
  if (shape.circle) {
    const [cx, cy, r] = shape.circle;
    return dhypot(x - cx, y - cy) <= r;
  }
  if (shape.poly) {
    const p = shape.poly;
    let ins = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) ins = !ins;
    }
    return ins;
  }
  return false;
}

/** 形を囲む四角 [x0, y0, x1, y1]（当たりの前の早い見分けに使う）。 */
export function shapeBounds(shape) {
  if (shape.rect) {
    const [x0, y0, x1, y1] = shape.rect;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
  if (shape.circle) {
    const [cx, cy, r] = shape.circle;
    return [cx - r, cy - r, cx + r, cy + r];
  }
  if (shape.poly && shape.poly.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of shape.poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }
  return [Infinity, Infinity, -Infinity, -Infinity];
}

/** 円（機体）と区域の形が重なるか。 @returns {boolean} */
export function circleHitsShape(shape, cx, cy, r) {
  if (pointInShape(shape, cx, cy)) return true;
  if (shape.rect) {
    const [x0, y0, x1, y1] = shapeBounds(shape);
    const qx = cx < x0 ? x0 : cx > x1 ? x1 : cx;
    const qy = cy < y0 ? y0 : cy > y1 ? y1 : cy;
    return dhypot(cx - qx, cy - qy) < r;
  }
  if (shape.circle) return dhypot(cx - shape.circle[0], cy - shape.circle[1]) < r + shape.circle[2];
  if (shape.poly) {
    const p = shape.poly;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if (distToSegment(cx, cy, p[j][0], p[j][1], p[i][0], p[i][1]) < r) return true;
    }
  }
  return false;
}
