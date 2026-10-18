/**
 * @file app/js/progress.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 解禁・肩書・★の集計・章の進み具合・一度きりの★の取り直し。
 * SPEC: 2.5（開くきまり・肩書）・3.6（取り直し）・7.3「W7 js/progress.js」・8 章（53 面・★ 159）
 *
 * 章の一覧（data/chapters.json）と肩書（data/titles.json）は init() で受け取る。記録は store.js から読む。
 * 数は文に直接書かず、ここの定数から作る（11.4）。
 *
 * 開くきまり（2.5）:
 *   1 章 … 最初から。章の中の面 … 1 つ前の面をクリア。クリアした面はいつでも遊べる。
 *   2〜10 章 … 1 つ前の章のボス（その章の最後の面）をクリア。10 章の 3 面はどれからでも遊べる。
 *   おまけ C … 5 章クリア（C の中は順に）。自由走行場・SIL への書き出し … 1 章クリア。道具箱 … 5 章クリア。
 * 章のクリア: 1〜9 章はボス（最後の面）のクリア、10 章は 3 面すべてのクリア、C は 3 面すべて。
 */

import * as store from './store.js';

/** 面の数（本編 50＋おまけ C 3）。 */
export const TOTAL_LEVELS = 53;
/** ★の数（本編 150＋おまけ C 9）。 */
export const TOTAL_STARS = 159;
/** 本編の★（「部のエース」の条件）。 */
export const MAIN_STARS = 150;

/** 章の一覧が無い時の控え（SPEC 8.2 の面の並び）。 */
const FALLBACK_CHAPTERS = [
  [1, 6], [2, 5], [3, 5], [4, 5], [5, 4], [6, 5], [7, 6], [8, 5], [9, 6], [10, 3], ['C', 3],
].map(([no, n]) => ({ no, levels: Array.from({ length: n }, (_, i) => `${no}-${i + 1}`), title_after: null }));

const FALLBACK_TITLES = ['見学者', '新入部員', '走行係', 'ルート係', 'センサ係', 'ソフト係', '制御係', '航法係', '画像係', '搭載ソフト担当', '種コン代表'];

let chapters = FALLBACK_CHAPTERS;
let titlesDef = null;
let order = [];
let chapterOfId = new Map();

/**
 * 章と肩書を入れる（main.js が data/*.json を読んだ後）。
 * @param {{chapters?: object[], titles?: object}} o
 */
export function init(o = {}) {
  if (Array.isArray(o.chapters) && o.chapters.length) chapters = o.chapters.filter((c) => c && Array.isArray(c.levels));
  if (o.titles) titlesDef = o.titles;
  rebuild();
}
function rebuild() {
  order = [];
  chapterOfId = new Map();
  for (const c of chapters) for (const id of c.levels) { order.push(id); chapterOfId.set(id, c); }
}
rebuild();

/** 面の順（本編 → C）。 @returns {string[]} */
export function levelOrder() { return order.slice(); }
/** 本編の面だけ。 */
export function mainLevels() { return order.filter((id) => !id.startsWith('C-')); }
/** 章の一覧。 */
export function chapterList() { return chapters; }
/** 面の章（chapters.json の 1 つ）。 @param {string} id */
export function chapterOf(id) { return chapterOfId.get(id) || null; }
/** 章の番号から章。 @param {number|string} no */
export function chapterByNo(no) { return chapters.find((c) => String(c.no) === String(no)) || null; }
/** 面の章の番号（1〜10 か "C"）。 @param {string} id */
export function chapterNo(id) { const c = chapterOf(id); if (c) return c.no; const m = /^(\d+|C)-/.exec(id || ''); return m ? (m[1] === 'C' ? 'C' : Number(m[1])) : null; }

const cleared = (id) => store.hasLevel(id) && store.level(id).cleared === true;

/** 章のボス（最後の面）。10 章・C はボスが無い（null）。 @param {object} c */
function bossOf(c) {
  if (!c) return null;
  if (String(c.no) === '10' || String(c.no) === 'C') return null;
  return c.levels[c.levels.length - 1];
}

/** 章をクリアしたか（1〜9 章はボス、10 章・C は全部）。 @param {number|string} no */
export function isChapterCleared(no) {
  const c = chapterByNo(no);
  if (!c) return false;
  const b = bossOf(c);
  return b ? cleared(b) : c.levels.every(cleared);
}

/** 章が開いているか（2.5）。 @param {number|string} no */
export function isChapterUnlocked(no) {
  if (String(no) === '1') return true;
  if (String(no) === 'C') return isChapterCleared(5);
  const n = Number(no);
  if (!Number.isFinite(n)) return false;
  return isChapterCleared(n - 1);
}

/**
 * その面が遊べるか（2.5: 1 つ前の面をクリア・章は前の章のボス・10 章はどれからでも・C は 5 章クリア）。
 * @param {string} id @returns {boolean}
 */
export function isUnlocked(id) {
  if (cleared(id)) return true;
  const c = chapterOf(id);
  if (!c) return false;
  if (!isChapterUnlocked(c.no)) return false;
  if (String(c.no) === '10') return true;
  const i = c.levels.indexOf(id);
  return i <= 0 ? true : cleared(c.levels[i - 1]);
}

/** ★とクリアの合計。 @returns {{stars: number, clears: number, mainStars: number}} */
export function totals() {
  let stars = 0;
  let clears = 0;
  let mainStars = 0;
  for (const id of order) {
    if (!store.hasLevel(id)) continue;
    const L = store.level(id);
    if (L.cleared) clears++;
    const n = (L.stars || []).filter(Boolean).length;
    stars += n;
    if (!id.startsWith('C-')) mainStars += n;
  }
  return { stars, clears, mainStars };
}

/** 肩書の名前の並び（0 = 見学者 … 10 = 種コン代表）。 */
function titleNames() {
  if (titlesDef && Array.isArray(titlesDef.titles) && titlesDef.titles.length) {
    const out = [];
    for (const tt of titlesDef.titles) out[tt.after_chapter] = tt.name;
    return out.map((n, i) => n || FALLBACK_TITLES[i]);
  }
  return FALLBACK_TITLES;
}

/** 今の肩書（下がらない）と札。 @returns {{name: string, rank: number, ace: boolean, cBadge: boolean, aceName: string, badgeName: string}} */
export function title() {
  let rank = 0;
  for (let n = 1; n <= 10; n++) if (isChapterCleared(n)) rank = n;
  const names = titleNames();
  const ace = totals().mainStars >= MAIN_STARS;
  const cBadge = isChapterCleared('C');
  const aceName = (titlesDef && titlesDef.ace && titlesDef.ace.name) || '部のエース';
  const badgeName = (titlesDef && titlesDef.c_badge && titlesDef.c_badge.name) || 'マイコンもいける';
  return { name: ace ? aceName : names[rank] || names[0], rank, ace, cBadge, aceName, badgeName, base: names[rank] || names[0] };
}

/** 章のクリアで上がる肩書の名前。 @param {number|string} no */
export function titleAfter(no) {
  const c = chapterByNo(no);
  if (c && c.title_after) return c.title_after;
  const n = Number(no);
  return Number.isFinite(n) ? titleNames()[n] || null : null;
}

/** 章の進み具合（クリアした面 / 面の数）。 @param {number|string} n @returns {{cleared: number, total: number, stars: number}} */
export function chapterProgress(n) {
  const c = chapterByNo(n);
  if (!c) return { cleared: 0, total: 0, stars: 0 };
  let cl = 0;
  let st = 0;
  for (const id of c.levels) {
    if (!store.hasLevel(id)) continue;
    const L = store.level(id);
    if (L.cleared) cl++;
    st += (L.stars || []).filter(Boolean).length;
  }
  return { cleared: cl, total: c.levels.length, stars: st };
}

/**
 * 〔1.1〕一度きりの★（1 回目の実行でクリア・1 回目の予想）を取り直せるか（外した後、ほかの面を 1 つクリアしてから）。
 * @param {string} id @returns {boolean}
 */
export function canRetryOneShot(id) {
  if (!store.hasLevel(id)) return false;
  const L = store.level(id);
  const o = L.oneShot;
  return !!(o && o.usedAt !== null && o.usedAt !== undefined && o.retryAfterClears >= 1);
}

/** 1 章クリアなどで開くもの（2.5）。 */
export function features() {
  return {
    free: isChapterCleared(1),
    sil: isChapterCleared(1),
    toolbox: isChapterCleared(5),
    c: isChapterCleared(5),
  };
}

/** 次の面（同じ章の次・無ければ次の章の最初。開いていなくても返す）。 @param {string} id @returns {string|null} */
export function nextLevel(id) {
  const i = order.indexOf(id);
  if (i < 0 || i + 1 >= order.length) return null;
  const nx = order[i + 1];
  if (id.startsWith('C-') !== nx.startsWith('C-')) return null;
  return nx;
}

/** 今の面（地図の橙）: 開いていてまだクリアしていない最初の面。全部クリアなら null。 */
export function currentLevel() {
  for (const id of mainLevels()) if (isUnlocked(id) && !cleared(id)) return id;
  return null;
}

/** その面が章のボスか（1〜9 章の最後の面）。 @param {string} id */
export function isBoss(id) {
  const c = chapterOf(id);
  return !!c && bossOf(c) === id;
}

/** その面のクリアで章がクリアになるか（10 章・C は最後の 1 面）。 @param {string} id */
export function completesChapter(id) {
  const c = chapterOf(id);
  if (!c) return false;
  const b = bossOf(c);
  if (b) return b === id;
  return c.levels.every((x) => x === id || cleared(x));
}
