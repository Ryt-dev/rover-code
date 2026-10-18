/**
 * @file app/worker/sim/sim.js
 * 持ち主: W1（シミュレータ）
 * 役割: ローバーの物理と世界（走る・ぶつかる・投下・センサ・記録）。依存なし。
 *       Node（テスト）と Worker（ブラウザ）の両方で動く ES モジュール。Python から同期で呼ばれる。
 * SPEC: 6 章（6.1〜6.11）・7.3「W1 worker/sim/sim.js」・13.2 W1
 * 元にしたもの: design/curriculum_check/refsim.py（物理。53 面の模範解答はこの物理で確かめ済み。
 *               W4 が SPEC 1.1 にそろえた写し tools/refsim/refsim.py とも同じ）、
 *               spike/sim.js（記録の形・同期で呼ぶ作り・速さの工夫）
 * 中で使うもの: ./rng.js（6.9）・./geometry.js（決まった答えの数学・当たり・光線）・./ground.js（6.4）・
 *               ./sensors.js（6.7）・./drop.js（6.6）
 *
 * ◆ W1 が決めた所（SPEC に無い細部。W2 への連絡は progress/W1.md の末尾）
 *  1. 時刻は刻みの数 n（整数）で持ち、t = n ÷ 500（dt 0.002）。ためている端数 pending の足し引きは refsim の
 *     advance と同じ順（端数がちょうど dt/2 の時に進むかどうかまで refsim と同じになる）。
 *  2. 時間が進む呼び出し（wait・now・センサ）は、制限時間を超えたら TimeUpSignal を返す（7.3）。
 *     Python 側は戻り値か sim.timeUp を見て _TimeUp を投げる。一度時間切れになったら、あとの呼び出しもすぐ TimeUpSignal。
 *  3. now(line) を足した（0.001 s 進めて t を返す。5.1〔1.1〕）。setMotor の 4 つ目の引数で 'stop' と数えられる。
 *  4. 三角関数などは geometry.js の決まった答えの関数（fdlibm）だけを使う（どのブラウザでも同じ記録。6.7〔1.1〕・12 章）。
 *  5. 記録: frames は 50 Hz（10 刻みごと）と最後のコマ。events は 2 万個まで。命令を呼んだ記録（motor・センサ・phase・
 *     nichrome）があふれそうな時は、一番多い種類を 1 つおきに間引く（calls の数は正しいまま）。
 *     ぶつかる・着地などの世界のイベントは間引かない。segments は同じ行・同じ種類が続けば 1 つにまとめる（5 万個まで）。
 */

import { mulberry32, hash32 } from './rng.js';
import { dsincos, dsin, dcos, dexp, dhypot, wrap2pi, wrap360, distToSegment, pointInShape, DEG, PI } from './geometry.js';
import { Ground, uphillFactor, slopeYawRate } from './ground.js';
import { Sensors } from './sensors.js';
import { DropModel, MODE } from './drop.js';

/**
 * 機体の数字（SPEC 6.2）。ゲームの都合で変えない（1.2 の約束 2）。refsim の SPEC と同じ値。
 */
export const ROVER_SPEC = Object.freeze({
  wheelDiameter: 0.127,   // 車輪の直径 m
  track: 0.162,           // 左右の車輪の中心間 m
  vMax: 1.1,              // デューティ 1 の速さ m/s
  deadband: 0.08,         // 絶対値がこれ未満のデューティは 0
  tau: 0.12,              // 車輪の速さの 1 次遅れ s
  radius: 0.12,           // 当たり判定の円の半径 m
  lidar: Object.freeze({ forward: 0.10, height: 0.08, min: 0.05, max: 12 }),            // m
  camera: Object.freeze({ height: 0.12, hfov: 62.2, vfov: 48.8, range: 20, latency: 0.4 }), // m・度・s
  encoderCpr: 2000,       // 車輪 1 回転のカウント（仮。SIL は hello の値）
  cone: Object.freeze({ height: 0.70, radius: 0.19 }),                                 // m
  rockMinH: 0.06,         // これより低い岩にはぶつからない m（6.5）
});

/**
 * センサの誤差などの既定（SPEC 6.7・6.10）。世界の `sensor` に書いた値が上書きする。
 * 〔1.1〕GNSS の既定は refsim と同じ τ 30 s・white 0 m（現実らしい値は面の世界に書く）。
 */
export const SENSOR_DEFAULTS = Object.freeze({
  lidar_noise: 0.02, heading_noise: 1.5, heading_bias: 0, heading_broken: false, heading_latency: 0,
  gnss_sigma: 2.0, gnss_tau: 30, gnss_white: 0, gnss_latency: 0.3, gnss_ttff: 1.0,
  gnss_outage: null, gnss_speed_noise: 0.05, cam_angle_noise: 1.0, cam_miss: 0.0,
  cam_false: 0.0, cam_false_dir: null, cam_broken: false, cam_range: 20.0, lidar_broken: false, alt_noise: 0.1,
});

/** 命令を呼んだ時に進む sim の時間 s（SPEC 5.1 の「sim の時間」の列。wait は引数の秒）。 */
export const COST = Object.freeze({
  print: 0, motor: 0, stop: 0, distance_to_cone: 0, phase: 0, nichrome: 0,
  now: 0.001, odometer: 0.001, encoder: 0.001, gnss: 0.001,
  lidar: 0.01, heading: 0.01, altitude: 0.01, accel: 0.01,
  camera: 0.4, marker: 0.4,
});

/**
 * 記録のコマ（frames）の項目の順（SPEC 6.11）。
 * h は度。v は地面に対する速さ m/s。wl/wr は車輪の速さ。z は高さ。
 * mode 0=地上 1=つり下げ 2=落下 3=降下。inv 1=さかさま。cx,cy はパラの位置（無ければ NaN）。
 */
export const FRAME_FIELDS = Object.freeze(['t', 'x', 'y', 'h', 'v', 'wl', 'wr', 'cmdL', 'cmdR', 'z', 'mode', 'inv', 'cx', 'cy']);
const NF = FRAME_FIELDS.length;

/**
 * 時間が進む呼び出し（wait・now・センサ）が、制限時間を超えた時に返す印（SPEC 7.3。Python 側が _TimeUp にする）。
 * 見分け方: `r instanceof TimeUpSignal` か `r.timeUp === true`（Python では `getattr(r, "timeUp", False)`）か `sim.timeUp`。
 */
export class TimeUpSignal {
  constructor(t) {
    /** 時間切れになった sim 時刻 s */
    this.t = t;
    /** いつも true（Python から見分けやすいように） */
    this.timeUp = true;
  }
}

/** 世界を書かなかった時の原点（船橋キャンパス。6.10 の例）。 */
const DEFAULT_ORIGIN = Object.freeze({ lat: 35.726195, lon: 140.057112 });

/** 命令を呼んだ記録として間引いてよいイベントの種類（ぶつかる・着地などの世界のイベントは間引かない）。 */
const THIN_KINDS = new Set(['motor', 'lidar', 'heading', 'odometer', 'encoder', 'gnss', 'camera', 'marker',
  'altitude', 'accel', 'now', 'phase', 'nichrome']);
const SEGMENT_CAP = 50000;
const PHASE_CAP = 20000;
/** 止まった（車輪の速さを 0 にしてよい）とみなす車輪の速さ m/s。refsim との差は 1 μm 未満。 */
const WHEEL_SNAP = 1e-6;

/** ぶつかった相手がパラのひもの時の印。 */
const TETHER = Object.freeze({ id: 'tether', what: 'tether' });

/**
 * @typedef {object} World 世界（SPEC 6.10）。venue・venue_key・origin・start・time_limit・objects[]・
 *   motor・ground・slope・sensor・drop・parachute_on_ground・inverted・api_off
 */
/**
 * @typedef {object} SimExport `RoverSim.export()` の戻り値（RunRecord の sim の部分。SPEC 6.11）
 * @property {string[]} fields FRAME_FIELDS
 * @property {Float32Array} frames 50 Hz のコマ（fields の順に並べる。最後のコマも入る）
 * @property {object[]} events {t, k, …}（2 万個まで。命令を呼んだ記録は種類ごとに間引く。t の順）
 * @property {Array<[number, number, number, string]>} segments 時間が進んだ区間 [行, t0, t1, 種類]
 * @property {Array<[number, number, number, number, number, boolean]>} gnssFixes [時刻, 本当の x, y, 測った x, y, valid]
 * @property {Object<string, number>} calls 命令ごとの呼んだ回数（sim に来た命令だけ。print などは W2 が足す）
 * @property {Array<[number, string]>} phases [時刻, 名前]
 * @property {number|null} programEndT finish() を呼んだ時刻（プログラムが終わった時刻）
 * @property {object} final 最後の状態（t・x・y・heading・z・stopped・touchedCone・bumps・odometer・timeUp・landed_t・
 *   separated・tangled・crashed・motor_before_land・nichrome_in_air ＋ inverted・mode・stuck・stalls・gap・canopy・encoder・v）
 * @property {object} stats {steps, frames, events, eventsDropped, eventStride, segments, segmentsDropped}
 */
/** @typedef {{valid: boolean, lat: number|null, lon: number|null, speed: number|null, course: number|null, t: number|null}} GnssValue */
/** @typedef {{found: boolean, angle: number|null, size: number|null, t: number}} CameraValue */
/** @typedef {{found: boolean, id: number|null, angle: number|null, dist: number|null, t: number}} MarkerValue */

/** ローバー 1 台と 1 つの世界。1 回の走行ごとに作る。 */
export class RoverSim {
  /**
   * @param {World} world 世界（6.10 節の形）
   * @param {object} [opts]
   * @param {number} opts.seed 主の乱数の種（6.9: hash32(面の id + ":" + 世界の番号)）
   * @param {number} [opts.gnssSeed] GNSS のずれの種（6.9: hash32(… + ":gnss")）。無ければ hash32(seed + ":gnss")
   * @param {number} [opts.dt=0.002] 計算の刻み s（6.1）
   * @param {number} [opts.frameHz=50] 記録のコマの数 /s
   * @param {number} [opts.eventCap=20000] events の上限
   */
  constructor(world, { seed = 0, gnssSeed, dt = 0.002, frameHz = 50, eventCap = 20000 } = {}) {
    const w = world || {};
    this.world = w;
    this.spec = ROVER_SPEC;
    this.seed = seed >>> 0;
    this.gnssSeed = gnssSeed === undefined || gnssSeed === null ? hash32(`${this.seed}:gnss`) : gnssSeed >>> 0;
    this.opts = { seed: this.seed, gnssSeed: this.gnssSeed, dt, frameHz, eventCap };
    this.rand = mulberry32(this.seed);
    this.gnssRand = mulberry32(this.gnssSeed);

    // ---- 時間（6.1: 刻みの数 n × dt。ためている端数 pending を持ち越す） ----
    this.dt = dt;
    const hz = Math.round(1 / dt);
    this.hz = Math.abs(hz * dt - 1) < 1e-12 ? hz : 0;   // 1/dt が整数なら t = n / hz（端数の誤差なし）
    this.n = 0;
    this.pending = 0;
    this.limit = Number(w.time_limit ?? 120);
    this.nLimit = Math.ceil((this.hz ? this.limit * this.hz : this.limit / dt) - 0.5 - 1e-9);
    if (!(this.nLimit >= 0)) this.nLimit = 0;
    this._timeUp = false;
    this._tus = null;
    this.finished = false;
    this.programEndT = null;

    // ---- 機体 ----
    const st = w.start || {};
    this.x = Number(st.x ?? 0);
    this.y = Number(st.y ?? 0);
    this.h = wrap2pi(Number(st.heading ?? 0) * DEG);   // refsim は最初の刻みで 0〜2π に直す。同じこと
    this.mL = 0; this.mR = 0;          // 左右の車輪の速さ m/s
    this.cmdL = 0; this.cmdR = 0;      // デューティ（−1〜1 に丸めた後）
    this.distL = 0; this.distR = 0;    // 車輪が回った距離（すべっても・ぶつかっていても増える）
    this.vx = 0; this.vy = 0;          // 地面に対する速さ（記録の v・GNSS の speed/course）
    this.inverted = !!w.inverted;
    /** @type {null|'pond'|'crash'|'tangled'} 動けなくなった理由 */
    this.stuck = null;
    const mot = w.motor || {};
    this.gainL = Number(mot.left ?? 1.0);
    this.gainR = Number(mot.right ?? 1.0);
    this.wheelA = 1 - dexp(-dt / ROVER_SPEC.tau);
    this.origin = w.origin && typeof w.origin.lat === 'number' ? w.origin : DEFAULT_ORIGIN;

    // ---- 世界の物（6.10 の objects） ----
    const lidarK = 1 - ROVER_SPEC.lidar.height / ROVER_SPEC.cone.height;
    this.cones = []; this.rocks = []; this.walls = []; this.markers = [];
    for (const o of w.objects || []) {
      if (!o || typeof o !== 'object') continue;
      if (o.type === 'cone') {
        const r = Number(o.r ?? ROVER_SPEC.cone.radius);
        this.cones.push({ id: o.id ?? 'cone', what: 'cone', x: Number(o.x), y: Number(o.y), r, lidarR: r * lidarK, lim: ROVER_SPEC.radius + r });
      } else if (o.type === 'rock') {
        const r = Number(o.r ?? 0.2);
        this.rocks.push({ id: o.id ?? 'rock', what: 'rock', x: Number(o.x), y: Number(o.y), r, h: Number(o.h ?? 0.3), lim: ROVER_SPEC.radius + r });
      } else if (o.type === 'wall') {
        const x1 = Number(o.x1), y1 = Number(o.y1), x2 = Number(o.x2), y2 = Number(o.y2), R = ROVER_SPEC.radius;
        this.walls.push({ id: o.id ?? 'wall', what: 'wall', x1, y1, x2, y2,
          bx0: Math.min(x1, x2) - R, bx1: Math.max(x1, x2) + R, by0: Math.min(y1, y2) - R, by1: Math.max(y1, y2) + R });
      } else if (o.type === 'marker') {
        this.markers.push({ id: o.id ?? 'marker', x: Number(o.x), y: Number(o.y), code: o.code ?? null });
      }
    }
    this.blockRocks = this.rocks.filter((r) => r.h >= ROVER_SPEC.rockMinH);
    this.ground = new Ground(w);
    for (const hl of this.ground.hills) hl.what = 'hill';
    this.drop = new DropModel(w.drop || null, w.parachute_on_ground || null, { x: this.x, y: this.y, dt });

    // ---- ぶつかる（6.5） ----
    this.contact = null;          // 今ふれている相手（cones・rocks・walls・hills の物か TETHER）
    this.touchedCone = false;
    this.bumps = 0;               // 岩・壁・斜面にふれ始めた回数
    this.stallN0 = null;          // ふれたまま押し始めた刻み
    this.stallId = null;
    this.stallOn = false;
    this.stallCount = 0;
    this.stallSteps = Math.round(1.0 / dt);

    // ---- 記録 ----
    this.frameEvery = Math.max(1, Math.round(1 / (frameHz * dt)));
    this.nextFrameN = 0;
    this.frames = new Float32Array(NF * 1024);
    this.nFrames = 0;
    this.lastFrameN = -1;
    this.eventCap = eventCap;
    this.seq = 0;
    this.evPhys = [];             // [seq, event]
    this.evThin = new Map();      // 種類 → {list: [[seq, event, callIndex]], stride, count}
    this.evTotal = 0;
    this.evDropped = 0;
    this.segments = [];
    this.segLast = null;          // まとめるための最後の区間 {line, kind, n1, arr}
    this.segDropped = 0;
    this.calls = {};
    this.phases = [];

    // ---- センサ（GNSS の最初の測位は 0 s。refsim と同じ順: 最初のずれ → 0 s の測位 → 最初のコマ） ----
    this.sensorCfg = { ...SENSOR_DEFAULTS, ...(w.sensor || {}) };
    this.sensors = new Sensors(this, this.sensorCfg, this.rand, this.gnssRand, ROVER_SPEC);
    // 方位の遅れ（sensor.heading_latency 秒。6-4・6-5 の「向きの値がおくれて届く」。0 なら使わない）
    const hLat = Number(this.sensorCfg.heading_latency) || 0;
    this.hLagSteps = hLat > 0 ? Math.max(1, Math.round(hLat / dt)) : 0;
    this.hHist = this.hLagSteps ? new Float64Array(this.hLagSteps + 1).fill(this.h) : null;
    this.hInit = this.h;
    this.fixIndex = 0;
    this.nextFixN = 0;
    this._gnssTickIfDue();
    this._pushFrame();

    this._sc = new Float64Array(2);
    this._pondX = NaN; this._pondY = NaN;
  }

  // ================================================================ 時間
  /** 今の sim 時刻 s（刻みの数 n ÷ 500。足し算をくり返さないので端数の誤差が無い）。 @returns {number} */
  get t() { return this.hz ? this.n / this.hz : this.n * this.dt; }
  /** 制限時間（world.time_limit）を超えたか。 @returns {boolean} */
  get timeUp() { return this._timeUp; }
  /** 方位センサが見る向き rad（heading_latency 秒前の向き。遅れが無ければ今の向き）。 */
  get hSensed() {
    if (!this.hHist) return this.h;
    const k = this.n - this.hLagSteps;
    return k <= 0 ? this.hInit : this.hHist[k % this.hHist.length];
  }
  /** 刻みの時刻（テスト・記録用）。 */
  tAt(n) { return this.hz ? n / this.hz : n * this.dt; }

  /**
   * sec 秒ぶん時間を進める（6.1: 端数 pending にためて、dt の半分以上たまったら 1 刻み進める）。
   * refsim の advance と同じ足し引きの順にしてある（pending += sec、1 刻みごとに pending −= dt）。
   * なので wait(0.003) は 2 刻み進めて −0.001 を持ち越し、端数がちょうど dt/2 の時の進む・進まないも refsim と
   * 1 ビットも違わない（浮動小数の足し引きは IEEE 754 で答えが 1 つに決まるので、どのブラウザでも同じ）。
   * 時刻そのものは刻みの数 n で持つので、20 分たっても t に端数の誤差は出ない（⑦）。
   * @returns {boolean} まだ時間がある（false = 時間切れ）
   */
  advance(sec) {
    if (this._timeUp) return false;
    let s = Number(sec);
    if (!(s > 0)) s = 0;                      // マイナス・NaN は 0（はじくのは Python 側）
    this.pending += s;
    const half = this.dt / 2;
    while (this.pending >= half && this.n < this.nLimit) {
      this.step();
      this.pending -= this.dt;
    }
    if (this.n >= this.nLimit) {
      if (this.pending > half) this.pending = 0;   // 時間切れで使わなかった分は捨てる
      this._timeUp = true;
      this.event('timeup', {});
      return false;
    }
    return true;
  }

  /** 時間切れの印（1 つの sim で 1 つ）。 */
  _timeUpSignal() {
    if (!this._tus) this._tus = new TimeUpSignal(this.t);
    return this._tus;
  }

  /** 時間を進めて、進んだ区間を segments に残す。 @returns {boolean} まだ時間がある */
  _spend(sec, line, kind) {
    const n0 = this.n;
    const ok = this.advance(sec);
    if (this.n > n0) this._addSegment(line, n0, this.n, kind);
    return ok;
  }

  _addSegment(line, n0, n1, kind) {
    const L = line ?? null;
    const last = this.segLast;
    if (last && last.line === L && last.kind === kind && last.n1 === n0) {
      last.n1 = n1;
      last.arr[2] = this.tAt(n1);
      return;
    }
    if (this.segments.length >= SEGMENT_CAP) {
      // あふれそうなら、センサを読んだ短い区間（0.05 s 未満）を 1 つおきに減らす（wait などの長い区間は残す。
      // 20 分の再生では 1 コマ 0.02 s より短い区間は見えない）
      const before = this.segments.length;
      let k = 0;
      this.segments = this.segments.filter((s) => s[2] - s[1] >= 0.05 || (k++ % 2) === 0);
      this.segDropped += before - this.segments.length;
      this.segLast = null;
      if (this.segments.length >= SEGMENT_CAP) { this.segDropped++; return; }
    }
    const arr = [L, this.tAt(n0), this.tAt(n1), kind];
    this.segments.push(arr);
    this.segLast = { line: L, kind, n1, arr };
  }

  // ================================================================ 物理（6.3〜6.6）
  /** デューティ → 目標の車輪の速さ（不感帯 0.08。refsim の duty_speed）。 */
  dutySpeed(d, gain) {
    if (Math.abs(d) < ROVER_SPEC.deadband) return 0;
    return d * ROVER_SPEC.vMax * gain;
  }

  /** 1 刻み進める。 */
  step() {
    if (this.drop.mode !== MODE.GROUND) this.drop.airStep(this);
    else this._groundStep();
    this.n++;
    if (this.hHist) this.hHist[this.n % this.hHist.length] = this.h;
    this.drop.afterStep(this);
    if (this.n >= this.nextFrameN) this._pushFrame();
    if (this.n >= this.nextFixN) this._gnssTickIfDue();
  }

  _gnssTickIfDue() {
    this.sensors.gnssTick();
    this.fixIndex++;
    this.nextFixN = this.hz ? this.fixIndex * this.hz : Math.round(this.fixIndex / this.dt);
  }

  /** 地上の 1 刻み（refsim の _ground_step と同じ順の計算）。 */
  _groundStep() {
    const dt = this.dt;
    const DB = ROVER_SPEC.deadband;
    const drop = this.drop;
    // 止まっていて、指令も 0（不感帯の中）なら、動かないので早道（refsim と同じ結果になる所だけ）
    if (this.mL === 0 && this.mR === 0 && !drop.dragging &&
        (this.stuck || (Math.abs(this.cmdL) < DB && Math.abs(this.cmdR) < DB))) {
      this.vx = 0; this.vy = 0;
      if (this.contact) this.contact = null;
      this._stallEnd();
      if (!this.stuck && (this.x !== this._pondX || this.y !== this._pondY)) {
        this._pondX = this.x; this._pondY = this.y;
        const G = this.ground.at(this.x, this.y);
        if (G.pond) { this.stuck = 'pond'; this.event('pond', { id: G.pond.id }); }
      }
      drop.checkTangle(this);
      return;
    }
    this._pondX = NaN;
    const G = this.ground.at(this.x, this.y);
    let tl = this.dutySpeed(this.cmdL, this.gainL) * G.speed;
    let tr = this.dutySpeed(this.cmdR, this.gainR) * G.speed;
    const hdeg = this.h / DEG;
    if (G.hasSlope) {
      // 上り坂はモーターの負荷で車輪が遅くなる（13° より急だと止まる）
      const f = uphillFactor(G.slopeDeg, G.slopeDown, hdeg, (tl + tr) * (this.inverted ? -1 : 1));
      if (f !== 1) { tl *= f; tr *= f; }
    }
    if (this.stuck) { tl = 0; tr = 0; this.mL = 0; this.mR = 0; }
    const a = this.wheelA;
    this.mL += (tl - this.mL) * a;
    this.mR += (tr - this.mR) * a;
    if (tl === 0 && Math.abs(this.mL) < WHEEL_SNAP) this.mL = 0;
    if (tr === 0 && Math.abs(this.mR) < WHEEL_SNAP) this.mR = 0;
    this.distL += this.mL * dt;
    this.distR += this.mR * dt;
    let gl, gr;
    if (this.inverted) { gl = -this.mR; gr = -this.mL; } else { gl = this.mL; gr = this.mR; }
    const slip = G.slip;
    gl *= (1 - slip);
    gr *= (1 - slip);
    const v = (gl + gr) / 2;
    let w = (gl - gr) / ROVER_SPEC.track * G.turn;
    if (G.hasSlope) w += slopeYawRate(G.slopeDeg, G.slopeDown, hdeg, v);   // 下り側へ流される
    let nx = this.x, ny = this.y;
    if (v !== 0) {
      const hm = this.h + w * dt / 2;
      const sc = dsincos(hm, this._sc);
      nx = this.x + v * sc[0] * dt;
      ny = this.y + v * sc[1] * dt;
    }
    if (drop.dragging) {
      // 引きずり（強風でパラがついたまま）
      const dv = drop.drag;
      const sx = dv * dsin(drop.windTo) * dt, sy = dv * dcos(drop.windTo) * dt;
      nx += sx; ny += sy;
      drop.canopy[0] += sx; drop.canopy[1] += sy;
    }
    if (w !== 0) this.h = wrap2pi(this.h + w * dt);
    let blocked = null;
    if (nx !== this.x || ny !== this.y) {
      blocked = this._collides(nx, ny);
      if (blocked === null && drop.tetherBlocks(nx, ny)) blocked = TETHER;
    }
    if (blocked !== null) {
      if (this.contact !== blocked) {
        this.event('contact', { id: blocked.id, what: blocked.what, speed: Math.round(Math.abs(v) * 1000) / 1000 });
        if (blocked.what === 'cone') { this.touchedCone = true; this.event('cone_touch', { id: blocked.id }); }
        if (blocked.what === 'rock' || blocked.what === 'wall' || blocked.what === 'hill') this.bumps++;
        this._stallEnd();
      }
      this.contact = blocked;
      this.vx = 0; this.vy = 0;
      if (Math.max(Math.abs(this.cmdL), Math.abs(this.cmdR)) >= DB) {
        if (this.stallN0 === null) { this.stallN0 = this.n; this.stallId = blocked.id; }
        else if (!this.stallOn && this.n - this.stallN0 >= this.stallSteps) {
          this.stallOn = true;
          this.stallCount++;
          this._physEvent({ t: this.tAt(this.stallN0), k: 'stall', id: this.stallId, t_found: this.t });
        }
      } else {
        this._stallEnd();
      }
    } else {
      this.vx = (nx - this.x) / dt;
      this.vy = (ny - this.y) / dt;
      this.x = nx; this.y = ny;
      this.contact = null;
      this._stallEnd();
    }
    if (G.pond && !this.stuck) {
      this.stuck = 'pond';
      this.event('pond', { id: G.pond.id });
    }
    drop.checkTangle(this);
  }

  _stallEnd() {
    if (this.stallOn) this.event('stall_end', { id: this.stallId });
    this.stallN0 = null;
    this.stallId = null;
    this.stallOn = false;
  }

  /** その位置で機体の円がぶつかる相手（コーン・高さ 0.06 m 以上の岩・登れない斜面・壁の順。refsim の collides）。 */
  _collides(x, y) {
    const R = ROVER_SPEC.radius;
    const cones = this.cones;
    for (let i = 0; i < cones.length; i++) {
      const c = cones[i], dx = x - c.x, dy = y - c.y;
      if (Math.abs(dx) < c.lim && Math.abs(dy) < c.lim && Math.sqrt(dx * dx + dy * dy) < c.lim) return c;
    }
    const rocks = this.blockRocks;
    for (let i = 0; i < rocks.length; i++) {
      const r = rocks[i], dx = x - r.x, dy = y - r.y;
      if (Math.abs(dx) < r.lim && Math.abs(dy) < r.lim && Math.sqrt(dx * dx + dy * dy) < r.lim) return r;
    }
    if (this.ground.hills.length) {
      const hl = this.ground.hillAt(x, y);
      if (hl) return hl;
    }
    const walls = this.walls;
    for (let i = 0; i < walls.length; i++) {
      const wl = walls[i];
      if (x >= wl.bx0 && x <= wl.bx1 && y >= wl.by0 && y <= wl.by1 && distToSegment(x, y, wl.x1, wl.y1, wl.x2, wl.y2) < R) return wl;
    }
    return null;
  }

  // ================================================================ 記録
  _pushFrame() {
    if (this.lastFrameN === this.n && this.nFrames > 0) return;
    if ((this.nFrames + 1) * NF > this.frames.length) {
      const f = new Float32Array(this.frames.length * 2);
      f.set(this.frames);
      this.frames = f;
    }
    const f = this.frames, o = this.nFrames * NF, d = this.drop;
    f[o] = this.t; f[o + 1] = this.x; f[o + 2] = this.y; f[o + 3] = wrap360(this.h / DEG);
    f[o + 4] = dhypot(this.vx, this.vy); f[o + 5] = this.mL; f[o + 6] = this.mR;
    f[o + 7] = this.cmdL; f[o + 8] = this.cmdR; f[o + 9] = d.z; f[o + 10] = d.mode; f[o + 11] = this.inverted ? 1 : 0;
    f[o + 12] = d.canopy ? d.canopy[0] : NaN; f[o + 13] = d.canopy ? d.canopy[1] : NaN;
    this.nFrames++;
    this.lastFrameN = this.n;
    this.nextFrameN = this.n - (this.n % this.frameEvery) + this.frameEvery;
  }

  /** 世界のイベント（ぶつかる・着地など。間引かない）。命令の記録の種類なら間引く方へ回す。 */
  event(kind, data) {
    if (THIN_KINDS.has(kind)) { this._thinEvent(kind, data); return; }
    this._physEvent({ t: this.t, k: kind, ...data });
  }

  _physEvent(e) {
    if (this.evTotal >= this.eventCap && !this._decimate()) { this.evDropped++; return; }
    this.evPhys.push([this.seq++, e]);
    this.evTotal++;
  }

  /** 命令を呼んだ記録（あふれそうなら種類ごとに間引く。6.11）。 */
  _thinEvent(kind, data) {
    let b = this.evThin.get(kind);
    if (!b) { b = { list: [], stride: 1, count: 0 }; this.evThin.set(kind, b); }
    const ci = b.count++;
    if (ci % b.stride !== 0) return;
    while (this.evTotal >= this.eventCap) {
      if (!this._decimate()) { this.evDropped++; return; }
      if (ci % b.stride !== 0) return;
    }
    b.list.push([this.seq++, { t: this.t, k: kind, ...data }, ci]);
    this.evTotal++;
  }

  /** 一番多い種類の命令の記録を 1 つおきに減らす。減らせなければ false。 */
  _decimate() {
    let best = null;
    for (const b of this.evThin.values()) if (b.list.length > 1 && (!best || b.list.length > best.list.length)) best = b;
    if (!best) return false;
    best.stride *= 2;
    const before = best.list.length;
    best.list = best.list.filter((e) => e[2] % best.stride === 0);
    this.evTotal -= before - best.list.length;
    return true;
  }

  _count(name) { this.calls[name] = (this.calls[name] || 0) + 1; }

  // ================================================================ 指令
  /**
   * 左右のデューティを決める（−1〜1 に丸める。|d| < 0.08 は車輪が回らない）。
   * @param {number} l 左 @param {number} r 右 @param {number} line 呼んだ行（記録用）
   * @param {'motor'|'stop'} [name='motor'] calls に数える名前（stop() は 'stop'）
   * @returns {{clamped: boolean}} 丸めたら true（API_MOTOR_RANGE の注意に使う）
   */
  setMotor(l, r, line, name = 'motor') {
    this._count(name);
    let L = Number(l), R = Number(r);
    if (L !== L) L = 0;
    if (R !== R) R = 0;
    const cl = L < -1 ? -1 : L > 1 ? 1 : L;
    const cr = R < -1 ? -1 : R > 1 ? 1 : R;
    this.cmdL = cl; this.cmdR = cr;
    const ev = { l: cl, r: cr, line: line ?? null };
    if (name === 'stop') ev.stop = true;
    this._thinEvent('motor', ev);
    return { clamped: cl !== L || cr !== R };
  }

  /** ニクロム線に電気を流す／止める（6.6 の分離・空中で焼く）。 @param {boolean} on @param {number} line */
  nichrome(on, line) {
    this._count('nichrome');
    const v = !!on;
    this.drop.nichrome(this, v);
    this._thinEvent('nichrome', { on: v, line: line ?? null });
  }

  /** 今のフェーズの名前を記録に出す（phases と phase のイベント）。 @param {string} name @param {number} line */
  phase(name, line) {
    this._count('phase');
    const s = String(name);
    if (this.phases.length < PHASE_CAP) this.phases.push([this.t, s]);
    this._thinEvent('phase', { name: s, line: line ?? null });
  }

  // ================================================================ 時間を進める命令
  /**
   * 今の指令のまま sec 秒進める（6.1: 刻みの数 n × dt で持ち、端数 pending を持ち越す）。
   * @param {number} sec @param {number} line
   * @returns {number|TimeUpSignal} 進んだ後の時刻。制限時間を超えたら TimeUpSignal
   */
  wait(sec, line) {
    this._count('wait');
    if (!this._spend(sec, line, 'wait')) return this._timeUpSignal();
    return this.t;
  }

  /** now()（5.1〔1.1〕: 0.001 s 進めてから今の時刻を返す）。 @param {number} line @returns {number|TimeUpSignal} */
  now(line) {
    this._count('now');
    if (!this._spend(COST.now, line, 'now')) return this._timeUpSignal();
    return this.t;
  }

  // ---- センサ（読む時間 COST を自分で進める。測れない時は null。時間切れは TimeUpSignal） ----
  /** LiDAR の距離 m（1 cm 単位、0.05〜12 m）。何も無い・故障・空中は null。 @param {number} line @returns {number|null|TimeUpSignal} */
  lidar(line) {
    this._count('lidar');
    if (!this._spend(COST.lidar, line, 'lidar')) return this._timeUpSignal();
    const r = this.sensors.lidar();
    this._thinEvent('lidar', { v: r.v, truth: r.truth === null ? null : Math.round(r.truth * 1e4) / 1e4, line: line ?? null });
    return r.v;
  }

  /** 方位 度（北 0・時計回り、0.1 度単位）。故障は null。 @param {number} line @returns {number|null|TimeUpSignal} */
  heading(line) {
    this._count('heading');
    if (!this._spend(COST.heading, line, 'heading')) return this._timeUpSignal();
    const r = this.sensors.heading();
    this._thinEvent('heading', { v: r.v, truth: Math.round(r.truth * 100) / 100, line: line ?? null });
    return r.v;
  }

  /** 左右の車輪が回った距離の平均 m。 @param {number} line @returns {number|TimeUpSignal} */
  odometer(line) {
    this._count('odometer');
    if (!this._spend(COST.odometer, line, 'odometer')) return this._timeUpSignal();
    const v = (this.distL + this.distR) / 2;
    this._thinEvent('odometer', { v, line: line ?? null });
    return v;
  }

  /** 左右のカウント（車輪 1 回転で 2000）。 @param {number} line @returns {[number, number]|TimeUpSignal} */
  encoder(line) {
    this._count('encoder');
    if (!this._spend(COST.encoder, line, 'encoder')) return this._timeUpSignal();
    const v = this._encoderCounts();
    this._thinEvent('encoder', { l: v[0], r: v[1], line: line ?? null });
    return v;
  }

  _encoderCounts() {
    const k = ROVER_SPEC.encoderCpr / (PI * ROVER_SPEC.wheelDiameter);
    return [Math.round(this.distL * k), Math.round(this.distR * k)];
  }

  /** GNSS（1 Hz・遅れ 0.3 s・ずれ）。valid が偽なら他は null。 @param {number} line @returns {GnssValue|TimeUpSignal} */
  gnss(line) {
    this._count('gnss');
    if (!this._spend(COST.gnss, line, 'gnss')) return this._timeUpSignal();
    const r = this.sensors.gnss();
    const ev = { valid: r.valid, lat: r.lat, lon: r.lon, line: line ?? null };
    if (r.valid) {
      ev.t_fix = r.t;
      ev.xt = Math.round(r.fix.x * 1000) / 1000; ev.yt = Math.round(r.fix.y * 1000) / 1000;
      ev.xm = Math.round(r.gx * 1000) / 1000; ev.ym = Math.round(r.gy * 1000) / 1000;
    }
    this._thinEvent('gnss', ev);
    return { valid: r.valid, lat: r.lat, lon: r.lon, speed: r.speed, course: r.course, t: r.t };
  }

  /** カメラ（0.4 s。その間も走る）。故障の世界は {broken: true}。 @param {number} line @returns {CameraValue|{broken: true, t: number}|TimeUpSignal} */
  camera(line) {
    this._count('camera');
    if (this.sensorCfg.cam_broken) {
      if (!this._spend(COST.camera, line, 'camera')) return this._timeUpSignal();
      this._thinEvent('camera', { broken: true, line: line ?? null });
      return { broken: true, t: this.t };
    }
    const tShot = this.t;
    const r = this.sensors.camera();
    if (!this._spend(COST.camera, line, 'camera')) return this._timeUpSignal();
    this._thinEvent('camera', {
      t_shot: tShot, found: r.found, angle: r.angle === null ? null : Math.round(r.angle * 100) / 100,
      size: r.size === null ? null : Math.round(r.size * 1000) / 1000,
      truth: r.truth === null ? null : Math.round(r.truth * 100) / 100, line: line ?? null,
    });
    return { found: r.found, angle: r.angle, size: r.size, t: tShot };
  }

  /** AR マーカー（4 m 以内・画角の中の一番近いもの。0.4 s）。カメラ故障の世界は {broken: true}。 @param {number} line @returns {MarkerValue|{broken: true, t: number}|TimeUpSignal} */
  marker(line) {
    this._count('marker');
    if (this.sensorCfg.cam_broken) {
      if (!this._spend(COST.marker, line, 'marker')) return this._timeUpSignal();
      this._thinEvent('marker', { broken: true, line: line ?? null });
      return { broken: true, t: this.t };
    }
    const tShot = this.t;
    const r = this.sensors.marker();
    if (!this._spend(COST.marker, line, 'marker')) return this._timeUpSignal();
    this._thinEvent('marker', { t_shot: tShot, found: r.found, id: r.id, angle: r.angle, dist: r.dist, line: line ?? null });
    return { found: r.found, id: r.id, angle: r.angle, dist: r.dist, t: tShot };
  }

  /** 気圧の高さ m（電源を入れた地面が 0、σ 0.1 m）。 @param {number} line @returns {number|TimeUpSignal} */
  altitude(line) {
    this._count('altitude');
    if (!this._spend(COST.altitude, line, 'altitude')) return this._timeUpSignal();
    const r = this.sensors.altitude();
    this._thinEvent('altitude', { v: Math.round(r.v * 1000) / 1000, truth: Math.round(r.truth * 1000) / 1000, line: line ?? null });
    return r.v;
  }

  /** 加速度 m/s²（機体の座標 x 前・y 左・z 上、±156.9 で頭打ち）。 @param {number} line @returns {[number, number, number]|TimeUpSignal} */
  accel(line) {
    this._count('accel');
    if (!this._spend(COST.accel, line, 'accel')) return this._timeUpSignal();
    const v = this.sensors.accel();
    this._thinEvent('accel', { v: v.map((a) => Math.round(a * 1000) / 1000), line: line ?? null });
    return v;
  }

  /** 最初のコーンまでのすき間 m（ふれて 0、誤差なし。練習用の巻尺）。コーンが無い世界は null。時間は進まない。 @returns {number|null} */
  distanceToCone() {
    this._count('distance_to_cone');
    if (!this.cones.length) return null;
    const c = this.cones[0];
    return Math.max(0, dhypot(c.x - this.x, c.y - this.y) - ROVER_SPEC.radius - c.r);
  }

  // ================================================================ 終わり
  /** 止まっていて、もう動かないか（惰性を打ち切る見分け）。 */
  _resting() {
    const DB = ROVER_SPEC.deadband;
    if (this.drop.mode !== MODE.GROUND) return false;
    const idle = this.stuck || (Math.abs(this.cmdL) < DB && Math.abs(this.cmdR) < DB);
    return idle && Math.abs(this.mL) < 1e-3 && Math.abs(this.mR) < 1e-3;
  }

  /**
   * プログラムが終わった後、最後の指令のまま最大 tailS 秒走らせる（止まっていればすぐ終わる。時間切れの後は走らせない）。
   * 2 回目からは何もしない。 @param {number} [tailS=3.0]
   */
  finish(tailS = 3.0) {
    if (this.finished) return;
    this.finished = true;
    this.programEndT = this.t;
    if (!this._timeUp) {
      const endN = Math.min(this.n + Math.round(Math.max(0, Number(tailS) || 0) / this.dt), this.nLimit);
      while (this.n < endN) {
        if (this._resting()) break;
        this.step();
      }
    }
    this._stallEnd();
    this._pushFrame();
  }

  /** 最初のコーンとのすき間（無ければ null）。 */
  _gap() {
    if (!this.cones.length) return null;
    const c = this.cones[0];
    return Math.max(0, dhypot(c.x - this.x, c.y - this.y) - ROVER_SPEC.radius - c.r);
  }

  /** 今の状態（テストと画面の確かめ用）。 */
  state() {
    return {
      t: this.t, n: this.n, x: this.x, y: this.y, heading: wrap360(this.h / DEG), v: dhypot(this.vx, this.vy),
      wl: this.mL, wr: this.mR, cmdL: this.cmdL, cmdR: this.cmdR, z: this.drop.z, mode: this.drop.modeName,
      inverted: this.inverted, stuck: this.stuck, pending: this.pending,
    };
  }

  /** 記録を取り出す（6.11）。finish() を呼んでいなければ、今の所で最後のコマを足す。 @returns {SimExport} */
  export() {
    this._pushFrame();
    const all = this.evPhys.slice();
    for (const b of this.evThin.values()) for (const e of b.list) all.push(e);
    all.sort((a, b) => (a[1].t - b[1].t) || (a[0] - b[0]));
    const events = all.map((e) => e[1]);
    const eventStride = {};
    for (const [k, b] of this.evThin) if (b.stride > 1) eventStride[k] = b.stride;
    const DB = ROVER_SPEC.deadband;
    const v = dhypot(this.vx, this.vy);
    const d = this.drop;
    const final = {
      t: this.t, x: this.x, y: this.y, heading: wrap360(this.h / DEG), z: d.z,
      stopped: v < 0.02 && Math.abs(this.cmdL) < DB && Math.abs(this.cmdR) < DB,
      touchedCone: this.touchedCone, bumps: this.bumps, odometer: (this.distL + this.distR) / 2,
      timeUp: this._timeUp, landed_t: d.landedT, separated: d.separated, tangled: d.tangled, crashed: d.crashed,
      motor_before_land: d.motorBeforeLand, nichrome_in_air: d.nichromeInAir,
      inverted: this.inverted, mode: d.modeName, stuck: this.stuck, stalls: this.stallCount, gap: this._gap(),
      canopy: d.canopy ? [d.canopy[0], d.canopy[1]] : null, attached: d.attached, encoder: this._encoderCounts(), v,
    };
    return {
      fields: FRAME_FIELDS.slice(),
      frames: this.frames.slice(0, this.nFrames * NF),
      events,
      segments: this.segments.map((s) => s.slice()),
      gnssFixes: this.sensors.fixes.map((f) => [f.t, f.x, f.y, f.mx, f.my, f.valid]),
      calls: { ...this.calls },
      phases: this.phases.map((p) => p.slice()),
      programEndT: this.programEndT,
      final,
      stats: {
        steps: this.n, frames: this.nFrames, events: events.length, eventsDropped: this.evDropped, eventStride,
        segments: this.segments.length, segmentsDropped: this.segDropped,
      },
    };
  }
}

// ==================================================================== 世界の確かめ（6.10）
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const TOP_KEYS = new Set(['venue', 'venue_key', 'origin', 'start', 'time_limit', 'objects', 'motor', 'ground', 'slope',
  'sensor', 'drop', 'parachute_on_ground', 'inverted', 'api_off', 'name', 'note', 'seed']);
const OBJ_TYPES = ['cone', 'flag', 'rock', 'wall', 'area', 'line', 'marker'];
const AREA_KINDS = ['sand', 'slope', 'pond', 'hill'];
const DROP_KEYS = ['height', 'release_t', 'wind_speed', 'wind_from', 'descent', 'inverted', 'land_heading',
  'sep_fail_first', 'canopy_dist', 'drag'];
const PG_KEYS = ['wind_from', 'canopy_dist', 'sep_fail_first', 'drag'];
/** 自由走行場の上限（3.8）。 */
export const WORLD_LIMITS = Object.freeze({ objects: 200, timeLimit: 1200 });

/**
 * 世界の形を確かめる（足りない項目・おかしな値を日本語の文で返す。空なら合格）。
 * 自由走行場の読み込み（3.8）でも使う: 物は 200 個まで・制限時間は 1200 s まで。
 * 頭が `_` の項目は書き手のメモとして見逃す。
 * @param {World} world
 * @returns {string[]} 例「objects[2]（r1）の r が数ではないよ」
 */
export function validateWorld(world) {
  const err = [];
  if (!world || typeof world !== 'object' || Array.isArray(world)) return ['世界が { } の形ではないよ'];
  for (const k of Object.keys(world)) {
    if (!TOP_KEYS.has(k) && !k.startsWith('_')) err.push(`知らない項目 ${k} があるよ（書きまちがい？）`);
  }
  // 制限時間
  if (!('time_limit' in world)) err.push('time_limit（制限時間 秒）が無いよ');
  else if (!isNum(world.time_limit) || world.time_limit <= 0) err.push('time_limit は 0 より大きい数にしてね');
  else if (world.time_limit > WORLD_LIMITS.timeLimit) err.push(`time_limit は ${WORLD_LIMITS.timeLimit} 秒（20 分）までだよ`);
  // 原点
  const o = world.origin;
  if (o === undefined) err.push('origin（原点の緯度経度）が無いよ');
  else if (!o || typeof o !== 'object' || !isNum(o.lat) || !isNum(o.lon)) err.push('origin は {"lat": 数, "lon": 数} の形にしてね');
  else if (Math.abs(o.lat) > 85 || Math.abs(o.lon) > 180) err.push('origin の緯度は −85〜85、経度は −180〜180 にしてね');
  // スタート
  const st = world.start;
  if (st === undefined) err.push('start（スタートの位置と向き）が無いよ');
  else if (!st || typeof st !== 'object' || !isNum(st.x) || !isNum(st.y) || !(st.heading === undefined || isNum(st.heading))) {
    err.push('start は {"x": 数, "y": 数, "heading": 数} の形にしてね');
  }
  // 物
  const objs = world.objects;
  const ids = new Set();
  if (!Array.isArray(objs)) err.push('objects（世界の物の一覧）が [ ] の形ではないよ');
  else {
    if (objs.length > WORLD_LIMITS.objects) err.push(`物は ${WORLD_LIMITS.objects} 個までだよ（いま ${objs.length} 個）`);
    objs.forEach((ob, i) => validateObject(ob, i, ids, err));
  }
  // 機体と地面
  checkNumObj(world.motor, 'motor', { left: [0.1, 2], right: [0.1, 2] }, err);
  checkNumObj(world.ground, 'ground', { speed: [0, 3], slip: [0, 0.95], turn: [0, 3] }, err);
  if (world.slope !== undefined && world.slope !== null) {
    checkNumObj(world.slope, 'slope', { deg: [0, 45], down: [-360, 360] }, err);
    if (world.slope && typeof world.slope === 'object' && !isNum(world.slope.deg)) err.push('slope には deg（坂の度）が要るよ');
  }
  // センサ
  const s = world.sensor;
  if (s !== undefined && s !== null) {
    if (typeof s !== 'object' || Array.isArray(s)) err.push('sensor は { } の形にしてね');
    else {
      for (const [k, v] of Object.entries(s)) {
        if (k.startsWith('_')) continue;
        if (!(k in SENSOR_DEFAULTS)) { err.push(`sensor に知らない項目 ${k} があるよ`); continue; }
        const def = SENSOR_DEFAULTS[k];
        if (k === 'cam_false_dir') {
          if (v !== null && !(isNum(v) && Math.abs(v) <= 360)) err.push('sensor.cam_false_dir は null か −360〜360 度にしてね');
        } else if (k === 'gnss_outage') {
          if (v !== null && !(Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) && v[0] <= v[1])) {
            err.push('sensor.gnss_outage は null か [始めの秒, 終わりの秒] にしてね');
          }
        } else if (typeof def === 'boolean') {
          if (typeof v !== 'boolean') err.push(`sensor.${k} は true か false にしてね`);
        } else if (!isNum(v)) err.push(`sensor.${k} が数ではないよ`);
        else if (k === 'heading_bias') { if (Math.abs(v) > 180) err.push('sensor.heading_bias は −180〜180 度にしてね'); }
        else if (v < 0) err.push(`sensor.${k} はマイナスにできないよ`);
        else if ((k === 'cam_miss' || k === 'cam_false') && v > 1) err.push(`sensor.${k} は 0〜1 の割合にしてね`);
        else if (k === 'gnss_tau' && v <= 0) err.push('sensor.gnss_tau は 0 より大きくしてね');
      }
    }
  }
  // 投下
  const d = world.drop;
  if (d !== undefined && d !== null) {
    if (typeof d !== 'object' || Array.isArray(d)) err.push('drop は { } の形にしてね');
    else {
      for (const k of Object.keys(d)) if (!DROP_KEYS.includes(k) && !k.startsWith('_')) err.push(`drop に知らない項目 ${k} があるよ`);
      for (const k of DROP_KEYS) {
        if (!(k in d) || k === 'inverted') continue;
        if (!isNum(d[k])) err.push(`drop.${k} が数ではないよ`);
      }
      if ('inverted' in d && typeof d.inverted !== 'boolean') err.push('drop.inverted は true か false にしてね');
      if (isNum(d.height) && (d.height <= 0 || d.height > 200)) err.push('drop.height は 0 より大きく 200 m までにしてね');
      if (isNum(d.descent) && d.descent <= 0) err.push('drop.descent（降下の速さ）は 0 より大きくしてね');
      if (isNum(d.release_t) && d.release_t < 0) err.push('drop.release_t はマイナスにできないよ');
      if (isNum(d.wind_speed) && d.wind_speed < 0) err.push('drop.wind_speed はマイナスにできないよ');
      if (isNum(d.sep_fail_first) && (d.sep_fail_first < 0 || d.sep_fail_first !== Math.floor(d.sep_fail_first))) err.push('drop.sep_fail_first は 0 以上の整数にしてね');
      if (isNum(d.drag) && d.drag < 0) err.push('drop.drag はマイナスにできないよ');
    }
  }
  const pg = world.parachute_on_ground;
  if (pg !== undefined && pg !== null) {
    if (typeof pg !== 'object' || Array.isArray(pg)) err.push('parachute_on_ground は { } の形にしてね');
    else {
      for (const k of Object.keys(pg)) if (!PG_KEYS.includes(k) && !k.startsWith('_')) err.push(`parachute_on_ground に知らない項目 ${k} があるよ`);
      for (const k of PG_KEYS) if (k in pg && !isNum(pg[k])) err.push(`parachute_on_ground.${k} が数ではないよ`);
      if (!isNum(pg.wind_from)) err.push('parachute_on_ground には wind_from（風の吹いてくる向き）が要るよ');
    }
    if (d) err.push('drop と parachute_on_ground は同時に使えないよ');
  }
  if ('inverted' in world && typeof world.inverted !== 'boolean') err.push('inverted は true か false にしてね');
  if ('api_off' in world && !(Array.isArray(world.api_off) && world.api_off.every((a) => typeof a === 'string'))) {
    err.push('api_off は命令の名前（文字）の [ ] にしてね');
  }
  // スタートが物に重なっていないか（投下の世界は着地した所から走るので見ない）
  if (!err.length && !d && Array.isArray(objs) && st) {
    const sim = new RoverSim({ ...world, sensor: undefined, drop: undefined }, { seed: 1 });
    const hit = sim._collides(sim.x, sim.y);
    if (hit) err.push(`スタートの位置が ${hit.id}（${WHAT_JA[hit.what] || hit.what}）に重なっているよ`);
  }
  return err;
}

const WHAT_JA = { cone: 'コーン', rock: '岩', wall: '壁', hill: '登れない斜面' };

function checkNumObj(v, name, ranges, err) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'object' || Array.isArray(v)) { err.push(`${name} は { } の形にしてね`); return; }
  for (const [k, val] of Object.entries(v)) {
    if (k.startsWith('_')) continue;
    if (!(k in ranges)) { err.push(`${name} に知らない項目 ${k} があるよ`); continue; }
    if (!isNum(val)) { err.push(`${name}.${k} が数ではないよ`); continue; }
    const [lo, hi] = ranges[k];
    if (val < lo || val > hi) err.push(`${name}.${k} は ${lo}〜${hi} にしてね（いま ${val}）`);
  }
}

function validateObject(ob, i, ids, err) {
  const at = (o) => `objects[${i}]${o && typeof o.id === 'string' ? `（${o.id}）` : ''}`;
  if (!ob || typeof ob !== 'object' || Array.isArray(ob)) { err.push(`objects[${i}] が { } の形ではないよ`); return; }
  const where = at(ob);
  if (typeof ob.id !== 'string' || !ob.id) err.push(`${where} に id（名前の文字）が無いよ`);
  else if (ids.has(ob.id)) err.push(`${where} の id「${ob.id}」がほかの物と同じだよ`);
  else ids.add(ob.id);
  if (!OBJ_TYPES.includes(ob.type)) { err.push(`${where} の type「${ob.type}」は使えないよ（${OBJ_TYPES.join('・')} のどれか）`); return; }
  const num = (k, { pos = false, opt = false } = {}) => {
    if (!(k in ob)) { if (!opt) err.push(`${where} に ${k} が無いよ`); return; }
    if (!isNum(ob[k])) { err.push(`${where} の ${k} が数ではないよ`); return; }
    if (pos && ob[k] <= 0) err.push(`${where} の ${k} は 0 より大きくしてね`);
  };
  switch (ob.type) {
    case 'cone': num('x'); num('y'); num('r', { pos: true, opt: true }); break;
    case 'flag': num('x'); num('y'); if ('label' in ob && typeof ob.label !== 'string') err.push(`${where} の label は文字にしてね`); break;
    case 'rock': num('x'); num('y'); num('r', { pos: true }); num('h', { pos: true, opt: true }); break;
    case 'wall': case 'line':
      num('x1'); num('y1'); num('x2'); num('y2');
      if (isNum(ob.x1) && isNum(ob.y1) && ob.x1 === ob.x2 && ob.y1 === ob.y2) err.push(`${where} の 2 つの端が同じ点だよ`);
      break;
    case 'marker':
      num('x'); num('y');
      if (!Number.isInteger(ob.code) || ob.code < 0) err.push(`${where} の code（マーカーの番号）は 0 以上の整数にしてね`);
      break;
    case 'area': {
      if (!AREA_KINDS.includes(ob.kind)) err.push(`${where} の kind「${ob.kind}」は使えないよ（${AREA_KINDS.join('・')} のどれか）`);
      const shapes = ['rect', 'circle', 'poly'].filter((k) => k in ob);
      if (shapes.length !== 1) { err.push(`${where} の形は rect・circle・poly のどれか 1 つを書いてね`); break; }
      const sh = shapes[0], v = ob[sh];
      if (sh === 'rect' && !(Array.isArray(v) && v.length === 4 && v.every(isNum))) err.push(`${where} の rect は [x0, y0, x1, y1] にしてね`);
      if (sh === 'circle' && !(Array.isArray(v) && v.length === 3 && v.every(isNum) && v[2] > 0)) err.push(`${where} の circle は [中心 x, 中心 y, 半径] にしてね`);
      if (sh === 'poly' && !(Array.isArray(v) && v.length >= 3 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum)))) {
        err.push(`${where} の poly は [[x, y], …] の 3 点以上にしてね`);
      }
      if (ob.kind === 'sand') {
        num('speed', { pos: true, opt: true }); num('slip', { opt: true });
        if (isNum(ob.slip) && (ob.slip < 0 || ob.slip >= 1)) err.push(`${where} の slip は 0 以上 1 未満にしてね`);
        if (isNum(ob.speed) && ob.speed > 3) err.push(`${where} の speed は 3 までにしてね`);
      }
      if (ob.kind === 'slope') { num('deg'); num('down'); }
      if (ob.kind === 'hill') { num('deg', { opt: true }); num('down', { opt: true }); }
      break;
    }
    default: break;
  }
}

/** 点が区域の中か（画面・判定の道具が使えるように。geometry.js の pointInShape と同じ）。 */
export { pointInShape };
