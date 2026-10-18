/**
 * @file app/js/screens/title.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: タイトル: 背景は静止画から始め、Python の準備のあと 3D に（重い端末・「軽い」・reduced-motion は静止画のまま）。
 *       はじめる／続きから（面の名前つき）＋地図・設定・クレジット、「Python の準備 63%」、初回の 1 行、別のタブ。
 * SPEC: 3.2・2.2・2.3・7.6
 */

import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';
import { failCard } from './loadfail.js';

/**
 * 画面を出す。
 * @param {HTMLElement} root @param {object} app main.js の道具 @param {string|null} param
 * @returns {{unmount: () => void}}
 */
export function mount(root, app, param) {
  const { t, store, progress } = app;
  const d = store.get();
  const hasRecord = Object.values(d.levels).some((L) => L.attempts > 0 || L.cleared || (typeof L.code === 'string' && L.code.length));
  const lastId = (d.last && d.last.levelId) || progress.currentLevel() || '1-1';
  root.innerHTML = `
    <div class="title-bg" aria-hidden="true"><img class="title-still" src="assets/img/title.webp" alt="" decoding="async" fetchpriority="high"></div>
    <div class="title-wrap">
      <h1 class="title-logo">${titleMark()}<span>${esc(t('app.name'))}</span></h1>
      <p class="title-sub">${esc(t('app.subtitle'))}</p>
      <div class="title-actions">
        ${hasRecord
          ? `<button type="button" class="btn big primary" data-act="continue">${icon('play')}<span>${esc(t('button.continue'))}<small class="cont-name"></small></span></button>
             <button type="button" class="btn big" data-act="map">${icon('map')}<span>${esc(t('button.map'))}</span></button>`
          : `<button type="button" class="btn big primary" data-act="start">${icon('play')}<span>${esc(t('button.start'))}</span></button>`}
      </div>
      <div class="title-sub-actions">
        <button type="button" class="btn ghost" data-act="settings">${icon('gear')}<span>${esc(t('button.settings'))}</span></button>
        <button type="button" class="btn ghost" data-act="credits">${icon('info')}<span>${esc(t('button.credits'))}</span></button>
      </div>
      <p class="title-load" aria-live="polite"></p>
      <div class="title-fail"></div>
      ${!hasRecord ? `<p class="title-note">${esc(t('title.first_note'))}</p>` : ''}
      <p class="title-tab" hidden>${esc(t('title.other_tab'))}</p>
      <p class="title-nostore" hidden>${esc(t('title.nostorage'))}</p>
    </div>`;
  const q = (s) => root.querySelector(s);
  // 続きから（面の名前つき）
  if (hasRecord) {
    app.level(lastId).then((L) => {
      const el = q('.cont-name');
      if (el) el.textContent = L ? t('title.continue_level', { id: L.id, title: L.title }) : lastId;
    });
  }
  const offs = [];
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    app.audio.unlock();                          // 2.2: 押す操作で音を起こす
    const act = b.dataset.act;
    if (act === 'start') { store.markUnlocked('1-1'); app.go('#/play/1-1'); }
    else if (act === 'continue') app.go(`#/play/${encodeURIComponent(lastId)}`);
    else if (act === 'map') app.go('#/map');
    else if (act === 'settings') app.go('#/settings');
    else if (act === 'credits') showCredits(app);
  });
  // Python の準備 %
  const loadEl = q('.title-load');
  const failEl = q('.title-fail');
  offs.push(app.bridge.onState((s) => {
    if (s.state === 'loading' || s.state === 'respawn') {
      loadEl.textContent = s.slow ? t('runner.slow', { pct: s.pct || 0 }) : t('title.loading_note', { pct: s.pct || 0 });
      loadEl.hidden = false;
      failEl.innerHTML = '';
    } else if (s.state === 'failed') {
      loadEl.hidden = true;
      failEl.innerHTML = '';
      failEl.appendChild(failCard(app, s.reason));
    } else {
      loadEl.hidden = true;
      failEl.innerHTML = '';
      if (s.state === 'ready') start3D();
    }
  }));
  // 別のタブ・保存できない
  const tabEl = q('.title-tab');
  tabEl.hidden = !store.isReadOnly();
  offs.push(store.on('readonly', () => { tabEl.hidden = false; }));
  offs.push(store.on('owner', () => { tabEl.hidden = true; }));
  q('.title-nostore').hidden = store.canStore();

  // 3D の背景（準備が終わってから。軽い・動きを減らす・重い端末は静止画のまま）
  let scene = null;
  let raf = 0;
  let disposed = false;
  async function start3D() {
    if (scene || disposed) return;
    const s = store.settings();
    const reduce = s.reduceMotion || (globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const weak = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
    if (reduce || s.quality === 'light' || (s.quality === 'auto' && weak)) return;
    const deps = await app.deps;
    if (!deps.createScene || disposed) return;
    try {
      const bg = q('.title-bg');
      const host = document.createElement('div');
      host.className = 'title-3d';
      bg.appendChild(host);
      scene = deps.createScene(host, { quality: s.quality });
      const world = { venue_key: 'bushitsu', start: { x: 0, y: 0, heading: 0 }, objects: [{ id: 'cone', type: 'cone', x: 0.6, y: 4.2, r: 0.19 }], time_limit: 60 };
      const venues = await app.lazy('venues');
      scene.loadWorld(world, venues && venues.venues ? venues.venues.bushitsu : null);
      const rec = demoRecord();
      scene.setRecord(rec, {});
      scene.setCamera('follow');
      const T = rec.frames.length / rec.fields.length * 0.02;
      const t0 = performance.now();
      const loop = (now) => {
        if (disposed) return;
        scene.setTime(((now - t0) / 1000) % T);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      requestAnimationFrame(() => host.classList.add('on'));
    } catch (e) {
      console.warn('タイトルの 3D は出せなかった（静止画のまま）', e);
      scene = null;
    }
  }

  return {
    unmount() {
      disposed = true;
      for (const off of offs) off();
      if (raf) cancelAnimationFrame(raf);
      if (scene) { try { scene.dispose(); } catch { /* なし */ } }
    },
  };
}

/** タイトルのロゴの絵（2 輪）。 */
function titleMark() {
  return '<svg class="title-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="11" cy="26" r="9" fill="#2a3238"/><circle cx="29" cy="26" r="9" fill="#2a3238"/><circle cx="11" cy="26" r="4" fill="#f3ead8"/><circle cx="29" cy="26" r="4" fill="#f3ead8"/><rect x="11" y="15" width="18" height="10" rx="3" fill="#5f8f3e"/><rect x="18" y="8" width="2" height="7" fill="#2a3238"/><circle cx="19" cy="7" r="2.5" fill="#d9672b"/></svg>';
}

/** タイトルの 3D 用: ゆっくり往復するだけの記録（6.11 の形）。 */
export function demoRecord() {
  const fields = ['t', 'x', 'y', 'h', 'v', 'wl', 'wr', 'cmdL', 'cmdR', 'z', 'mode', 'inv', 'cx', 'cy'];
  const frames = [];
  const T = 16;
  for (let i = 0; i <= T * 50; i++) {
    const tt = i * 0.02;
    const u = (tt % T) / T;                         // 0〜1
    // 0〜0.4 前へ・0.4〜0.5 回る・0.5〜0.9 戻る・0.9〜1 回る
    let y; let h; let v;
    if (u < 0.4) { y = 3.2 * (u / 0.4); h = 0; v = 0.5; }
    else if (u < 0.5) { y = 3.2; h = 180 * ((u - 0.4) / 0.1); v = 0; }
    else if (u < 0.9) { y = 3.2 * (1 - (u - 0.5) / 0.4); h = 180; v = 0.5; }
    else { y = 0; h = 180 + 180 * ((u - 0.9) / 0.1); v = 0; }
    frames.push(tt, 0, y, h % 360, v, v, v, v ? 0.45 : 0, v ? 0.45 : 0, 0, 0, 0, NaN, NaN);
  }
  return { world: 0, name: 'タイトル', seed: 1, end: 'end', fields, frames, events: [], segments: [], prints: [], hits: [], lineLog: [[], []], lineCount: 0, varLog: [], phases: [], calls: {}, gnssFixes: [], programEndT: T, final: { t: T } };
}

/** クレジット（3.9・12 章「法と表示」）。 */
export async function showCredits(app) {
  const { t } = app;
  const box = document.createElement('div');
  box.className = 'credits';
  let soundList = t('credits.sound_synth');
  try {
    const r = await fetch(new URL('../../assets/audio/credits.json', import.meta.url));
    const j = await r.json();
    const rec = (j.sounds || []).filter((s) => s.kind === 'recording');
    if (rec.length) soundList = rec.map((s) => `${s.label}（${s.author}・${s.license}）`).join('、');
  } catch { /* 既定の文 */ }
  box.innerHTML = `<p>${esc(t('credits.intro'))}</p><ul>
    <li>${esc(t('credits.pyodide'))}</li><li>${esc(t('credits.codemirror'))}</li><li>${esc(t('credits.three'))}</li>
    <li>${esc(t('credits.fonts'))}</li><li>${esc(t('credits.sound', { list: soundList }))}</li><li>${esc(t('credits.art'))}</li></ul>`;
  app.openDialog({ title: t('title.credits_title'), body: box, actions: [{ label: t('button.close'), value: 'close', primary: true }] });
}
