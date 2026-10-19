/**
 * @file app/js/screens/play_layout.js
 * 持ち主: W7（画面・流れ・保存・音）。直し係 7（2026-10-19）
 * 役割: 遊ぶ画面の欄の大きさを、境目を引いて変える（900 px 以上だけ。せまい画面のタブはそのまま）。
 *   境目は 3 本:  左の欄｜右側（.asplit・左右）  3D／エディタ（.vsplit・上下）  エディタ｜出力（.csplit・左右。1280 px 以上だけ）
 *   - マウス・タッチ（pointer events）で引く。動かす量は requestAnimationFrame で 1 コマに 1 回にまとめる
 *   - フォーカスして矢印キー（Shift で大きく）・Home／End・Enter でたたむ（左の欄と出力）。ダブルクリックで元の大きさ
 *   - 左の欄と出力は、端まで寄せると細い帯にたたむ（帯を押すと戻る）
 *   - 決めた大きさは画面に対する割合で localStorage に（どの面でも同じ。画面の大きさが変わったら割合で直す）
 *   - CodeMirror は欄の大きさが変わったら refresh（3D の canvas は scene.js・fallback_view.js が自分の ResizeObserver で setSize）
 * 並べ方は screens.css の .play（--aside-w・--console-w・--view-h を style に書いて上書きする）。
 */

export const LAYOUT_KEY = 'rovercode.layout';
const OLD_VIEW_KEY = 'rovercode.viewH';          // 直し A-4 の保存（3D の高さの px）。最初に読んだ時に割合へ直して消す
/** 欄の最小の大きさ（px）。middle はエディタの列の幅、editor はエディタの行の高さ */
export const MIN = { aside: 240, console: 220, middle: 440, view: 140, editor: 180 };
export const FOLD_W = 34;                        // たたんだ帯の幅
const FOLD_SLACK = 70;                           // 最小より、さらにこれだけ寄せるとたたむ
const DEF = { asideWide: 430, asideMid: 360, console: 360 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 保存した配置を読む（壊れていても {}） */
export function loadLayout() {
  let o = {};
  try { const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (raw && typeof raw === 'object') o = raw; } catch { /* なし */ }
  return {
    aside: num(o.aside), console: num(o.console), view: num(o.view),
    asideFold: o.asideFold === true, consoleFold: o.consoleFold === true,
  };
}
export function saveLayout(st) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...st })); } catch { /* なし */ }
}
/** 設定の「画面の配置を元に戻す」 */
export function resetSavedLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* なし */ }
  try { localStorage.removeItem(OLD_VIEW_KEY); } catch { /* なし */ }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));

/**
 * 割合から px を決める（純な関数。tests/fix7 が Node で確かめる）。
 * @param {{W:number, H:number, mode:'three'|'two', fixedH:number}} box  fixedH = 時間の帯（とタブ）の高さ
 * @param {object} st loadLayout() の形
 * @param {'aside'|'console'|'view'|null} active 今引いている境目（ほかの欄を先に守る）
 * @returns {{aside:number, console:number|null, view:number|null, asideFold:boolean, consoleFold:boolean}}
 */
export function solve(box, st, active = null) {
  const { W, H, mode, fixedH } = box;
  const three = mode === 'three';
  const asideFold = !!st.asideFold;
  const consoleFold = three && !!st.consoleFold;
  const minA = asideFold ? FOLD_W : MIN.aside;
  const minC = consoleFold ? FOLD_W : MIN.console;
  let a = asideFold ? FOLD_W : st.aside != null ? st.aside * W : three ? DEF.asideWide : DEF.asideMid;
  let c = !three ? 0 : consoleFold ? FOLD_W : st.console != null ? st.console * W : DEF.console;
  a = Math.max(minA, a);
  if (three) c = Math.max(minC, c);
  const room = W - MIN.middle;
  if (a + c > room) {
    if (active === 'aside') { a = Math.max(minA, room - c); if (a + c > room) c = Math.max(minC, room - a); }
    else { c = three ? Math.max(minC, room - a) : 0; if (a + c > room) a = Math.max(minA, room - c); }
  }
  let v = null;
  if (st.view != null) v = clamp(st.view * H, MIN.view, H - fixedH - MIN.editor);
  return { aside: Math.round(a), console: three ? Math.round(c) : null, view: v == null ? null : Math.round(v), asideFold, consoleFold };
}

/**
 * 遊ぶ画面に境目をつける。
 * @param {HTMLElement} P .play
 * @param {{t:(k:string,o?:object)=>string, getCM?:()=>any}} opts
 * @returns {{destroy:()=>void, reset:()=>void, state:()=>object}}
 */
export function setupLayout(P, opts = {}) {
  const t = opts.t || ((k) => k);
  const q = (s) => P.querySelector(s);
  const bars = { aside: q('.asplit'), console: q('.csplit'), view: q('.vsplit') };
  const mq = (s) => !!(globalThis.matchMedia && matchMedia(s).matches);
  const modeNow = () => (mq('(max-width: 899px)') ? 'narrow' : mq('(max-width: 1279px)') ? 'two' : 'three');
  let st = loadLayout();
  // 直し A-4 の 3D の高さ（px）を割合に直す
  try {
    const old = Number(localStorage.getItem(OLD_VIEW_KEY));
    if (old > 0 && st.view == null) {
      const h = P.getBoundingClientRect().height;
      if (h > 0) { st.view = old / h; saveLayout(st); }
    }
    localStorage.removeItem(OLD_VIEW_KEY);
  } catch { /* なし */ }
  let cur = null;                    // 最後に当てた px
  const offs = [];
  const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); offs.push(() => el.removeEventListener(ev, fn, o)); };

  function box() {
    const r = P.getBoundingClientRect();
    const mode = modeNow();
    const tl = q('.tl-host');
    const tabs = mode === 'two' ? q('.ptabs') : null;
    const fixedH = (tl ? tl.getBoundingClientRect().height : 56) + (tabs ? tabs.getBoundingClientRect().height : 0);
    return { W: r.width, H: r.height, left: r.left, right: r.right, top: r.top, mode, fixedH };
  }

  function clearStyle() {
    for (const k of ['--aside-w', '--console-w', '--view-h']) P.style.removeProperty(k);
    P.classList.remove('aside-folded', 'console-folded');
  }

  /** 今の st を画面に当てる */
  function apply(active = null) {
    const b = box();
    if (b.mode === 'narrow' || b.W <= 0) { clearStyle(); cur = null; return null; }
    const s = solve(b, st, active);
    P.style.setProperty('--aside-w', `${s.aside}px`);
    if (s.console != null) P.style.setProperty('--console-w', `${s.console}px`); else P.style.removeProperty('--console-w');
    if (s.view != null) P.style.setProperty('--view-h', `${s.view}px`); else P.style.removeProperty('--view-h');
    P.classList.toggle('aside-folded', s.asideFold);
    P.classList.toggle('console-folded', s.consoleFold);
    cur = { ...s, box: b };
    updateAria();
    return s;
  }

  function updateAria() {
    if (!cur) return;
    const { box: b } = cur;
    const set = (bar, px, total, folded) => {
      if (!bar) return;
      bar.setAttribute('aria-valuenow', String(Math.round(px / Math.max(1, total) * 100)));
      bar.setAttribute('aria-valuetext', folded ? t('play.split_folded') : `${Math.round(px)} px`);
    };
    set(bars.aside, cur.aside, b.W, cur.asideFold);
    if (cur.console != null) set(bars.console, cur.console, b.W, cur.consoleFold);
    const vh = q('.view') ? q('.view').getBoundingClientRect().height : 0;
    set(bars.view, vh, b.H, false);
  }

  const save = () => saveLayout(st);

  // ---- 引く（pointer events。1 コマに 1 回）
  let raf = 0, pending = null;
  function flush() {
    raf = 0;
    if (!pending) return;
    const { which, x, y } = pending;
    pending = null;
    const b = box();
    if (b.mode === 'narrow') return;
    if (which === 'aside' || which === 'console') {
      const want = which === 'aside' ? x - b.left : b.right - x;
      const min = which === 'aside' ? MIN.aside : MIN.console;
      const fold = which === 'aside' ? 'asideFold' : 'consoleFold';
      if (want < min - FOLD_SLACK) st[fold] = true;
      else { st[fold] = false; st[which] = Math.max(min, want) / b.W; }
      apply(which);
      // 届かなかった分（最大で止まった）は割合も合わせておく
      if (!st[fold]) st[which] = cur[which] / b.W;
    } else {
      const want = y - b.top;
      st.view = want / Math.max(1, b.H);
      apply('view');
      st.view = cur.view / Math.max(1, b.H);
    }
  }
  function drag(which) {
    const bar = bars[which];
    if (!bar) return;
    on(bar, 'pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { bar.setPointerCapture(e.pointerId); } catch { /* なし */ }
      bar.classList.add('dragging');
      P.classList.add('resizing');
      const move = (ev) => { pending = { which, x: ev.clientX, y: ev.clientY }; if (!raf) raf = requestAnimationFrame(flush); };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        if (raf) { cancelAnimationFrame(raf); flush(); }
        bar.classList.remove('dragging');
        P.classList.remove('resizing');
        save();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
    on(bar, 'dblclick', () => resetOne(which));
    on(bar, 'keydown', (e) => key(which, e));
  }

  function resetOne(which) {
    if (which === 'view') st.view = null;
    else if (which === 'aside') { st.aside = null; st.asideFold = false; }
    else { st.console = null; st.consoleFold = false; }
    apply(which);
    save();
  }

  function key(which, e) {
    if (!cur) return;
    const horiz = which !== 'view';
    const big = e.shiftKey ? 64 : 16;
    const b = cur.box;
    const fold = which === 'aside' ? 'asideFold' : 'consoleFold';
    let handled = true;
    if (horiz && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const grow = (e.key === 'ArrowRight') === (which === 'aside');
      if (st[fold]) { if (grow) st[fold] = false; }
      else {
        const px = cur[which] + (grow ? big : -big);
        st[which] = Math.max(which === 'aside' ? MIN.aside : MIN.console, px) / b.W;
      }
    } else if (!horiz && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const vh = q('.view').getBoundingClientRect().height;
      st.view = (vh + (e.key === 'ArrowDown' ? big + 8 : -big - 8)) / Math.max(1, b.H);
    } else if (e.key === 'Home') {
      if (horiz) { st[fold] = false; st[which] = (which === 'aside' ? MIN.aside : MIN.console) / b.W; } else st.view = 0;
    } else if (e.key === 'End') {
      if (horiz) { st[fold] = false; st[which] = 1; } else st.view = 1;
    } else if (horiz && (e.key === 'Enter' || e.key === ' ')) {
      st[fold] = !st[fold];
    } else handled = false;
    if (!handled) return;
    e.preventDefault();
    apply(which);
    if (which === 'view') st.view = cur.view / Math.max(1, b.H);
    else if (!st[fold]) st[which] = cur[which] / b.W;
    save();
  }

  drag('aside'); drag('console'); drag('view');
  // たたんだ帯を押すと戻る
  for (const [sel, fold] of [['.unfold-aside', 'asideFold'], ['.unfold-console', 'consoleFold']]) {
    const btn = q(sel);
    if (btn) on(btn, 'click', () => { st[fold] = false; apply(); save(); });
  }

  // ---- 画面の大きさが変わった時（割合で直す）
  let rraf = 0;
  const onResize = () => { if (!rraf) rraf = requestAnimationFrame(() => { rraf = 0; apply(); }); };
  on(window, 'resize', onResize);

  // ---- CodeMirror は欄の大きさが変わったら描き直す
  let craf = 0;
  const host = q('.editor-host');
  const ro = typeof ResizeObserver === 'function' && host ? new ResizeObserver(() => {
    if (craf) return;
    craf = requestAnimationFrame(() => { craf = 0; try { const cm = opts.getCM && opts.getCM(); if (cm && cm.refresh) cm.refresh(); } catch { /* なし */ } });
  }) : null;
  if (ro) ro.observe(host);

  apply();

  return {
    destroy() {
      for (const off of offs) off();
      if (ro) ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (rraf) cancelAnimationFrame(rraf);
      if (craf) cancelAnimationFrame(craf);
    },
    reset() { st = { aside: null, console: null, view: null, asideFold: false, consoleFold: false }; resetSavedLayout(); apply(); },
    state: () => ({ saved: { ...st }, cur: cur && { aside: cur.aside, console: cur.console, view: cur.view, asideFold: cur.asideFold, consoleFold: cur.consoleFold } }),
  };
}
