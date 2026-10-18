/**
 * @file app/js/ui/error_card.js
 * 持ち主: W3（エラー説明）
 * 役割: エラーカード（ローバーの顔・title・where・もっと詳しく（why・fix・例・用語）・本物のエラー文）を作る。
 *       先輩のひとこと（replay の Hint）も同じ形で出せる（speaker が senpai の時は先輩の顔）。
 * SPEC: 9.3（エラーカード）・9.2（display の設定: 英文の出し分け・quickfix）・3.4（鍵の行のエラー）・10.1（動き）・10.6（音）・11 章（文言）
 *
 * 決めた形（W7 の遊ぶ画面が使う。7.3 に定めが無いので W3 が決めた）:
 *   import { createErrorCard, decorateCard, rawModeFor } from './ui/error_card.js';
 *   const c = createErrorCard(card, {
 *     chapter: 3, rawMode: settings.rawError,            // 'chapter'（章に合わせる）| 'always'（いつも見せる）。3.9
 *     rules,                                             // data/error_rules.json（display・zukan の名前・where の文）
 *     onQuickfix: (ruleId) => …,                         // ［半角に直す］など → Runner.quickfix(code, ruleId)
 *     onZukan: (zukanId) => …,                           // 用語・ずかんへ → #/zukan/<id>
 *     onLine: (line, col) => …,                          // where を押した → エディタのその行へ
 *     onConfirm: (choice) => …,                          // L_WAIT_MS など confirm のカード: 'run'（このまま実行）| 'fix'（直す）
 *     worldNote: '（世界 2 でだけ起きたよ）',            // 〔1.1〕where の後ろに足す（replay_explain.js の addWorldNotes が runs に足していれば不要）
 *     locked: level.locked,                              // 〔1.1〕鍵の行 [[1, 4], …]。鍵の行のエラーなら where に足して onLockedError を呼ぶ
 *     lockedNote: editorOut.note,                        // 〔1.1〕W6 の editor が鍵の行と見分けた時の文（worldNote と同じ形。あれば locked より優先）
 *     onLockedError: (card) => …,                        // 空欄の箱を光らせる（W6 の locked.js）
 *     reduceMotion: settings.reduceMotion,               // 動きを減らす（prefers-reduced-motion でも揺れない）
 *     sound: true,                                       // 音（エラーはウッドブロック 1 打・注意は鉛筆の音）。関数を渡せばそれを呼ぶ
 *   });
 *   outputPane.append(c.el);   c.open(2);   c.destroy();
 *
 * 開き方は 3 段（display.hint_steps）: ① title と where → ② ＋why → ③ ＋fix と例・用語・［直す］ボタン。最初は ①。
 * 英文（raw、display.raw_message）: 1〜2 章はかくす（押すと開く）・3〜6 章と C 章は小さく・7〜10 章は先に英文を出して
 * 「英文を自分で読んでみよう → 答え合わせ」。設定「いつも見せる」なら 1〜6 章と C 章も小さく見せる。
 * 実行前の注意（lint・severity が warn / info）は黄色の小さなカードで、揺れない（実行は止めない）。
 * エラーのカードは 1 回だけ小さく揺れる（動きを減らす設定・prefers-reduced-motion では揺れない）。光る線・発光は使わない。
 */

import { play } from '../audio.js';

const STYLE_ID = 'rc-ec-style';
const CSS = `
.rc-ec{--ec-line:var(--line,#d9d2c3);background:var(--card,#fffdf8);color:var(--ink,#23313a);border:1px solid var(--ec-line);
  border-left:4px solid var(--error,#b4472f);border-radius:12px;padding:12px 14px;margin:8px 0;font-size:var(--ui-font,15px);
  line-height:1.7;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}
.rc-ec--warn,.rc-ec--info{background:var(--warn,#fff3e6);border-color:var(--warn-line,#f0d3b3);border-left-color:var(--star-ink,#9a6a12);
  padding:8px 12px;font-size:calc(var(--ui-font,15px) - 1px)}
.rc-ec--hint{border-left-color:var(--grass,#5f8f3e)}
.rc-ec-head{display:flex;gap:10px;align-items:flex-start}
.rc-ec-face{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;
  background:var(--sand,#f3ead8);color:var(--ink,#23313a);border:1px solid var(--ec-line)}
.rc-ec--warn .rc-ec-face,.rc-ec--info .rc-ec-face{width:26px;height:26px}
.rc-ec-title{margin:2px 0 0;font-weight:700}
.rc-ec-where{display:inline-flex;gap:6px;align-items:center;margin:6px 0 0 42px;padding:2px 6px;border:0;border-radius:6px;
  background:transparent;color:var(--blue,#2f6f9f);font:inherit;text-align:left;cursor:pointer;text-decoration:underline;
  text-underline-offset:3px}
.rc-ec-where[aria-disabled="true"]{color:var(--sub,#5d6b73);cursor:default;text-decoration:none}
.rc-ec-sec{margin:8px 0 0 42px}
.rc-ec-sec p{margin:4px 0}
.rc-ec-label{font-weight:700;margin-right:4px}
.rc-ec-ex{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.rc-ec-ex pre{margin:0;padding:6px 10px;border-radius:8px;background:#262d32;color:#c8a2d8;font-family:'BIZ UDGothic',monospace;
  font-size:14px;line-height:1.5;white-space:pre;overflow-x:auto;max-width:100%}
.rc-ec-ex .rc-ec-bad::before{content:"✗ ";color:#e4806a}
.rc-ec-ex .rc-ec-good::before{content:"✓ ";color:#8cc6a0}
.rc-ec-ex pre code{color:#e9e4d8}
.rc-ec-btns{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0 42px}
.rc-ec button.rc-ec-btn{font:inherit;font-size:14px;padding:6px 12px;min-height:36px;border-radius:999px;cursor:pointer;
  border:1px solid var(--ec-line);background:var(--card,#fffdf8);color:var(--ink,#23313a)}
.rc-ec button.rc-ec-fix{background:var(--grass-btn,#4a7a2e);border-color:var(--grass-btn,#4a7a2e);color:#fff}
.rc-ec button.rc-ec-next{border-style:dashed}
.rc-ec button:focus-visible{outline:2px solid var(--focus-color,#23313a);outline-offset:2px}
.rc-ec-raw{margin:8px 0 0 42px;color:var(--sub,#5d6b73)}
.rc-ec-raw code{font-family:'BIZ UDGothic',monospace;font-size:13px;overflow-wrap:anywhere}
.rc-ec-raw--small{font-size:13px}
.rc-ec-raw--first{margin:8px 0 4px 42px;color:var(--ink,#23313a)}
.rc-ec-raw--first code{display:block;font-size:15px;padding:6px 10px;border-radius:8px;background:var(--sand,#f3ead8)}
.rc-ec-raw summary{cursor:pointer;font-size:13px}
.rc-ec-notes{color:var(--sub,#5d6b73)}
.rc-ec--shake{animation:rc-ec-shake .32s ease-out 1}
@keyframes rc-ec-shake{0%{transform:translateX(0)}25%{transform:translateX(-3px)}50%{transform:translateX(3px)}75%{transform:translateX(-2px)}100%{transform:translateX(0)}}
@media (prefers-reduced-motion: reduce){.rc-ec--shake{animation:none}}
@media (max-width:599px){.rc-ec-where,.rc-ec-sec,.rc-ec-btns,.rc-ec-raw{margin-left:0}}
`;

// 線の太さ 1.75 px・角丸の小さな絵（3.1 のアイコンと同じ描き方。色は currentColor）
const SVG = (inner, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  rover: SVG('<rect x="5" y="7" width="14" height="9" rx="3"/><circle cx="9.5" cy="11.5" r="1"/><circle cx="14.5" cy="11.5" r="1"/><path d="M12 7V4.5"/><circle cx="7.5" cy="18.5" r="1.8"/><circle cx="16.5" cy="18.5" r="1.8"/>'),
  senpai: SVG('<circle cx="12" cy="9" r="4"/><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5"/><path d="M9 8.2c1.6-1.6 4.4-1.6 6 0"/>'),
  pin: SVG('<path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>', 16),
  why: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5"/><path d="M12 17h.01"/>', 16),
  fix: SVG('<path d="M14.5 6.5a4 4 0 0 0 5 5l-8.6 8.6a2 2 0 0 1-2.8-2.8z"/><path d="M14.5 6.5l3-3"/>', 16),
  book: SVG('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20"/>', 16),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 章の番号（"C" は C）。 */
function chapterKey(ch) {
  if (typeof ch === 'number') return ch;
  const s = String(ch ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  return s.toUpperCase() === 'C' ? 'C' : 99;
}

/**
 * 英文（本物のエラー文）の見せ方（9.2 display.raw_message）。
 * @param {number|string} chapter @param {'chapter'|'always'} [setting='chapter'] @param {object} [rules]
 * @returns {'hidden'|'small'|'first'}
 */
export function rawModeFor(chapter, setting = 'chapter', rules) {
  const ch = chapterKey(chapter);
  const table = rules?.display?.raw_message || [
    { chapters: [1, 2], mode: 'hidden' }, { chapters: [3, 6], mode: 'small' }, { chapters: [7, 10], mode: 'first' }, { chapters: ['C'], mode: 'small' }];
  let mode = 'small';
  for (const row of table) {
    const [a, b] = row.chapters;
    if (ch === 'C' ? a === 'C' : (typeof a === 'number' && ch >= a && ch <= (b ?? a))) { mode = row.mode; break; }
  }
  if (setting === 'always' && mode === 'hidden') mode = 'small';
  return mode;
}

/**
 * where に「（世界 2 でだけ起きたよ）」「（鍵の行。原因は空欄に入れた値かもしれないよ）」を足した、新しいカードを返す（9.2・3.4〔1.1〕）。
 * もとのカードは書きかえない。同じ種類の文は 2 回足さない（card.notes を見る）。
 * @param {object} card @param {{locked?: number[][], worldNote?: string, lockedNote?: string, rules?: object}} [opts]
 * @returns {object} カード（locked: 鍵の行のエラーなら true）
 */
export function decorateCard(card, { locked, worldNote, lockedNote, rules } = {}) {
  const c = { ...card, notes: [...(card?.notes || [])] };
  const has = (kind) => c.notes.some((n) => n.kind === kind);
  if (worldNote && !has('world')) {
    c.where = (c.where || '') + worldNote;
    c.notes.push({ kind: 'world', text: worldNote });
  }
  // 鍵の行: エディタ（W6 の editor.js）が見分けて lockedNote を渡すか、locked の行の範囲からここで見分ける
  const ln = c.line;
  const inLocked = !!(ln && Array.isArray(locked) && locked.some(([a, b]) => ln >= a && ln <= b));
  if (lockedNote || inLocked) {
    c.locked = true;
    if (!has('locked')) {
      const t = typeof lockedNote === 'string' && lockedNote ? lockedNote : (rules?.where_locked || '（鍵の行。原因は空欄に入れた値かもしれないよ）');
      c.where = (c.where || '') + t;
      c.notes.push({ kind: 'locked', text: t });
    }
  }
  return c;
}

function ensureStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  (doc.head || doc.documentElement).appendChild(st);
}

let uid = 0;

/**
 * カードの要素を作る（SPEC 9.3）。
 * @param {import('../../worker/engine.js').Card} card error_explain.py の Card か replay_explain.js の Hint
 * @param {object} opts 上の「決めた形」
 * @param {number|string} opts.chapter 章（英文の出し分け）
 * @param {'chapter'|'always'} [opts.rawMode='chapter'] 設定「英語のエラー文」（3.9）
 * @param {(ruleId: string) => void} [opts.onQuickfix] ［半角に直す］などを押した時
 * @param {(zukanId: string) => void} [opts.onZukan] 用語・ずかんへ
 * @param {(line: number, col: number|null) => void} [opts.onLine] where を押した時（エディタのその行へ）
 * @param {string|null} [opts.worldNote] 〔1.1〕「（世界 2 でだけ起きたよ）」など where の後ろに足す文
 * @param {string|null} [opts.lockedNote] 〔1.1〕鍵の行のエラーの時に where の後ろに足す文（W6 の editor が見分けて渡す）。あれば onLockedError も呼ぶ
 * @param {number[][]} [opts.locked] 鍵の行の範囲（lockedNote が無い時に、ここで見分ける）
 * @returns {{el: HTMLElement, open: (step: 1|2|3) => void, destroy: () => void, readonly step: number, card: object}}
 */
export function createErrorCard(card, opts = {}) {
  const doc = opts.document || globalThis.document;
  ensureStyle(doc);
  const rules = opts.rules;
  const c = decorateCard(card || {}, { locked: opts.locked, worldNote: opts.worldNote, lockedNote: opts.lockedNote, rules });
  if (c.locked && typeof opts.onLockedError === 'function') { try { opts.onLockedError(c); } catch { /* 画面の都合で失敗しても続ける */ } }
  const sev = c.severity || 'error';
  const kind = sev === 'hint' ? 'hint' : (sev === 'warn' || sev === 'info') ? sev : 'error';
  const speaker = c.speaker || (kind === 'hint' ? 'senpai' : 'rover');
  const mode = c.raw ? rawModeFor(opts.chapter, opts.rawMode, rules) : 'none';
  const id = `rc-ec-${++uid}`;
  const steps = rules?.display?.hint_steps;
  const zukanName = c.zukan && rules?.zukan?.[c.zukan]?.name;
  const hasWhy = !!c.why;
  const hasFix = !!(c.fix || c.example || c.quickfix || c.term || c.confirm);

  const el = doc.createElement('section');
  el.className = `rc-ec rc-ec--${kind}`;
  el.dataset.id = c.id || '';
  el.dataset.raw = mode;
  el.setAttribute('aria-labelledby', `${id}-title`);

  const where = c.where
    ? `<button type="button" class="rc-ec-where" data-part="where" ${c.line ? '' : 'aria-disabled="true"'}>${ICONS.pin}<span>${esc(c.where)}</span></button>`
    : '';
  const ex = c.example && (c.example.bad || c.example.good)
    ? `<div class="rc-ec-ex">${c.example.bad ? `<pre class="rc-ec-bad" aria-label="まちがいの例"><code>${esc(c.example.bad)}</code></pre>` : ''}${c.example.good ? `<pre class="rc-ec-good" aria-label="よい例"><code>${esc(c.example.good)}</code></pre>` : ''}</div>` : '';
  // 全角の文字のエラーは［半角に直す］をカードの最初の段に出す（1-1 のヒントが「ボタンでも直せる」と言うのに、2 回開くまで出なかった。直し係 4）
  const qfTop = !!(c.quickfix && c.quickfix.label && (/^(FW_|CHOON_)/.test(String(c.id || '')) || c.quickfix.type === 'char_map'));
  const qfBtn = c.quickfix && c.quickfix.label ? `<button type="button" class="rc-ec-btn rc-ec-fix" data-part="quickfix">${esc(c.quickfix.label)}</button>` : '';
  const qf = qfTop ? '' : qfBtn;
  const confirm = c.confirm
    ? `<button type="button" class="rc-ec-btn" data-part="confirm-run">このまま実行</button><button type="button" class="rc-ec-btn rc-ec-fix" data-part="confirm-fix">直す</button>` : '';
  const term = c.term ? `<p class="rc-ec-term">${ICONS.book}<span class="rc-ec-label">用語:</span>${esc(c.term)}</p>` : '';
  const zukan = c.zukan ? `<button type="button" class="rc-ec-btn" data-part="zukan">ずかん「${esc(zukanName || c.zukan)}」へ</button>` : '';
  const rawFirst = mode === 'first'
    ? `<div class="rc-ec-raw rc-ec-raw--first" data-part="raw"><p class="rc-ec-label">${esc(rowLabel(rules, 'first') || '英文を自分で読んでみよう')}</p><code lang="en">${esc(c.raw)}</code>
       <div class="rc-ec-btns" style="margin-left:0"><button type="button" class="rc-ec-btn" data-part="reveal">${esc(rowReveal(rules) || '答え合わせ')}</button></div></div>` : '';
  const rawLate = mode === 'hidden'
    ? `<details class="rc-ec-raw rc-ec-raw--hidden" data-part="raw"><summary>${esc(rowLabel(rules, 'hidden') || '本物のエラー文を見る')}</summary><code lang="en">${esc(c.raw)}</code></details>`
    : mode === 'small' ? `<p class="rc-ec-raw rc-ec-raw--small" data-part="raw"><span class="rc-ec-label">${esc(rowLabel(rules, 'small') || '本物のエラー文')}:</span><code lang="en">${esc(c.raw)}</code></p>` : '';

  el.innerHTML = `
    ${rawFirst}
    <div class="rc-ec-head" data-part="head">
      <span class="rc-ec-face" title="${speaker === 'senpai' ? 'ミナミ先輩' : 'ローバー'}">${speaker === 'senpai' ? ICONS.senpai : ICONS.rover}</span>
      <p class="rc-ec-title" id="${id}-title">${esc(c.title || c.say || '')}</p>
    </div>
    ${where}
    <div class="rc-ec-sec" data-part="why" hidden>${hasWhy ? `<p>${ICONS.why}<span class="rc-ec-label">なぜ:</span>${esc(c.why)}</p>` : ''}</div>
    <div class="rc-ec-sec" data-part="fix" hidden>
      ${c.fix ? `<p>${ICONS.fix}<span class="rc-ec-label">どう直す:</span>${esc(c.fix)}</p>` : ''}
      ${ex}${term}
      <div class="rc-ec-btns" style="margin-left:0">${confirm}${qf}${zukan}</div>
    </div>
    <div class="rc-ec-btns" data-part="nav">${qfTop ? qfBtn : ''}<button type="button" class="rc-ec-btn rc-ec-next" data-part="next" aria-expanded="false" aria-controls="${id}-title"></button></div>
    ${rawLate}`;

  const q = (part) => el.querySelector(`[data-part="${part}"]`);
  const nextBtn = q('next');
  let step = 1;
  let revealed = mode !== 'first';
  const maxStep = hasFix ? 3 : hasWhy ? 2 : 1;

  function render() {
    q('head').hidden = !revealed;
    if (q('where')) q('where').hidden = false;
    q('why').hidden = !revealed || step < 2 || !hasWhy;
    q('fix').hidden = !revealed || step < 3 || !hasFix;
    el.dataset.step = String(step);
    const label = step >= maxStep ? 'とじる ▴' : step === 1 ? (hasWhy ? 'もっと詳しく ▾' : '直し方を見る ▾') : '直し方を見る ▾';
    nextBtn.textContent = label;
    nextBtn.title = steps ? steps[Math.min(step, steps.length - 1)] || '' : '';
    nextBtn.setAttribute('aria-expanded', step > 1 ? 'true' : 'false');
    q('nav').hidden = !revealed || (maxStep === 1 && !qfTop);
    nextBtn.hidden = maxStep === 1;
  }
  function open(s) {
    step = Math.max(1, Math.min(maxStep, Number(s) || 1));
    render();
  }
  function onClick(e) {
    const b = e.target.closest('[data-part]');
    if (!b || !el.contains(b)) return;
    const part = b.dataset.part;
    if (part === 'next') open(step >= maxStep ? 1 : step + 1);
    else if (part === 'reveal') { revealed = true; b.closest('.rc-ec-btns').hidden = true; render(); }
    else if (part === 'where' && c.line && opts.onLine) opts.onLine(c.line, c.col ?? null);
    else if (part === 'quickfix' && opts.onQuickfix) opts.onQuickfix(c.id);
    else if (part === 'zukan' && opts.onZukan) opts.onZukan(c.zukan);
    else if (part === 'confirm-run' && opts.onConfirm) opts.onConfirm('run');
    else if (part === 'confirm-fix' && opts.onConfirm) opts.onConfirm('fix');
  }
  el.addEventListener('click', onClick);
  render();

  // 1 回だけ小さく揺れる（エラーのカードだけ。動きを減らす設定・prefers-reduced-motion では揺れない）
  const reduce = opts.reduceMotion ?? !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (kind === 'error' && !reduce) {
    el.classList.add('rc-ec--shake');
    el.addEventListener('animationend', () => el.classList.remove('rc-ec--shake'), { once: true });
  }
  // 音（1 回）: エラーはウッドブロック、注意・先輩は鉛筆の音。音だけで伝えることはしない（10.1）
  if (opts.sound !== false) {
    const name = kind === 'error' ? 'error' : 'note';
    try {
      if (typeof opts.sound === 'function') opts.sound(name);
      else play(name);
    } catch { /* 音が出せなくても（AudioContext が起きていない・音の部品がまだ無い）カードは出す */ }
  }

  return {
    el,
    open,
    get step() { return step; },
    card: c,
    destroy() { el.removeEventListener('click', onClick); el.remove(); },
  };
}

function rowLabel(rules, mode) {
  const row = (rules?.display?.raw_message || []).find((r) => r.mode === mode);
  return row && row.label;
}
function rowReveal(rules) {
  const row = (rules?.display?.raw_message || []).find((r) => r.mode === 'first');
  return row && row.reveal;
}
