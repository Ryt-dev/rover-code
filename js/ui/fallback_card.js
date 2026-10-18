/**
 * @file app/js/ui/fallback_card.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: W3 のエラーカード（js/ui/error_card.js）がまだ空の実装の間の代わり。同じ窓口 createErrorCard(card, opts) → {el, open, destroy}。
 *       W3 のカードができれば play.js はそちらを使う（ここは使わない）。
 * SPEC: 9.3（エラーカードの形・3 段の開き方・英文の出し分け）・3.4（鍵の行）・9.2（一部の世界だけ）
 */

import { esc, t } from './strings.js';
import { roverSVG } from './senpai.js';

/**
 * @param {object} card 9.3 のカード
 * @param {{chapter?: number|string, rawMode?: 'chapter'|'always', onQuickfix?: (id: string) => void, onLine?: (line: number, col: number|null) => void, worldNote?: string|null}} [opts]
 */
export function createFallbackCard(card, opts = {}) {
  const el = document.createElement('div');
  const warn = card.severity === 'warning' || card.severity === 'info' || card.stage === 'lint';
  el.className = warn ? 'ecard warn' : 'ecard';
  el.setAttribute('role', warn ? 'note' : 'alert');
  const ch = opts.chapter;
  const n = Number(ch);
  const rawShow = opts.rawMode === 'always' ? 'small' : ch === 'C' ? 'small' : !Number.isFinite(n) ? 'small' : n <= 2 ? 'hide' : n <= 6 ? 'small' : 'first';
  const where = `${card.where || ''}${opts.worldNote ? ` ${opts.worldNote}` : ''}`;
  const qf = card.quickfix && opts.onQuickfix ? `<button type="button" class="btn small qf">${esc(card.quickfix.label || t('button.fix_zenkaku'))}</button>` : '';
  const ex = card.example ? `<div class="ec-ex"><span class="bad">✗ <code>${esc(card.example.bad)}</code></span><span class="good">✓ <code>${esc(card.example.good)}</code></span></div>` : '';
  const raw = card.raw && rawShow !== 'hide' ? `<details class="ec-raw"${rawShow === 'first' ? '' : ''}><summary>本物のエラー文を見る</summary><code>${esc(card.raw)}</code></details>` : '';
  const rawFirst = card.raw && rawShow === 'first' ? `<div class="ec-rawfirst"><code>${esc(card.raw)}</code><div class="ec-q">自分で読めるかな？</div></div>` : '';
  el.innerHTML = `
    ${rawFirst}
    <div class="ec-head"><span class="ec-face">${roverSVG()}</span><div class="ec-title">${esc(card.title || '')}</div></div>
    ${where ? `<div class="ec-where"><button type="button" class="linkish ec-line">${esc(where)}</button>${qf}</div>` : qf ? `<div class="ec-where">${qf}</div>` : ''}
    <details class="ec-more"${rawFirst ? '' : ''}><summary>もっと詳しく</summary>
      ${card.why ? `<p class="ec-why"><b>なぜ:</b> ${esc(card.why)}</p>` : ''}
      ${card.fix ? `<p class="ec-fix"><b>どう直す:</b> ${esc(card.fix)}</p>` : ''}
      ${ex}
    </details>
    ${raw}`;
  const more = el.querySelector('.ec-more');
  const lineBtn = el.querySelector('.ec-line');
  if (lineBtn && opts.onLine && card.line) lineBtn.addEventListener('click', () => opts.onLine(card.line, card.col ?? null));
  const q = el.querySelector('.qf');
  if (q) q.addEventListener('click', () => opts.onQuickfix(card.id));
  if (!warn && !(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) && !document.documentElement.classList.contains('reduce-motion')) {
    el.classList.add('shake');
  }
  return {
    el,
    open(step) { if (step >= 2) more.open = true; },
    destroy() { el.remove(); },
    fallback: true,
  };
}
