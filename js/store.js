/**
 * @file app/js/store.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 保存（localStorage）。今のコードの自動保存・★とクリア・履歴・クリアした時のコード・設定・書き出しと読み込み・別のタブ。
 * SPEC: 7.9（保存の形）・7.3「W7 js/store.js」・3.9（データ）・3.6（取り直し）・2.3（続きから・今週の走行）・12 章「保存」
 *
 * キー（7.9〔1.1〕）:
 *   rovercode.v1.meta          … 下の JSON から levels[].code・history・clearedCode を除いたもの
 *   rovercode.v1.code.<面>     … 今のコード（文字のまま）
 *   rovercode.v1.hist.<面>     … {"history": [...], "clearedCode": "..."}
 * 書くのは変わったキーだけ。最初の変更から 1 s まとめて書く（打った文字は 1 s 以内に保存される）。読み書きは全部 try/catch。
 *
 * 別のタブ（7.9〔1.1〕）: BroadcastChannel("rovercode")。あとから開いたタブは「見るだけ」（書かない）。先のタブが閉じたら
 * 残ったタブが引きつぐ。ほかのタブが書いた時は storage イベントで読み直し、★とクリアは合わせる（OR）ので消えない。
 *
 * 出来事（on(name, fn)）: change（中身が変わった）・readonly（見るだけになった）・owner（保存を引きついだ）・
 *   quota（書けなかった。書き出しを出す）・trimmed（古い履歴を減らした）・nostorage（保存できない設定）・external（ほかのタブの記録を読み直した）
 */

export const PREFIX = 'rovercode.v1.';
/** キー（7.9〔1.1〕: 分けて、変わったキーだけ書く）。 */
export const KEY_META = 'rovercode.v1.meta';
/** @param {string} id 面 @returns {string} 今のコードのキー */
export const keyCode = (id) => `rovercode.v1.code.${id}`;
/** @param {string} id 面 @returns {string} 履歴とクリアした時のコードのキー */
export const keyHist = (id) => `rovercode.v1.hist.${id}`;
/** 保存の形の版（7.9 の version）。 */
export const SAVE_VERSION = 1;
/** 履歴の数（新しい順）。 */
export const HISTORY_MAX = 5;
/** 履歴の合計の上限（7.9: 2 MB を超えたら古い履歴から消す。文字数で数える）。 */
export const HISTORY_BUDGET = 2 * 1024 * 1024;
/** コード 1 本の上限（5.5: 60 KB）。 */
export const CODE_MAX = 60 * 1024;
/** 自由走行場の保存の数（3.8）。 */
export const FREE_MAX = 20;
/** localStorage の目安の上限（多くのブラウザで 1 つのサイトに 5 MB）。 */
export const QUOTA_GUESS = 5 * 1024 * 1024;
/** 書き出しの声かけの間かく（7.9: 7 日）。 */
export const EXPORT_NUDGE_DAYS = 7;

const LEVEL_ID = /^(?:[1-9]|10|C)-[1-9]\d?$/;

/** 設定の既定（3.9）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  sfx: 60, ambience: 40, mute: false, autoZenkaku: true, editorFont: 15, uiFont: 15,
  replaySpeed: 'auto', quality: 'auto', theme: 'light', rawError: 'chapter', reduceMotion: false,
  overlays: Object.freeze({ trail: true, ghost: true, sensors: true, gnss: true }),
});

// ---------------------------------------------------------------- 内部の状態

let storage = null;          // localStorage か、テストの入れ物
let storageOk = true;
let data = null;             // 7.9 の形（levels[].code・history・clearedCode も入れて持つ）
let dirty = new Set();       // 'meta' | 'code:<id>' | 'hist:<id>'
let timer = null;
let flushMs = 1000;
let clock = () => Date.now();
let readOnly = false;
let tabId = Math.random().toString(36).slice(2);
let channel = null;
let channelFactory = (name) => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null);
let ownerSeen = false;
let claimTimer = null;
let beatTimer = null;        // 〔1.1〕先のタブが落ちて bye を出せなかった時のための合図（2 s ごと）
let lastBeat = 0;
export const BEAT_MS = 2000;
export const BEAT_LOST_MS = 6500;
let undoSnapshot = null;
let sinceLastSeenMs = null;
const fns = new Map();
let warnedNoStorage = false;

function emit(name, v) {
  for (const fn of fns.get(name) || []) { try { fn(v); } catch (e) { console.error(e); } }
}

/**
 * 出来事を受ける。 @param {string} name @param {(v: any) => void} fn @returns {() => void} 外す関数
 */
export function on(name, fn) {
  if (!fns.has(name)) fns.set(name, new Set());
  fns.get(name).add(fn);
  return () => fns.get(name).delete(fn);
}

/**
 * テストや特別な場面のための差しかえ（入れ物・タブの連絡・時計・まとめる時間）。
 * @param {{storage?: Storage|null, channelFactory?: (name: string) => any, clock?: () => number, flushMs?: number, tabId?: string}} o
 */
export function configure(o = {}) {
  if ('storage' in o) storage = o.storage;
  if (o.channelFactory) channelFactory = o.channelFactory;
  if (o.clock) clock = o.clock;
  if (typeof o.flushMs === 'number') flushMs = o.flushMs;
  if (o.tabId) tabId = o.tabId;
}

/** テスト用: 状態を全部捨てる（入れ物の中身は消さない）。 */
export function _reset() {
  if (timer) clearTimeout(timer);
  if (claimTimer) clearTimeout(claimTimer);
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null; lastBeat = 0;
  try { channel && channel.close && channel.close(); } catch { /* なし */ }
  timer = null; claimTimer = null; channel = null; data = null; dirty = new Set(); readOnly = false; ownerSeen = false;
  undoSnapshot = null; fns.clear(); warnedNoStorage = false; storageOk = true; sinceLastSeenMs = null;
}

// ---------------------------------------------------------------- 入れ物（try/catch）

function backend() {
  if (storage) return storage;
  try {
    const s = globalThis.localStorage;
    if (s) { storage = s; return s; }
  } catch { /* 使えない */ }
  return null;
}
function rawGet(key) {
  const s = backend();
  if (!s) return null;
  try { return s.getItem(key); } catch { noStorage(); return null; }
}
function rawSet(key, value) {
  const s = backend();
  if (!s) { noStorage(); return false; }
  s.setItem(key, value);       // 例外は呼ぶ側で受ける（QuotaExceededError を見分けるため）
  return true;
}
function rawRemove(key) {
  const s = backend();
  if (!s) return;
  try { s.removeItem(key); } catch { /* なし */ }
}
function rawKeys() {
  const s = backend();
  const out = [];
  if (!s) return out;
  try {
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) out.push(k); }
  } catch { /* なし */ }
  return out;
}
function noStorage() {
  storageOk = false;
  if (!warnedNoStorage) { warnedNoStorage = true; emit('nostorage'); }
}
/** @param {any} e @returns {boolean} 入れ物がいっぱいか */
export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

// ---------------------------------------------------------------- 形

function nowIso() { return new Date(clock()).toISOString(); }

/** 空の記録。 @returns {object} */
export function fresh() {
  const t = nowIso();
  return {
    version: SAVE_VERSION, createdAt: t, updatedAt: t,
    last: { screen: null, levelId: null },
    levels: {},
    zukan: { seen: [], new: [] },
    errorsSeen: {}, errorsFirst: {},
    weekly: { weekStart: weekStartOf(clock()), runs: 0 },
    lastExportAt: null, lastSeenAt: null, reviewShown: null,
    storySeen: [],
    free: { saved: [] },
    settings: cloneSettings(DEFAULT_SETTINGS),
  };
}
function cloneSettings(s) { return { ...s, overlays: { ...s.overlays } }; }

/** 1 つの面の空の記録（7.9 の levels[id]）。 */
export function freshLevel() {
  return {
    unlocked: false, cleared: false, stars: [false, false, false],
    best: { gap: null, t_stop: null, lines: null },
    attempts: 0, firstClearAttempt: null,
    code: null, history: [], clearedCode: null,
    hintsOpened: 0, answerSeen: false, answerSeenClearsAfter: 0,
    attemptsSinceReset: 0,
    oneShot: null,
    prediction: null,
    lastRun: null,
  };
}

/** 月曜日を週の始まりにした日付（ローカル時刻、YYYY-MM-DD）。 @param {number} ms */
export function weekStartOf(ms) {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7;      // 月曜 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 古い版の保存を今の形に読みかえる（古い記録を消さない）。足りない項目は既定で埋める。
 * @param {object} d @returns {object}
 */
export function migrate(d) {
  const out = fresh();
  if (!d || typeof d !== 'object') return out;
  // 版 0（段 0 の案・版の書いていない記録）も版 1 と同じ形として読む。新しい版は知っている項目だけ読む。
  const src = d;
  out.createdAt = typeof src.createdAt === 'string' ? src.createdAt : out.createdAt;
  out.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : out.updatedAt;
  if (src.last && typeof src.last === 'object') {
    out.last = { screen: typeof src.last.screen === 'string' ? src.last.screen : null, levelId: LEVEL_ID.test(src.last.levelId || '') ? src.last.levelId : null };
  }
  if (src.levels && typeof src.levels === 'object') {
    for (const [id, L] of Object.entries(src.levels)) {
      if (!LEVEL_ID.test(id) || !L || typeof L !== 'object') continue;
      out.levels[id] = cleanLevel(L);
    }
  }
  if (src.zukan && typeof src.zukan === 'object') {
    out.zukan.seen = strList(src.zukan.seen, 500);
    out.zukan.new = strList(src.zukan.new, 500);
  }
  out.errorsSeen = numMap(src.errorsSeen);
  out.errorsFirst = strMap(src.errorsFirst);
  if (src.weekly && typeof src.weekly === 'object') {
    out.weekly = { weekStart: typeof src.weekly.weekStart === 'string' ? src.weekly.weekStart : out.weekly.weekStart, runs: num(src.weekly.runs, 0) };
  }
  out.lastExportAt = typeof src.lastExportAt === 'string' ? src.lastExportAt : null;
  out.lastSeenAt = typeof src.lastSeenAt === 'string' ? src.lastSeenAt : null;
  out.reviewShown = typeof src.reviewShown === 'string' ? src.reviewShown : null;
  out.storySeen = strList(src.storySeen, 40);
  if (src.free && Array.isArray(src.free.saved)) {
    out.free.saved = src.free.saved.filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.world && typeof s.world === 'object')
      .slice(0, FREE_MAX)
      .map((s) => ({ name: s.name.slice(0, 40), venue_key: typeof s.venue_key === 'string' ? s.venue_key : null, world: s.world,
        code: typeof s.code === 'string' ? s.code.slice(0, CODE_MAX) : '', strict: typeof s.strict === 'string' ? s.strict : 'real',
        seed: Number.isFinite(s.seed) ? s.seed : null, savedAt: typeof s.savedAt === 'string' ? s.savedAt : null }));
  }
  out.settings = cleanSettings(src.settings);
  out.version = SAVE_VERSION;
  return out;
}

function num(v, dflt) { return Number.isFinite(v) ? v : dflt; }
function bool(v) { return v === true; }
function str(v, max = CODE_MAX) { return typeof v === 'string' ? v.slice(0, max) : null; }
function strList(v, max) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, max) : []; }
function numMap(v) {
  const o = {};
  if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (Number.isFinite(n) && k.length < 80) o[k] = n;
  return o;
}
function strMap(v) {
  const o = {};
  if (v && typeof v === 'object') for (const [k, s] of Object.entries(v)) if (typeof s === 'string' && k.length < 80) o[k] = s.slice(0, 20);
  return o;
}
function cleanLevel(L) {
  const o = freshLevel();
  o.unlocked = bool(L.unlocked);
  o.cleared = bool(L.cleared);
  if (Array.isArray(L.stars)) o.stars = [0, 1, 2].map((i) => L.stars[i] === true);
  if (L.best && typeof L.best === 'object') {
    for (const k of ['gap', 't_stop', 'lines']) o.best[k] = Number.isFinite(L.best[k]) ? L.best[k] : null;
  }
  o.attempts = num(L.attempts, 0);
  o.firstClearAttempt = Number.isFinite(L.firstClearAttempt) ? L.firstClearAttempt : null;
  o.code = str(L.code);
  o.history = Array.isArray(L.history) ? L.history.filter((c) => typeof c === 'string').map((c) => c.slice(0, CODE_MAX)).slice(0, HISTORY_MAX) : [];
  o.clearedCode = str(L.clearedCode);
  o.hintsOpened = Math.max(0, Math.min(3, num(L.hintsOpened, 0)));
  o.answerSeen = bool(L.answerSeen);
  o.answerSeenClearsAfter = num(L.answerSeenClearsAfter, 0);
  o.attemptsSinceReset = num(L.attemptsSinceReset, 0);
  if (L.oneShot && typeof L.oneShot === 'object') {
    o.oneShot = { usedAt: Number.isFinite(L.oneShot.usedAt) ? L.oneShot.usedAt : null, retryAfterClears: num(L.oneShot.retryAfterClears, 0), retry: bool(L.oneShot.retry) };
  }
  if (L.prediction && typeof L.prediction === 'object' && Array.isArray(L.prediction.first)) {
    o.prediction = { first: L.prediction.first.filter(Number.isInteger).slice(0, 10), ok: bool(L.prediction.ok),
      order: Array.isArray(L.prediction.order) ? L.prediction.order.filter((x) => Array.isArray(x)).slice(0, 10) : null };
  }
  if (L.lastRun && typeof L.lastRun === 'object') o.lastRun = { t: typeof L.lastRun.t === 'string' ? L.lastRun.t : null, clear: bool(L.lastRun.clear) };
  return o;
}
function cleanSettings(s) {
  const o = cloneSettings(DEFAULT_SETTINGS);
  if (!s || typeof s !== 'object') return o;
  const clampN = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  o.sfx = clampN(s.sfx, 0, 100, o.sfx);
  o.ambience = clampN(s.ambience, 0, 100, o.ambience);
  o.mute = bool(s.mute);
  o.autoZenkaku = s.autoZenkaku !== false;
  o.editorFont = clampN(s.editorFont, 14, 20, o.editorFont);
  o.uiFont = clampN(s.uiFont, 14, 18, o.uiFont);
  if (['auto', 'line', '1', '2', 'result'].includes(String(s.replaySpeed))) o.replaySpeed = String(s.replaySpeed);
  if (['auto', 'light', 'normal', 'fine'].includes(s.quality)) o.quality = s.quality;
  if (['light', 'dusk', 'auto'].includes(s.theme)) o.theme = s.theme;
  if (['chapter', 'always'].includes(s.rawError)) o.rawError = s.rawError;
  o.reduceMotion = bool(s.reduceMotion);
  if (s.overlays && typeof s.overlays === 'object') for (const k of Object.keys(o.overlays)) if (typeof s.overlays[k] === 'boolean') o.overlays[k] = s.overlays[k];
  return o;
}

// ---------------------------------------------------------------- 読む

/**
 * 保存を読む（無ければ新しく作る。古い版は migrate で読みかえる）。2 回目からは読み直す。
 * @returns {object} 7.9 の JSON の形（levels[].code・history・clearedCode も入る）
 */
export function load() {
  const d = readAll();
  const first = data === null;
  data = d;
  if (first) {
    const last = Date.parse(data.lastSeenAt || '');
    sinceLastSeenMs = Number.isFinite(last) ? clock() - last : null;
    data.lastSeenAt = nowIso();
    rollWeek();
    dirty.add('meta');
    schedule();
    openChannel();
  }
  return data;
}

/** 入れ物から全部読む（meta と面ごとのコード・履歴）。 @returns {object} */
function readAll() {
  let meta = null;
  const text = rawGet(KEY_META);
  if (text) { try { meta = JSON.parse(text); } catch { meta = null; } }
  const d = meta ? migrate(meta) : fresh();
  for (const k of rawKeys()) {
    if (k.startsWith(PREFIX + 'code.')) {
      const id = k.slice((PREFIX + 'code.').length);
      if (!LEVEL_ID.test(id)) continue;
      (d.levels[id] || (d.levels[id] = freshLevel())).code = str(rawGet(k));
    } else if (k.startsWith(PREFIX + 'hist.')) {
      const id = k.slice((PREFIX + 'hist.').length);
      if (!LEVEL_ID.test(id)) continue;
      let h = null;
      try { h = JSON.parse(rawGet(k) || 'null'); } catch { h = null; }
      if (!h) continue;
      const L = d.levels[id] || (d.levels[id] = freshLevel());
      L.history = Array.isArray(h.history) ? h.history.filter((c) => typeof c === 'string').slice(0, HISTORY_MAX) : [];
      L.clearedCode = str(h.clearedCode);
    }
  }
  return d;
}

/** 今の記録（読んでいなければ読む）。 @returns {object} */
export function get() { return data || load(); }

/** 前に開いた時から何 ms たったか（初めては null）。2.3 のおさらいカードに使う。 */
export function sinceLastSeen() { get(); return sinceLastSeenMs; }

/** 1 つの面の記録（7.9 の levels[id]。無ければ作る）。 @param {string} id @returns {object} */
export function level(id) {
  const d = get();
  if (!d.levels[id]) d.levels[id] = freshLevel();
  return d.levels[id];
}

/** その面の記録があるか（作らずに見る）。 @param {string} id */
export function hasLevel(id) { return !!get().levels[id]; }

/** 設定（3.9）。 @returns {object} */
export function settings() { return get().settings; }

/** 設定を変える。 @param {object} patch */
export function setSettings(patch) {
  const d = get();
  const merged = { ...d.settings, ...patch, overlays: { ...d.settings.overlays, ...(patch.overlays || {}) } };
  d.settings = cleanSettings(merged);
  touch('meta');
  emit('change', { what: 'settings' });
}

// ---------------------------------------------------------------- 書く

function touch(key) {
  dirty.add(key);
  if (data) data.updatedAt = nowIso();
  schedule();
}
function schedule() {
  if (timer || readOnly) return;
  timer = setTimeout(() => { timer = null; flush(); }, flushMs);
}

function metaJSON() {
  const levels = {};
  for (const [id, L] of Object.entries(data.levels)) {
    const { code, history, clearedCode, ...rest } = L;
    levels[id] = rest;
  }
  return JSON.stringify({ ...data, levels });
}
function valueFor(key) {
  if (key === 'meta') return [KEY_META, metaJSON()];
  const [kind, id] = key.split(':');
  const L = data.levels[id];
  if (kind === 'code') return [keyCode(id), L && typeof L.code === 'string' ? L.code : null];
  if (kind === 'hist') return [keyHist(id), L && ((L.history && L.history.length) || L.clearedCode) ? JSON.stringify({ history: L.history || [], clearedCode: L.clearedCode || null }) : null];
  return [null, null];
}

/**
 * 変わったものを今すぐ書く（ふだんは 1 s まとめて自動で呼ぶ）。QuotaExceededError なら古い履歴から減らして書き直す。
 * @returns {boolean} 全部書けたか
 */
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!data || readOnly) return false;
  if (!backend()) { noStorage(); dirty.clear(); return false; }
  // ★とクリアの入った meta を先に書く（いっぱいでも★を守る）
  const keys = [...dirty].sort((a, b) => (a === 'meta' ? -1 : b === 'meta' ? 1 : 0));
  let ok = true;
  for (const key of keys) {
    const [k, v] = valueFor(key);
    if (!k) { dirty.delete(key); continue; }
    if (v === null) { rawRemove(k); dirty.delete(key); continue; }
    if (writeWithRetry(k, v, key)) dirty.delete(key);
    else ok = false;
  }
  return ok;
}

function writeWithRetry(k, v, key) {
  for (let tries = 0; tries < 8; tries++) {
    try {
      rawSet(k, v);
      return true;
    } catch (e) {
      if (!isQuotaError(e)) { noStorage(); return false; }
      // 古い履歴から減らす（クリアした時のコードは消さない）。減らせる物が無ければあきらめる
      const freed = trimHistories(Math.max(64 * 1024, v.length * 2));
      if (!freed) break;
      emit('trimmed', { freed });
      // 減らした面の hist をすぐ書き直して、入れ物の場所を本当に空ける（小さくなるので書ける）
      for (const id of Object.keys(data.levels)) {
        const hk = `hist:${id}`;
        if (hk === key) continue;
        const [hkk, hv] = valueFor(hk);
        try { if (hv === null) rawRemove(hkk); else rawSet(hkk, hv); dirty.delete(hk); } catch { /* 次の回で */ }
      }
      if (key.startsWith('hist:')) {
        v = valueFor(key)[1];
        if (v === null) return true;
      }
    }
  }
  emit('quota', { key: k });
  return false;
}

/**
 * 古い履歴を消して場所を空ける（一番古い＝履歴の後ろから、面をまたいで順に）。
 * @param {number} needChars 空けたい文字数の目安
 * @returns {number} 空けた文字数
 */
function trimHistories(needChars) {
  let freed = 0;
  for (let round = 0; round < HISTORY_MAX && freed < needChars; round++) {
    // 履歴の一番長い面から 1 つずつ（同じ長さなら面の順）
    const ids = Object.keys(data.levels).filter((id) => (data.levels[id].history || []).length > 0)
      .sort((a, b) => data.levels[b].history.length - data.levels[a].history.length);
    if (!ids.length) break;
    for (const id of ids) {
      const h = data.levels[id].history;
      const old = h.pop();
      freed += old ? old.length : 0;
      // 書き直しは呼んだ側（dirty に足す）
      if (freed >= needChars) break;
    }
  }
  if (freed) for (const id of Object.keys(data.levels)) dirty.add(`hist:${id}`);
  return freed;
}

/** 履歴の合計の文字数。 */
function historyChars() {
  let n = 0;
  for (const L of Object.values(data.levels)) for (const c of L.history || []) n += c.length;
  return n;
}

/** 変わったものを保存する（1 s まとめて書く）。 */
export function save() { touch('meta'); }

/**
 * 今のコードを保存する（打つたび。1 s まとめる。ここでは文字を覚えるだけなので速い）。
 * @param {string} id @param {string} code
 */
export function setCode(id, code) {
  const L = level(id);
  const c = typeof code === 'string' ? code.slice(0, CODE_MAX) : null;
  if (L.code === c) return;
  L.code = c;
  touch(`code:${id}`);
}

/** 今のコード（無ければ null）。 @param {string} id */
export function code(id) { const d = get(); return d.levels[id] && typeof d.levels[id].code === 'string' ? d.levels[id].code : null; }

/**
 * 実行したコードを履歴に足す（新しい順に 5 つ。前と同じコードは足さない。合計 2 MB を超えたら古いものから消す）。
 * @param {string} id @param {string} c
 */
export function pushHistory(id, c) {
  if (typeof c !== 'string') return;
  const L = level(id);
  const h = L.history || (L.history = []);
  const s = c.slice(0, CODE_MAX);
  const at = h.indexOf(s);
  if (at === 0) return;
  if (at > 0) h.splice(at, 1);
  h.unshift(s);
  if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
  let over = historyChars() - HISTORY_BUDGET;
  if (over > 0) trimHistories(over);
  touch(`hist:${id}`);
}

/** 〔1.1〕最後にクリアした時のコード（持ってくる・道具箱・履歴で使う）。 @param {string} id @returns {string|null} */
export function clearedCode(id) {
  const d = get();
  return d.levels[id] && typeof d.levels[id].clearedCode === 'string' ? d.levels[id].clearedCode : null;
}

/** 最後に開いていた画面と面（2.3 の続きから）。 @param {string} screen @param {string|null} levelId */
export function setLast(screen, levelId) {
  const d = get();
  if (d.last.screen === screen && d.last.levelId === (levelId ?? d.last.levelId)) return;
  d.last = { screen, levelId: levelId ?? d.last.levelId };
  touch('meta');
}

/** ★の式から「一度きりの★」（1 回目の実行・1 回目の予想）の番号（stars の添え字 1・2）を出す。 @param {object|null} def */
export function oneShotStarIndexes(def) {
  const out = [];
  (def && Array.isArray(def.stars) ? def.stars : []).forEach((s, i) => {
    if (s && typeof s.expr === 'string' && /\battempt\s*==\s*1\b|\bprediction_ok\b/.test(s.expr)) out.push(i + 1);
  });
  return out;
}

/**
 * 実行の結果を記録する（★は一度取ったら戻さない・attempts・best・履歴 5 つ・clearedCode・今週の走行・エラーずかん・取り直し）。
 * 計算まで進んだ実行だけを渡す（■ 止める・準備待ちの取り消しは渡さない。3.6 の attempt の数え方）。
 * @param {string} id
 * @param {import('../worker/engine.js').RunResult} rr
 * @param {{predictionOk?: boolean, attempt?: number, code?: string, level?: object, mode?: 'worlds'|'test', normalClear?: boolean, metrics?: object}} ui
 * @returns {{clear: boolean, firstClear: boolean, stars: boolean[], newStars: boolean[], capped: boolean, got: boolean[]}}
 *   stars は記録の★（今まで全部）、got はこの実行で取った★、newStars は初めて取った★
 */
export function recordRun(id, rr, ui = {}) {
  const d = get();
  const L = level(id);
  const def = ui.level || null;
  L.attempts += 1;
  L.attemptsSinceReset += 1;
  rollWeek();
  d.weekly.runs += 1;
  if (typeof ui.code === 'string') pushHistory(id, ui.code);
  for (const c of cardsOf(rr)) {
    if (!c || !c.id) continue;
    d.errorsSeen[c.id] = (d.errorsSeen[c.id] || 0) + 1;
    if (!d.errorsFirst[c.id]) d.errorsFirst[c.id] = id;
  }
  const j = (rr && rr.judge) || null;
  const isTest = ui.mode === 'test';
  const clear = isTest ? !!ui.normalClear : !!(j && j.clear && j.clear.ok);
  const starOk = (i) => {
    const s = j && Array.isArray(j.stars) ? j.stars[i] : null;
    if (!s || s.ok !== true) return false;
    if (!isTest && s.byTest) return false;           // 本番テストの★はふつうの実行では付けない（7.8）
    return true;
  };
  let s2 = clear && starOk(0);
  let s3 = clear && starOk(1);
  const capped = clear && L.answerSeen && L.answerSeenClearsAfter < 1;
  if (capped) s3 = false;                              // 3.6: 答えを見てからクリアした面は★2 まで
  const got = [clear, s2, s3];
  const newStars = got.map((g, i) => g && !L.stars[i]);
  L.stars = L.stars.map((s, i) => s || got[i]);
  const firstClear = clear && !L.cleared;
  if (clear) {
    L.cleared = true;
    L.unlocked = true;
    if (L.firstClearAttempt === null) L.firstClearAttempt = L.attempts;
    if (typeof ui.code === 'string') L.clearedCode = ui.code.slice(0, CODE_MAX);
    updateBest(L, rr, ui);
    // ほかの面の「取り直し」の数を進める（3.6）
    for (const [oid, O] of Object.entries(d.levels)) {
      if (oid === id) continue;
      if (O.answerSeen) O.answerSeenClearsAfter += 1;
      if (O.oneShot && O.oneShot.usedAt !== null) O.oneShot.retryAfterClears += 1;
    }
    if (L.answerSeen && L.answerSeenClearsAfter >= 1) L.answerSeen = false;
    touch(`hist:${id}`);
  }
  // 一度きりの★（3.6〔1.1〕）: 1 回目で取れなかったら「使った」と覚える。取り直しの 1 回も同じ
  const shots = oneShotStarIndexes(def);
  if (shots.length && (ui.attempt === 1 || (L.oneShot && L.oneShot.retry))) {
    const missed = shots.some((i) => !L.stars[i]);
    L.oneShot = missed ? { usedAt: L.attempts, retryAfterClears: 0, retry: false } : null;
  }
  L.lastRun = { t: nowIso(), clear };
  touch('meta');
  emit('change', { what: 'run', id });
  return { clear, firstClear, stars: L.stars.slice(), newStars, capped, got };
}

function cardsOf(rr) {
  const out = [];
  if (!rr) return out;
  if (rr.compileError) out.push(rr.compileError);
  for (const r of rr.runs || []) {
    if (r.error) out.push(r.error);
    if (r.guard) out.push(r.guard);
  }
  // 同じ ID を 1 回の実行で何度も数えない
  const seen = new Set();
  return out.filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id));
}

function updateBest(L, rr, ui) {
  const m = ui.metrics || (rr && rr.runs && rr.runs[0] && rr.runs[0].metrics) || {};
  const gap = Number.isFinite(m.gap) ? m.gap : Number.isFinite(m['gap:cone']) ? m['gap:cone'] : null;
  const tStop = Number.isFinite(m.t_stop) ? m.t_stop : null;
  const lines = Number.isFinite(ui.lines) ? ui.lines : Number.isFinite(m.lines) ? m.lines : null;
  const better = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
  L.best = { gap: better(L.best.gap, gap), t_stop: better(L.best.t_stop, tStop), lines: better(L.best.lines, lines) };
}

function rollWeek() {
  const d = data;
  const ws = weekStartOf(clock());
  if (!d.weekly || d.weekly.weekStart !== ws) d.weekly = { weekStart: ws, runs: 0 };
}

/** 今週の走行の回数（2.3）。 */
export function weeklyRuns() { get(); rollWeek(); return data.weekly.runs; }

/** ↺ 最初から（attempt を 0 から数え直す。3.6）。 @param {string} id */
export function resetAttempts(id) { const L = level(id); L.attemptsSinceReset = 0; touch('meta'); }

/**
 * 予想を保存する（選んだ時に保存。読み直しで選び直せない。2.4〔1.1〕）。すでにあれば何もしない。
 * @param {string} id @param {number[]} first 選んだ番号（元の choices の番号） @param {boolean} ok 全部当たったか
 * @returns {boolean} 保存したか
 */
export function setPrediction(id, first, ok) {
  const L = level(id);
  if (L.prediction && Array.isArray(L.prediction.first) && L.prediction.first.length) return false;
  L.prediction = { first: first.slice(), ok: !!ok, order: L.prediction && L.prediction.order ? L.prediction.order : null };
  touch('meta');
  flush();
  return true;
}

/** 予想の選択肢の並び（取り直しで入れかえた順）を覚える。 @param {string} id @param {number[][]} order */
export function setPredictionOrder(id, order) {
  const L = level(id);
  L.prediction = { ...(L.prediction || { first: [], ok: false }), order };
  touch('meta');
}

/**
 * 〔1.1〕一度きりの★の取り直しを始める（ほかの面を 1 つクリアした後。progress.canRetryOneShot で確かめてから呼ぶ）。
 * attempt を 1 から数え直し、予想を選び直せるようにする。 @param {string} id
 */
export function startOneShotRetry(id) {
  const L = level(id);
  L.attemptsSinceReset = 0;
  L.prediction = null;
  L.oneShot = { usedAt: null, retryAfterClears: 0, retry: true };
  touch('meta');
}

/** 開いたヒントの数（3.6）。 @param {string} id @param {number} n */
export function setHintsOpened(id, n) { const L = level(id); if (n > L.hintsOpened) { L.hintsOpened = Math.min(3, n); touch('meta'); } }

/** 先輩の答えを見た（3.6: ★3 はほかの面を 1 つクリアするまで取れない）。 @param {string} id */
export function markAnswerSeen(id) { const L = level(id); L.answerSeen = true; L.answerSeenClearsAfter = 0; touch('meta'); }

/** 面を開いた（解禁の印）。 @param {string} id */
export function markUnlocked(id) { const L = level(id); if (!L.unlocked) { L.unlocked = true; touch('meta'); } }

/** ずかんの項目に出会った（3.7: 習うまでは「？」、新しく開いた項目に「新」）。 @param {string[]} ids @returns {string[]} 新しく開いたもの */
export function markZukanSeen(ids) {
  const d = get();
  const added = [];
  for (const id of ids || []) {
    if (typeof id !== 'string' || d.zukan.seen.includes(id)) continue;
    d.zukan.seen.push(id);
    if (!d.zukan.new.includes(id)) d.zukan.new.push(id);
    added.push(id);
  }
  if (added.length) touch('meta');
  return added;
}
/** ずかんの項目を読んだ（「新」を消す）。 @param {string} id */
export function markZukanRead(id) {
  const d = get();
  const i = d.zukan.new.indexOf(id);
  if (i >= 0) { d.zukan.new.splice(i, 1); touch('meta'); }
}

/** おさらいカードを出した章（2.3: 1 回だけ）。 @param {string} key */
export function setReviewShown(key) { get().reviewShown = key; touch('meta'); }

/** 見た章の場面（'1'〜'10'・'C'）とエンディング（'ending'）。章の最後の面を本番テストでクリアした時も、次へで場面へ行くため（直し係 3 の 2）。 */
export function markStorySeen(key) { const d = get(); const k = String(key); if (!Array.isArray(d.storySeen)) d.storySeen = []; if (!d.storySeen.includes(k)) { d.storySeen.push(k); touch('meta'); } }
/** @param {string|number} key @returns {boolean} */
export function storySeen(key) { const d = get(); return Array.isArray(d.storySeen) && d.storySeen.includes(String(key)); }

// ---------------------------------------------------------------- 自由走行場（3.8）

/** @returns {object[]} 保存した場面 */
export function freeList() { return get().free.saved; }
/**
 * 場面を保存する（同じ名前は上書き。20 個まで）。
 * @param {{name: string, venue_key: string, world: object, code: string, strict?: string, seed?: number}} s
 * @returns {{ok: boolean, full?: boolean}}
 */
export function saveFree(s) {
  const d = get();
  const list = d.free.saved;
  const name = String(s.name || '').trim().slice(0, 40) || '名前なし';
  const entry = { name, venue_key: s.venue_key || null, world: s.world, code: String(s.code || '').slice(0, CODE_MAX), strict: s.strict || 'real', seed: Number.isFinite(s.seed) ? s.seed : null, savedAt: nowIso() };
  const at = list.findIndex((x) => x.name === name);
  if (at >= 0) list[at] = entry;
  else if (list.length >= FREE_MAX) return { ok: false, full: true };
  else list.unshift(entry);
  touch('meta');
  return { ok: true };
}
/** @param {string} name */
export function deleteFree(name) {
  const d = get();
  const i = d.free.saved.findIndex((x) => x.name === name);
  if (i >= 0) { d.free.saved.splice(i, 1); touch('meta'); }
}

// ---------------------------------------------------------------- 道具箱（3.4〔1.1〕）

/**
 * 〔1.1〕道具箱: クリアした面のコードから取り出した自分の関数（取り出しは Worker の Engine.extractDefs に頼む）。
 * 同じ名前の関数がいくつかの面にある時は、新しい面の版を先に並べる。
 * @param {{extractDefs: (code: string) => Promise<{name: string, src: string, needs: string[], lines: number}[]>, order?: string[]}} [deps]
 *   order は面の順（progress の順）。無ければ保存の順
 * @returns {Promise<{name: string, levelId: string, code: string, needs: string[], lines: number}[]>}
 */
export async function toolbox(deps = {}) {
  const d = get();
  const extract = deps.extractDefs;
  if (typeof extract !== 'function') return [];
  const order = deps.order || Object.keys(d.levels);
  const rank = new Map(order.map((id, i) => [id, i]));
  const out = [];
  for (const id of order) {
    const c = d.levels[id] && d.levels[id].clearedCode;
    if (!c || !/\bdef\s/.test(c)) continue;
    let defs = [];
    try { defs = await extract(c); } catch { defs = []; }
    for (const f of defs || []) out.push({ name: f.name, levelId: id, code: f.src, needs: f.needs || [], lines: f.lines || String(f.src || '').split('\n').length });
  }
  out.sort((a, b) => (a.name === b.name ? (rank.get(b.levelId) ?? 0) - (rank.get(a.levelId) ?? 0) : a.name.localeCompare(b.name)));
  return out;
}

// ---------------------------------------------------------------- 書き出し・読み込み

/** 記録を JSON の文字に（設定の「書き出し」）。書き出した日を覚える。 @returns {string} */
export function exportJSON() {
  const d = get();
  d.lastExportAt = nowIso();
  touch('meta');
  return JSON.stringify({ app: 'ROVER CODE', ...d }, null, 1);
}

/** 書き出しの声かけ（7.9: 前の書き出しから 7 日以上たっている時だけ）を出すか。 */
export function exportNudgeDue() {
  const d = get();
  const t = Date.parse(d.lastExportAt || '');
  return !Number.isFinite(t) || clock() - t >= EXPORT_NUDGE_DAYS * 86400000;
}

/** ★とクリアの数（今の記録か、渡した記録）。 @param {object} [d] */
export function countOf(d) {
  const src = d || get();
  let stars = 0;
  let clears = 0;
  for (const L of Object.values(src.levels || {})) {
    if (L.cleared) clears++;
    for (const s of L.stars || []) if (s) stars++;
  }
  return { stars, clears };
}

/**
 * 記録を読み込む（version と形を確かめ、知らない項目は捨て、文字の長さを切る）。置きかえは commit() を呼んだ時。
 * 置きかえる前の記録は 1 つ前として残し、undoImport() で 1 回だけ戻せる。
 * @param {string} text
 * @returns {{ok: boolean, diff?: {starsNow: number, starsFile: number, clearsNow: number, clearsFile: number}, error?: string, commit?: () => void}}
 */
export function importJSON(text) {
  if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) return { ok: false, error: 'ファイルが大きすぎる' };
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'JSON として読めない' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '記録の形ではない' };
  if (!Number.isInteger(raw.version)) return { ok: false, error: 'version が無い' };
  if (raw.version > SAVE_VERSION) return { ok: false, error: 'このゲームより新しい版の記録' };
  if (!raw.levels || typeof raw.levels !== 'object') return { ok: false, error: 'levels が無い' };
  const clean = migrate(raw);
  const now = countOf(get());
  const file = countOf(clean);
  return {
    ok: true,
    diff: { starsNow: now.stars, starsFile: file.stars, clearsNow: now.clears, clearsFile: file.clears },
    commit() { replaceAll(clean, true); },
  };
}

function replaceAll(next, keepUndo) {
  const prev = data;
  if (keepUndo) undoSnapshot = JSON.parse(JSON.stringify(prev));
  const prevIds = new Set(Object.keys(prev ? prev.levels : {}));
  data = next;
  data.updatedAt = nowIso();
  dirty.add('meta');
  for (const id of new Set([...prevIds, ...Object.keys(data.levels)])) { dirty.add(`code:${id}`); dirty.add(`hist:${id}`); }
  // 消えた面のキーを消す
  for (const id of prevIds) if (!data.levels[id]) { rawRemove(keyCode(id)); rawRemove(keyHist(id)); }
  flush();
  emit('change', { what: 'import' });
}

/** 読み込む前の記録に戻す（1 回だけ）。 @returns {boolean} */
export function undoImport() {
  if (!undoSnapshot) return false;
  const snap = migrate(undoSnapshot);
  // migrate は code・history を落とさない（cleanLevel が持つ）
  undoSnapshot = null;
  replaceAll(snap, false);
  return true;
}
/** 元に戻せるか。 */
export function canUndoImport() { return !!undoSnapshot; }

/** 全部消す（設定で 2 回確認した後）。 */
export function resetAll() {
  for (const k of rawKeys()) rawRemove(k);
  data = fresh();
  dirty = new Set(['meta']);
  undoSnapshot = null;
  flush();
  emit('change', { what: 'reset' });
}

// ---------------------------------------------------------------- 量

/** 〔1.1〕使っている量（設定に出す）。文字数 × 2 バイトで数える。 @returns {{bytes: number, quota: number}} */
export function usage() {
  let bytes = 0;
  for (const k of rawKeys()) { const v = rawGet(k) || ''; bytes += (k.length + v.length) * 2; }
  return { bytes, quota: QUOTA_GUESS };
}

/** 起動の時に消えにくくしてもらう（7.9〔1.1〕。断られても遊べる）。 @returns {Promise<boolean>} */
export async function requestPersist() {
  try {
    const s = globalThis.navigator && globalThis.navigator.storage;
    if (s && typeof s.persist === 'function') return !!(await s.persist());
  } catch { /* なし */ }
  return false;
}

/** 保存ができる状態か（localStorage が使えるか）。 */
export function canStore() { if (!backend()) return false; try { backend().getItem(KEY_META); return storageOk; } catch { return false; } }

// ---------------------------------------------------------------- 別のタブ（7.9〔1.1〕）

/** 〔1.1〕別のタブがすでに開いていて、こちらは見るだけか（BroadcastChannel("rovercode")）。 @returns {boolean} */
export function isReadOnly() { return readOnly; }

function post(msg) { try { channel && channel.postMessage({ ...msg, from: tabId }); } catch { /* なし */ } }

function openChannel() {
  if (channel) return;
  try { channel = channelFactory('rovercode'); } catch { channel = null; }
  if (channel) {
    const onMsg = (ev) => {
      const m = ev && ev.data;
      if (!m || m.from === tabId) return;
      if (m.type === 'beat') {
        lastBeat = clock();
      } else if (m.type === 'hello') {
        if (!readOnly) post({ type: 'owner' });
      } else if (m.type === 'owner') {
        ownerSeen = true;
        lastBeat = clock();
        if (!readOnly) becomeReadOnly();
      } else if (m.type === 'bye') {
        if (readOnly) {
          // 先のタブが閉じた: 少し待って、ほかに引きつぐタブが無ければ引きつぐ（番号の小さいタブが先）
          const wait = 30 + (parseInt(tabId.slice(0, 4), 36) % 120);
          if (claimTimer) clearTimeout(claimTimer);
          claimTimer = setTimeout(() => { claimTimer = null; becomeOwner(); }, wait);
        }
      } else if (m.type === 'claim') {
        if (claimTimer) { clearTimeout(claimTimer); claimTimer = null; }
        if (!readOnly && m.from !== tabId) becomeReadOnly();
      }
    };
    if (typeof channel.addEventListener === 'function') channel.addEventListener('message', onMsg);
    else channel.onmessage = onMsg;
    post({ type: 'hello' });
    startBeat();
  }
  const win = globalThis.window;
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('storage', onStorage);
    win.addEventListener('pagehide', () => release());
  }
}

/**
 * 合図: 保存するタブは 2 s ごとに beat を出す。見るだけのタブは、6.5 s 合図が来なければ（先のタブが落ちた・
 * pagehide が来ずに閉じた）引きつぐ。ブラウザの中だけで動かす（Node のテストを止めないため）。
 */
function startBeat() {
  if (beatTimer || !globalThis.window || typeof setInterval !== 'function') return;
  lastBeat = clock();
  beatTimer = setInterval(() => {
    if (!channel) return;
    if (!readOnly) { post({ type: 'beat' }); return; }
    if (clock() - lastBeat > BEAT_LOST_MS && !claimTimer) {
      const wait = 30 + (parseInt(tabId.slice(0, 4), 36) % 120);
      claimTimer = setTimeout(() => { claimTimer = null; if (readOnly && clock() - lastBeat > BEAT_LOST_MS) becomeOwner(); }, wait);
    }
  }, BEAT_MS);
}

/** このタブを閉じる時（pagehide）: 書き残してから、ほかのタブに保存を引きつぐ。 */
export function release() {
  if (!readOnly && data) { flush(); post({ type: 'bye' }); }
}

function becomeReadOnly() {
  // 書く前に残りを書き出す必要は無い（先のタブが正）。読み直して見るだけにする
  if (timer) { clearTimeout(timer); timer = null; }
  dirty.clear();
  readOnly = true;
  reloadFromStorage();
  emit('readonly');
}
function becomeOwner() {
  readOnly = false;
  reloadFromStorage();
  post({ type: 'claim' });
  emit('owner');
}

function reloadFromStorage() {
  const keep = sinceLastSeenMs;
  data = readAll();
  sinceLastSeenMs = keep;
}

/** ほかのタブが書いた時（storage イベント）: 読み直して、★とクリアは合わせる（OR）。 */
function onStorage(ev) {
  if (!ev || (ev.key && !ev.key.startsWith(PREFIX)) || !data) return;
  const mine = data;
  const theirs = readAll();
  if (!theirs) return;
  if (readOnly) {
    data = theirs;
  } else {
    // 自分が持ち主なのに書かれた（古いブラウザなど）: 合わせてから書き直す
    for (const [id, T] of Object.entries(theirs.levels)) {
      const M = mine.levels[id];
      if (!M) { mine.levels[id] = T; continue; }
      M.stars = M.stars.map((s, i) => s || !!T.stars[i]);
      M.cleared = M.cleared || T.cleared;
      M.unlocked = M.unlocked || T.unlocked;
      M.attempts = Math.max(M.attempts, T.attempts);
      if (!M.clearedCode && T.clearedCode) M.clearedCode = T.clearedCode;
    }
    for (const s of theirs.zukan.seen) if (!mine.zukan.seen.includes(s)) mine.zukan.seen.push(s);
    for (const [k, n] of Object.entries(theirs.errorsSeen)) mine.errorsSeen[k] = Math.max(mine.errorsSeen[k] || 0, n);
    touch('meta');
  }
  emit('external');
  emit('change', { what: 'external' });
}

/** テスト用: storage イベントを起こしたことにする。 */
export function _onStorage(ev) { onStorage(ev); }
/** テスト用: 今の持ち主の状態。 */
export function _state() { return { readOnly, ownerSeen, dirty: [...dirty], tabId }; }
