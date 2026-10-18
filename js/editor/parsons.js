/**
 * @file app/js/editor/parsons.js
 * 持ち主: W6（エディタ）
 * 役割: 並べる面: エディタの代わりに行のカードの列。ドラッグかキーボードの ↑↓ で並べ、← → で字下げ。固定の行は上に鍵つき。
 * SPEC: 3.4「並べる面」・4 章の 15・7.7 の parsons・3.6（取り直しでカードをばらばらに）・13.2 W6 ③
 *
 * 決めた形（W6）
 *  - splitParsons(code, parsons): コードを「固定の行」と「カード」に分ける。固定の行は先頭から fixed_lines 個のコードの行
 *    （間と直後のコメントの行もふくむ。「# ↓ ここから下の行を並べかえよう」など）。残りの空でない行がカード（字下げは 4 つで 1 段）。
 *    スターターでも、並べたあとの保存したコードでも同じ分け方になる。distractors（使わないカード）はカードに足し、「使わない」の箱へ動かせる。
 *  - カード: 左に行番号、字下げは点線のガイド、右に ↑ ↓ ← → の小さなボタンと、つまみ（44 px）。
 *    キーボード: カードにフォーカスして ↑↓ で動かす・← → で字下げ・Tab で次のカードへ。ボタンは Tab で止まらない（tabindex=-1）。
 *    マウス: カードのどこでもドラッグ（横に動かすと字下げ）。タッチ: つまみを長押し（0.35 s）してからドラッグ。
 *  - 動かすたびに onChange(code)。読み上げ用に「5 行目へ動かした・字下げ 1」を aria-live で出す。
 *  - setActiveLine・markLine は「並べたコードの行番号」（固定の行から数える）でカードを光らせる（再生・エラーの行）。
 */

const LOCK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 16 24" aria-hidden="true"><circle cx="5" cy="6" r="1.6"/><circle cx="11" cy="6" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="12" r="1.6"/><circle cx="5" cy="18" r="1.6"/><circle cx="11" cy="18" r="1.6"/></svg>';
const KW = new Set('and as assert break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' '));
const BUILTIN = new Set('print motor wait stop distance_to_cone lidar heading odometer encoder gnss camera phase altitude accel nichrome marker now range abs len min max int float str round sum'.split(' '));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** カードの中の 1 行を色分けする（エディタと同じ色。CodeMirror を使わない軽い字句分け）。 */
export function highlightLine(text) {
  let out = '';
  const re = /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b)|([\p{L}_][\p{L}\p{N}_]*)|(\s+)|(.)/gu;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out += `<span class="cm-comment">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="cm-string">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="cm-number">${esc(m[3])}</span>`;
    else if (m[4]) out += KW.has(m[4]) ? `<span class="cm-keyword">${esc(m[4])}</span>` : BUILTIN.has(m[4]) ? `<span class="cm-builtin">${esc(m[4])}</span>` : esc(m[4]);
    else out += esc(m[0]);
  }
  return out;
}

/**
 * コードを固定の行とカードに分ける。
 * @param {string} code スターターか、並べたあとのコード
 * @param {{fixed_lines?: number, distractors?: string[]}|null} parsons
 * @param {number} [indentUnit=4]
 * @returns {{fixedLines: string[], cards: {text: string, level: number}[]}}
 */
export function splitParsons(code, parsons, indentUnit = 4) {
  const lines = String(code ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const n = Math.max(0, (parsons && parsons.fixed_lines) | 0);
  const fixedLines = [];
  let i = 0;
  let codeSeen = 0;
  const isComment = (l) => /^\s*#/.test(l);
  const isBlank = (l) => l.trim() === '';
  // 固定のコードの行を n 個（間のコメント・空行もふくむ）
  while (i < lines.length && codeSeen < n) {
    if (!isComment(lines[i]) && !isBlank(lines[i])) codeSeen++;
    fixedLines.push(lines[i]);
    i++;
  }
  // 先頭（n = 0 の時）か固定の行のすぐ後ろのコメント・空行（説明）も固定に
  while (i < lines.length && (isComment(lines[i]) || isBlank(lines[i]))) {
    if (!isBlank(lines[i])) fixedLines.push(lines[i]);
    i++;
  }
  const cards = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    const lead = l.length - l.replace(/^[ \t]+/, '').length;
    const width = l.slice(0, lead).replace(/\t/g, ' '.repeat(indentUnit)).length;
    cards.push({ text: l.trim(), level: Math.round(width / indentUnit) });
  }
  return { fixedLines, cards };
}

/** 決まった種で混ぜる（mulberry32）。 */
function shuffled(arr, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * 〔1.1〕タッチ端末ではカードの右端のつまみ（44 px）を長押しして動かす。各カードに ↑ ↓ ← → の小さなボタンも付ける。
 * 「ふつうに書く」でエディタに戻せる（★3 で数を変える面のため）。取り直しの時はカードをばらばらに戻す（3.6）。
 * @param {HTMLElement} el
 * @param {{fixedLines: string[], cards: ({text: string, level: number}|string)[], aside?: string[], onChange: (code: string) => void,
 *   onFreeEdit?: () => void, indentUnit?: number, maxIndent?: number, allowAside?: boolean}} opts
 * @returns {{getCode: () => string, shuffle: (seed?: number) => void, setActiveLine: (n: number|null) => void,
 *   markLine: (n: number|null, severity?: string) => void, clearMarks: () => void, setReadOnly: (v: boolean) => void,
 *   focus: () => void, destroy: () => void, lineCount: () => number, cards: () => {text: string, level: number}[], move: (from: number, to: number) => void,
 *   indent: (i: number, d: number) => void, element: HTMLElement}}
 */
export function createParsons(el, opts) {
  const unit = opts.indentUnit || 4;
  const maxIndent = opts.maxIndent ?? 4;
  const fixed = (opts.fixedLines || []).slice();
  let cards = (opts.cards || []).map((c, k) => (typeof c === 'string' ? { id: k, text: c.trim(), level: 0 } : { id: k, text: c.text, level: c.level | 0 }));
  let aside = (opts.aside || []).map((t, k) => ({ id: 1000 + k, text: t.trim(), level: 0 }));
  const allowAside = opts.allowAside ?? aside.length > 0;
  let readOnly = false;
  let activeLine = null;
  const marks = new Map();       // 行番号 → severity

  const root = document.createElement('div');
  root.className = 'rc-parsons';
  root.innerHTML = `
    <p class="rc-parsons-help">カードを並べて、正しい順番にしよう。<span class="rc-keys">カードを選んで ↑↓ で動かす・← → で字下げ</span></p>
    <div class="rc-parsons-foot rc-parsons-top">${opts.onFreeEdit ? '<button type="button" class="rc-btn rc-free-btn">ふつうに書く</button><span class="rc-free-note">並べ終わったあと、数を書きかえたい時（★3 など）はこちら</span>' : ''}</div>
    <ol class="rc-parsons-fixed" aria-label="決まっている行（鍵つき）"></ol>
    <ol class="rc-parsons-list" aria-label="並べるカード"></ol>
    ${allowAside ? '<p class="rc-parsons-aside-h">使わないカード</p><ol class="rc-parsons-aside" aria-label="使わないカード"></ol>' : ''}
    <div class="sr-only" aria-live="polite"></div>`;
  el.appendChild(root);
  const fixedEl = root.querySelector('.rc-parsons-fixed');
  const listEl = root.querySelector('.rc-parsons-list');
  const asideEl = root.querySelector('.rc-parsons-aside');
  const live = root.querySelector('[aria-live]');
  const freeBtn = root.querySelector('.rc-free-btn');
  if (freeBtn) freeBtn.addEventListener('click', () => opts.onFreeEdit && opts.onFreeEdit());

  // ---- 固定の行
  fixed.forEach((t, k) => {
    const li = document.createElement('li');
    li.className = 'rc-card rc-card-fixed';
    li.dataset.line = String(k + 1);
    const lead = t.length - t.replace(/^ +/, '').length;
    li.innerHTML = `<span class="rc-ln">${k + 1}</span><span class="rc-lockmark" title="鍵つきの行（動かせない）">${LOCK_SVG}</span>` +
      `<span class="rc-indent" style="--lv:${Math.round(lead / unit)}"></span><code class="rc-card-code">${highlightLine(t.trim()) || '&nbsp;'}</code>`;
    fixedEl.appendChild(li);
  });
  fixedEl.hidden = fixed.length === 0;

  const lineOf = (i) => fixed.length + i + 1;
  const say = (text) => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); };

  function cardEl(c, i, inAside) {
    const li = document.createElement('li');
    li.className = 'rc-card' + (inAside ? ' is-aside' : '');
    li.tabIndex = -1;
    li.dataset.id = String(c.id);
    const ln = inAside ? '' : lineOf(i);
    li.innerHTML = `<span class="rc-ln">${ln}</span><span class="rc-indent" style="--lv:${c.level}"></span>` +
      `<code class="rc-card-code">${highlightLine(c.text)}</code>` +
      `<span class="rc-card-btns">` +
      (inAside ? `<button type="button" tabindex="-1" data-act="use" aria-label="使うカードに戻す">使う</button>` :
        `<button type="button" tabindex="-1" data-act="up" aria-label="上へ">↑</button><button type="button" tabindex="-1" data-act="down" aria-label="下へ">↓</button>` +
        `<button type="button" tabindex="-1" data-act="left" aria-label="字下げを減らす">←</button><button type="button" tabindex="-1" data-act="right" aria-label="字下げを増やす">→</button>` +
        (allowAside ? `<button type="button" tabindex="-1" data-act="aside" aria-label="使わないカードへ">✕</button>` : '')) +
      `</span><span class="rc-grip" aria-hidden="true" title="長押しして動かす">${GRIP_SVG}</span>`;
    li.setAttribute('aria-label', inAside ? `使わないカード: ${c.text}` : `${ln} 行目: ${c.text}（字下げ ${c.level}）`);
    return li;
  }

  let focusId = null;
  function render(keepFocus = true) {
    const had = keepFocus && root.contains(document.activeElement) ? document.activeElement.closest('.rc-card')?.dataset.id : null;
    listEl.textContent = '';
    cards.forEach((c, i) => {
      const li = cardEl(c, i, false);
      if (activeLine === lineOf(i)) li.classList.add('is-active');
      const sev = marks.get(lineOf(i));
      if (sev) li.classList.add(sev === 'error' ? 'is-error' : 'is-warn');
      listEl.appendChild(li);
    });
    if (asideEl) { asideEl.textContent = ''; aside.forEach((c, i) => asideEl.appendChild(cardEl(c, i, true))); }
    // Tab で止まるのは各カード（ロービング: 全部 tabindex=0）
    root.querySelectorAll('.rc-card:not(.rc-card-fixed)').forEach((li) => { li.tabIndex = readOnly ? -1 : 0; });
    const fid = had ?? focusId;
    if (fid != null) { const t = root.querySelector(`.rc-card[data-id="${fid}"]`); if (t && keepFocus && had != null) t.focus(); }
    root.classList.toggle('is-readonly', readOnly);
  }

  function getCode() {
    const body = cards.map((c) => ' '.repeat(unit * c.level) + c.text);
    return [...fixed, ...body].join('\n') + '\n';
  }
  const changed = () => { if (opts.onChange) opts.onChange(getCode()); };

  function move(from, to) {
    if (readOnly || from === to || from < 0 || to < 0 || from >= cards.length || to >= cards.length) return false;
    const [c] = cards.splice(from, 1);
    cards.splice(to, 0, c);
    focusId = c.id;
    render();
    changed();
    say(`${lineOf(to)} 行目へ動かした（字下げ ${c.level}）`);
    return true;
  }
  function indent(i, d) {
    if (readOnly || i < 0 || i >= cards.length) return false;
    const c = cards[i];
    const lv = Math.max(0, Math.min(maxIndent, c.level + d));
    if (lv === c.level) return false;
    c.level = lv;
    focusId = c.id;
    render();
    changed();
    say(`字下げ ${lv}`);
    return true;
  }
  function toAside(i) {
    if (readOnly || !asideEl) return;
    const [c] = cards.splice(i, 1);
    c.level = 0;
    aside.push(c);
    render(); changed();
    say('使わないカードへ動かした');
    const next = listEl.children[Math.min(i, cards.length - 1)];
    if (next) next.focus();
  }
  function fromAside(i) {
    if (readOnly) return;
    const [c] = aside.splice(i, 1);
    cards.push(c);
    focusId = c.id;
    render(); changed();
    say(`${lineOf(cards.length - 1)} 行目に戻した`);
    const t = root.querySelector(`.rc-card[data-id="${c.id}"]`);
    if (t) t.focus();
  }
  const idxOf = (li) => cards.findIndex((c) => String(c.id) === li.dataset.id);

  // ---- ボタン
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const li = b.closest('.rc-card');
    if (b.dataset.act === 'use') { fromAside(aside.findIndex((c) => String(c.id) === li.dataset.id)); return; }
    const i = idxOf(li);
    if (b.dataset.act === 'up') move(i, i - 1);
    else if (b.dataset.act === 'down') move(i, i + 1);
    else if (b.dataset.act === 'left') indent(i, -1);
    else if (b.dataset.act === 'right') indent(i, 1);
    else if (b.dataset.act === 'aside') toAside(i);
    const t = root.querySelector(`.rc-card[data-id="${li.dataset.id}"]`);
    if (t && b.dataset.act !== 'aside') t.focus();
  });

  // ---- キーボード
  root.addEventListener('keydown', (e) => {
    const li = e.target.closest && e.target.closest('.rc-card');
    if (!li || li.classList.contains('rc-card-fixed') || li.classList.contains('is-aside') || e.target !== li) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const i = idxOf(li);
    let done = false;
    if (e.key === 'ArrowUp') done = move(i, i - 1) || true;
    else if (e.key === 'ArrowDown') done = move(i, i + 1) || true;
    else if (e.key === 'ArrowLeft') done = indent(i, -1) || true;
    else if (e.key === 'ArrowRight') done = indent(i, 1) || true;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && allowAside) { toAside(i); done = true; }
    if (done) {
      e.preventDefault();
      const t = root.querySelector(`.rc-card[data-id="${li.dataset.id}"]`);
      if (t && document.activeElement !== t) t.focus();
    }
  });

  // ---- ドラッグ（マウス: カードのどこでも／タッチ: つまみを長押し）
  let drag = null;
  const LONG_MS = 350;
  root.addEventListener('pointerdown', (e) => {
    if (readOnly || e.button > 0) return;
    const li = e.target.closest('.rc-card');
    if (!li || li.classList.contains('rc-card-fixed') || li.classList.contains('is-aside') || e.target.closest('button')) return;
    const onGrip = !!e.target.closest('.rc-grip');
    if (e.pointerType !== 'mouse' && !onGrip) return;          // タッチでカードの中を押したら、ふつうにスクロール
    const i = idxOf(li);
    drag = { li, id: li.dataset.id, startX: e.clientX, startY: e.clientY, startLevel: cards[i].level, active: false, pointerId: e.pointerId, timer: null };
    if (e.pointerType === 'mouse') {
      // 動かしたら始める
    } else {
      drag.timer = setTimeout(() => { if (drag) startDrag(); }, LONG_MS);
      li.classList.add('is-pressing');
    }
    try { li.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
  });
  function startDrag() {
    if (!drag || drag.active) return;
    drag.active = true;
    drag.li.classList.remove('is-pressing');
    drag.li.classList.add('is-dragging');
    root.classList.add('is-dragging');
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* なくてよい */ } }
  }
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (e.pointerType === 'mouse' && Math.hypot(dx, dy) > 5) startDrag();
      else if (e.pointerType !== 'mouse' && Math.hypot(dx, dy) > 10) { clearTimeout(drag.timer); drag.li.classList.remove('is-pressing'); drag = null; return; }
      if (!drag || !drag.active) return;
    }
    e.preventDefault();
    // 縦: 並びの中の位置
    const items = [...listEl.children];
    const me = items.findIndex((x) => x.dataset.id === drag.id);
    let target = me;
    for (let k = 0; k < items.length; k++) {
      if (k === me) continue;
      const r = items[k].getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (k < me && e.clientY < mid) { target = k; break; }
      if (k > me && e.clientY > mid) target = k;
    }
    if (target !== me) {
      const [c] = cards.splice(me, 1);
      cards.splice(target, 0, c);
      render(false);
      drag.li = listEl.querySelector(`.rc-card[data-id="${drag.id}"]`);
      drag.li.classList.add('is-dragging');
      drag.moved = true;
    }
    // 横: 字下げ（2 文字ぶんで 1 段）
    const code = drag.li.querySelector('.rc-card-code');
    const chW = code ? Math.max(6, (parseFloat(getComputedStyle(code).fontSize) || 14) * 0.55) : 8;
    const lv = Math.max(0, Math.min(maxIndent, drag.startLevel + Math.round(dx / (chW * 4))));
    const c = cards.find((x) => String(x.id) === drag.id);
    if (c && c.level !== lv) { c.level = lv; drag.li.querySelector('.rc-indent').style.setProperty('--lv', lv); drag.moved = true; }
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    clearTimeout(drag.timer);
    const was = drag;
    drag = null;
    root.classList.remove('is-dragging');
    if (!was.active) { was.li.classList.remove('is-pressing'); return; }
    focusId = Number(was.id);
    render(false);
    const t = root.querySelector(`.rc-card[data-id="${was.id}"]`);
    if (t) t.focus({ preventScroll: true });
    if (was.moved) {
      changed();
      const i = cards.findIndex((c) => String(c.id) === was.id);
      say(`${lineOf(i)} 行目へ動かした（字下げ ${cards[i].level}）`);
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  // 長押しの間に出る右クリックのメニューを止める
  root.addEventListener('contextmenu', (e) => { if (e.target.closest('.rc-grip')) e.preventDefault(); });

  render(false);

  return {
    element: root,
    getCode,
    cards: () => cards.map((c) => ({ text: c.text, level: c.level })),
    lineCount: () => fixed.length + cards.length,
    move, indent,
    shuffle(seed = Date.now()) {
      const before = cards.map((c) => c.id).join(',');
      let next = shuffled(cards, seed);
      if (next.length > 1 && next.map((c) => c.id).join(',') === before) next = [...next.slice(1), next[0]];
      cards = next.map((c) => ({ ...c, level: 0 }));
      render(false);
      changed();
    },
    setActiveLine(n) {
      activeLine = n;
      root.querySelectorAll('.rc-card.is-active').forEach((x) => x.classList.remove('is-active'));
      if (n == null) return;
      const t = n <= fixed.length ? fixedEl.children[n - 1] : listEl.children[n - fixed.length - 1];
      if (t) { t.classList.add('is-active'); t.scrollIntoView({ block: 'nearest' }); }
    },
    markLine(n, severity = 'error') {
      if (n == null) return;
      marks.set(n, severity);
      const t = n <= fixed.length ? fixedEl.children[n - 1] : listEl.children[n - fixed.length - 1];
      if (t) { t.classList.add(severity === 'error' ? 'is-error' : 'is-warn'); t.scrollIntoView({ block: 'nearest' }); }
    },
    /** エラー・注意の印だけ消す（今の行は残す）。 */
    clearLineMarks() {
      marks.clear();
      root.querySelectorAll('.is-error, .is-warn').forEach((x) => x.classList.remove('is-error', 'is-warn'));
    },
    clearMarks() {
      marks.clear();
      activeLine = null;
      root.querySelectorAll('.is-error, .is-warn, .is-active').forEach((x) => x.classList.remove('is-error', 'is-warn', 'is-active'));
    },
    setReadOnly(v) { readOnly = !!v; render(false); },
    focus() { const t = listEl.querySelector('.rc-card'); if (t) t.focus(); },
    destroy() { root.remove(); },
  };
}
