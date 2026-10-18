/**
 * @file app/js/replay/graphs.js
 * 持ち主: W5（3D と再生）
 * 役割: グラフの窓（つまみの右端の「グラフ」で開く）: その面に関係する値の時間のグラフ。つまみと同じ時刻に縦線。押すとその時刻へ。
 * SPEC: 7.3「W5 js/replay/*」・3.4「グラフの窓」・4 章の 11
 *
 * kinds: 'speed'（速さ）・'heading'（方位の本当と測った値）・'lidar'（測った値と本当）・'gnss'（ずれ）・'altitude'（高さ）・'accel'（加速度）
 * 系列の計算（graphSeries）は three も DOM も使わない（Node のテストでも動く）。色は落ち着いた色、光らせない。
 */
import { normalizeRecord } from './player.js';

export const GRAPH_KINDS = Object.freeze(['speed', 'motor', 'aim', 'heading', 'lidar', 'gnss', 'altitude', 'accel']);
const INK = '#23313a', BLUE = '#2f6f9f', GREEN = '#4a7a2e', SAND = '#b39b6e', RUST = '#a2533a';

/** 面に合うグラフ（面の graphs が無い時）。記録にあるセンサだけ。 */
export function defaultGraphKinds(level, record) {
  const N = normalizeRecord(record);
  const out = ['speed'];
  if ((N.byKind.heading || []).length) out.push('heading');
  if ((N.byKind.lidar || []).length) out.push('lidar');
  if ((N.byKind.gnss || []).length && (record.gnssFixes || []).length) out.push('gnss');
  let air = false;
  for (let i = 0; i < N.n; i++) if (N.col.mode[i] !== 0) { air = true; break; }
  if (air || (N.byKind.altitude || []).length) out.push('altitude');
  if ((N.byKind.accel || []).length) out.push('accel');
  return out;
}

/**
 * 1 つのグラフの系列。
 * @param {object} recOrN @param {string} kind
 * @returns {{kind: string, title: string, unit: string, lines: Array<{name: string, color: string, style: 'line'|'dots'|'dash', pts: number[]}>, y0: number, y1: number}}
 *   pts は [t, v, t, v, …]。NaN は線を切る。
 */
export function graphSeries(recOrN, kind, world = null) {
  const N = recOrN && recOrN.col ? recOrN : normalizeRecord(recOrN);
  const c = N.col;
  const step = Math.max(1, Math.floor(N.n / 1500));
  const frames = (f) => { const p = []; for (let i = 0; i < N.n; i += step) p.push(c.t[i], f(i)); if ((N.n - 1) % step) p.push(c.t[N.n - 1], f(N.n - 1)); return p; };
  const evs = (k, f) => { const p = []; for (const e of N.byKind[k] || []) { const v = f(e); p.push(e.t, v === null || v === undefined ? NaN : v); } return p; };
  let s;
  switch (kind) {
    case 'speed':
      s = { title: '速さ', unit: 'm/s', lines: [
        { name: '本当の速さ', color: GREEN, style: 'line', pts: frames((i) => Math.abs(c.v[i])) },
        { name: '指令（左右の平均 × 1.1）', color: SAND, style: 'dash', pts: frames((i) => Math.abs((c.cmdL[i] + c.cmdR[i]) / 2) * 1.1) },
      ] };
      break;
    case 'heading': {
      const truth = frames((i) => c.h[i]);
      breakWraps(truth);
      s = { title: '方位', unit: '°', lines: [
        { name: '本当の向き', color: INK, style: 'line', pts: truth },
        { name: 'heading() の値', color: BLUE, style: 'dots', pts: evs('heading', (e) => e.v) },
      ], y0: 0, y1: 360 };
      break;
    }
    case 'lidar':
      s = { title: 'LiDAR', unit: 'm', lines: [
        { name: '本当の距離', color: INK, style: 'line', pts: evs('lidar', (e) => e.truth) },
        { name: 'lidar() の値', color: RUST, style: 'dots', pts: evs('lidar', (e) => e.v) },
      ] };
      break;
    case 'gnss': {
      const p = [];
      for (const f of N.rec.gnssFixes || []) if (f[5]) p.push(f[0], Math.hypot(f[3] - f[1], f[4] - f[2]));
      s = { title: 'GNSS のずれ', unit: 'm', lines: [{ name: '測った位置と本当の位置の差', color: BLUE, style: 'line', pts: p }] };
      break;
    }
    case 'motor':
      // 左右のモーターへの指令（P 制御で左右の差が変わるのが見える。直し B1）
      s = { title: '左右のモーター', unit: '−1〜1', lines: [
        { name: '左 motor', color: RUST, style: 'line', pts: frames((i) => c.cmdL[i]) },
        { name: '右 motor', color: BLUE, style: 'dash', pts: frames((i) => c.cmdR[i]) },
      ] };
      break;
    case 'aim': {
      // コーンの方向と今の向きの差（P 制御の e。右が +）
      const objs = (world && world.objects) || [];
      const cone = objs.find((o) => o.type === 'cone') || objs.find((o) => o.type === 'flag');
      const p = cone ? frames((i) => { const want = Math.atan2(cone.x - c.x[i], cone.y - c.y[i]) * 180 / Math.PI; return ((want - c.h[i] + 540) % 360) - 180; }) : [];
      s = { title: 'コーンの方向とのずれ（e）', unit: '°', lines: [{ name: 'コーンの方向 − 今の向き（右が +）', color: INK, style: 'line', pts: p }] };
      break;
    }
    case 'altitude':
      s = { title: '高さ', unit: 'm', lines: [
        { name: '本当の高さ', color: INK, style: 'line', pts: frames((i) => Math.max(0, c.z[i])) },
        { name: 'altitude() の値', color: BLUE, style: 'dots', pts: evs('altitude', (e) => e.v) },
      ] };
      break;
    case 'accel':
      s = { title: '加速度', unit: 'm/s²', lines: [
        { name: 'z（上）', color: INK, style: 'line', pts: evs('accel', (e) => (Array.isArray(e.v) ? e.v[2] : NaN)) },
        { name: 'x（前）', color: RUST, style: 'dots', pts: evs('accel', (e) => (Array.isArray(e.v) ? e.v[0] : NaN)) },
      ] };
      break;
    default:
      s = { title: kind, unit: '', lines: [] };
  }
  if (s.y0 === undefined) {
    let lo = Infinity, hi = -Infinity;
    for (const l of s.lines) for (let i = 1; i < l.pts.length; i += 2) { const v = l.pts[i]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0 && lo < hi * 0.5) lo = 0;
    const pad = (hi - lo) * 0.08 || 0.5;
    s.y0 = lo === 0 ? 0 : lo - pad; s.y1 = hi + pad;
  }
  return { kind, ...s };
}

/** 359° → 1° のような折り返しで線を切る。 */
function breakWraps(p) {
  for (let i = 3; i < p.length; i += 2) if (Math.abs(p[i] - p[i - 2]) > 180) { p.splice(i - 1, 0, (p[i - 1] + p[i - 3]) / 2, NaN); i += 2; }
}

export class Graphs {
  /**
   * @param {HTMLElement} el 窓の要素（中身は作り直す。開け閉めは el.hidden）
   * @param {import('../../worker/engine.js').RunRecord} record
   * @param {string[]} kinds レベルの graphs（7.7）
   * @param {import('./player.js').Player} player
   */
  constructor(el, record, kinds, player, world = null) {
    this.el = el;
    this.player = player;
    this.N = normalizeRecord(record);
    this.kinds = (kinds && kinds.length ? kinds : defaultGraphKinds(null, record)).filter((k) => GRAPH_KINDS.includes(k));
    this.series = this.kinds.map((k) => graphSeries(this.N, k, world));
    el.classList.add('graphs');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'グラフ');
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'gr-head';
    head.innerHTML = '<b>グラフ</b><span class="gr-note">押すとその時刻へ</span>';
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'gr-close'; close.textContent = '閉じる';
    close.addEventListener('click', () => { el.hidden = true; el.dispatchEvent(new CustomEvent('rc-graphs', { bubbles: true, detail: { open: false } })); });
    head.appendChild(close);
    el.appendChild(head);
    this.items = this.series.map((s) => {
      const box = document.createElement('div');
      box.className = 'gr-item';
      const cap = document.createElement('div');
      cap.className = 'gr-cap';
      cap.innerHTML = `<span class="gr-title">${s.title}（${s.unit}）</span>` + s.lines.map((l) => `<span class="gr-key"><i style="background:${l.color};${l.style === 'dots' ? 'border-radius:50%;width:7px;height:7px' : l.style === 'dash' ? 'height:2px;background:repeating-linear-gradient(90deg,' + l.color + ' 0 4px,transparent 4px 7px)' : ''}"></i>${l.name}</span>`).join('');
      const cv = document.createElement('canvas');
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', `${s.title}の時間のグラフ（${fmtNum(s.y0)}〜${fmtNum(s.y1)} ${s.unit}）`);
      cv.addEventListener('pointerdown', (e) => {
        const r = cv.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (e.clientX - r.left - PAD_L) / Math.max(1, r.width - PAD_L - PAD_R))) * this.N.T;
        this.player.pause(); this.player.seek(t);
      });
      box.append(cap, cv);
      el.appendChild(box);
      return { s, cv, base: null };
    });
    this._off = player.on('time', (t) => this.update(t));
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { for (const it of this.items) it.base = null; this.update(this.player.t); }) : null;
    if (this._ro) this._ro.observe(el);
    this.update(player.t);
  }

  /** 今の時刻の縦線を描く（線の絵は 1 回だけ作って使い回す）。 */
  update(t) {
    if (this.el.hidden) return;
    for (const it of this.items) {
      const cv = it.cv;
      const w = Math.max(60, Math.round(cv.clientWidth || 300)), h = Math.max(40, Math.round(cv.clientHeight || 84));
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      if (!it.base || it.base.width !== Math.round(w * dpr) || it.base.height !== Math.round(h * dpr)) {
        it.base = drawSeries(it.s, w, h, dpr, this.N.T);
        cv.width = it.base.width; cv.height = it.base.height;
      }
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(it.base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = PAD_L + (t / (this.N.T || 1)) * (w - PAD_L - PAD_R);
      g.strokeStyle = INK; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - PAD_B); g.stroke();
    }
  }

  /** 片づけ。 */
  destroy() { if (this._off) this._off(); if (this._ro) this._ro.disconnect(); this.el.innerHTML = ''; }
}

const PAD_L = 38, PAD_R = 8, PAD_B = 16;
const fmtNum = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function drawSeries(s, w, h, dpr, T) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#fffdf8'; g.fillRect(0, 0, w, h);
  const X = (t) => PAD_L + (t / (T || 1)) * (w - PAD_L - PAD_R);
  const Y = (v) => 4 + (1 - (v - s.y0) / ((s.y1 - s.y0) || 1)) * (h - 4 - PAD_B);
  // 目盛り
  g.strokeStyle = '#e6dfcf'; g.lineWidth = 1;
  g.fillStyle = '#5d6b73'; g.font = '10px "BIZ UDGothic", ui-monospace, monospace';
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let k = 0; k <= 2; k++) {
    const v = s.y0 + (s.y1 - s.y0) * k / 2;
    const y = Y(v);
    g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(w - PAD_R, y); g.stroke();
    g.fillText(fmtNum(v), PAD_L - 4, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const tStep = T > 300 ? 60 : T > 60 ? 10 : T > 20 ? 5 : T > 6 ? 1 : 0.5;
  for (let t = 0; t <= T + 1e-9; t += tStep) g.fillText(`${+t.toFixed(1)}`, X(t), h - 3);
  for (const l of s.lines) {
    g.strokeStyle = l.color; g.fillStyle = l.color; g.lineWidth = 1.6;
    g.setLineDash(l.style === 'dash' ? [5, 3] : []);
    if (l.style === 'dots') {
      let lastPx = -9;
      for (let i = 0; i < l.pts.length; i += 2) {
        const v = l.pts[i + 1];
        if (!Number.isFinite(v)) continue;
        const x = X(l.pts[i]);
        if (x - lastPx < 1.2) continue;
        lastPx = x;
        g.beginPath(); g.arc(x, Y(v), 1.8, 0, Math.PI * 2); g.fill();
      }
    } else {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < l.pts.length; i += 2) {
        const v = l.pts[i + 1];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const x = X(l.pts[i]), y = Y(v);
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.stroke();
    }
  }
  g.setLineDash([]);
  return cv;
}
