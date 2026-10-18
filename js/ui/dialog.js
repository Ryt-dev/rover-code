/**
 * @file app/js/ui/dialog.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: ダイアログ（角丸 16 px のカード。Esc で閉じる。重ねて開かない。小さい画面（900 px 未満）では全画面）。
 * SPEC: 3.1（ダイアログ）・3.5（900 px 未満は全画面）・3.1 の Esc の順番（開いていれば最初に閉じる）
 *
 * ブラウザの <dialog>（showModal）を使う: 後ろの画面に Tab が抜けない・Esc で cancel が来る・閉じたら開いた所へフォーカスが戻る。
 */

import { icon } from './icons.js';
import { t } from './strings.js';

let current = null;   // { el, resolve, opener }

/** 開いているか。 */
export function isOpen() { return !!current; }

/**
 * ダイアログを開く（すでに開いていれば閉じてから）。
 * @param {{title: string, body: HTMLElement|string, actions?: {label: string, value: string, primary?: boolean, danger?: boolean}[],
 *          cls?: string, wide?: boolean, onOpen?: (el: HTMLElement) => void, noCopy?: boolean}} opts
 *   body が文字なら字として入れる（HTML にはしない）。noCopy は先輩の答え（選べない・写せない。3.6）
 * @returns {Promise<string|null>} 押したボタンの value。Esc・閉じるは null
 */
export function openDialog(opts) {
  if (current) closeDialog(null);
  const opener = document.activeElement;
  const dlg = document.createElement('dialog');
  dlg.className = `dlg${opts.cls ? ' ' + opts.cls : ''}${opts.wide ? ' wide' : ''}`;
  const titleId = `dlg-t-${Math.random().toString(36).slice(2, 8)}`;
  dlg.setAttribute('aria-labelledby', titleId);
  const head = document.createElement('div');
  head.className = 'dlg-head';
  const h = document.createElement('h2');
  h.id = titleId;
  h.textContent = opts.title || '';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dlg-x';
  x.setAttribute('aria-label', t('dialog.close'));
  x.innerHTML = icon('close');
  x.addEventListener('click', () => closeDialog(null));
  head.append(h, x);
  const body = document.createElement('div');
  body.className = 'dlg-body';
  if (typeof opts.body === 'string') body.textContent = opts.body;
  else if (opts.body) body.appendChild(opts.body);
  dlg.append(head, body);
  if (opts.actions && opts.actions.length) {
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`;
      b.textContent = a.label;
      b.dataset.value = a.value;
      b.addEventListener('click', () => closeDialog(a.value));
      foot.appendChild(b);
    }
    dlg.appendChild(foot);
  }
  if (opts.noCopy) {
    dlg.classList.add('nocopy');
    for (const ev of ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart']) dlg.addEventListener(ev, (e) => e.preventDefault());
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(null); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(null); });   // 外側を押したら閉じる
  document.body.appendChild(dlg);
  return new Promise((resolve) => {
    current = { el: dlg, resolve, opener };
    try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
    if (opts.onOpen) { try { opts.onOpen(body); } catch (e) { console.error(e); } }
    const first = dlg.querySelector('.dlg-foot .primary') || dlg.querySelector('.dlg-body button, .dlg-body input, .dlg-body select, .dlg-body textarea, .dlg-body [tabindex]') || x;
    try { first.focus(); } catch { /* なし */ }
  });
}

/** 開いているダイアログを閉じる。 @param {string|null} [value] */
export function closeDialog(value = null) {
  if (!current) return;
  const { el, resolve, opener } = current;
  current = null;
  try { el.close(); } catch { /* なし */ }
  el.remove();
  resolve(value);
  if (opener && typeof opener.focus === 'function' && opener.isConnected) { try { opener.focus(); } catch { /* なし */ } }
}

/**
 * はい・いいえを聞く。 @param {string} title @param {string} text @param {{ok?: string, cancel?: string, danger?: boolean}} [o]
 * @returns {Promise<boolean>}
 */
export async function confirmDialog(title, text, o = {}) {
  const v = await openDialog({ title, body: text, actions: [
    { label: o.cancel || t('button.cancel'), value: 'no' },
    { label: o.ok || t('button.ok'), value: 'yes', primary: !o.danger, danger: !!o.danger },
  ] });
  return v === 'yes';
}
