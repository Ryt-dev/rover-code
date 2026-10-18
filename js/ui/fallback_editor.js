/**
 * @file app/js/ui/fallback_editor.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: W6 のエディタ（js/editor/editor.js、CodeMirror 5）がまだ使えない時の代わり。同じ窓口（7.3「W6 js/editor/*」）を
 *       ふつうの <textarea> で出す。W6 のエディタが動けば play.js はそちらを使う（ここは使わない）。
 * SPEC: 7.3（Editor の形）・3.1（Ctrl+Enter・変換中は無視・Esc → Tab で外へ）・3.4（今の行・回数・下線）
 *
 * 足した窓口（W6 にも同じものを頼んでいる。progress/W7.md の連絡）: setReadOnly(b)・setFontSize(px)・destroy()。
 */

import { t } from './strings.js';

/**
 * @param {HTMLElement} el
 * @param {{lang?: string, value?: string, fontSize?: number, label?: string}} opts
 */
export function createFallbackEditor(el, opts = {}) {
  el.classList.add('fe');
  el.innerHTML = `<div class="fe-gutter" aria-hidden="true"></div><div class="fe-area"><div class="fe-back" aria-hidden="true"></div><textarea class="fe-text" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea></div><div class="fe-tabout" hidden>${t('play.tab_out')}</div>`;
  const ta = el.querySelector('textarea');
  const gutter = el.querySelector('.fe-gutter');
  const back = el.querySelector('.fe-back');
  const tabout = el.querySelector('.fe-tabout');
  ta.setAttribute('aria-label', opts.label || `${t('play.tab_code')}（${opts.lang === 'c' ? 'main.c' : 'main.py'}）`);
  ta.id = 'code';
  ta.value = opts.value || '';
  const fns = { change: new Set(), run: new Set(), escape: new Set() };
  let active = null;
  let hits = null;
  let marks = [];
  let escArmed = false;
  let varSource = null;
  let fontSize = opts.fontSize || 15;

  const lineH = () => fontSize * 1.75;
  function setFont(px) {
    fontSize = px;
    el.style.setProperty('--fe-fs', `${px}px`);
    render();
  }
  function render() {
    const n = ta.value.split('\n').length;
    let g = '';
    for (let i = 1; i <= n; i++) {
      const h = hits && hits[i] ? `<span class="fe-hits">×${hits[i]}</span>` : '';
      const err = marks.some((m) => m.line === i) ? ' err' : '';
      g += `<div class="fe-ln${i === active ? ' on' : ''}${err}">${i}${h}</div>`;
    }
    gutter.innerHTML = g;
    back.innerHTML = '';
    if (active) {
      const d = document.createElement('div');
      d.className = 'fe-cur';
      d.style.top = `${(active - 1) * lineH() + 10}px`;
      d.style.height = `${lineH()}px`;
      back.appendChild(d);
    }
    for (const m of marks) {
      const d = document.createElement('div');
      d.className = 'fe-err';
      d.style.top = `${(m.line - 1) * lineH() + 10 + lineH() - 3}px`;
      back.appendChild(d);
    }
    sync();
  }
  function sync() {
    gutter.scrollTop = ta.scrollTop;
    back.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }
  const emit = (name, v) => { for (const f of fns[name]) { try { f(v); } catch (e) { console.error(e); } } };

  ta.addEventListener('scroll', sync);
  ta.addEventListener('input', () => { escArmed = false; tabout.hidden = true; render(); emit('change', ta.value); });
  ta.addEventListener('blur', () => { escArmed = false; tabout.hidden = true; });
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;          // 日本語入力の変換中は何もしない（3.1）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); emit('run'); return; }
    if (e.key === 'Escape') {
      escArmed = true;
      tabout.hidden = false;
      emit('escape');
      return;                                                  // 計算・再生を止めるのは画面の Esc（main.js）
    }
    if (e.key === 'Tab') {
      if (escArmed) { escArmed = false; tabout.hidden = true; return; }   // ふつうの Tab で外へ
      e.preventDefault();
      if (ta.readOnly) return;
      const s = ta.selectionStart;
      const v = ta.value;
      if (e.shiftKey) {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const m = /^ {1,4}/.exec(v.slice(ls));
        if (m) { ta.setRangeText('', ls, ls + m[0].length, 'end'); ta.selectionStart = ta.selectionEnd = Math.max(ls, s - m[0].length); }
      } else {
        ta.setRangeText('    ', s, ta.selectionEnd, 'end');
      }
      ta.dispatchEvent(new Event('input'));
      return;
    }
    escArmed = false;
    tabout.hidden = true;
  });
  ta.addEventListener('mousemove', (e) => {
    if (!varSource) return;
    // 単語の上の変数の値（簡単な見積もり: マウスの位置から行と列）
    const r = ta.getBoundingClientRect();
    const line = Math.floor((e.clientY - r.top + ta.scrollTop - 10) / lineH());
    const cw = fontSize * 0.5;
    const col = Math.floor((e.clientX - r.left + ta.scrollLeft - 12) / cw);
    const text = ta.value.split('\n')[line] || '';
    const m = /[A-Za-z_぀-鿿][\w぀-鿿]*/g;
    let w = null;
    let mm;
    while ((mm = m.exec(text))) if (col >= mm.index && col <= mm.index + mm[0].length) { w = mm[0]; break; }
    ta.title = w ? (varSource(w) || '') : '';
  });
  setFont(fontSize);

  return {
    getCode: () => ta.value,
    setCode(code) { ta.value = code; render(); emit('change', ta.value); },
    setActiveLine(n) { active = n || null; render(); if (n) scrollToLine(n); },
    setHits(h) { hits = h || null; render(); },
    showCard(card) { if (card && card.line) { marks = [{ line: card.line, col: card.col }]; render(); scrollToLine(card.line); } },
    clearMarks() { marks = []; hits = null; active = null; render(); },
    on(name, fn) { (fns[name] || (fns[name] = new Set())).add(fn); return () => fns[name].delete(fn); },
    setVarSource(fn) { varSource = fn; },
    focus() { ta.focus(); },
    setReadOnly(b) { ta.readOnly = !!b; el.classList.toggle('ro', !!b); },
    setFontSize(px) { setFont(px); },
    gotoLine(n) { scrollToLine(n); const lines = ta.value.split('\n'); let p = 0; for (let i = 0; i < n - 1 && i < lines.length; i++) p += lines[i].length + 1; ta.focus(); ta.setSelectionRange(p, p); },
    destroy() { el.innerHTML = ''; el.classList.remove('fe'); },
    fallback: true,
  };
  function scrollToLine(n) {
    const y = (n - 1) * lineH();
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lineH() * 2) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  }
}
