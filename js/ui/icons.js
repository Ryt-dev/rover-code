/**
 * @file app/js/ui/icons.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: アイコン（見本の絵文字 🗺 📖 ⚙ 💡 👀 は OS で見た目が変わるので、同じ線の太さ 1.75 px・角丸の自作 SVG に置きかえる）。
 * SPEC: 3.1（アイコン）
 *
 * 使い方: el.innerHTML = icon('map')。色は currentColor（字の色）。label を渡すと role="img" と aria-label が付く。
 */

const P = {
  map: '<path d="M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20z"/><path d="M8.5 4v13.5M15.5 6.5V20"/>',
  book: '<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"/><path d="M12 6.5v13"/>',
  gear: '<path d="M19.11 9.94 L21.48 10.50 L21.48 13.50 L19.11 14.06 L18.48 15.56 L19.77 17.64 L17.64 19.77 L15.56 18.48 L14.06 19.11 L13.50 21.48 L10.50 21.48 L9.94 19.11 L8.44 18.48 L6.36 19.77 L4.23 17.64 L5.52 15.56 L4.89 14.06 L2.52 13.50 L2.52 10.50 L4.89 9.94 L5.52 8.44 L4.23 6.36 L6.36 4.23 L8.44 5.52 L9.94 4.89 L10.50 2.52 L13.50 2.52 L14.06 4.89 L15.56 5.52 L17.64 4.23 L19.77 6.36 L18.48 8.44 Z"/><circle cx="12" cy="12" r="3"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  play: '<path d="M7.5 5.5v13l11-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4.5h11l-2.5 4 2.5 4H6"/>',
  graph: '<path d="M4 4v16h16"/><path d="m7 15 3.5-4 3 2.5L19 7"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><path d="M12 8v4.5l3 2"/>',
  toolbox: '<rect x="3.5" y="8" width="17" height="11" rx="2"/><path d="M9 8V5.5h6V8M3.5 12.5h17M10.5 12.5v2h3v-2"/>',
  carry: '<path d="M4 12h12"/><path d="m12 7 5 5-5 5"/><path d="M20 5v14"/>',
  next: '<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>',
  back: '<path d="M19 12H6"/><path d="m11 6-6 6 6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  test: '<path d="M9 3.5h6M10 3.5v5.5L5 18.5A1.6 1.6 0 0 0 6.4 21h11.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3.5"/><path d="M7.5 15h9"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7.5" rx="2"/><path d="M7 14h10v6H7z"/>',
  sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  key: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h.01M10 11h.01M13 11h.01M16 11h.01M8 14h8"/>',
  cone: '<path d="M9.5 4h5l4 15h-13z"/><path d="M8.2 10h7.6M7 14.5h10M4 19.5h16"/>',
  rock: '<path d="M4 17.5 6.5 10l4-3.5 5 1.5 3.5 4 1 5.5z"/>',
  wall: '<path d="M3.5 7h17v10h-17zM3.5 12h17M9 7v5M15 7v5M12 12v5M6 12v5M18 12v5"/>',
  sand: '<path d="M3 15c3-2 6-2 9 0s6 2 9 0M3 19c3-2 6-2 9 0s6 2 9 0"/><path d="M7 9h.01M12 7h.01M17 10h.01"/>',
  start: '<circle cx="12" cy="12" r="7.5"/><path d="M12 7.5v4.5l3 2"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  erase: '<path d="M8 20h12"/><path d="m4.5 15.5 9-9 5 5-6.5 6.5H8z"/>',
  world: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
  leaf: '<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 13 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5h.01"/>',
  sil: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/><path d="m8 9 2 1.5L8 12M12 12h4"/>',
};

/** アイコンの名前。 */
export const ICON_NAMES = Object.freeze(Object.keys(P));

/**
 * SVG の文字を返す（viewBox 0 0 24 24、stroke は currentColor・1.75 px・角丸。fill なし）。
 * @param {string} name @param {{size?: number, label?: string, cls?: string}} [opts] label が無ければ aria-hidden
 * @returns {string}
 */
export function icon(name, opts = {}) {
  const d = P[name] || P.info;
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  const a = opts.label ? ` role="img" aria-label="${String(opts.label).replace(/"/g, '&quot;')}"` : ' aria-hidden="true"';
  return `<svg class="ic${opts.cls ? ' ' + opts.cls : ''}" viewBox="0 0 24 24"${size}${a} focusable="false">${d}</svg>`;
}
