/**
 * @file app/js/screens/free.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 自由走行場（1 章クリアで開く）: 会場を選ぶ・物を置く／動かす／消す・世界の厳しさ 3 段・投下・センサの故障・保存 20 個・
 *       JSON の書き出しと読み込み（validateWorld で確かめる）・理想と現実を重ねる。判定はない（任意で「コーンの○ cm 以内」の目標）。
 * SPEC: 3.8・6.10（世界の書き方）・7.4（job の mode: free）・2.5（使える命令は、それまでに開いた全部）
 */

import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';
import { createFallbackEditor } from '../ui/fallback_editor.js';
import { SimplePlayer, SimpleTimeline, readFrames, poseAt } from '../ui/fallback_view.js';
import { createFallbackCard } from '../ui/fallback_card.js';
import { tipEl } from '../ui/senpai.js';

export const FILE_MAX = 200 * 1024;
export const OBJ_MAX = 200;
export const TIME_MAX = 1200;
export const TIME_DEFAULT = 300;

const TOOLS = ['select', 'cone', 'rock', 'wall', 'flag', 'sand', 'start', 'erase'];
const TOOL_ICON = { select: 'move', cone: 'cone', rock: 'rock', wall: 'wall', flag: 'flag', sand: 'sand', start: 'start', erase: 'erase' };

/** 厳しさごとのセンサと機体（6.7・6.8 の数。現実は会場の既定、本番は 10 章なみ）。 */
export function strictPreset(kind, venue) {
  if (kind === 'ideal') {
    return { sensor: { lidar_noise: 0, heading_noise: 0, heading_bias: 0, gnss_sigma: 0, gnss_tau: 30, gnss_white: 0, gnss_latency: 0.3, gnss_ttff: 1, cam_angle_noise: 0, cam_miss: 0, cam_false: 0, alt_noise: 0 },
      motor: { left: 1, right: 1 }, ground: { speed: 1, slip: 0, turn: 1 } };
  }
  const base = (venue && venue.sensor) || {};
  if (kind === 'final') {
    return { sensor: { lidar_noise: 0.02, heading_noise: 1.5, heading_bias: 2, gnss_sigma: 2.0, gnss_tau: 300, gnss_white: 0.6, gnss_latency: 0.3, gnss_ttff: 1, cam_angle_noise: 1.0, cam_miss: 0.08, cam_false: 0.01, alt_noise: 0.1, ...base },
      motor: { left: 1, right: 0.94 }, ground: { speed: 0.9, slip: 0.02, turn: 0.8, ...((venue && venue.ground) || {}) } };
  }
  return { sensor: { lidar_noise: 0.02, heading_noise: 1.5, heading_bias: 0, gnss_sigma: 1.5, gnss_tau: 300, gnss_white: 0.6, gnss_latency: 0.3, gnss_ttff: 1, cam_angle_noise: 1.0, cam_miss: 0.05, cam_false: 0.01, alt_noise: 0.1, ...base },
    motor: { left: 1, right: 0.96 }, ground: { speed: 1, slip: 0, turn: 1, ...((venue && venue.ground) || {}) } };
}

/**
 * 読み込んだ場面のファイルを確かめる（3.8〔1.1〕: 物は 200 個まで・ファイルは 200 KB まで・制限時間は 1200 s まで）。
 * @param {string} text @param {(w: object) => string[]} [validateWorld] W1 の validateWorld（無ければ形だけ見る）
 * @returns {{ok: true, scene: object}|{ok: false, why: string}}
 */
export function checkSceneFile(text, validateWorld) {
  if (typeof text !== 'string') return { ok: false, why: 'ファイル' };
  if (text.length > FILE_MAX) return { ok: false, why: '200 KB より小さいファイル' };
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, why: 'JSON の形' }; }
  if (!j || typeof j !== 'object') return { ok: false, why: '場面の形' };
  const w = j.world;
  if (!w || typeof w !== 'object') return { ok: false, why: 'world' };
  if (!Array.isArray(w.objects)) return { ok: false, why: 'world.objects' };
  if (w.objects.length > OBJ_MAX) return { ok: false, why: `物を ${OBJ_MAX} 個まで` };
  if (!w.start || !Number.isFinite(w.start.x) || !Number.isFinite(w.start.y)) return { ok: false, why: 'world.start' };
  const tl = Number.isFinite(w.time_limit) ? w.time_limit : TIME_DEFAULT;
  const world = { ...w, time_limit: Math.min(TIME_MAX, Math.max(1, tl)) };
  if (typeof validateWorld === 'function') {
    let errs = [];
    try { errs = validateWorld(world) || []; } catch (e) { errs = [String(e && e.message || e)]; }
    if (errs.length) return { ok: false, why: String(errs[0]).slice(0, 60) };
  }
  return { ok: true, scene: { name: typeof j.name === 'string' ? j.name.slice(0, 40) : '読み込んだ場面', venue_key: typeof j.venue_key === 'string' ? j.venue_key : w.venue_key || 'funabashi',
    strict: ['ideal', 'real', 'final'].includes(j.strict) ? j.strict : 'real', world, code: typeof j.code === 'string' ? j.code.slice(0, 60 * 1024) : '' } };
}

/**
 * @param {HTMLElement} root @param {object} app @param {string|null} param
 */
export async function mount(root, app, param) {
  const { t, store, progress } = app;
  app.header.set({ place: t('free.title') });
  if (!progress.features().free) {
    root.innerHTML = `<div class="screen-msg card"><h1>${esc(t('free.locked'))}</h1><p><button type="button" class="btn primary" data-go>${icon('map')}<span>${esc(t('button.map'))}</span></button></p></div>`;
    root.querySelector('[data-go]').addEventListener('click', () => app.go('#/map'));
    return { unmount() {} };
  }
  const [venuesJ, api] = await Promise.all([app.lazy('venues'), app.lazy('api')]);
  const deps = await app.deps;
  const venues = (venuesJ && venuesJ.venues) || {};
  const openVenues = Object.entries(venues).filter(([, v]) => (v.chapters || []).some((c) => progress.isChapterUnlocked(c)));
  const fns = (api && api.functions) || {};
  const equipped = Object.entries(fns).filter(([, f]) => !f.unlock || progress.isUnlocked(f.unlock)).map(([n]) => n).filter((n) => n !== 'distance_to_cone' || !progress.isChapterCleared(3));

  // 場面の状態
  let st = {
    name: '', venue_key: (openVenues[0] && openVenues[0][0]) || 'bushitsu', strict: 'real', drop: false,
    broken: { lidar: false, camera: false, heading: false }, target: 0, seed: (Date.now() >>> 0),
    world: { start: { x: 0, y: 0, heading: 0 }, time_limit: TIME_DEFAULT, objects: [{ id: 'cone', type: 'cone', x: 0, y: 4, r: 0.19 }] },
    code: app.pendingFreeCode || '# 自由に走らせてみよう\nmotor(0.5, 0.5)\nwait(3)\nstop()\n',
  };
  app.pendingFreeCode = null;
  let tool = 'select';
  let sel = null;

  root.innerHTML = `<div class="page free">
    <h1>${icon('flag')}<span>${esc(t('free.title'))}</span></h1>
    <div class="free-grid">
      <section class="free-side card">
        <label class="fld"><span>${esc(t('free.venue'))}</span><select class="venue">${openVenues.map(([k, v]) => `<option value="${esc(k)}">${esc(v.name || k)}</option>`).join('')}</select></label>
        <fieldset class="tools"><legend>${esc(t('free.tools'))}</legend>
          ${TOOLS.map((k) => `<button type="button" class="tool" data-tool="${k}" aria-pressed="${k === tool}">${icon(TOOL_ICON[k])}<span>${esc(t(`free.tool_${k}`))}</span></button>`).join('')}
        </fieldset>
        <label class="fld"><span class="hd-label"></span><input type="range" class="heading" min="0" max="359" step="1" value="0"></label>
        <fieldset><legend>${esc(t('free.strict'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('free.strict'))}">${['ideal', 'real', 'final'].map((k) => `<label class="opt"><input type="radio" name="strict" value="${k}"${k === st.strict ? ' checked' : ''}> <span>${esc(t(`free.strict_${k}`))}</span></label>`).join('')}</div>
        </fieldset>
        <fieldset><legend>${esc(t('free.drop'))}</legend>
          <label class="opt"><input type="checkbox" class="drop"> <span>${esc(t('free.drop_on'))}</span></label>
        </fieldset>
        <fieldset><legend>${esc(t('free.broken'))}</legend>
          ${['lidar', 'camera', 'heading'].map((k) => `<label class="opt"><input type="checkbox" class="broken" value="${k}"> <span>${esc(t(`free.broken_${k}`))}</span></label>`).join('')}
        </fieldset>
        <label class="fld"><span class="tg-label"></span><input type="range" class="target" min="0" max="100" step="5" value="0"></label>
        <div class="save-box">
          <label class="fld"><span>${esc(t('free.name'))}</span><input type="text" class="sname" maxlength="40"></label>
          <div class="row"><button type="button" class="btn small" data-a="save">${icon('download')}<span>${esc(t('button.save'))}</span></button>
            <button type="button" class="btn small" data-a="export">${icon('download')}<span>${esc(t('button.export'))}</span></button>
            <label class="btn small file-btn">${icon('upload')}<span>${esc(t('button.import'))}</span><input type="file" class="sr-only imp" accept="application/json,.json"></label></div>
          <h3 class="saved-h"></h3><ul class="saved"></ul>
        </div>
      </section>
      <section class="free-main">
        <div class="free-view"><canvas class="free-canvas" tabindex="0" aria-label="${esc(t('free.map_label'))}"></canvas><div class="free-3d" hidden></div><p class="free-help note small">${esc(t('free.kb_help'))}</p>
          <div class="camsw free-mode" role="group" aria-label="${esc(t('free.view_label'))}"><button type="button" data-fv="2d" aria-pressed="true">${esc(t('free.view_2d'))}</button><button type="button" data-fv="3d" aria-pressed="false">${esc(t('free.view_3d'))}</button></div></div>
        <div class="tl-host"><div class="tl-empty"><span>${esc(t('play.tl_empty'))}</span><i class="tl-rail" aria-hidden="true"></i></div></div>
        <div class="free-work">
          <div class="editor"><div class="etop"><span class="file">main.py</span>
            <button class="btn-dark" type="button" data-a="overlay">${esc(t('button.overlay_ideal'))}</button>
            <button class="btn-dark" type="button" data-a="stop" disabled>${icon('stop')}<span>${esc(t('button.stop'))}</span></button>
            <button class="btn-run" type="button" data-a="run">▶&#xFE0E; ${esc(t('button.run'))}</button></div><div class="editor-host"></div></div>
          <div class="console"><h2 class="console-h">${esc(t('play.output'))}</h2><div class="log" role="log"></div><div class="sr-only result-live" aria-live="polite"></div></div>
        </div>
      </section>
    </div>
  </div>`;
  const q = (s) => root.querySelector(s);
  const cv = q('.free-canvas');
  const c2 = cv.getContext('2d');

  // エディタ
  let editor = null;
  const edOpts = { lang: 'python', value: st.code, mode: 'free', palette: equipped.filter((n) => fns[n] && fns[n].palette).map((n) => ({ label: fns[n].palette, insert: fns[n].palette, summary: fns[n].summary || '', name: n })), fontSize: store.settings().editorFont };
  if (deps.createEditor) { try { editor = deps.createEditor(q('.editor-host'), edOpts); } catch { editor = null; q('.editor-host').innerHTML = ''; } }
  if (!editor) editor = createFallbackEditor(q('.editor-host'), edOpts);
  editor.on('change', () => { st.code = editor.getCode(); });
  editor.on('run', () => run(false));

  // 図
  const B = { x0: -8, x1: 8, y0: -3, y1: 15 };
  let trails = { real: null, ideal: null };
  let tNow = Infinity;
  let player = null;
  let timeline = null;
  function view() {
    const r = cv.getBoundingClientRect();
    const W = Math.max(100, r.width);
    const H = Math.max(100, r.height);
    const s = Math.min(W / (B.x1 - B.x0), H / (B.y1 - B.y0));
    const ox = (W - (B.x1 - B.x0) * s) / 2;
    const oy = (H - (B.y1 - B.y0) * s) / 2;
    return { W, H, s, X: (x) => ox + (x - B.x0) * s, Y: (y) => H - (oy + (y - B.y0) * s), ix: (px) => B.x0 + (px - ox) / s, iy: (py) => B.y0 + (H - py - oy) / s };
  }
  function draw() {
    const v = view();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    // 幅だけでなく高さが変わった時も描き直す（方眼が縦にのびて、間かくがそろっていなかった。直し C16）
    if (cv.width !== Math.round(v.W * dpr) || cv.height !== Math.round(v.H * dpr)) { cv.width = Math.round(v.W * dpr); cv.height = Math.round(v.H * dpr); }
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const venue = venues[st.venue_key] || {};
    c2.fillStyle = /lunar|takezaki/.test(st.venue_key) ? '#d9c79f' : '#8fb067';
    c2.fillRect(0, 0, v.W, v.H);
    c2.strokeStyle = 'rgba(255,255,255,.2)';
    c2.lineWidth = 1;
    for (let x = Math.ceil(B.x0); x <= B.x1; x++) { c2.beginPath(); c2.moveTo(v.X(x), 0); c2.lineTo(v.X(x), v.H); c2.stroke(); }
    for (let y = Math.ceil(B.y0); y <= B.y1; y++) { c2.beginPath(); c2.moveTo(0, v.Y(y)); c2.lineTo(v.W, v.Y(y)); c2.stroke(); }
    void venue;
    for (const o of st.world.objects) {
      const on = sel === o;
      if (o.type === 'area') { c2.fillStyle = '#e3d3a8'; c2.fillRect(v.X(o.rect[0]), v.Y(o.rect[3]), (o.rect[2] - o.rect[0]) * v.s, (o.rect[3] - o.rect[1]) * v.s); }
      if (o.type === 'wall') { c2.strokeStyle = '#7a7f84'; c2.lineWidth = Math.max(3, 0.1 * v.s); c2.beginPath(); c2.moveTo(v.X(o.x1), v.Y(o.y1)); c2.lineTo(v.X(o.x2), v.Y(o.y2)); c2.stroke(); }
      if (o.type === 'cone') { c2.fillStyle = '#d9672b'; c2.beginPath(); c2.arc(v.X(o.x), v.Y(o.y), o.r * v.s, 0, 7); c2.fill(); }
      if (o.type === 'rock') { c2.fillStyle = '#9a9690'; c2.beginPath(); c2.arc(v.X(o.x), v.Y(o.y), o.r * v.s, 0, 7); c2.fill(); }
      if (o.type === 'flag') { c2.fillStyle = '#e9a326'; c2.beginPath(); c2.moveTo(v.X(o.x), v.Y(o.y) - 14); c2.lineTo(v.X(o.x) + 10, v.Y(o.y) - 10); c2.lineTo(v.X(o.x), v.Y(o.y) - 6); c2.fill(); c2.strokeStyle = '#23313a'; c2.beginPath(); c2.moveTo(v.X(o.x), v.Y(o.y)); c2.lineTo(v.X(o.x), v.Y(o.y) - 14); c2.stroke(); }
      if (on) { const p = centerOf(o); c2.strokeStyle = '#23313a'; c2.setLineDash([4, 3]); c2.lineWidth = 1.5; c2.beginPath(); c2.arc(v.X(p.x), v.Y(p.y), 14, 0, 7); c2.stroke(); c2.setLineDash([]); }
    }
    if (st.target > 0) {
      const cone = st.world.objects.find((o) => o.type === 'cone');
      if (cone) { c2.strokeStyle = 'rgba(35,49,58,.6)'; c2.setLineDash([6, 4]); c2.beginPath(); c2.arc(v.X(cone.x), v.Y(cone.y), (cone.r + 0.12 + st.target / 100) * v.s, 0, 7); c2.stroke(); c2.setLineDash([]); }
    }
    const line = (F, upto, color, w, dash) => {
      if (!F) return;
      c2.strokeStyle = color; c2.lineWidth = w; c2.setLineDash(dash); c2.beginPath();
      let st0 = false;
      for (let i = 0; i < F.n && F.col.t[i] <= upto; i++) { const x = F.col.x[i], y = F.col.y[i]; if (!Number.isFinite(x)) continue; if (!st0) { c2.moveTo(v.X(x), v.Y(y)); st0 = true; } else c2.lineTo(v.X(x), v.Y(y)); }
      c2.stroke(); c2.setLineDash([]);
    };
    line(trails.ideal, Infinity, 'rgba(255,255,255,.9)', 2, [6, 4]);
    line(trails.real, tNow, '#a8742a', 3, []);
    const sp = st.world.start;
    const p = trails.real && Number.isFinite(tNow) ? poseAt(trails.real, tNow) : null;
    const rx = p ? p.x : sp.x, ry = p ? p.y : sp.y, rh = p ? p.h : sp.heading;
    c2.save(); c2.translate(v.X(rx), v.Y(ry)); c2.rotate(rh * Math.PI / 180);
    const R = Math.max(6, 0.12 * v.s);
    c2.fillStyle = '#eef0ea'; c2.strokeStyle = '#2a3238'; c2.lineWidth = 2; c2.beginPath(); c2.arc(0, 0, R, 0, 7); c2.fill(); c2.stroke();
    c2.fillStyle = '#d9672b'; c2.beginPath(); c2.moveTo(0, -R - 6); c2.lineTo(-4, -R + 1); c2.lineTo(4, -R + 1); c2.fill();
    c2.restore();
  }
  const centerOf = (o) => (o.type === 'wall' ? { x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 } : o.type === 'area' ? { x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 } : { x: o.x, y: o.y });
  function hit(x, y) {
    let best = null; let bd = 0.6;
    for (const o of st.world.objects) { const c = centerOf(o); const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = o; } }
    return best;
  }
  const nextId = (p) => { let i = 1; while (st.world.objects.some((o) => o.id === `${p}${i}`)) i++; return `${p}${i}`; };
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    const v = view();
    const r = cv.getBoundingClientRect();
    const x = Math.round(v.ix(e.clientX - r.left) * 10) / 10;
    const y = Math.round(v.iy(e.clientY - r.top) * 10) / 10;
    cv.setPointerCapture(e.pointerId);
    if (tool === 'select') { sel = hit(x, y); drag = sel ? { kind: 'move', x, y } : null; }
    else if (tool === 'erase') { const o = hit(x, y); if (o) st.world.objects = st.world.objects.filter((z) => z !== o); sel = null; }
    else if (tool === 'start') { st.world.start = { ...st.world.start, x, y }; }
    else if (st.world.objects.length >= OBJ_MAX) { app.toast(t('free.obj_max', { n: OBJ_MAX })); }
    else if (tool === 'cone') { const o = { id: st.world.objects.some((z) => z.id === 'cone') ? nextId('cone') : 'cone', type: 'cone', x, y, r: 0.19 }; st.world.objects.push(o); sel = o; }
    else if (tool === 'rock') { const o = { id: nextId('r'), type: 'rock', x, y, r: 0.25, h: 0.3 }; st.world.objects.push(o); sel = o; }
    else if (tool === 'flag') { const o = { id: nextId('f'), type: 'flag', x, y, label: '' }; st.world.objects.push(o); sel = o; }
    else if (tool === 'wall') { const o = { id: nextId('w'), type: 'wall', x1: x, y1: y, x2: x + 0.1, y2: y }; st.world.objects.push(o); sel = o; drag = { kind: 'wall', o }; }
    else if (tool === 'sand') { const o = { id: nextId('s'), type: 'area', kind: 'sand', rect: [x, y, x + 0.1, y + 0.1], speed: 0.6, slip: 0.02 }; st.world.objects.push(o); sel = o; drag = { kind: 'sand', o, x, y }; }
    trails = { real: null, ideal: null };
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const v = view();
    const r = cv.getBoundingClientRect();
    const x = Math.round(v.ix(e.clientX - r.left) * 10) / 10;
    const y = Math.round(v.iy(e.clientY - r.top) * 10) / 10;
    if (drag.kind === 'move' && sel) moveBy(sel, x - drag.x, y - drag.y), (drag.x = x), (drag.y = y);
    else if (drag.kind === 'wall') { drag.o.x2 = x; drag.o.y2 = y; }
    else if (drag.kind === 'sand') drag.o.rect = [Math.min(drag.x, x), Math.min(drag.y, y), Math.max(drag.x, x), Math.max(drag.y, y)];
    draw();
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  function moveBy(o, dx, dy) {
    if (o.type === 'wall') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
    else if (o.type === 'area') o.rect = [o.rect[0] + dx, o.rect[1] + dy, o.rect[2] + dx, o.rect[3] + dy];
    else { o.x = Math.round((o.x + dx) * 100) / 100; o.y = Math.round((o.y + dy) * 100) / 100; }
  }
  cv.addEventListener('keydown', (e) => {
    if (!sel) { if (e.key === 'Tab') return; if (/^Arrow/.test(e.key)) { sel = st.world.objects[0] || null; draw(); e.preventDefault(); } return; }
    const d = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft') moveBy(sel, -d, 0);
    else if (e.key === 'ArrowRight') moveBy(sel, d, 0);
    else if (e.key === 'ArrowUp') moveBy(sel, 0, d);
    else if (e.key === 'ArrowDown') moveBy(sel, 0, -d);
    else if (e.key === 'Delete' || e.key === 'Backspace') { st.world.objects = st.world.objects.filter((z) => z !== sel); sel = null; }
    else if (e.key === 'n') { const i = st.world.objects.indexOf(sel); sel = st.world.objects[(i + 1) % st.world.objects.length] || null; }
    else return;
    e.preventDefault();
    draw();
  });

  // 左の欄
  q('.venue').value = st.venue_key;
  const syncLabels = () => {
    q('.hd-label').textContent = t('free.heading', { deg: Math.round(st.world.start.heading) });
    q('.tg-label').textContent = st.target > 0 ? t('free.target', { cm: st.target }) : t('free.target_none');
    q('.saved-h').textContent = t('free.saved_list', { n: store.freeList().length });
  };
  root.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-tool]');
    if (tb) { tool = tb.dataset.tool; for (const b of root.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b === tb)); return; }
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    app.audio.unlock();
    if (a === 'run') run(false);
    else if (a === 'overlay') run(true);
    else if (a === 'stop') { app.bridge.stop(); runSeq++; q('[data-a="stop"]').disabled = true; logLine(t('play.stopped')); }
    else if (a === 'save') saveScene();
    else if (a === 'export') exportScene();
    else if (a === 'open') loadScene(store.freeList().find((x) => x.name === b.dataset.name));
    else if (a === 'del') { store.deleteFree(b.dataset.name); renderSaved(); }
  });
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList.contains('heading')) { st.world.start.heading = Number(el.value); syncLabels(); draw(); }
    if (el.classList.contains('target')) { st.target = Number(el.value); syncLabels(); draw(); }
  });
  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.classList.contains('venue')) { st.venue_key = el.value; draw(); }
    else if (el.name === 'strict') st.strict = el.value;
    else if (el.classList.contains('drop')) st.drop = el.checked;
    else if (el.classList.contains('broken')) st.broken[el.value] = el.checked;
    else if (el.classList.contains('imp') && el.files && el.files[0]) {
      const f = el.files[0];
      el.value = '';
      const r = checkSceneFile(f.size > FILE_MAX ? 'x'.repeat(FILE_MAX + 1) : await f.text(), deps.validateWorld);
      if (!r.ok) { app.toast(t('free.import_bad', { why: r.why })); return; }
      loadScene(r.scene);
      app.toast(t('free.import_done', { name: r.scene.name }));
    }
  });
  function renderSaved() {
    const list = store.freeList();
    q('.saved').innerHTML = list.map((s) => `<li><button type="button" class="linkish" data-a="open" data-name="${esc(s.name)}">${esc(s.name)}</button> <button type="button" class="btn tiny" data-a="del" data-name="${esc(s.name)}" aria-label="${esc(t('button.delete'))} ${esc(s.name)}">${icon('close')}</button></li>`).join('');
    syncLabels();
  }
  function loadScene(s) {
    if (!s) return;
    st = { ...st, name: s.name, venue_key: s.venue_key || st.venue_key, strict: s.strict || 'real', world: JSON.parse(JSON.stringify(s.world)), code: s.code || st.code, seed: Number.isFinite(s.seed) ? s.seed : st.seed };
    st.drop = !!st.world.drop;
    st.broken = { lidar: !!(st.world.sensor && st.world.sensor.lidar_broken), camera: !!(st.world.sensor && st.world.sensor.cam_broken), heading: !!(st.world.sensor && st.world.sensor.heading_broken) };
    q('.sname').value = st.name;
    q('.venue').value = st.venue_key;
    for (const r of root.querySelectorAll('[name="strict"]')) r.checked = r.value === st.strict;
    q('.drop').checked = st.drop;
    for (const c of root.querySelectorAll('.broken')) c.checked = !!st.broken[c.value];
    q('.heading').value = String(st.world.start.heading || 0);
    editor.setCode(st.code);
    trails = { real: null, ideal: null };
    syncLabels();
    draw();
  }
  function buildWorld(strict) {
    const venue = venues[st.venue_key] || {};
    const pre = strictPreset(strict, venue);
    const w = {
      venue: venue.name || st.venue_key, venue_key: st.venue_key, origin: venue.origin || { lat: 35.726195, lon: 140.057112 },
      start: { ...st.world.start }, time_limit: Math.min(TIME_MAX, st.world.time_limit || TIME_DEFAULT), objects: JSON.parse(JSON.stringify(st.world.objects)),
      motor: pre.motor, ground: pre.ground,
      sensor: { ...pre.sensor, lidar_broken: st.broken.lidar, cam_broken: st.broken.camera, heading_broken: st.broken.heading },
      api_off: [],
    };
    if (st.drop) w.drop = { height: 30, release_t: 3, wind_speed: strict === 'ideal' ? 0 : strict === 'final' ? 6 : 3, wind_from: 300, descent: 4.8, inverted: false, land_heading: st.world.start.heading || 0, sep_fail_first: strict === 'final' ? 1 : 0, canopy_dist: 1.2, drag: 0 };
    return w;
  }
  function saveScene() {
    const name = q('.sname').value.trim() || t('free.scene_n', { n: store.freeList().length + 1 });
    const r = store.saveFree({ name, venue_key: st.venue_key, world: buildWorld(st.strict), code: editor.getCode(), strict: st.strict, seed: st.seed });
    if (!r.ok) { app.toast(t('free.full')); return; }
    st.name = name;
    store.flush();
    app.toast(t('free.saved', { name }));
    renderSaved();
  }
  function exportScene() {
    const name = q('.sname').value.trim() || 'scene';
    const text = JSON.stringify({ app: 'ROVER CODE', kind: 'free_scene', version: 1, name, venue_key: st.venue_key, strict: st.strict, world: buildWorld(st.strict), code: editor.getCode() }, null, 1);
    app.downloadText(`rovercode_scene_${name.replace(/[^\w぀-鿿-]+/g, '_')}.json`, text, 'application/json');
    app.toast(t('free.export_done'));
  }

  // 実行（mode: free。判定なし）
  let runSeq = 0;
  async function run(overlay) {
    if (app.bridge.state.state !== 'ready') { app.toast(t('runner.not_ready')); return; }
    const my = ++runSeq;
    q('.log').innerHTML = '';
    q('[data-a="stop"]').disabled = false;
    app.audio.play('run');
    const mk = (strict) => ({ levelId: 'free', chapter: maxChapter(), lang: 'python', code: editor.getCode(), mode: 'free',
      worlds: [{ name: t('free.title'), world: buildWorld(strict), inject: {}, judge: {}, seed: st.seed }], conditions: null, ui: {}, equipped,
      limits: { lineLimit: 2000000, wallLimitS: 8, printCap: 3000, logCap: 20000, eventCap: 20000 }, tailS: 3, keepFrames: 'all', explain: { goal: 'free', goalRadius: 1, expectTurn: null }, varWatch: true });
    try {
      const real = await app.bridge.run(mk(overlay ? 'real' : st.strict), {});
      const ideal = overlay ? await app.bridge.run(mk('ideal'), {}) : null;
      if (my !== runSeq) return;
      q('[data-a="stop"]').disabled = true;
      show(real, ideal);
    } catch (e) {
      if (my !== runSeq) return;
      q('[data-a="stop"]').disabled = true;
      if (!(e && (e.cancelled || e.stopped))) logLine(t('play.fatal'));
    }
  }
  function maxChapter() { let m = 1; for (let n = 1; n <= 10; n++) if (progress.isChapterUnlocked(n)) m = n; return m; }
  function show(rr, ideal) {
    if (rr.compileError) { q('.log').appendChild(createFallbackCard(rr.compileError, { chapter: maxChapter() }).el); app.audio.play('error'); return; }
    const rec = rr.runs && rr.runs[0];
    if (!rec) return;
    trails = { real: readFrames(rec), ideal: ideal && ideal.runs && ideal.runs[0] ? readFrames(ideal.runs[0]) : null };
    if (ideal) logLine(t('free.overlay_note'));
    if (player) player.destroy();
    if (timeline) timeline.destroy();
    const Pl = deps.Player || SimplePlayer;
    try { player = new Pl(rec, { speed: 1 }); } catch { player = new SimplePlayer(rec, { speed: 1 }); }
    timeline = new SimpleTimeline(q('.tl-host'), rec, null, player);
    let shown = 0;
    lastRec = rec;
    if (scene3d) { try { scene3d.loadWorld(buildWorld(st.strict), venues[st.venue_key] || st.venue_key); scene3d.setRecord(rec, {}); } catch (e) { console.warn(e); } }
    player.on('time', (tt) => {
      tNow = tt;
      draw();
      if (scene3d && mode3d) { try { scene3d.setTime(tt); } catch { /* なし */ } }
      const ps = rec.prints || [];
      while (shown < ps.length && ps[shown][0] <= tt) { logLine(`[${ps[shown][0].toFixed(1)} s] ${ps[shown][2]}`); shown++; }
    });
    player.on('end', () => {
      tNow = Infinity;
      draw();
      const card = rec.error || rec.guard;
      if (card) q('.log').appendChild(createFallbackCard(card, { chapter: maxChapter() }).el);
      const cone = st.world.objects.find((o) => o.type === 'cone');
      const f = rec.final || {};
      if (st.target > 0 && cone && Number.isFinite(f.x)) {
        const gap = Math.max(0, Math.hypot(cone.x - f.x, cone.y - f.y) - cone.r - 0.12);
        const ok = gap * 100 <= st.target;
        q('.log').appendChild(tipEl(ok ? t('free.target_ok', { cm: Math.round(gap * 100) }) : t('free.target_ng', { cm: Math.round(gap * 100 - st.target) }), ok ? 'smile' : 'think'));
        q('.result-live').textContent = ok ? t('free.target_ok', { cm: Math.round(gap * 100) }) : t('free.target_ng', { cm: Math.round(gap * 100 - st.target) });
        if (ok) app.audio.play('clear');
      } else q('.result-live').textContent = t('free.no_target');
    });
    player.play();
  }
  function logLine(s) { const d = document.createElement('div'); d.className = 'll'; d.textContent = s; q('.log').appendChild(d); }

  // 3D で見る（置くのは上からの図で。走った後は 3D でも再生できる。直し C16）
  let scene3d = null;
  let mode3d = false;
  let lastRec = null;
  q('.free-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fv]');
    if (!b) return;
    mode3d = b.dataset.fv === '3d';
    for (const x of root.querySelectorAll('.free-mode [data-fv]')) x.setAttribute('aria-pressed', String(x === b));
    q('.free-3d').hidden = !mode3d;
    cv.hidden = mode3d;
    q('.free-help').hidden = mode3d;
    if (mode3d) {
      if (!scene3d && deps.createScene) {
        try { scene3d = deps.createScene(q('.free-3d'), { quality: store.settings().quality || 'auto' }); } catch (err) { console.warn(err); scene3d = null; }
      }
      if (!scene3d) { app.toast(t('free.no_3d')); return; }
      try {
        scene3d.loadWorld(buildWorld(st.strict), venues[st.venue_key] || st.venue_key);
        if (lastRec) { scene3d.setRecord(lastRec, {}); scene3d.setTime(Number.isFinite(tNow) ? tNow : (player ? player.t || 0 : 0)); }
        scene3d.resize && scene3d.resize();
      } catch (err) { console.warn(err); }
    } else draw();
  });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(cv);
  renderSaved();
  syncLabels();
  draw();
  app.keyHandler = (e, ctx) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { run(false); return true; }
    if (e.key === 'Escape' && player && player.playing) { player.toEnd(); return true; }
    if (ctx.free && e.key === ' ' && player) { player.toggle(); return true; }
    return false;
  };
  return { unmount() { runSeq++; if (scene3d) { try { scene3d.dispose(); } catch { /* なし */ } } if (ro) ro.disconnect(); if (player) player.destroy(); if (timeline) timeline.destroy(); if (editor.destroy) editor.destroy(); } };
}
