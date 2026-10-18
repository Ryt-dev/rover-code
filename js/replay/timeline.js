/**
 * @file app/js/replay/timeline.js
 * 持ち主: W5（3D と再生）
 * 役割: 時間のつまみ（3D の下、高さ 56 px）: 再生・一時停止・速さ・つまみ・今の時刻と、その上の行の帯。
 * SPEC: 7.3「W5 js/replay/*」・3.4「時間のつまみ」・3.1（キー: Space・[ ]・Shift+[ ]）・3.11（小さい画面は 44 px で帯なし）
 *
 * 行の帯: 時間が進んだ区間（segments の wait とセンサ）をその行の色で塗り、行番号を書く。時間を使わない行（motor・print）は細い縦の印。
 * くり返しは帯の模様として見える。帯を押すとその行へ飛ぶ。
 * three を使わない（帯の計算 computeBands は Node のテストでも動く）。
 */
import { normalizeRecord, SPEEDS } from './player.js';

/** 速さの選びかた（3.4）。値は Player の speed。 */
export const SPEED_OPTIONS = Object.freeze([
  ...SPEEDS.map((v) => ({ value: v, label: `×${v}` })),
  { value: 'line', label: '行ごと' },
  { value: 'result', label: '結果だけ' },
]);

/** 面の既定の速さ（3.9: 1〜3 章は行ごと、4 章から ×1）。 */
export function defaultSpeedFor(level) {
  const c = level && level.chapter;
  const n = typeof c === 'number' ? c : parseInt(c, 10);
  return Number.isFinite(n) && n <= 3 ? 'line' : 1;
}

/** 行の色（くすんだ自然色。同じ行はいつも同じ色）。 */
const LINE_COLORS = ['#9bbb6e', '#dcae68', '#86abc0', '#cf9575', '#b4ad72', '#a497bf', '#7fb0a4', '#cfa982', '#93a4b8', '#c7b26a'];
export function lineColor(n) { return LINE_COLORS[((n | 0) * 7 + 3) % LINE_COLORS.length]; }

/**
 * 行の帯と縦の印を記録から作る。
 * @param {object} recOrN RunRecord か normalizeRecord の戻り値
 * @returns {{T: number, bands: Array<{line: number, t0: number, t1: number, kind: string}>, ticks: Array<{line: number, t: number}>}}
 *   bands は segments と同じ数・同じ順（時刻順）。ticks は時間を使わずに動いた行（lineLog で、次の行と同じ時刻のもの）。
 */
export function computeBands(recOrN) {
  const N = recOrN && recOrN.col ? recOrN : normalizeRecord(recOrN);
  const bands = N.segments.map(([line, t0, t1, kind]) => ({ line, t0, t1, kind }));
  const ticks = [];
  const L = N.logLines, Tm = N.logTimes;
  for (let i = 0; i < L.length; i++) {
    const t = Tm[i];
    const next = i + 1 < L.length ? Tm[i + 1] : N.programEndT;
    if (next - t < 1e-6) ticks.push({ line: L[i], t });
  }
  return { T: N.T, bands, ticks };
}

/** 押した時刻に一番近い帯（その中なら帯、無ければ null）。 */
export function bandAt(bands, t) {
  let lo = 0, hi = bands.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bands[m].t0 <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans >= 0 && t <= bands[ans].t1) return bands[ans];
  return null;
}

const fmtT = (t) => (t < 60 ? `${t.toFixed(1)} s` : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);

export class Timeline {
  /**
   * @param {HTMLElement} el つまみの区画（.timeline）。中身は作り直す
   * @param {import('../../worker/engine.js').RunRecord} record
   * @param {object} level レベルの定義（7.7）
   * @param {import('./player.js').Player} player
   * @param {{onGraphs?: () => void}} [opts] onGraphs: 「グラフ」を押した時（無ければ el から 'rc-graphs' の出来事を出す）
   */
  constructor(el, record, level, player, opts = {}) {
    this.el = el;
    this.level = level || null;
    this.opts = opts;
    this._offs = [];
    this._build();
    this.setPlayer(player, record);
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this._draw()) : null;
    if (this._ro) this._ro.observe(this.track);
  }

  _build() {
    const el = this.el;
    el.innerHTML = '';
    el.classList.add('timeline');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', '再生');
    const mk = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    this.playBtn = mk('button', 'tl-play', { type: 'button', 'aria-label': '再生' });
    this.playBtn.textContent = '▶︎';
    this.speedSel = mk('select', 'tl-speed', { 'aria-label': '再生の速さ' });
    for (const o of SPEED_OPTIONS) { const op = document.createElement('option'); op.value = String(o.value); op.textContent = o.label; this.speedSel.appendChild(op); }
    this.track = mk('div', 'track');
    this.canvas = mk('canvas', 'bands', { 'aria-hidden': 'true' });
    this.range = mk('input', 'tl-range', { type: 'range', min: '0', max: '1', step: 'any', value: '0', 'aria-label': '再生の時刻' });
    this.track.append(this.canvas, this.range);
    this.timeEl = mk('span', 'time');
    this.autoEl = mk('span', 'tl-auto');
    this.curLine = mk('span', 'curline', { 'aria-live': 'off' });
    this.graphBtn = mk('button', 'tl-graph', { type: 'button', 'aria-pressed': 'false' });
    this.graphBtn.textContent = 'グラフ';
    el.append(this.playBtn, this.speedSel, this.track, this.timeEl, this.autoEl, this.curLine, this.graphBtn);

    this.playBtn.addEventListener('click', () => this.player && this.player.toggle());
    this.speedSel.addEventListener('change', () => {
      const v = this.speedSel.value;
      this.player.setSpeed(v === 'line' || v === 'result' ? v : Number(v));
    });
    this.range.addEventListener('input', () => { if (this.player) { this.player.pause(); this.player.seek(Number(this.range.value)); } });
    this.canvas.addEventListener('pointerdown', (e) => this._onBandClick(e));
    this.graphBtn.addEventListener('click', () => {
      const on = this.graphBtn.getAttribute('aria-pressed') !== 'true';
      this.graphBtn.setAttribute('aria-pressed', String(on));
      if (this.opts.onGraphs) this.opts.onGraphs(on);
      else el.dispatchEvent(new CustomEvent('rc-graphs', { bubbles: true, detail: { open: on } }));
    });
  }

  /** 別の記録と Player に替える（世界の切りかえ）。 */
  setPlayer(player, record) {
    for (const off of this._offs) off();
    this._offs = [];
    this.player = player;
    this.record = record;
    this.N = normalizeRecord(record);
    this.data = computeBands(this.N);
    this.range.max = String(Math.max(0.01, this.N.T));
    this._offs.push(player.on('time', (t) => this._onTime(t)));
    this._offs.push(player.on('state', (p) => this._onState(p)));
    this._offs.push(player.on('line', (n) => { this.curLine.textContent = n ? `${n} 行目` : ''; }));
    this._offs.push(player.on('speed', () => this._onSpeed()));
    this._onSpeed();
    this._onState(player.playing);
    this._onTime(player.t);
    this._draw();
  }

  /** 別の記録に替える（SPEC 7.3 の形。Player は同じものを使い続ける時）。 */
  setRecord(record) { this.setPlayer(this.player, record); }

  _onTime(t) {
    this.range.value = String(t);
    const txt = `${fmtT(t)} / ${fmtT(this.N.T)}`;
    if (this.timeEl.textContent !== txt) this.timeEl.textContent = txt;
    this.range.setAttribute('aria-valuetext', `${t.toFixed(1)} 秒`);
  }

  _onState(playing) {
    this.playBtn.textContent = playing ? '❚❚' : '▶︎';
    this.playBtn.setAttribute('aria-label', playing ? '一時停止' : '再生');
  }

  _onSpeed() {
    const p = this.player;
    this.speedSel.value = String(p.speed);
    const S = p.schedule;
    let note = '';
    if (S && S.auto && p.speed !== 'result') {
      if (S.speed === 'line') note = S.fallback ? '行が多いので ×1' : (S.used > 1 ? `速めて ×${S.used}` : '');
      else if (S.used !== S.speed) note = `長いので ×${S.used}`;
      if (S.idleCount) note += `${note ? '・' : ''}待ちは早送り`;
    }
    this.autoEl.textContent = note;
    this.autoEl.hidden = !note;
  }

  _onBandClick(e) {
    const r = this.canvas.getBoundingClientRect();
    if (r.width <= 0) return;
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.N.T;
    const b = bandAt(this.data.bands, t);
    const px = this.N.T / r.width;
    let target = b ? b.t0 : t, line = b ? b.line : undefined;
    if (!b) {
      // 近くの縦の印（3 px 以内）
      let best = null, bd = 3 * px;
      for (const k of this.data.ticks) { const d = Math.abs(k.t - t); if (d < bd) { bd = d; best = k; } }
      if (best) { target = best.t; line = best.line; }
    }
    this.player.pause();
    this.player.seek(target, line);
  }

  /** 帯を描く。 */
  _draw() {
    const cv = this.canvas;
    const w = Math.max(1, Math.round(cv.clientWidth || this.track.clientWidth || 300));
    const h = Math.max(1, Math.round(cv.clientHeight || 12));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#ece5d6';
    g.fillRect(0, 0, w, h);
    const T = this.N.T || 1;
    const X = (t) => (t / T) * w;
    // 惰性の 3 s（プログラムの後）は薄い斜線
    const pe = this.N.programEndT;
    if (pe < T) {
      g.fillStyle = '#e2dccd';
      g.fillRect(X(pe), 0, w - X(pe), h);
    }
    // 区間（帯）
    let lastX = -1, lastLine = -1;
    const labels = [];
    for (const b of this.data.bands) {
      const x0 = X(b.t0), x1 = Math.max(x0 + 0.6, X(b.t1));
      g.fillStyle = lineColor(b.line);
      g.fillRect(x0, 0, x1 - x0, h);
      if (x1 - x0 >= 16 && !(Math.floor(x0) === lastX && b.line === lastLine)) labels.push([b.line, (x0 + x1) / 2]);
      lastX = Math.floor(x0); lastLine = b.line;
    }
    // 時間を使わない行（細い縦の印。同じ画素は 1 本）
    const seen = new Set();
    g.globalAlpha = 0.9;
    for (const k of this.data.ticks) {
      const px = Math.round(X(k.t) * 2);
      const key = px * 1000 + (k.line % 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      g.fillStyle = shade(lineColor(k.line), -0.35);
      g.fillRect(X(k.t) - 0.5, 0, 1, h);
    }
    g.globalAlpha = 1;
    // 行番号
    g.fillStyle = '#23313a';
    g.font = '600 9px "BIZ UDGothic", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [line, x] of labels) g.fillText(String(line), x, h / 2 + 0.5);
  }

  /**
   * キー（3.1）: Space 再生・一時停止、[ ] 5% 送り、Shift+[ ] 1 コマ送り（行ごとの時は 1 行）。
   * W7 のキー操作（エディタの外で、ボタン以外にフォーカスがある時だけ）から呼ぶ。
   * @param {KeyboardEvent} e @returns {boolean} 使ったか（使ったら e.preventDefault() 済み）
   */
  handleKey(e) {
    if (!this.player || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return false;
    // 字（key）で見分ける（JIS の配列では [ ] の位置の code が US と違うため）
    const key = e.key;
    let used = true;
    if (key === ' ' || key === 'Spacebar') this.player.toggle();
    else if (key === '[' || key === '{' || key === '「' || key === '『') (e.shiftKey || key === '{' || key === '『') ? this.player.step(-1) : this.player.nudge(-1);
    else if (key === ']' || key === '}' || key === '」' || key === '』') (e.shiftKey || key === '}' || key === '』') ? this.player.step(1) : this.player.nudge(1);
    else used = false;
    if (used) e.preventDefault();
    return used;
  }

  /** 片づけ。 */
  destroy() {
    for (const off of this._offs) off();
    this._offs = [];
    if (this._ro) this._ro.disconnect();
    this.el.innerHTML = '';
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c * (1 + k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
