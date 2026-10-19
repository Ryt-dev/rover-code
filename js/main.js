/**
 * @file app/js/main.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 起動。ページを開いた瞬間に Runner.start()（W2）で Pyodide を読み始め、保存（store.js）を読み、ルータ（router.js）で画面を出す。
 * SPEC: 7.1（全体の図）・7.6（読み込みの順番）・2.1（画面の切りかえ）・2.2（はじめての人の最初の 5 分）・3.1（キー操作）
 *
 * 読み込みの順番（7.6〔1.1〕）:
 *   ① index.html のインラインの CSS と静止画のタイトル（JS を待たずに出る）
 *   ② すぐ Runner.start()（このファイルの一番初めに runner.js を読む）
 *   ③ CodeMirror・three・1 章のレベルは index.html の <link rel="prefetch"> で低い優先度で先に取る
 *   ④ レベルの JSON は章ごと（地図で章を開いた時・遊ぶ画面を開いた時）に読む
 * 画面のモジュールは開く時に読む（タイトルを待たせない）。
 */

import * as store from './store.js';
import * as progress from './progress.js';
import * as audio from './audio.js';
import { createRouter, makeHash } from './router.js';
import { setStrings, t } from './ui/strings.js';
import { createHeader } from './ui/header.js';
import { toast } from './ui/toast.js';
import { openDialog, closeDialog, isOpen as dialogOpen } from './ui/dialog.js';
import { createBridge } from './ui/run_bridge.js';
import { loadDeps } from './ui/deps.js';
import { createWaitBar } from './ui/wait_bar.js';

// ② ページを開いたらすぐ Python の準備を始める（ほかの何より先）
const runnerReady = import('./runner.js').then((m) => m, (e) => { console.warn('runner.js を読めなかった', e); return null; });
const bridgePromise = runnerReady.then((m) => { const b = createBridge(m, bridgeTimes()); b.start(); return b; });

/** テストで「遅い回線」「失敗」までの時間を短くする（?slow_ms=800&fail_ms=3000。ふだんは 15 s・60 s）。 */
function bridgeTimes() {
  try {
    const q = new URLSearchParams(location.search);
    const n = (k) => (q.has(k) && Number(q.get(k)) > 0 ? Number(q.get(k)) : undefined);
    const o = {};
    if (n('slow_ms')) o.slowMs = n('slow_ms');
    if (n('fail_ms')) o.failMs = n('fail_ms');
    return o;
  } catch { return {}; }
}

const DATA = '../data/';
const fetchJSON = async (rel, fallback = null) => {
  try {
    const r = await fetch(new URL(DATA + rel, import.meta.url));
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } catch (e) {
    if (fallback === null) console.warn(`読めなかった: data/${rel}`, e && e.message);
    return fallback;
  }
};

const SCREENS = {
  title: () => import('./screens/title.js'),
  map: () => import('./screens/map.js'),
  play: () => import('./screens/play.js'),
  zukan: () => import('./screens/zukan.js'),
  free: () => import('./screens/free.js'),
  settings: () => import('./screens/settings.js'),
  story: () => import('./screens/story.js'),
  ending: () => import('./screens/ending.js'),
};

/** 章の番号からレベルのファイル名（7.7）。 */
export const levelFile = (no) => (String(no) === 'C' ? 'levels/chC.json' : `levels/ch${String(no).padStart(2, '0')}.json`);

/** アプリを起動する。 */
export async function boot() {
  let root = document.getElementById('app');
  const headerEl = document.getElementById('app-header');

  // 保存を読む（使えなくても遊べる）
  store.load();
  applySettings(store.settings());
  store.requestPersist();

  // 文言と共通のデータ（小さいものだけ先に。ずかん・エラーのルールは開く時）
  const [strings, chapters, titles] = await Promise.all([
    fetchJSON('strings.ja.json', {}), fetchJSON('chapters.json', []), fetchJSON('titles.json', null),
  ]);
  setStrings(strings);
  progress.init({ chapters, titles });

  const levelCache = new Map();     // 章 → Promise<Level[]>
  const app = {
    store, progress, audio, t, toast, openDialog, closeDialog,
    bridge: null,
    deps: null,
    router: null,
    header: null,
    data: { chapters, titles, strings },
    /** 章のレベルを読む。 @param {number|string} no @returns {Promise<object[]>} */
    chapterLevels(no) {
      const k = String(no);
      if (!levelCache.has(k)) levelCache.set(k, fetchJSON(levelFile(no), { levels: [] }).then((j) => (j && Array.isArray(j.levels) ? j.levels : [])));
      return levelCache.get(k);
    },
    /** 面のレベル定義（無ければ null）。 @param {string} id */
    async level(id) {
      const no = progress.chapterNo(id);
      if (no === null) return null;
      const list = await app.chapterLevels(no);
      return list.find((L) => L.id === id) || null;
    },
    /** 遅く読むデータ（ずかん・物語・会場・命令・エラーのルール）。 @param {string} name */
    lazy(name) {
      const files = { zukan: 'zukan.json', story: 'story.json', venues: 'venues.json', api: 'api.json', rules: 'error_rules.json' };
      if (!app.data[`_${name}`]) app.data[`_${name}`] = fetchJSON(files[name], null);
      return app.data[`_${name}`];
    },
    go(hash) { app.router.go(hash); },
    applySettings,
    refreshHeader,
    exportRecord: () => exportRecord(),
    downloadText: (n, x, ty) => downloadText(n, x, ty),
    showKeys: () => showKeys(),
    /** 今の画面のキー操作（play.js などが入れる）。 */
    keyHandler: null,
  };
  globalThis.__rovercode = app;       // テストと調べ物のため（何も送らない）

  app.bridge = await bridgePromise;
  app.deps = loadDeps();              // Promise（遊ぶ画面が待つ）
  app.header = createHeader(headerEl, { go: (h) => app.go(h) });
  refreshHeader();

  // 保存の出来事
  store.on('readonly', () => { toast(t('toast.readonly')); document.body.classList.add('readonly'); });
  store.on('owner', () => { toast(t('toast.owner')); document.body.classList.remove('readonly'); });
  store.on('quota', () => toast(t('toast.quota'), { action: { label: t('button.export'), run: () => exportRecord() } }));
  store.on('trimmed', () => toast(t('toast.quota_trimmed')));
  store.on('nostorage', () => toast(t('toast.cannot_save')));
  store.on('external', () => refreshHeader());
  store.on('change', () => refreshHeader());

  // 画面の切りかえ
  let current = null;   // { name, unmount }
  let seq = 0;
  const screenWait = createWaitBar(document.body, { className: 'screen-wait' });   // 画面の切りかえが 0.5 秒をこえた時だけ（ブラッシュアップ 15）
  // ボタンを押した時の小さな木の音（−18 dB。ブラッシュアップ 13）
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button, .btn, [role="tab"], .opt');
    if (b && !b.disabled && !b.closest('[data-a="run"]')) audio.play('tap');
  }, true);
  const show = async (name, param) => {
    const my = ++seq;
    audio.play('tap');                                      // 画面の切りかえも同じ木の音
    screenWait.start(t('wait.screen'));
    try { await showInner(name, param, my); } finally { if (my === seq) screenWait.stop(); }
  };
  const showInner = async (name, param, my) => {
    if (dialogOpen()) closeDialog(null);
    let mod;
    try { mod = await SCREENS[name](); } catch (e) { console.error(e); mod = await SCREENS.title(); name = 'title'; }
    if (my !== seq) return;
    if (current && current.unmount) { try { current.unmount(); } catch (e) { console.error(e); } }
    app.keyHandler = null;
    // 画面は root にリスナーを付ける（click など）。同じ要素を使い回すと前の画面のリスナーが残り、
    // 例えば ▶ 実行 で前に開いた面の実行まで走るので、画面ごとに #app を作り直す（つなぎ込みで見つけた）
    const fresh = root.cloneNode(false);
    root.replaceWith(fresh);
    root = fresh;
    root.className = `screen screen-${name}`;
    const full = name === 'title' || name === 'story' || name === 'ending';
    app.header.show(!full);
    if (!full) app.header.set({ place: t(`button.${name === 'zukan' ? 'zukan' : name === 'free' ? 'free' : name === 'settings' ? 'settings' : 'map'}`) });
    document.body.dataset.screen = name;
    try {
      const r = await mod.mount(root, app, param);
      current = { name, unmount: r && r.unmount };
    } catch (e) {
      console.error(e);
      current = null;
      root.innerHTML = `<div class="screen-error card"><p>${t('play.level_missing')}</p><p><a href="#/map">${t('button.map')}</a></p></div>`;
    }
    if (name !== 'title') store.setLast(name, name === 'play' ? param : null);
    window.scrollTo(0, 0);
    const h = root.querySelector('h1, [data-autofocus]');
    if (h && document.activeElement === document.body) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  };
  app.router = createRouter(Object.fromEntries(Object.keys(SCREENS).map((n) => [n, (p) => show(n, p)])));
  installKeys(app);
  app.router.start();

  // 3 日あいた時のおさらいは遊ぶ画面が見る。ここでは何もしない
  return app;

  function refreshHeader() {
    if (!app.header) return;
    const tt = progress.totals();
    // クリアの札の★が点くまでは、前の「クリア n/53」のまま（走り終わる前のネタばれをなくす。ブラッシュアップ 4）
    const clears = app.headerHold && Number.isFinite(app.headerHold.clears) ? app.headerHold.clears : tt.clears;
    app.header.setTotals({ clears, total: progress.levelOrder().length || progress.TOTAL_LEVELS });
  }
}

/** 設定を画面に当てる（色・字の大きさ・動きを減らす・音量）。 @param {object} s */
export function applySettings(s) {
  const de = document.documentElement;
  de.dataset.theme = s.theme || 'light';
  de.style.setProperty('--fs-ui', `${s.uiFont || 15}px`);
  de.style.setProperty('--fs-code', `${s.editorFont || 15}px`);
  const sysReduce = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  de.classList.toggle('reduce-motion', !!s.reduceMotion || sysReduce);
  de.dataset.reducedMotion = String(!!s.reduceMotion || sysReduce);   // 3D（scene.js）はこちらを見る（直し C5）
  audio.setVolume({ sfx: s.sfx, ambience: s.ambience, mute: s.mute });
}

/** 記録の書き出し（設定・トーストの［書き出す］）。 */
export function exportRecord() {
  const text = store.exportJSON();
  const d = new Date();
  const name = `rovercode_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  downloadText(name, text, 'application/json');
  store.flush();
  toast(t('toast.exported'));
}

/** 文字をファイルとして保存させる。 @param {string} name @param {string} text @param {string} [type] */
export function downloadText(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/**
 * キー操作（3.1）: Ctrl/⌘+Enter 実行・Esc の順番・Space・[ ]・? はエディタの外でボタン以外の時だけ。F1 は使わない。
 * 画面ごとの動きは app.keyHandler(e, ctx) に任せる（play.js・free.js）。
 */
function installKeys(app) {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;                 // 日本語入力の変換中
    const tgt = e.target instanceof Element ? e.target : null;
    const inEditor = !!(tgt && tgt.closest('.CodeMirror, .fe, textarea, input, select, [contenteditable="true"]'));
    const onButton = !!(tgt && tgt.closest('button, a, summary, [role="button"], [role="tab"], [role="menuitem"], [role="radio"], label'));
    const ctx = { inEditor, onButton, free: !inEditor && !onButton };
    if (e.key === 'Escape') {
      if (dialogOpen()) return;                                       // ① ダイアログは <dialog> が閉じる
      if (app.keyHandler && app.keyHandler(e, ctx) === true) { e.preventDefault(); return; }   // ② 計算中・再生中なら止める
      return;                                                          // ③ エディタの中はエディタが「Tab で外へ」にする
    }
    if (dialogOpen()) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (app.keyHandler && app.keyHandler(e, ctx) === true) e.preventDefault();
      return;
    }
    if (!ctx.free) return;
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showKeys(); return; }
    if (app.keyHandler && app.keyHandler(e, ctx) === true) e.preventDefault();
  });
}

/** キー一覧（?）。 */
export function showKeys() {
  const ul = document.createElement('ul');
  ul.className = 'keys-list';
  for (const k of ['run', 'esc', 'space', 'brackets', 'help']) {
    const li = document.createElement('li');
    li.textContent = t(`keys.${k}`);
    ul.appendChild(li);
  }
  openDialog({ title: t('keys.title'), body: ul, actions: [{ label: t('button.close'), value: 'close', primary: true }] });
}

/** 画面の名前と引数からハッシュ（screens から使う）。 */
export { makeHash };

boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('app');
  if (root) root.insertAdjacentHTML('beforeend', '<p class="boot-error">読み込みの途中で止まっちゃった。ページを読み直してね</p>');
});
