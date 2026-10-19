/**
 * @file app/js/ui/wait_bar.js
 * 持ち主: 見た目の直し係（ブラッシュアップ 15）
 * 役割: 待ち時間の細い進捗バー（高さ 4 px・芝色）。ローバーのアイコンが道を進み、横にひとことを出す。
 *       0.5 秒より短い待ちでは出さない（チラつかせない）。割合が分からない時は、ローバーが道をゆっくり行き来する
 *       （動きを減らす設定では止めて、真ん中に置く）。
 */

const ROVER = '<svg viewBox="0 0 24 16" width="20" height="14" aria-hidden="true" focusable="false"><rect x="6" y="3" width="12" height="7" rx="2" fill="#5f8f3e"/><rect x="11" y="0" width="1.6" height="4" fill="#2a3238"/><circle cx="11.8" cy="0.9" r="1.3" fill="#d9672b"/><circle cx="6" cy="11" r="4.2" fill="#2a3238"/><circle cx="18" cy="11" r="4.2" fill="#2a3238"/><circle cx="6" cy="11" r="1.6" fill="#f3ead8"/><circle cx="18" cy="11" r="1.6" fill="#f3ead8"/></svg>';

/**
 * @param {HTMLElement} host 入れる場所（その最後に足す）
 * @param {{delay?: number, className?: string}} [o]
 * @returns {{start: (text?: string, pct?: number|null) => void, set: (pct?: number|null, text?: string) => void, stop: () => void, readonly shown: boolean}}
 */
export function createWaitBar(host, { delay = 500, className = '' } = {}) {
  const el = document.createElement('div');
  el.className = `wait-bar${className ? ` ${className}` : ''}`;
  el.setAttribute('role', 'status');
  el.hidden = true;
  el.innerHTML = `<div class="wb-road"><i class="wb-fill"></i><span class="wb-rover">${ROVER}</span></div><span class="wb-text"></span>`;
  host.appendChild(el);
  let timer = 0;
  let running = false;
  let pct = null;
  let text = '';
  function paint() {
    el.querySelector('.wb-text').textContent = text;
    const known = Number.isFinite(pct);
    el.classList.toggle('unknown', !known);
    const p = known ? Math.max(0, Math.min(100, pct)) : 0;
    el.querySelector('.wb-fill').style.width = known ? `${p}%` : '';
    el.querySelector('.wb-rover').style.left = known ? `${p}%` : '';
  }
  return {
    start(t = '', p = null) {
      text = t; pct = p;
      paint();
      if (running) return;
      running = true;
      clearTimeout(timer);
      timer = setTimeout(() => { if (running) el.hidden = false; }, delay);
    },
    set(p = null, t) { pct = p; if (t !== undefined) text = t; paint(); },
    stop() { running = false; clearTimeout(timer); el.hidden = true; },
    get shown() { return !el.hidden; },
    el,
  };
}
