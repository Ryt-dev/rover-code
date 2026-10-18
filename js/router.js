/**
 * @file app/js/router.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 画面の切りかえ（1 ページの中でハッシュのルータ。ブラウザの「戻る」で 1 つ前の画面へ）。
 * SPEC: 2.1（#/title・#/map・#/play/1-3・#/zukan/motor・#/free・#/settings・#/story/2）
 *
 * 形（W7 が決めた）:
 *   const r = createRouter({ title(param) {…}, map(param) {…}, … }, { win: window });
 *   r.start()            今のハッシュの画面を出す（無ければ #/title）
 *   r.go('#/play/1-3')   履歴に足して切りかえる（「戻る」で戻れる）
 *   r.replace('#/map')   履歴に足さずに切りかえる（はじめる → 1-1 の時など）
 *   r.current()          { name, param }
 * ハンドラは同期でも async でもよい。切りかえの前に beforeLeave() が false を返したら切りかえない（今は使っていない）。
 */

/** 画面の名前（2.1）。 */
export const ROUTES = Object.freeze(['title', 'map', 'play', 'zukan', 'free', 'settings', 'story', 'ending']);

/**
 * ハッシュを読む。例 "#/play/1-3" → { name: 'play', param: '1-3' }。知らない時は title。
 * @param {string} hash @returns {{name: string, param: string|null}}
 */
export function parseHash(hash) {
  const s = String(hash || '').replace(/^#\/?/, '');
  if (!s) return { name: 'title', param: null };
  const i = s.indexOf('/');
  const name = (i < 0 ? s : s.slice(0, i)).toLowerCase();
  let param = i < 0 ? null : s.slice(i + 1);
  if (param !== null) {
    try { param = decodeURIComponent(param); } catch { /* そのまま */ }
    if (param === '') param = null;
  }
  if (!ROUTES.includes(name)) return { name: 'title', param: null };
  return { name, param };
}

/**
 * 画面の名前と引数からハッシュを作る。
 * @param {string} name @param {string|number|null} [param] @returns {string}
 */
export function makeHash(name, param) {
  return param === undefined || param === null || param === '' ? `#/${name}` : `#/${name}/${encodeURIComponent(String(param))}`;
}

/**
 * ルータを作る。
 * @param {Object<string, (param: string|null, info: {from: {name: string, param: string|null}|null}) => any>} handlers 画面の名前ごとの関数
 * @param {{win?: Window}} [opts]
 * @returns {{start: () => void, go: (hash: string) => void, replace: (hash: string) => void, current: () => {name: string, param: string|null}, stop: () => void}}
 */
export function createRouter(handlers, { win = globalThis.window } = {}) {
  let cur = null;
  let started = false;

  function show(hash) {
    const next = parseHash(hash);
    const from = cur;
    cur = next;
    const h = handlers[next.name] || handlers.title;
    try {
      const r = h && h(next.param, { from });
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(e));
    } catch (e) { console.error(e); }
  }
  const onHash = () => show(win.location.hash);

  return {
    start() {
      if (started) return;
      started = true;
      win.addEventListener('hashchange', onHash);
      show(win.location.hash);
    },
    go(hash) {
      if (win.location.hash === hash) show(hash);
      else win.location.hash = hash;          // hashchange で show
    },
    replace(hash) {
      const url = `${win.location.pathname}${win.location.search}${hash}`;
      try { win.history.replaceState(win.history.state, '', url); } catch { win.location.replace(hash); return; }
      show(hash);
    },
    current() { return cur || parseHash(win.location.hash); },
    stop() { win.removeEventListener('hashchange', onHash); started = false; },
  };
}
