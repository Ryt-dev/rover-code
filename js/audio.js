/**
 * @file app/js/audio.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 音（生楽器ふう。シンセ音は使わない）。「はじめる」などの操作で AudioContext を起こす。音だけで伝えることは作らない。
 * SPEC: 10.6（音の表）・2.2（はじめるで音を起こす）・3.9（音量）・10.1（音を消しても全部遊べる）
 *
 * 録音の素材がまだ無い（14 章の 2）ので、音は WebAudio の中で「物の鳴り方」をまねて作る:
 *   - マリンバ・木琴・カリンバ … 棒や板の固有の振動（倍音の比が整数でない）を、それぞれ指数で減衰させて足す＋ばちの当たる音
 *   - 拍子木・ウッドブロック … 木の固有の振動（高い 2〜3 個）が数十 ms で消える＋当たる瞬間の雑音
 *   - ギター … Karplus-Strong（弦を弾いた時の振動をまねる計算）
 *   - 鉛筆・紙・布・焼ける音 … 雑音を帯で切って、こすれ・はためきの強弱をつける
 *   - 走る音 … 歯車の歯が当たる小さな音の列＋芝を踏む雑音（ずっと同じ高さの音を鳴らす発振器は使わない）
 * どの音も鳴り始めて減衰して消える（持続する発振音を使わない）。音の高さは 10.6 のとおりサンプルの再生速度で変える。
 * assets/audio/credits.json に録音のファイル（CC0 など）が書いてあれば、その名前の音は録音を使う（後で差しかえられる）。
 */

/** 音の名前（10.6 の表）。 */
export const SOUNDS = Object.freeze({
  run: '木のクリック（拍子木を小さく）',
  star: 'マリンバ（★ごとに 1 音ずつ上がる）',
  clear: 'マリンバの短い分散和音',
  leaves: 'カリンバの高い 2 音（★3 の舞い）',
  error: 'ウッドブロックの小さな 1 打',
  note: '鉛筆でノートに書く音（注意・先輩のひとこと）',
  page: '紙をめくる音（ヒントを開く）',
  chute: '布がはためく音・小さく焼ける音（パラ・溶断）',
  chapter: '木琴とアコースティックギターの短いフレーズ（章クリア）',
  // ブラッシュアップ 13
  tap: '小さな木の音（ボタン・画面の切りかえ。−18 dB）',
  bump: 'こもった音（コーンにぶつかった）',
  stop: 'マリンバを 1 打（ローバーが止まった）',
});

// ---------------------------------------------------------------- 音を作る（純粋な計算。Node のテストでも動く）

/** 決まった種の乱数（同じ音は毎回同じ）。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1 次の低域通過（雑音を丸める）。 */
function lowpass(x, sr, fc) {
  const a = Math.exp(-2 * Math.PI * fc / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; }
  return x;
}
/** 2 次の帯域通過（RBJ）。 */
function bandpass(x, sr, f0, q) {
  const w = 2 * Math.PI * f0 / sr;
  const al = Math.sin(w) / (2 * q);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = (b0 * xi + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}
function normalize(x, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) { const k = peak / m; for (let i = 0; i < x.length; i++) x[i] *= k; }
  return x;
}
/** 終わりを 5 ms で 0 にする（ぷつっと切れないように）。 */
function fadeTail(x, sr, ms = 5) {
  const n = Math.min(x.length, Math.round(sr * ms / 1000));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
  return x;
}

/**
 * 叩く楽器（棒・板・木）。partials: [比, 強さ, 減衰の時定数 s]。
 * @param {number} sr @param {number} f0 @param {number} dur s @param {number[][]} partials
 * @param {{attackMs?: number, mallet?: number, malletFc?: number, seed?: number}} [o]
 * @returns {Float32Array}
 */
export function struck(sr, f0, dur, partials, { attackMs = 1.5, mallet = 0.15, malletFc = 3000, seed = 1 } = {}) {
  const n = Math.round(sr * dur);
  const x = new Float32Array(n);
  const R = rng(seed);
  for (const [ratio, amp, tau] of partials) {
    const f = f0 * ratio;
    if (f >= sr / 2) continue;
    const ph = R() * 0.3;
    const w = 2 * Math.PI * f / sr;
    const k = Math.exp(-1 / (tau * sr));
    let e = amp;
    for (let i = 0; i < n; i++) { x[i] += e * Math.sin(w * i + ph); e *= k; }
  }
  // ばちが当たる瞬間（短い雑音）
  const m = Math.min(n, Math.round(sr * 0.006));
  const noise = new Float32Array(m);
  for (let i = 0; i < m; i++) noise[i] = (R() * 2 - 1) * Math.exp(-i / (sr * 0.0012));
  lowpass(noise, sr, malletFc);
  for (let i = 0; i < m; i++) x[i] += noise[i] * mallet;
  // 立ち上がり
  const a = Math.max(1, Math.round(sr * attackMs / 1000));
  for (let i = 0; i < a && i < n; i++) x[i] *= i / a;
  return fadeTail(normalize(x), sr);
}

/** マリンバの 1 音（倍音 1 : 3.93 : 9.2、低い音ほど長く響く）。 */
export function marimba(sr, f0 = 523.25, dur = 1.0) {
  const s = Math.min(1.4, 440 / f0);
  return struck(sr, f0, dur, [[1, 1, 0.3 * s + 0.1], [3.93, 0.32, 0.08 * s], [9.2, 0.07, 0.025]], { mallet: 0.12, malletFc: 2200, seed: 11 });
}
/** 木琴の 1 音（倍音 1 : 3 : 6、明るく短い）。 */
export function xylophone(sr, f0 = 1046.5, dur = 0.6) {
  return struck(sr, f0, dur, [[1, 1, 0.28], [3.0, 0.45, 0.09], [6.0, 0.18, 0.03], [10.2, 0.05, 0.012]], { mallet: 0.22, malletFc: 5000, seed: 12 });
}
/** カリンバの 1 音（金属の舌。倍音 1 : 5.4 : 13.1）。 */
export function kalimba(sr, f0 = 1318.5, dur = 0.6) {
  return struck(sr, f0, dur, [[1, 1, 0.22], [5.4, 0.18, 0.05], [13.1, 0.06, 0.02]], { mallet: 0.06, malletFc: 4000, attackMs: 0.8, seed: 13 });
}
/** 拍子木を小さく（木の高い固有振動が数十 ms で消える）。 */
export function clapper(sr) {
  return struck(sr, 1850, 0.1, [[1, 1, 0.022], [1.71, 0.7, 0.016], [2.83, 0.4, 0.01], [4.1, 0.2, 0.006]], { mallet: 0.5, malletFc: 7000, attackMs: 0.3, seed: 21 });
}
/** ウッドブロックの小さな 1 打。 */
export function woodblock(sr) {
  return struck(sr, 820, 0.12, [[1, 1, 0.035], [2.62, 0.45, 0.018], [4.4, 0.15, 0.008]], { mallet: 0.35, malletFc: 4000, attackMs: 0.4, seed: 22 });
}

/** 雑音の入れ物。 */
function noise(sr, dur, seed) {
  const n = Math.round(sr * dur);
  const x = new Float32Array(n);
  const R = rng(seed);
  for (let i = 0; i < n; i++) x[i] = R() * 2 - 1;
  return { x, R, n };
}

/** 鉛筆でノートに書く音（細かいこすれの粒）。 */
export function pencil(sr) {
  const { x, R, n } = noise(sr, 0.3, 31);
  bandpass(x, sr, 4200, 0.9);
  const env = new Float32Array(n);
  // 3 本の線を書く（線の中は細かく強弱）
  const strokes = [[0.0, 0.08], [0.1, 0.17], [0.2, 0.29]];
  for (const [a, b] of strokes) {
    const i0 = Math.round(a * sr), i1 = Math.round(b * sr);
    for (let i = i0; i < i1 && i < n; i++) {
      const u = (i - i0) / (i1 - i0);
      env[i] = Math.sin(Math.PI * u) * (0.6 + 0.4 * R());
    }
  }
  for (let i = 0; i < n; i++) x[i] *= env[i];
  lowpass(env, sr, 60);
  return fadeTail(normalize(x, 0.5), sr);
}
/** 紙をめくる音（ふわっと立ち上がって、すれる音の高さが上がる）。 */
export function page(sr) {
  const { x, R, n } = noise(sr, 0.3, 41);
  const parts = 6;
  const out = new Float32Array(n);
  for (let p = 0; p < parts; p++) {
    const seg = x.slice();
    bandpass(seg, sr, 700 + p * 600, 1.2);
    const c = (p + 0.5) / parts;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const w = Math.exp(-((u - c) ** 2) / 0.02);
      out[i] += seg[i] * w;
    }
  }
  for (let i = 0; i < n; i++) { const u = i / n; out[i] *= Math.sin(Math.PI * Math.min(1, u * 1.1)) * (0.8 + 0.2 * R()); }
  return fadeTail(normalize(out, 0.5), sr);
}
/** 布がはためく音＋小さく焼ける音（パラ・溶断）。 */
export function fabric(sr) {
  const { x, R, n } = noise(sr, 0.5, 51);
  lowpass(x, sr, 900);
  lowpass(x, sr, 1400);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    ph += 2 * Math.PI * (11 + 6 * Math.sin(u * 7)) / sr;
    const flap = 0.5 + 0.5 * Math.sin(ph) ** 2;
    x[i] *= flap * Math.sin(Math.PI * u);
  }
  // 焼ける音（ぱちぱち）
  for (let k = 0; k < 14; k++) {
    const i0 = Math.round(R() * (n - 200));
    const amp = 0.4 + 0.6 * R();
    for (let j = 0; j < 160; j++) x[i0 + j] += amp * (R() * 2 - 1) * Math.exp(-j / 25);
  }
  return fadeTail(normalize(x, 0.6), sr);
}

/**
 * ギターの 1 音（Karplus-Strong: 弦を弾いた振動のまね）。
 * @param {number} sr @param {number} f @param {number} dur
 */
export function guitar(sr, f, dur = 1.6, seed = 61) {
  const n = Math.round(sr * dur);
  const x = new Float32Array(n);
  const N = Math.max(2, Math.round(sr / f));
  const R = rng(seed + Math.round(f));
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = R() * 2 - 1;
  lowpass(buf, sr, 3500);          // 指で弾いた柔らかさ
  let idx = 0;
  const decay = 0.996;
  for (let i = 0; i < n; i++) {
    const a = buf[idx];
    const b = buf[(idx + 1) % N];
    const v = decay * 0.5 * (a + b);
    buf[idx] = v;
    x[i] = a;
    idx = (idx + 1) % N;
  }
  // 胴の響き（ゆるい帯域）
  const body = x.slice();
  bandpass(body, sr, 220, 1.5);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.8 + body[i] * 0.6;
  return fadeTail(normalize(x, 0.7), sr, 20);
}

/** 音を足し合わせる（ずらして重ねる）。 */
function mix(sr, dur, parts) {
  const out = new Float32Array(Math.round(sr * dur));
  for (const [buf, at, gain] of parts) {
    const i0 = Math.round(at * sr);
    for (let i = 0; i < buf.length && i0 + i < out.length; i++) out[i0 + i] += buf[i] * gain;
  }
  return fadeTail(normalize(out, 0.85), sr, 30);
}

const NOTE = (name) => {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] ? 1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (semis / 12);
};

/** マリンバの短い分散和音（クリア、0.8 s）。 */
export function clearArp(sr) {
  const notes = ['C5', 'E5', 'G5', 'C6'];
  return mix(sr, 1.1, notes.map((nm, i) => [marimba(sr, NOTE(nm), 1.0 - i * 0.1), i * 0.11, 1 - i * 0.08]));
}
/** カリンバの高い 2 音（★3 の舞い、0.5 s）。 */
export function kalimbaTwo(sr) {
  return mix(sr, 0.7, [[kalimba(sr, NOTE('E6'), 0.55), 0, 1], [kalimba(sr, NOTE('B6'), 0.55), 0.13, 0.8]]);
}
/** 木琴とギターの短いフレーズ（章クリア、2 s 以内）。 */
export function chapterPhrase(sr) {
  const parts = [];
  const strum = ['C3', 'G3', 'C4', 'E4', 'G4'];
  strum.forEach((nm, i) => parts.push([guitar(sr, NOTE(nm), 1.7), 0.02 + i * 0.018, 0.55]));
  const mel = [['G5', 0.0], ['C6', 0.18], ['E6', 0.36], ['D6', 0.6], ['E6', 0.78], ['G6', 1.0]];
  for (const [nm, at] of mel) parts.push([xylophone(sr, NOTE(nm), 0.6), at, 0.75]);
  return mix(sr, 1.9, parts);
}

/**
 * 走る音のループ 2 s: 小石や芝を車輪が転がる「じゃり」の粒（間かくも強さも高さもばらばら）＋ごく小さな低いころがり音。
 * 等間かくの音を並べると 1 つの高さのブザーに聞こえるので、粒は不規則に（平均 1 秒に 38 回）。シンセの持続音は使わない（直し C8）。
 * つなぎ目が切れないよう、粒は輪の中で折り返す。
 * @param {number} sr
 */
export function driveLoop(sr) {
  const n = sr * 2;
  const x = new Float32Array(n);
  const R = rng(71);
  // 砂利の粒: 指数分布の間かく（ポアソン）。1 粒は 3〜18 ms の雑音を、粒ごとにちがう高さの帯に通す
  let t = 0;
  while (true) {
    t += -Math.log(1 - R() * 0.999) / 38;
    const i0 = Math.round(t * sr);
    if (i0 >= n) break;
    const len = Math.round(sr * (0.003 + 0.015 * R() * R()));
    const g = new Float32Array(len);
    for (let j = 0; j < len; j++) g[j] = (R() * 2 - 1) * Math.exp(-5 * j / len);
    bandpass(g, sr, 900 + 3200 * R(), 0.9 + R());
    const amp = 0.15 + 0.85 * R() ** 2;
    for (let j = 0; j < len; j++) x[(i0 + j) % n] += g[j] * amp;
  }
  // 低いころがり音: ゆっくり大きさの変わる雑音を低い所だけ（高さの決まった音にはしない）
  const rum = new Float32Array(n);
  let env = 0.5;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) env = Math.min(1, Math.max(0.2, env + (R() - 0.5) * 0.3));
    rum[i] = (R() * 2 - 1) * env;
  }
  const low = lowpass(rum, sr, 260);
  for (let i = 0; i < n; i++) x[i] = x[i] * 0.9 + low[i] * 0.35;
  // 輪のつなぎ目をなめらかに（最初と最後 20 ms を重ねる）
  const f = Math.round(sr * 0.02);
  for (let j = 0; j < f; j++) { const a = j / f; x[j] = x[j] * a + x[n - f + j] * (1 - a); }
  return normalize(x.subarray(0, n - f), 0.45);
}

/** 小さな木の音（短い木の板を指先でたたく。ボタン・画面の切りかえ）。 */
export function woodTap(sr) {
  return struck(sr, 1320, 0.06, [[1, 1, 0.012], [2.3, 0.5, 0.007], [3.9, 0.2, 0.004]], { mallet: 0.25, malletFc: 5000, attackMs: 0.3, seed: 81 });
}
/** こもった音（布をかぶせた太鼓のような低い 1 打。コーンにぶつかった）。 */
export function bump(sr) {
  const x = struck(sr, 150, 0.22, [[1, 1, 0.06], [1.6, 0.5, 0.035], [2.4, 0.25, 0.02]], { mallet: 0.5, malletFc: 900, attackMs: 1.2, seed: 82 });
  lowpass(x, sr, 700);
  return fadeTail(normalize(x), sr);
}
/**
 * 環境音のループ 8 s: 芝の上の風（ゆっくり強弱が変わる低い雑音）と遠くの鳥（短いさえずりが時々）。
 * 鳥は 1 声 0.1 s ほどで消える。ずっと鳴る発振音は使わない。
 * @param {number} sr
 */
export function ambienceLoop(sr) {
  const n = sr * 8;
  const R = rng(91);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = R() * 2 - 1;
  lowpass(x, sr, 500); lowpass(x, sr, 800);
  // 風の強弱（ゆっくり。ループの両端で同じ値）
  for (let i = 0; i < n; i++) { const u = i / n; x[i] *= 0.55 + 0.3 * Math.sin(2 * Math.PI * u) + 0.15 * Math.sin(2 * Math.PI * 3 * u + 1); }
  // 遠くの鳥: 2〜3 声のさえずりを 2 回
  for (const at of [1.6, 5.3]) {
    for (let k = 0; k < 3; k++) {
      const i0 = Math.round((at + k * 0.16) * sr), len = Math.round(sr * 0.09);
      const f0 = 3200 + 500 * R(), f1 = f0 + 900;
      let ph = 0;
      for (let j = 0; j < len && i0 + j < n; j++) {
        const u = j / len;
        ph += 2 * Math.PI * (f0 + (f1 - f0) * u) / sr;
        x[i0 + j] += 0.18 * Math.sin(ph) * Math.sin(Math.PI * u) ** 2;
      }
    }
  }
  const f = Math.round(sr * 0.05);
  for (let j = 0; j < f; j++) { const a = j / f; x[j] = x[j] * a + x[n - f + j] * (1 - a); }
  return normalize(x.subarray(0, n - f), 0.35);
}
/** 短い残響（約 0.4 s。部屋の壁のはね返りのまね）のインパルス応答。 */
export function roomImpulse(sr, dur = 0.4) {
  const n = Math.round(sr * dur);
  const R = rng(97);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (R() * 2 - 1) * Math.exp(-6.9 * i / n);   // 0.4 s で −60 dB
  lowpass(x, sr, 3500);
  return x;
}

/** 名前ごとの作り方。 */
export const MAKERS = Object.freeze({
  run: (sr) => clapper(sr),
  star: (sr) => marimba(sr, NOTE('C5'), 1.0),
  // ★は音程ごとに作り分ける（再生の速さを変えると音色まで変わるので。ブラッシュアップ 13）
  star0: (sr) => marimba(sr, NOTE('C5'), 1.0),
  star1: (sr) => marimba(sr, NOTE('E5'), 0.95),
  star2: (sr) => marimba(sr, NOTE('G5'), 0.9),
  tap: (sr) => woodTap(sr),
  bump: (sr) => bump(sr),
  stop: (sr) => marimba(sr, NOTE('G4'), 0.9),
  amb: (sr) => ambienceLoop(sr),
  clear: (sr) => clearArp(sr),
  leaves: (sr) => kalimbaTwo(sr),
  error: (sr) => woodblock(sr),
  note: (sr) => pencil(sr),
  page: (sr) => page(sr),
  chute: (sr) => fabric(sr),
  chapter: (sr) => chapterPhrase(sr),
  drive: (sr) => driveLoop(sr),
});

/** ★の何番目かで上がる音（ド・ミ・ソ）。再生の速さの比。 */
export const STAR_RATES = Object.freeze([1, 2 ** (4 / 12), 2 ** (7 / 12)]);

// ---------------------------------------------------------------- 鳴らす

let ctx = null;
let master = null;
let sfxGain = null;
let ambGain = null;
const buffers = new Map();
let vol = { sfx: 60, ambience: 40, mute: false };
let driveSrc = null;
let driveGain = null;
let ambSrc = null;
let ambLoopGain = null;
let recorded = null;   // credits.json の録音 { name: url }

const toGain = (v) => { const u = Math.max(0, Math.min(100, v)) / 100; return u * u; };

/** 録音の一覧を読む（あれば）。 */
async function loadRecorded() {
  if (recorded !== null) return recorded;
  recorded = {};
  try {
    const r = await fetch(new URL('../assets/audio/credits.json', import.meta.url));
    const j = await r.json();
    for (const s of j.sounds || []) if (s && s.file && s.name && s.kind === 'recording') recorded[s.name] = new URL(`../assets/audio/${s.file}`, import.meta.url).href;
  } catch { /* 無くてよい */ }
  return recorded;
}

function bufferFor(name) {
  if (buffers.has(name)) return buffers.get(name);
  const make = MAKERS[name];
  if (!make || !ctx) return null;
  const data = make(ctx.sampleRate);
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.getChannelData(0).set(data);
  buffers.set(name, b);
  return b;
}

/**
 * 人の操作の中で呼んで AudioContext を起こす（ブラウザは人の操作の前に音を鳴らせない）。何度呼んでもよい。
 * @returns {boolean} 起こせたか
 */
export function unlock() {
  try {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
      sfxGain = ctx.createGain();
      ambGain = ctx.createGain();
      sfxGain.connect(master);
      ambGain.connect(master);
      // 全体に短い残響（約 0.4 s）を薄く（ブラッシュアップ 13）
      try {
        const conv = ctx.createConvolver();
        const ir = roomImpulse(ctx.sampleRate);
        const irb = ctx.createBuffer(2, ir.length, ctx.sampleRate);
        irb.getChannelData(0).set(ir); irb.getChannelData(1).set(roomImpulse(ctx.sampleRate, 0.38).subarray(0, ir.length));
        conv.buffer = irb;
        const wet = ctx.createGain();
        wet.gain.value = 0.14;
        sfxGain.connect(conv); conv.connect(wet); wet.connect(master);
      } catch { /* 残響なしでもよい */ }
      applyVolume();
      // 録音があれば読み込む（無ければ作った音）
      loadRecorded().then(async (rec) => {
        for (const [name, url] of Object.entries(rec)) {
          try {
            const ab = await (await fetch(url)).arrayBuffer();
            buffers.set(name, await ctx.decodeAudioData(ab));
          } catch { /* 作った音のまま */ }
        }
      });
      // よく使う音を先に作っておく（最初の 1 打を待たせない）
      setTimeout(() => { for (const n of ['run', 'star0', 'star1', 'star2', 'error', 'clear', 'tap']) bufferFor(n); }, 0);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  } catch { return false; }
}

/** 音が鳴らせる状態か。 */
export function isReady() { return !!ctx && ctx.state === 'running'; }

/**
 * 鳴らす。
 * @param {keyof SOUNDS} name
 * @param {{index?: number, delay?: number}} [opts] index は★の何番目か（0〜2。音の高さ）
 */
let lastTap = 0;
export function play(name, opts = {}) {
  if (!ctx || vol.mute || vol.sfx <= 0) return;
  if (name === 'tap') { const now = ctx.currentTime; if (now - lastTap < 0.09) return; lastTap = now; }   // ボタンと画面の切りかえが重なっても 1 回
  try {
    if (ctx.state === 'suspended') ctx.resume();
    const starIdx = name === 'star' && Number.isInteger(opts.index) ? Math.max(0, Math.min(2, opts.index)) : null;
    const recStar = !!(recorded && recorded.star && buffers.has('star'));     // 録音の★だけは再生の速さで高さを変える
    const b = bufferFor(starIdx !== null && !recStar ? `star${starIdx}` : name);
    if (!b) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    if (starIdx !== null && recStar) src.playbackRate.value = STAR_RATES[starIdx];
    const g = ctx.createGain();
    g.gain.value = name === 'tap' ? 0.126 : name === 'run' || name === 'error' ? 0.7 : name === 'note' || name === 'page' ? 0.55 : name === 'bump' ? 0.6 : 0.9;   // tap は −18 dB
    src.connect(g);
    g.connect(sfxGain);
    src.start(ctx.currentTime + (opts.delay || 0));
  } catch { /* 音は無くても遊べる */ }
}

/**
 * 走る音のループ（速さで高さと大きさを変える）。0 で止める。
 * @param {number} speed m/s（最高 約 1.1）
 */
export function drive(speed) {
  if (!ctx) return;
  const v = Math.min(1.2, Math.abs(Number(speed) || 0));
  try {
    if (v < 0.02 || vol.mute || vol.ambience <= 0) {
      if (driveGain) driveGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      return;
    }
    if (!driveSrc) {
      driveSrc = ctx.createBufferSource();
      driveSrc.buffer = bufferFor('drive');
      driveSrc.loop = true;
      driveGain = ctx.createGain();
      driveGain.gain.value = 0;
      driveSrc.connect(driveGain);
      driveGain.connect(ambGain);
      driveSrc.start();
    }
    const u = v / 1.1;
    driveSrc.playbackRate.setTargetAtTime(0.75 + 0.45 * u, ctx.currentTime, 0.1);
    driveGain.gain.setTargetAtTime(0.12 + 0.5 * u, ctx.currentTime, 0.1);
  } catch { /* なし */ }
}

/**
 * 芝の上の風と遠くの鳥（走る音のつまみで、とても小さく）。on=false で止める。
 * @param {boolean} on
 */
export function ambience(on) {
  if (!ctx) return;
  try {
    if (!on) {
      if (ambLoopGain) ambLoopGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      const s = ambSrc; ambSrc = null;
      if (s) setTimeout(() => { try { s.stop(); } catch { /* なし */ } }, 1500);
      return;
    }
    if (ambSrc || vol.mute) return;
    ambSrc = ctx.createBufferSource();
    ambSrc.buffer = bufferFor('amb');
    ambSrc.loop = true;
    ambLoopGain = ctx.createGain();
    ambLoopGain.gain.value = 0;
    ambSrc.connect(ambLoopGain);
    ambLoopGain.connect(ambGain);
    ambSrc.start();
    ambLoopGain.gain.setTargetAtTime(0.09, ctx.currentTime, 0.8);
  } catch { /* なし */ }
}

/** 走る音を止めて片づける。 */
export function stopDrive() {
  try { if (driveSrc) driveSrc.stop(); } catch { /* なし */ }
  driveSrc = null;
  driveGain = null;
}

function applyVolume() {
  if (!ctx) return;
  sfxGain.gain.value = vol.mute ? 0 : toGain(vol.sfx);
  ambGain.gain.value = vol.mute ? 0 : toGain(vol.ambience) * 0.6;
}

/** 音量（0〜100）。 @param {{sfx?: number, ambience?: number, mute?: boolean}} v */
export function setVolume(v) {
  vol = { ...vol, ...v };
  applyVolume();
}
