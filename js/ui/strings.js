/**
 * @file app/js/ui/strings.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 画面の文言（data/strings.ja.json）を読み、t('分類.名前', {値}) で差しこんで返す。
 * SPEC: 11 章（文言のきまり）・11.2（{rover}）・11.4（{total_levels}・{total_stars} から作る）
 *
 * - {名前} は vars（rover・total_levels など）と、呼ぶ時に渡した値で置きかえる。知らない {名前} はそのまま残す（9.2 と同じ）。
 * - 読み込む前に呼ばれた時や、無いキーの時は、キーの名前をそのまま返す（画面が止まらないように）。
 */

let table = {};
let vars = {};

/** 文言を入れる（main.js が fetch した JSON、テストは直接）。 @param {object} json */
export function setStrings(json) {
  table = json || {};
  vars = { ...(table.vars || {}) };
}

/** 差しこみの共通の値を足す・変える（例: ローバーの名前が決まった時）。 @param {object} v */
export function setVars(v) { Object.assign(vars, v); }

/** @returns {object} 共通の値 */
export function getVars() { return vars; }

/**
 * 文の {名前} を置きかえる。
 * @param {string} s @param {object} [v]
 * @returns {string}
 */
export function fill(s, v = {}) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => {
    if (v && Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined && v[k] !== null) return String(v[k]);
    if (Object.prototype.hasOwnProperty.call(vars, k)) return String(vars[k]);
    return m;
  });
}

/**
 * 文言を 1 つ取り出す。
 * @param {string} key 例 'button.start'
 * @param {object} [v] 差しこむ値
 * @returns {string}
 */
export function t(key, v) {
  const parts = key.split('.');
  let cur = table;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return key;
  }
  return typeof cur === 'string' ? fill(cur, v) : key;
}

/** 文言のキーがあるか。 @param {string} key */
export function has(key) { return t(key) !== key; }

/** HTML に入れる時の書き換え（& < > " '）。 @param {any} s @returns {string} */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
