/**
 * @file app/js/replay/player.js
 * 持ち主: W5（3D と再生）
 * 役割: 記録の再生（時刻を進める・止める・飛ぶ・コマ送り・行ごと）。3D・つまみ・エディタの今の行がこれに合わせて動く。
 * SPEC: 7.3「W5 js/replay/*」・2.4 の 5（再生）・3.4「時間のつまみ」・6.11（RunRecord）
 *
 * three を使わない（Node のテストでも動く）。記録の読み方（normalizeRecord・sampleFrame・lineAt）もここに置き、
 * scene.js・timeline.js・graphs.js が同じものを使う。
 *
 * 時刻は 2 つある:
 *   - sim の時刻 t（記録の秒。つまみ・HUD・グラフはこちら）
 *   - 見せる時刻 d（画面で実際に流れる秒）。速さ・行ごと・早送りは「d → t の折れ線（schedule）」で表す。
 */

/** 選べる速さ（3.4）。'line' は行ごと、'result' は結果だけ。 */
export const SPEEDS = Object.freeze([0.25, 0.5, 1, 2, 4, 8, 16]);
/** 行ごとの再生で 1 行に足す見せる時間 s（tech_spike 3.7・3.4）。 */
export const LINE_HOLD_S = 0.3;
/** 〔1.1〕これより長くなる再生は速さを自動で上げる（2.4 の 5）。 */
export const MAX_REPLAY_S = 40;
/** 早送りする「何も起きない区間」の最短の長さ s と、その区間の見せる時間 s。 */
export const IDLE_MIN_S = 2.0;
export const IDLE_SHOW_S = 0.5;
/** 記録のコマの間隔 s（6.11: 50 Hz）。1 コマ送りに使う。 */
export const FRAME_DT = 0.02;

/** 6.11 の 14 項目。 */
export const FRAME_FIELDS = Object.freeze(['t', 'x', 'y', 'h', 'v', 'wl', 'wr', 'cmdL', 'cmdR', 'z', 'mode', 'inv', 'cx', 'cy']);
const WHEEL_R = 0.127 / 2;
/** センサを読むイベント（早送りの区間を切らない）。 */
const SENSOR_KINDS = new Set(['lidar', 'heading', 'gnss', 'camera', 'marker', 'altitude', 'accel', 'odometer', 'encoder', 'now']);

const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;

/** 数の並びを Float32Array に（JSON の null は NaN に）。 */
function toF32(arr) {
  if (arr instanceof Float32Array) return arr;
  if (arr && arr.buffer instanceof ArrayBuffer && !Array.isArray(arr)) return new Float32Array(arr);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; out[i] = v === null || v === undefined ? NaN : v; }
  return out;
}

/** 二分探索: a[i] <= x となる最後の i（無ければ -1）。 */
export function lastLE(a, x, n = a.length) {
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= x) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/**
 * @typedef {object} NormRecord 読みやすくした記録（normalizeRecord の戻り値）
 * @property {object} rec 元の記録
 * @property {number} n コマの数
 * @property {Object<string, Float32Array>} col 項目ごとの列（t・x・y・h・v・wl・wr・cmdL・cmdR・z・mode・inv・cx・cy）
 * @property {Float64Array} hu ほどいた向き（度。補間用）
 * @property {Float64Array} angL 左の車輪の回った角度（rad）
 * @property {Float64Array} angR
 * @property {number} T 最後のコマの時刻 s
 * @property {number} programEndT プログラムが終わった時刻 s
 * @property {Array<[number, number, number, string]>} segments 時刻順の区間
 * @property {Float64Array} segT0
 * @property {Int32Array} logLines
 * @property {Float64Array} logTimes
 * @property {boolean} logTruncated
 * @property {object[]} events 時刻のあるイベント（時刻順）
 * @property {Object<string, object[]>} byKind 種類ごとのイベント
 */

/**
 * 記録（6.11）を読みやすい形にする。何度呼んでも同じもの（記録に隠して持つ）。
 * frames は Float32Array・数の配列（null は NaN）・行の配列のどれでもよい。項目が足りない記録（spike の 8 項目など）も読む。
 * @param {object} rec RunRecord
 * @returns {NormRecord}
 */
export function normalizeRecord(rec) {
  if (!rec) throw new Error('記録がありません');
  if (rec.__norm) return rec.__norm;
  const fields = Array.isArray(rec.fields) && rec.fields.length ? rec.fields : FRAME_FIELDS;
  let flat = rec.frames || [];
  if (Array.isArray(flat) && flat.length && Array.isArray(flat[0])) flat = flat.flat();
  const f32 = toF32(flat);
  const F = fields.length;
  const n = Math.floor(f32.length / F);
  const col = {};
  const idx = Object.fromEntries(fields.map((k, i) => [k, i]));
  const pick = (name, fallback) => {
    const out = new Float32Array(Math.max(n, 1));
    const j = idx[name];
    for (let i = 0; i < n; i++) out[i] = j === undefined ? fallback(i) : f32[i * F + j];
    return out;
  };
  col.t = pick('t', (i) => i * FRAME_DT);
  col.x = pick('x', () => 0);
  col.y = pick('y', () => 0);
  col.h = pick('h', () => 0);
  col.wl = idx.wl !== undefined ? pick('wl', () => 0) : pick('vl', () => 0);
  col.wr = idx.wr !== undefined ? pick('wr', () => 0) : pick('vr', () => 0);
  col.v = idx.v !== undefined ? pick('v', () => 0) : (() => { const o = new Float32Array(Math.max(n, 1)); for (let i = 0; i < n; i++) o[i] = (col.wl[i] + col.wr[i]) / 2; return o; })();
  col.cmdL = pick('cmdL', () => 0);
  col.cmdR = pick('cmdR', () => 0);
  col.z = pick('z', () => 0);
  col.mode = pick('mode', () => 0);
  col.inv = pick('inv', () => 0);
  col.cx = pick('cx', () => NaN);
  col.cy = pick('cy', () => NaN);
  if (n === 0) { // コマが無い記録（書き方のエラーなど）: スタートの 1 コマを作る
    for (const k of Object.keys(col)) col[k][0] = (k === 'cx' || k === 'cy') ? NaN : 0;
  }
  const N = Math.max(n, 1);
  // ほどいた向き・車輪の角度
  const hu = new Float64Array(N);
  const angL = new Float64Array(N), angR = new Float64Array(N);
  hu[0] = col.h[0];
  for (let i = 1; i < N; i++) {
    hu[i] = hu[i - 1] + wrap180(col.h[i] - col.h[i - 1]);
    const dt = col.t[i] - col.t[i - 1];
    angL[i] = angL[i - 1] + (col.wl[i - 1] + col.wl[i]) / 2 * dt / WHEEL_R;
    angR[i] = angR[i - 1] + (col.wr[i - 1] + col.wr[i]) / 2 * dt / WHEEL_R;
  }
  const T = col.t[N - 1];
  const programEndT = Number.isFinite(rec.programEndT) ? Math.min(rec.programEndT, T) : T;
  const segments = (rec.segments || []).filter((s) => Array.isArray(s) && s.length >= 3 && Number.isFinite(s[1]) && Number.isFinite(s[2]))
    .map((s) => [s[0] | 0, +s[1], +s[2], String(s[3] || 'wait')]).sort((a, b) => a[1] - b[1]);
  const segT0 = Float64Array.from(segments, (s) => s[1]);
  const ll = rec.lineLog || [[], []];
  const logLines = Int32Array.from(ll[0] || []);
  const logTimes = Float64Array.from(ll[1] || [], (v) => +v);
  const logCap = (rec.limits && rec.limits.logCap) || 20000;
  const logTruncated = logLines.length >= logCap;
  const events = (rec.events || []).filter((e) => e && Number.isFinite(e.t)).slice().sort((a, b) => a.t - b.t);
  const byKind = {};
  for (const e of events) (byKind[e.k] || (byKind[e.k] = [])).push(e);
  const norm = { rec, n: N, col, hu, angL, angR, T, programEndT, segments, segT0, logLines, logTimes, logTruncated, events, byKind };
  try { Object.defineProperty(rec, '__norm', { value: norm, enumerable: false, configurable: true }); } catch { /* 凍った記録は毎回作る */ }
  return norm;
}

/**
 * その時刻の姿（コマを補間）。向きは 0〜360 度、mode・inv は前のコマの値、パラの位置は無ければ NaN。
 * @param {NormRecord} N @param {number} t sim 秒 @param {object} [out] 使い回す入れ物
 * @returns {{t: number, x: number, y: number, h: number, v: number, wl: number, wr: number, cmdL: number, cmdR: number,
 *   z: number, mode: number, inv: number, cx: number, cy: number, angL: number, angR: number, i: number}}
 */
export function sampleFrame(N, t, out = {}) {
  const c = N.col;
  const tc = Math.max(c.t[0], Math.min(N.T, t));
  // 時刻の列は Float32 のことがある（Worker から）。コマの時刻ちょうどを聞かれたらそのコマにする（1 µs の余裕）
  let i = lastLE(c.t, tc + 1e-6, N.n);
  if (i < 0) i = 0;
  const j = Math.min(N.n - 1, i + 1);
  const span = c.t[j] - c.t[i];
  const a = j > i && span > 0 ? Math.max(0, Math.min(1, (tc - c.t[i]) / span)) : 0;
  const L = (k) => c[k][i] + (c[k][j] - c[k][i]) * a;
  out.t = tc; out.i = i; out.a = a;
  out.x = L('x'); out.y = L('y'); out.z = L('z'); out.v = L('v');
  out.wl = L('wl'); out.wr = L('wr'); out.cmdL = c.cmdL[i]; out.cmdR = c.cmdR[i];
  const hu = N.hu[i] + (N.hu[j] - N.hu[i]) * a;
  out.h = ((hu % 360) + 360) % 360;
  out.mode = c.mode[i]; out.inv = c.inv[i];
  const cxi = c.cx[i], cxj = c.cx[j];
  if (Number.isFinite(cxi) && Number.isFinite(cxj)) { out.cx = L('cx'); out.cy = L('cy'); } else { out.cx = cxi; out.cy = c.cy[i]; }
  out.angL = N.angL[i] + (N.angL[j] - N.angL[i]) * a;
  out.angR = N.angR[i] + (N.angR[j] - N.angR[i]) * a;
  return out;
}

/**
 * その時刻に光らせる行（1 から）。プログラムが終わった後（惰性の 3 s）は null。
 * 時間が進んだ区間（segments）の中ならその行、そうでなければ lineLog でその時刻までに最後に動いた行。
 * @param {NormRecord} N @param {number} t
 * @returns {number|null}
 */
export function lineAt(N, t) {
  if (t > N.programEndT + 1e-6) return null;
  const k = lastLE(N.segT0, t);
  if (k >= 0) {
    const s = N.segments[k];
    if (t < s[2] - 1e-9) return s[0] || null;
  }
  const m = lastLE(N.logTimes, t + 1e-9);
  if (m >= 0) {
    if (N.logTruncated && m === N.logLines.length - 1 && k >= 0 && N.segments[k][1] > N.logTimes[m]) return N.segments[k][0] || null;
    return N.logLines[m] || null;
  }
  return null;
}

/**
 * 何も起きない区間（つり下げの待ち・止まって wait しているだけ）を探す。2.4 の 5〔1.1〕。
 * センサを読むだけのイベントは区間を切らない。ほかのイベント（着地・分離・接触・フェーズなど）の前後 0.3 s は残す。
 * @param {NormRecord} N
 * @returns {Array<[number, number]>} [始め, 終わり] の並び
 */
export function findIdle(N) {
  const c = N.col;
  const out = [];
  const marks = N.events.filter((e) => !SENSOR_KINDS.has(e.k) && e.k !== 'motor').map((e) => e.t);
  for (const p of (N.rec.prints || [])) marks.push(+p[0]);
  marks.sort((a, b) => a - b);
  const quiet = (i) => c.mode[i] === 1 || (c.mode[i] === 0 && Math.abs(c.v[i]) < 0.005 && Math.abs(c.wl[i]) < 0.005 &&
    Math.abs(c.wr[i]) < 0.005 && Math.abs(c.cmdL[i]) < 0.08 && Math.abs(c.cmdR[i]) < 0.08);
  let s = -1;
  const flush = (i0, i1) => {
    let a = c.t[i0], b = c.t[i1];
    // 目立つイベントで区間を切る
    let cur = a;
    for (const m of marks) {
      if (m < cur - 0.3 || m > b + 0.3) continue;
      if (m - 0.3 - cur >= IDLE_MIN_S) out.push([cur, m - 0.3]);
      cur = Math.max(cur, m + 0.3);
    }
    if (b - cur >= IDLE_MIN_S) out.push([cur, b]);
  };
  for (let i = 0; i < N.n; i++) {
    if (quiet(i)) { if (s < 0) s = i; } else if (s >= 0) { if (c.t[i - 1] - c.t[s] >= IDLE_MIN_S) flush(s, i - 1); s = -1; }
  }
  if (s >= 0 && c.t[N.n - 1] - c.t[s] >= IDLE_MIN_S) flush(s, N.n - 1);
  return out;
}

/**
 * @typedef {object} Schedule 見せる時刻 d → sim の時刻 t の折れ線
 * @property {Array<{d0: number, d1: number, s0: number, s1: number, line?: number|null, idle?: boolean}>} pieces
 * @property {number} total 見せる時間の合計 s
 * @property {number|'line'|'result'} speed 選んだ速さ
 * @property {number} used 実際に使う速さ（自動で上げた時はその値）
 * @property {boolean} auto 自動で速さを上げた・早送りを入れた
 * @property {number} idleCount 早送りした区間の数
 * @property {number} hold 行ごとの 1 行の見せる時間 s
 */

/**
 * 速さから「見せる時刻 → sim の時刻」の折れ線を作る。
 * @param {NormRecord} N
 * @param {number|'line'|'result'} speed
 * @param {{autoFit?: boolean, maxS?: number}} [opts]
 * @returns {Schedule}
 */
export function buildSchedule(N, speed, { autoFit = true, maxS = MAX_REPLAY_S } = {}) {
  const T = N.T;
  if (speed === 'result') return { pieces: [{ d0: 0, d1: 0, s0: T, s1: T, line: null }], total: 0, speed, used: Infinity, auto: false, idleCount: 0, hold: 0 };
  if (speed === 'line') return lineSchedule(N, maxS, autoFit);
  const s = Number(speed) > 0 ? Number(speed) : 1;
  const plain = { pieces: [{ d0: 0, d1: T / s, s0: 0, s1: T }], total: T / s, speed: s, used: s, auto: false, idleCount: 0, hold: 0 };
  if (!autoFit || T / s <= maxS) return plain;
  // 長い走行: 何も起きない区間を早送りし、残りの速さを上げて maxS 以内に収める
  const idle = findIdle(N);
  const idleSum = idle.reduce((a, [p, q]) => a + (q - p), 0);
  const active = T - idleSum;
  const room = maxS - idle.length * IDLE_SHOW_S;
  let used = s;
  if (room > 0) {
    const need = active / room;
    used = SPEEDS.find((v) => v >= s && v >= need - 1e-9) || Math.max(s, Math.ceil(need));
  } else used = Math.max(s, 16);
  const pieces = [];
  let d = 0, cur = 0;
  for (const [p, q] of idle) {
    if (p > cur) { const dd = (p - cur) / used; pieces.push({ d0: d, d1: d + dd, s0: cur, s1: p }); d += dd; }
    const dd = Math.min(IDLE_SHOW_S, (q - p) / used);
    pieces.push({ d0: d, d1: d + dd, s0: p, s1: q, idle: true }); d += dd; cur = q;
  }
  if (T > cur) { const dd = (T - cur) / used; pieces.push({ d0: d, d1: d + dd, s0: cur, s1: T }); d += dd; }
  return { pieces, total: d, speed: s, used, auto: true, idleCount: idle.length, hold: 0 };
}

function lineSchedule(N, maxS, autoFit) {
  const lines = N.logLines, times = N.logTimes;
  const M = lines.length;
  const endP = N.programEndT, T = N.T;
  // 行が多すぎて 1 行ずつでは見せきれない時（くり返しの多い面）は、ふつうの速さに切りかえる（fallback）
  if (M === 0 || (autoFit && M * 0.05 > maxS * 0.5)) {
    const b = buildSchedule(N, 1, { autoFit, maxS });
    return { ...b, speed: 'line', fallback: true };
  }
  const simPart = endP;                 // プログラムの間は ×1
  const tail = T - endP;                // 惰性
  let hold = LINE_HOLD_S;
  let rate = 1;                         // sim を進める速さ
  if (autoFit) {
    const over = M * hold + simPart + tail;
    if (over > maxS) {
      hold = Math.max(0.03, (maxS - Math.min(simPart + tail, maxS * 0.5)) / M);
      const rest = maxS - M * hold;
      if (simPart + tail > rest) rate = SPEEDS.find((v) => v >= (simPart + tail) / Math.max(rest, 1)) || Math.ceil((simPart + tail) / Math.max(rest, 1));
    }
  }
  const pieces = [];
  const starts = [];                    // 各行の始まりの見せる時刻（1 行送りに使う）
  let d = 0;
  for (let i = 0; i < M; i++) {
    const t0 = Math.max(0, times[i]);
    const t1 = i + 1 < M ? Math.max(t0, times[i + 1]) : (N.logTruncated ? t0 : Math.max(t0, endP));
    starts.push(d);
    pieces.push({ d0: d, d1: d + hold, s0: t0, s1: t0, line: lines[i] }); d += hold;
    if (t1 > t0) { const dd = (t1 - t0) / rate; pieces.push({ d0: d, d1: d + dd, s0: t0, s1: t1, line: lines[i] }); d += dd; }
  }
  // 記録が 2 万行で切れていたら、その後は区間から行を出す（line を書かない）
  const tLast = pieces.length ? pieces[pieces.length - 1].s1 : 0;
  if (endP > tLast) { const dd = (endP - tLast) / rate; pieces.push({ d0: d, d1: d + dd, s0: tLast, s1: endP }); d += dd; }
  if (T > endP) { const dd = (T - endP) / rate; pieces.push({ d0: d, d1: d + dd, s0: endP, s1: T, line: null }); d += dd; }
  return { pieces, starts, total: d, speed: 'line', used: rate, auto: autoFit && (hold < LINE_HOLD_S || rate > 1), idleCount: 0, hold };
}

/** 見せる時刻 d の piece の番号。 */
function pieceAtD(S, d) {
  const P = S.pieces;
  let lo = 0, hi = P.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].d0 <= d) lo = m; else hi = m - 1; }
  return lo;
}

/** d → { t, line（行ごとの時だけ） } */
export function mapD(S, d) {
  const P = S.pieces;
  if (!P.length) return { t: 0, k: 0 };
  const k = pieceAtD(S, Math.max(0, Math.min(S.total, d)));
  const p = P[k];
  const a = p.d1 > p.d0 ? Math.max(0, Math.min(1, (d - p.d0) / (p.d1 - p.d0))) : 1;
  return { t: p.s0 + (p.s1 - p.s0) * a, k, line: p.line };
}

/** sim の時刻 t → 見せる時刻 d（同じ t の piece が多い時は最初のもの）。 */
export function mapT(S, t) {
  const P = S.pieces;
  for (let k = 0; k < P.length; k++) {
    const p = P[k];
    if (t <= p.s1 + 1e-9 || k === P.length - 1) {
      if (p.s1 <= p.s0) return p.d0;
      const a = Math.max(0, Math.min(1, (t - p.s0) / (p.s1 - p.s0)));
      return p.d0 + (p.d1 - p.d0) * a;
    }
  }
  return S.total;
}

function defaultClock() {
  const g = globalThis;
  const now = () => (g.performance ? g.performance.now() : Date.now());
  if (typeof g.requestAnimationFrame === 'function') {
    return { now, raf: (f) => g.requestAnimationFrame(f), caf: (id) => g.cancelAnimationFrame(id) };
  }
  return { now, raf: (f) => setTimeout(() => f(now()), 16), caf: (id) => clearTimeout(id) };
}

/**
 * 再生の速さ: 0.25・0.5・1・2・4・〔1.1〕8・16、'line'（行ごと: 1 行に最低 0.3 s の見せる時間を足す）、'result'（結果だけ）。
 * 〔1.1〕再生が 40 s より長くなる走行は速さを自動で上げて 40 s 以内に収め、何も起きない区間（つり下げの待ち・止まって wait）は早送り。
 *
 * 出来事: 'time'（sim の時刻）・'line'（今の行。無い時は null）・'end'・'state'（再生中か）・'speed'（速さが変わった）。
 */
export class Player {
  /**
   * @param {import('../../worker/engine.js').RunRecord} record
   * @param {{speed?: number|'line'|'result', lineByLine?: boolean, autoFit?: boolean, maxS?: number,
   *          clock?: {now: () => number, raf: (f: Function) => any, caf: (id: any) => void}}} [opts]
   */
  constructor(record, { speed = 1, lineByLine = false, autoFit = true, maxS = MAX_REPLAY_S, clock } = {}) {
    this.record = record;
    this.opts = { speed: lineByLine ? 'line' : speed, lineByLine, autoFit, maxS };
    this.N = normalizeRecord(record);
    this.clock = clock || defaultClock();
    this._fns = { time: new Set(), line: new Set(), end: new Set(), state: new Set(), speed: new Set() };
    this._raf = null;
    this._playing = false;
    this._d = 0;
    this._t = 0;
    this._line = undefined;
    this._ended = false;
    this._rebuild();
  }

  _rebuild() {
    this.schedule = buildSchedule(this.N, this.opts.speed, { autoFit: this.opts.autoFit, maxS: this.opts.maxS });
  }

  /** sim の時刻 s */ get t() { return this._t; }
  /** 記録の長さ（最後のコマの時刻）s */ get duration() { return this.N.T; }
  /** プログラムが終わった時刻 s */ get programEndT() { return this.N.programEndT; }
  /** 見せる時間の合計 s */ get displayDuration() { return this.schedule.total; }
  /** 再生中か */ get playing() { return this._playing; }
  /** 今の速さ（選んだもの） */ get speed() { return this.opts.speed; }
  /** 今の行（無い時は null） */ get line() { return this._line === undefined ? null : this._line; }
  /** 終わりまで来たか */ get ended() { return this._ended; }

  /**
   * 出来事を受ける: 'time'（t）・'line'（今の行 n）・'end'。
   * @param {'time'|'line'|'end'|'state'|'speed'} name @param {(v?: any) => void} fn
   * @returns {() => void} 外す関数
   */
  on(name, fn) {
    const s = this._fns[name];
    if (!s) throw new Error(`知らない出来事: ${name}`);
    s.add(fn);
    return () => s.delete(fn);
  }

  _emit(name, v) { for (const fn of [...this._fns[name]]) { try { fn(v); } catch (e) { console.error(e); } } }

  _apply(d, { force = false } = {}) {
    const S = this.schedule;
    this._d = Math.max(0, Math.min(S.total, d));
    const m = mapD(S, this._d);
    const t = m.t;
    const line = m.line !== undefined ? m.line : lineAt(this.N, t);
    if (force || t !== this._t) { this._t = t; this._emit('time', t); }
    if (force || line !== this._line) { this._line = line; this._emit('line', line); }
  }

  /** 再生する（終わりにいれば最初から）。 */
  play() {
    if (this._playing) return;
    if (this.opts.speed === 'result') { this.toEnd(); return; }
    if (this._d >= this.schedule.total - 1e-9) { this._apply(0, { force: true }); }
    this._ended = false;
    this._playing = true;
    this._emit('state', true);
    let last = this.clock.now();
    const tick = (now) => {
      if (!this._playing) return;
      const n = typeof now === 'number' ? now : this.clock.now();
      const dt = Math.max(0, Math.min(0.1, (n - last) / 1000));   // 裏のタブから戻った時に飛ばない
      last = n;
      this._apply(this._d + dt);
      if (this._d >= this.schedule.total - 1e-9) { this._finish(); return; }
      this._raf = this.clock.raf(tick);
    };
    this._raf = this.clock.raf(tick);
  }

  _finish() {
    this._playing = false;
    if (this._raf !== null) { this.clock.caf(this._raf); this._raf = null; }
    this._emit('state', false);
    if (!this._ended) { this._ended = true; this._emit('end'); }
  }

  /** 一時停止。 */
  pause() {
    if (!this._playing) return;
    this._playing = false;
    if (this._raf !== null) { this.clock.caf(this._raf); this._raf = null; }
    this._emit('state', false);
  }

  /** 再生と一時停止を入れかえる（Space）。 */
  toggle() { if (this._playing) this.pause(); else this.play(); }

  /**
   * その時刻へ飛ぶ。行ごとの再生で line を渡すと、その時刻のその行の所へ（行の帯を押した時。同じ時刻に行がいくつもあるため）。
   * @param {number} t sim 秒 @param {number} [line]
   */
  seek(t, line) {
    const tc = Math.max(0, Math.min(this.N.T, Number(t) || 0));
    this._ended = false;
    if (line && this.schedule.speed === 'line') {
      const P = this.schedule.pieces;
      for (const p of P) {
        if (p.line === line && p.s0 <= tc + 1e-9 && tc <= p.s1 + 1e-9) {
          const a = p.s1 > p.s0 ? (tc - p.s0) / (p.s1 - p.s0) : 0;
          this._apply(p.d0 + (p.d1 - p.d0) * a, { force: true });
          return;
        }
      }
    }
    this._apply(mapT(this.schedule, tc), { force: true });
  }

  /** 終わりへ飛ぶ（結果だけ・■ 止める）。'end' を出す。 */
  toEnd() {
    this.pause();
    this._apply(this.schedule.total, { force: true });
    this._finish();
  }

  /**
   * 1 コマ（Shift+[ ]）か 1 行（行ごと）進める・戻す。
   * @param {1|-1} dir
   */
  step(dir) {
    this.pause();
    const sgn = dir < 0 ? -1 : 1;
    const st = this.schedule.starts;
    if (this.opts.speed === 'line' && st && st.length) {
      // 行ごと: 次（前）の行の始まりへ
      const d = this._d;
      let target = null;
      if (sgn > 0) { for (const s of st) if (s > d + 1e-9) { target = s; break; } }
      else { for (let k = st.length - 1; k >= 0; k--) if (st[k] < d - 1e-9) { target = st[k]; break; } }
      this._apply(target === null ? (sgn > 0 ? this.schedule.total : 0) : target, { force: true });
      return;
    }
    const t = Math.max(0, Math.min(this.N.T, this._t + sgn * FRAME_DT));
    this._apply(mapT(this.schedule, t), { force: true });
  }

  /** つまみの 5%（[ ]）だけ送る・戻す。 @param {1|-1} dir */
  nudge(dir) {
    const was = this._playing;
    const t = Math.max(0, Math.min(this.N.T, this._t + (dir < 0 ? -1 : 1) * this.N.T * 0.05));
    this.seek(t);
    if (!was) this.pause();
  }

  /** 速さを変える（今の時刻はそのまま）。 @param {number|'line'|'result'} speed */
  setSpeed(speed) {
    const t = this._t;
    this.opts.speed = speed;
    this.opts.lineByLine = speed === 'line';
    this._rebuild();
    this._emit('speed', { speed, used: this.schedule.used, auto: this.schedule.auto });
    if (speed === 'result') { this.toEnd(); return; }
    this._apply(mapT(this.schedule, t), { force: true });
  }

  /** 片づけ。 */
  destroy() {
    this.pause();
    for (const s of Object.values(this._fns)) s.clear();
  }
}
