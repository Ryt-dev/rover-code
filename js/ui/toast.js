/**
 * @file app/js/ui/toast.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: トースト（画面下中央、2.5 s で消える）: 「全角の（ を半角の ( に直したよ」「保存したよ」など。
 * SPEC: 3.1（トースト）
 *
 * 読み上げ: role="status"（aria-live="polite"）の箱に入れる。いくつか続いた時は前のものを消して新しいものを出す。
 * action を渡すと押せるボタンが付く（例: 「保存の場所がいっぱい」の［書き出す］）。その時は少し長く出す。
 */

let box = null;
let timer = null;

function ensureBox() {
  if (box && box.isConnected) return box;
  box = document.createElement('div');
  box.className = 'toast-box';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  document.body.appendChild(box);
  return box;
}

/**
 * @param {string} text
 * @param {{ms?: number, action?: {label: string, run: () => void}}} [opts] 既定 2500 ms
 */
export function toast(text, { ms = 2500, action = null } = {}) {
  if (typeof document === 'undefined') return;
  const b = ensureBox();
  b.textContent = '';
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { hide(); action.run(); });
    el.appendChild(btn);
  }
  b.appendChild(el);
  if (timer) clearTimeout(timer);
  timer = setTimeout(hide, action ? Math.max(ms, 6000) : ms);
}

/** 今のトーストを消す。 */
export function hide() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (box) box.textContent = '';
}
