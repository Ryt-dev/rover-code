/**
 * @file app/js/ui/fallback_view.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: W5 の 3D（js/replay/scene.js・player.js・timeline.js）がまだ使えない時、または WebGL が無い端末での代わり。
 *       上から見た 2D の図（canvas）・簡単な再生（Player と同じ窓口）・簡単な時間のつまみ。
 *       W5 の部品が動けば play.js はそちらを使う（ここは使わない）。
 * SPEC: 7.3「W5 js/replay/*」（Scene・Player・Timeline の形）・3.4（地面に描くもの: 線の形も変える・光らせない）・6.11（frames）
 */

import { t } from './strings.js';

const FIELDS = ['t', 'x', 'y', 'h', 'v', 'wl', 'wr', 'cmdL', 'cmdR', 'z', 'mode', 'inv', 'cx', 'cy'];

/** 記録の frames を列ごとに読む（Float32Array・数の配列・null 入り、どれでも）。 */
export function readFrames(rec) {
  const fields = Array.isArray(rec && rec.fields) && rec.fields.length ? rec.fields : FIELDS;
  const flat = (rec && rec.frames) || [];
  const W = fields.length;
  const n = Math.floor(flat.length / W);
  const col = {};
  for (const [k, name] of fields.entries()) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) { const v = flat[i * W + k]; a[i] = v === null || v === undefined ? NaN : v; }
    col[name] = a;
  }
  return { n, col, T: n ? col.t[n - 1] : 0 };
}

function idxAt(F, t) {
  const a = F.col.t;
  let lo = 0, hi = F.n - 1;
  if (hi < 0) return -1;
  if (t <= a[0]) return 0;
  if (t >= a[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m; else hi = m; }
  return lo;
}

/** その時刻の位置（補間しない。50 Hz なので十分）。 */
export function poseAt(F, t) {
  const i = idxAt(F, t);
  if (i < 0) return null;
  const c = F.col;
  return { t: c.t[i], x: c.x[i], y: c.y[i], h: c.h[i], v: c.v ? c.v[i] : 0, z: c.z ? c.z[i] : 0, inv: c.inv ? c.inv[i] : 0 };
}

/** その時刻の行（lineLog の［行…］［時刻…］から）。 */
export function lineAtRec(rec, t) {
  const ll = rec && rec.lineLog;
  if (!ll || !ll[0] || !ll[0].length) return null;
  const [lines, times] = ll;
  let ans = -1;
  let lo = 0, hi = times.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? lines[ans] : lines[0];
}

/**
 * 上から見た 2D の図（Scene の代わり）。
 * @param {HTMLElement} el
 */
export function createFallbackScene(el) {
  const cv = document.createElement('canvas');
  cv.className = 'fb-canvas';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', t('play.view_label'));
  el.appendChild(cv);
  const note = document.createElement('div');
  note.className = 'fb-note';
  note.textContent = t('play.view_fallback');
  el.appendChild(note);
  const ctx2 = cv.getContext('2d');
  let world = null;
  let rec = null;
  let F = null;
  let ghostF = null;
  let tNow = 0;
  let overlays = { trail: true, ghost: true, arrow: true, lidar: true };
  let wiggle = 0;
  let raf = 0;
  let bounds = { x0: -2, x1: 2, y0: -1, y1: 4 };

  function fit() {
    const pts = [[0, 0]];
    if (world) {
      const s = world.start || { x: 0, y: 0 };
      pts.push([s.x, s.y]);
      for (const o of world.objects || []) {
        if (Number.isFinite(o.x)) pts.push([o.x, o.y]);
        if (Number.isFinite(o.x1)) pts.push([o.x1, o.y1], [o.x2, o.y2]);
        if (Array.isArray(o.rect)) pts.push([o.rect[0], o.rect[1]], [o.rect[2], o.rect[3]]);
        if (Array.isArray(o.circle)) pts.push([o.circle[0] - o.circle[2], o.circle[1] - o.circle[2]], [o.circle[0] + o.circle[2], o.circle[1] + o.circle[2]]);
      }
    }
    if (F) for (let i = 0; i < F.n; i += 10) if (Number.isFinite(F.col.x[i])) pts.push([F.col.x[i], F.col.y[i]]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = Math.max(0.8, 0.12 * Math.max(x1 - x0, y1 - y0));
    bounds = { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
  }

  function draw() {
    raf = 0;
    const r = el.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const W = Math.max(50, Math.round(r.width));
    const H = Math.max(50, Math.round(r.height));
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const c = ctx2;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 地面（芝。会場が砂なら砂）
    const sandy = world && /lunar|ura/.test(world.venue_key || '');
    c.fillStyle = sandy ? '#d9c79f' : '#8fb067';
    c.fillRect(0, 0, W, H);
    const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
    const s = Math.min(W / bw, H / bh);
    const ox = (W - bw * s) / 2, oy = (H - bh * s) / 2;
    const X = (x) => ox + (x - bounds.x0) * s;
    const Y = (y) => H - (oy + (y - bounds.y0) * s);
    // 1 m の目盛り
    c.strokeStyle = 'rgba(255,255,255,.18)';
    c.lineWidth = 1;
    for (let gx = Math.ceil(bounds.x0); gx <= bounds.x1; gx++) { c.beginPath(); c.moveTo(X(gx), 0); c.lineTo(X(gx), H); c.stroke(); }
    for (let gy = Math.ceil(bounds.y0); gy <= bounds.y1; gy++) { c.beginPath(); c.moveTo(0, Y(gy)); c.lineTo(W, Y(gy)); c.stroke(); }
    // 物
    for (const o of (world && world.objects) || []) {
      if (o.type === 'area') {
        c.fillStyle = o.kind === 'pond' ? '#5f9a9a' : o.kind === 'hill' ? '#8c7a5b' : o.kind === 'slope' ? 'rgba(120,100,60,.25)' : '#e3d3a8';
        if (Array.isArray(o.rect)) c.fillRect(X(o.rect[0]), Y(o.rect[3]), (o.rect[2] - o.rect[0]) * s, (o.rect[3] - o.rect[1]) * s);
        else if (Array.isArray(o.circle)) { c.beginPath(); c.arc(X(o.circle[0]), Y(o.circle[1]), o.circle[2] * s, 0, Math.PI * 2); c.fill(); }
        else if (Array.isArray(o.poly)) { c.beginPath(); o.poly.forEach(([px, py], i) => (i ? c.lineTo(X(px), Y(py)) : c.moveTo(X(px), Y(py)))); c.closePath(); c.fill(); }
      }
    }
    for (const o of (world && world.objects) || []) {
      if (o.type === 'wall' || o.type === 'hedge') {
        c.strokeStyle = o.type === 'hedge' ? '#3f6b2a' : '#7a7f84'; c.lineWidth = Math.max(3, 0.12 * s);
        c.beginPath(); c.moveTo(X(o.x1), Y(o.y1)); c.lineTo(X(o.x2), Y(o.y2)); c.stroke();
      } else if (o.type === 'line') {
        c.strokeStyle = 'rgba(255,255,255,.6)'; c.setLineDash([4, 4]); c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(X(o.x1), Y(o.y1)); c.lineTo(X(o.x2), Y(o.y2)); c.stroke(); c.setLineDash([]);
      } else if (o.type === 'cone') {
        const rr = (o.r || 0.19) * s;
        c.fillStyle = '#d9672b'; c.beginPath(); c.arc(X(o.x), Y(o.y), rr, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#fffdf8'; c.lineWidth = Math.max(1.5, rr * 0.25); c.beginPath(); c.arc(X(o.x), Y(o.y), rr * 0.55, 0, Math.PI * 2); c.stroke();
      } else if (o.type === 'rock') {
        c.fillStyle = '#9a9690'; c.beginPath(); c.arc(X(o.x), Y(o.y), (o.r || 0.2) * s, 0, Math.PI * 2); c.fill();
      } else if (o.type === 'flag' || o.type === 'marker') {
        c.strokeStyle = '#23313a'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(o.x), Y(o.y)); c.lineTo(X(o.x), Y(o.y) - 16); c.stroke();
        c.fillStyle = o.type === 'marker' ? '#23313a' : '#e9a326'; c.beginPath(); c.moveTo(X(o.x), Y(o.y) - 16); c.lineTo(X(o.x) + 11, Y(o.y) - 12); c.lineTo(X(o.x), Y(o.y) - 8); c.fill();
        c.fillStyle = '#23313a'; c.font = '12px "Noto Sans JP", sans-serif'; c.fillText(o.label || o.id || '', X(o.x) + 6, Y(o.y) + 14);
      }
    }
    // 前回の跡（白い細い破線）
    if (ghostF && overlays.ghost) path(c, ghostF, ghostF.T, X, Y, 'rgba(255,255,255,.85)', 1.5, [5, 5]);
    // 今回の跡（黄土色の実線）
    if (F && overlays.trail !== false) path(c, F, tNow, X, Y, '#a8742a', 3, []);
    // ローバー
    const sStart = (world && world.start) || { x: 0, y: 0, heading: 0 };
    const p = F ? poseAt(F, tNow) : { x: sStart.x, y: sStart.y, h: sStart.heading || 0 };
    if (p && Number.isFinite(p.x)) {
      const hr = ((p.h || 0) + (wiggle ? Math.sin(performance.now() / 60) * 6 * wiggle : 0)) * Math.PI / 180;
      const R = Math.max(6, 0.12 * s);
      c.save();
      c.translate(X(p.x), Y(p.y));
      c.rotate(hr);
      c.fillStyle = '#eef0ea'; c.strokeStyle = '#2a3238'; c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = '#2a3238'; c.fillRect(-R - 2, -R * 0.55, 4, R * 1.1); c.fillRect(R - 2, -R * 0.55, 4, R * 1.1);
      c.fillStyle = '#d9672b'; c.beginPath(); c.moveTo(0, -R - 5); c.lineTo(-4, -R + 2); c.lineTo(4, -R + 2); c.fill();
      c.restore();
      // 止まった所から目標への矢印と cm の札
      if (overlays.arrow && F && tNow >= F.T - 1e-6) {
        const cone = ((world && world.objects) || []).find((o) => o.type === 'cone');
        if (cone) {
          const dx = cone.x - p.x, dy = cone.y - p.y;
          const d = Math.hypot(dx, dy) - (cone.r || 0.19) - 0.12;
          if (d > 0.02) {
            c.strokeStyle = '#23313a'; c.lineWidth = 1.5; c.setLineDash([3, 3]);
            c.beginPath(); c.moveTo(X(p.x), Y(p.y)); c.lineTo(X(cone.x), Y(cone.y)); c.stroke(); c.setLineDash([]);
            const label = d >= 1 ? `${d.toFixed(1)} m` : `${Math.round(d * 100)} cm`;
            c.font = '12px "BIZ UDGothic", monospace';
            const tw = c.measureText(label).width + 10;
            const mx = (X(p.x) + X(cone.x)) / 2, my = (Y(p.y) + Y(cone.y)) / 2;
            c.fillStyle = '#fffdf8'; c.fillRect(mx - tw / 2, my - 10, tw, 20);
            c.fillStyle = '#23313a'; c.fillText(label, mx - tw / 2 + 5, my + 4);
          }
        }
      }
    }
    if (wiggle) { wiggle = Math.max(0, wiggle - 0.02); raf = requestAnimationFrame(draw); }
  }
  function path(c, G, upto, X, Y, color, w, dash) {
    c.strokeStyle = color; c.lineWidth = w; c.setLineDash(dash); c.lineJoin = 'round';
    c.beginPath();
    let started = false;
    for (let i = 0; i < G.n && G.col.t[i] <= upto + 1e-9; i++) {
      const x = G.col.x[i], y = G.col.y[i];
      if (!Number.isFinite(x)) continue;
      if (!started) { c.moveTo(X(x), Y(y)); started = true; } else c.lineTo(X(x), Y(y));
    }
    c.stroke(); c.setLineDash([]);
  }
  const req = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(req) : null;
  if (ro) ro.observe(el);

  return {
    fallback: true,
    loadWorld(w) { world = w; F = null; ghostF = null; tNow = 0; fit(); req(); },
    setRecord(r, o = {}) { rec = r; F = r ? readFrames(r) : null; ghostF = o.ghost ? readFrames(o.ghost) : null; tNow = 0; fit(); req(); },
    setTime(tt) { tNow = tt; req(); },
    setCamera() { /* 上から見た図だけ */ },
    setOverlays(o) { overlays = { ...overlays, ...o }; req(); },
    celebrate(kind) { if (kind === 'wiggle' || kind === 'tilt') { wiggle = 1; req(); } },
    resize: req,
    dispose() { if (ro) ro.disconnect(); if (raf) cancelAnimationFrame(raf); cv.remove(); note.remove(); },
    get record() { return rec; },
  };
}

/**
 * 簡単な再生（W5 の Player と同じ窓口: play・pause・toggle・seek・toEnd・step・nudge・setSpeed・on・destroy・duration）。
 * @param {object} record @param {{speed?: number|'line'|'result'}} [o]
 */
export class SimplePlayer {
  constructor(record, { speed = 1 } = {}) {
    this.rec = record;
    this.F = readFrames(record);
    this.duration = Math.max(this.F.T, record && record.programEndT ? record.programEndT : 0);
    this.t = 0;
    this.speed = speed;
    this._fns = { time: new Set(), line: new Set(), end: new Set(), state: new Set(), speed: new Set() };
    this._playing = false;
    this._raf = 0;
    this._last = 0;
    this._line = null;
  }
  get playing() { return this._playing; }
  on(name, fn) { (this._fns[name] || (this._fns[name] = new Set())).add(fn); return () => this._fns[name].delete(fn); }
  _emit(name, v) { for (const f of [...(this._fns[name] || [])]) { try { f(v); } catch (e) { console.error(e); } } }
  _apply(tt) {
    this.t = Math.max(0, Math.min(this.duration, tt));
    this._emit('time', this.t);
    const ln = lineAtRec(this.rec, this.t);
    if (ln !== this._line) { this._line = ln; this._emit('line', ln); }
  }
  play() {
    if (this.speed === 'result') { this.toEnd(); return; }
    if (this.t >= this.duration) this._apply(0);
    this._playing = true;
    this._emit('state', 'playing');
    this._last = performance.now();
    const k = this.speed === 'line' ? 0.6 : Number(this.speed) || 1;
    const fitK = this.duration / k > 40 ? this.duration / 40 : k;
    const step = (now) => {
      if (!this._playing) return;
      const dt = (now - this._last) / 1000;
      this._last = now;
      this._apply(this.t + dt * fitK);
      if (this.t >= this.duration) { this._finish(); return; }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  _finish() { this._playing = false; this._emit('state', 'ended'); this._emit('end'); }
  pause() { this._playing = false; if (this._raf) cancelAnimationFrame(this._raf); this._emit('state', 'paused'); }
  toggle() { if (this._playing) this.pause(); else this.play(); }
  seek(tt) { this._apply(tt); }
  toEnd() { this.pause(); this._apply(this.duration); this._finish(); }
  step(dir) { this.pause(); this._apply(this.t + dir * 0.02); }
  nudge(dir) { this.pause(); this._apply(this.t + dir * 0.05 * this.duration); }
  setSpeed(s) { this.speed = s; this._emit('speed', s); if (this._playing) { this.pause(); this.play(); } }
  destroy() { this.pause(); for (const k of Object.keys(this._fns)) this._fns[k].clear(); }
}

/**
 * 簡単な時間のつまみ（W5 の Timeline の代わり）。再生・一時停止・速さ・つまみ・今の時刻。
 * @param {HTMLElement} el @param {object} record @param {object} level @param {SimplePlayer} player
 */
export class SimpleTimeline {
  constructor(el, record, level, player) {
    this.el = el;
    this.player = player;
    el.classList.add('timeline');
    el.innerHTML = `<button type="button" class="tl-play" aria-label="再生">▶&#xFE0E;</button>
      <label class="tl-speed"><span class="sr-only">速さ</span><select>
        <option value="line">行ごと</option><option value="0.5">×0.5</option><option value="1">×1</option><option value="2">×2</option><option value="4">×4</option><option value="8">×8</option><option value="16">×16</option><option value="result">${t('button.result_only')}</option>
      </select></label>
      <div class="track"><input type="range" min="0" max="1000" value="0" aria-label="再生の時刻"></div>
      <span class="time">0.0 s</span>`;
    this.range = el.querySelector('input[type=range]');
    this.timeEl = el.querySelector('.time');
    this.btn = el.querySelector('.tl-play');
    this.sel = el.querySelector('select');
    this.sel.value = String(player.speed);
    this.btn.addEventListener('click', () => player.toggle());
    this.sel.addEventListener('change', () => { const v = this.sel.value; player.setSpeed(v === 'line' || v === 'result' ? v : Number(v)); });
    this.range.addEventListener('input', () => player.seek(this.range.value / 1000 * player.duration));
    this._offs = [
      player.on('time', (tt) => { this.range.value = String(player.duration ? Math.round(tt / player.duration * 1000) : 0); this.timeEl.textContent = `${tt.toFixed(1)} s`; }),
      player.on('state', (s) => { const p = s === 'playing'; this.btn.textContent = p ? '❚❚' : '▶︎'; this.btn.setAttribute('aria-label', p ? '一時停止' : '再生'); }),
    ];
  }
  setRecord() { /* 世界の切りかえは play.js が Player を作り直す */ }
  destroy() { for (const off of this._offs) off(); this.el.innerHTML = ''; }
}
