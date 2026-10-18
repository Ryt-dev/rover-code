/**
 * @file app/js/editor/zenkaku.js
 * 持ち主: W6（エディタ）
 * 役割: 全角文字の見える化と自動直し（打っている間は波線・全角スペースは「□」・自動で半角に。日本語入力の変換中はさわらない）。
 * SPEC: 9.1 の ①・3.4（全角の見える化）・4 章の 4・12 章（本物の IME）・tech_spike 4 章
 * 元にしたもの: spike/zenkaku.js（IME の試験を通った作り）
 *
 * 方針（spike から引きついだもの）
 *  - 文字列（"..."）とコメント（# ...）の中の全角は正しいので、そのまま。字句の種類は CodeMirror のモードで見る
 *    （オーバーレイは状態を持てず三重クォートを追えないので markText にする）。
 *  - 日本語入力の変換中（compositionstart〜compositionend）は何もしない。確定した次の番で、今さわった行だけ直す。
 *  - 貼り付けた（paste・drop）コードは勝手に変えない（印だけ付ける。［半角に直す］は W3 のカード）。
 * 本番で足したもの
 *  - 直す表は error_rules.json の precheck（FW_*）の char_map と同じにした（［半角に直す］と同じ結果になるように）。
 *    行の頭の全角スペースは半角 2 つ（error_rules の leading と同じ）。
 *  - 長音「ー」や「－ − ‐ – —」などの横線は、場面で意味が違うので自動では直さない（印は付ける。fixAll では直す）。
 *    長音「ー」は、カタカナの続き（モーター）では印も付けない。
 *
 * この形は Node でも import できる（DOM にさわるのは attachZenkaku の中だけ）。
 */

/** 全角の英数字・記号・全角スペース・句読点・引用符（spike の正規表現。印を付ける字の主な範囲）。 */
export const ZEN_RE = /[　！-～、。“”‘’]/;

/** NFKC で直らない字・NFKC と違う字の直し方（error_rules.json の FW_QUOTE・FW_PAREN・FW_COMMA・FW_OPERATOR など）。 */
const EXTRA_MAP = {
  '　': ' ',                                    // 全角スペース
  '、': ',', '。': '.',                     // 、。
  '“': '"', '”': '"', '‘': "'", '’': "'",   // “ ” ‘ ’
  '「': '"', '」': '"', '『': '"', '』': '"',   // 「 」 『 』
  '〝': '"', '〟': '"',                     // 〝 〟
  '【': '[', '】': ']', '〔': '(', '〕': ')',   // 【 】 〔 〕
  '×': '*', '÷': '/',                     // × ÷
  '−': '-', '‐': '-', '–': '-', '—': '-',   // − ‐ – —
  'ー': '-', 'ｰ': '-',                     // ー ｰ（長音。マイナスのつもりの時だけ印を付ける）
};

/** 行の頭（字下げ）にある時だけの直し方（error_rules の FW_SPACE の leading）。 */
const LEADING_MAP = { '　': '  ' };

/** 自動では直さない字（印は付ける。fixAll とカードの［半角に直す］では直す）。 */
const NO_AUTO = new Set(['ー', 'ｰ', '－', '−', '‐', '–', '—']);

const ZEN_RE_G = /[　！-～、。“”‘’「-』〝〟【】〔〕×÷−‐–—ーｰ]/g;
const KANA_KANJI = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;
const CHOON = new Set(['ー', 'ｰ']);

/**
 * 1 文字を半角に。直せない字は null。
 * @param {string} ch @param {{leading?: boolean}} [opt] leading は行の頭の字下げの中かどうか
 * @returns {string|null}
 */
export function toHankaku(ch, opt = {}) {
  if (opt.leading && LEADING_MAP[ch] !== undefined) return LEADING_MAP[ch];
  if (EXTRA_MAP[ch] !== undefined) return EXTRA_MAP[ch];
  const n = ch.normalize('NFKC');
  return n.length === 1 && n.charCodeAt(0) < 128 ? n : null;
}

/** この字を、打っている間に自動で直してよいか。 @param {string} ch */
export function isAutoFixable(ch) { return !NO_AUTO.has(ch); }

/**
 * 1 行の中の全角を探す（字句の種類はかかわらない。テストと Node 用）。
 * @param {string} text @returns {{ch: number, char: string}[]}
 */
export function scanLine(text) {
  const out = [];
  if (!text) return out;
  ZEN_RE_G.lastIndex = 0;
  let m;
  while ((m = ZEN_RE_G.exec(text))) {
    const c = m[0];
    if (CHOON.has(c)) {
      // 長音はカタカナ・漢字の続き（モーター・データー）なら正しい字。マイナスのつもり（(ー0.25 や = ー1）だけ印
      const prev = text[m.index - 1] || '';
      const next = text[m.index + 1] || '';
      if (KANA_KANJI.test(prev) || !/[0-9０-９.．(（A-Za-z_]/.test(next)) continue;
    }
    out.push({ ch: m.index, char: c });
  }
  return out;
}

/**
 * 全角の場所を探す（文字列とコメントの中は除く）。
 * @param {object} cm CodeMirror @param {number} [fromLine] @param {number} [toLine]（どちらも 0 から）
 * @returns {{line: number, ch: number, char: string, fix: string|null, to: string|null, auto: boolean}[]}
 */
export function findZenkaku(cm, fromLine = cm.firstLine(), toLine = cm.lastLine()) {
  const out = [];
  for (let l = fromLine; l <= toLine; l++) {
    const text = cm.getLine(l);
    if (!text) continue;
    const hits = scanLine(text);
    if (!hits.length) continue;
    const lead = text.length - text.replace(/^[ \t　]+/, '').length;
    for (const h of hits) {
      const type = cm.getTokenTypeAt({ line: l, ch: h.ch + 1 }) || '';
      if (/string|comment/.test(type)) continue;
      const fix = toHankaku(h.char, { leading: h.ch < lead });
      out.push({ line: l, ch: h.ch, char: h.char, fix, to: fix, auto: isAutoFixable(h.char) });
    }
  }
  return out;
}

/**
 * 見つけた全角を半角に直す（1 回の undo で戻せる）。
 * @param {object} cm @param {object[]} [list] findZenkaku の結果 @returns {number} 直した数
 */
export function fixZenkaku(cm, list = findZenkaku(cm)) {
  const todo = list.filter((z) => z.fix != null);
  if (!todo.length) return 0;
  cm.operation(() => {
    // 後ろから直すと位置がずれない（行の頭の全角スペースは 2 文字になる）
    const sorted = [...todo].sort((a, b) => (b.line - a.line) || (b.ch - a.ch));
    for (const z of sorted) cm.replaceRange(z.fix, { line: z.line, ch: z.ch }, { line: z.line, ch: z.ch + 1 }, '+zenkaku');
  });
  return todo.length;
}

/** 直した字の知らせの文（SPEC 3.1 のトースト「全角の（ を半角の ( に直したよ」）。 @param {object[]} list */
export function fixMessage(list) {
  const show = (c) => (c === '　' ? '全角スペース' : c);
  const uniq = [];
  for (const z of list) if (!uniq.some((u) => u.char === z.char)) uniq.push(z);
  if (uniq.length === 1) {
    const z = uniq[0];
    if (z.char === '　') return '全角スペースを半角に直したよ';
    return `全角の${show(z.char)} を半角の ${z.fix.trim() || z.fix} に直したよ`;
  }
  if (uniq.length <= 3) return `全角の ${uniq.map((z) => show(z.char)).join(' ')} を半角に直したよ`;
  return `全角の文字を ${list.length} 個、半角に直したよ`;
}

/**
 * エディタにつなぐ。戻り値は「外す関数」で、check・fixAll・setAutoFix・state も持つ（spike と同じ使い方ができる）。
 * @param {object} cm
 * @param {{autoFix?: boolean, onFix?: (list: object[], afterComposition: boolean) => void, onFound?: (list: object[]) => void, markSpace?: boolean}} [opts]
 * @returns {(() => void) & {state: object, check: () => void, fixAll: () => number, setAutoFix: (v: boolean) => void}}
 */
export function attachZenkaku(cm, opts = {}) {
  const { autoFix = false, onFix = null, onFound = null, markSpace = true } = opts;
  const restoreSpace = markSpace ? setupSpaceMark(cm) : null;
  const state = { composing: false, autoFix, lastFound: [], marks: [], detached: false };
  const field = cm.getInputField();
  const onStart = () => { state.composing = true; };
  const onEnd = () => {
    state.composing = false;
    // 確定した直後は IME がまだ後始末をしているので、次の番で直す
    setTimeout(() => check(true), 0);
  };
  field.addEventListener('compositionstart', onStart);
  field.addEventListener('compositionend', onEnd);

  let pendingLines = null;
  let timer = null;
  const onChanges = (_cm, changes) => {
    for (const c of changes) {
      if (c.origin === '+zenkaku' || c.origin === 'setValue') continue;
      if (c.origin === 'paste' || c.origin === 'drop' || c.origin === 'undo' || c.origin === 'redo') continue;   // 貼り付け・戻すは勝手に変えない
      const a = c.from.line;
      const b = c.from.line + c.text.length - 1;
      pendingLines = pendingLines ? [Math.min(pendingLines[0], a), Math.max(pendingLines[1], b)] : [a, b];
    }
    if (!state.composing) schedule();
  };
  cm.on('changes', onChanges);

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(false); }, 0);
  }

  function check(afterComposition) {
    if (state.detached || state.composing) return;
    const found = findZenkaku(cm);
    state.lastFound = found;
    cm.operation(() => {
      for (const m of state.marks) m.clear();
      state.marks = found.map((z) => cm.markText({ line: z.line, ch: z.ch }, { line: z.line, ch: z.ch + 1 }, {
        className: z.char === '　' ? 'cm-zenkaku-space' : 'cm-zenkaku',
        attributes: { title: z.char === '　' ? '全角スペース → 半角に' : `全角の「${z.char}」→ 半角の「${z.fix ?? '?'}」` },
      }));
    });
    if (onFound) onFound(found);
    if (!state.autoFix || !pendingLines) { pendingLines = null; return 0; }
    // 自動で直すのは「今さわった行」だけ（貼り付けた大量のコードを勝手に変えない）
    const [a, b] = pendingLines;
    pendingLines = null;
    const mine = found.filter((z) => z.line >= a && z.line <= b && z.fix != null && z.auto);
    if (!mine.length) return 0;
    const n = fixZenkaku(cm, mine);
    if (onFix) onFix(mine, afterComposition);
    // 直したあとの印を付け直す
    const again = findZenkaku(cm);
    state.lastFound = again;
    cm.operation(() => {
      for (const m of state.marks) m.clear();
      state.marks = again.map((z) => cm.markText({ line: z.line, ch: z.ch }, { line: z.line, ch: z.ch + 1 },
        { className: z.char === '　' ? 'cm-zenkaku-space' : 'cm-zenkaku' }));
    });
    if (onFound) onFound(again);
    return n;
  }

  const detach = () => {
    state.detached = true;
    field.removeEventListener('compositionstart', onStart);
    field.removeEventListener('compositionend', onEnd);
    cm.off('changes', onChanges);
    for (const m of state.marks) m.clear();
    state.marks = [];
    if (restoreSpace) restoreSpace();
  };
  detach.state = state;
  detach.check = () => check(false);
  detach.setAutoFix = (v) => { state.autoFix = !!v; };
  detach.fixAll = () => {
    const n = fixZenkaku(cm);
    check(false);
    return n;
  };
  // 最初の印
  setTimeout(() => check(false), 0);
  return detach;
}

/**
 * 全角スペースを目に見える印（□）にする（specialChars に足す）。
 * spike の注意: contenteditable 方式では、この印のすぐ後ろに打った文字が消えることがあった。textarea 方式では問題なし。
 * @returns {() => void} 元に戻す関数
 */
function setupSpaceMark(cm) {
  const sc = cm.getOption('specialChars');
  const placeholder = cm.getOption('specialCharPlaceholder');
  if (!/\\u3000/.test(sc.source)) cm.setOption('specialChars', new RegExp(sc.source.replace(/\]$/, '\\u3000]'), sc.flags));
  cm.setOption('specialCharPlaceholder', (ch) => {
    const el = document.createElement('span');
    if (ch === '　') { el.className = 'cm-zen-space-mark'; el.textContent = '□'; el.title = '全角スペース'; }
    else { el.className = 'cm-invalidchar'; el.textContent = '•'; el.title = '\\u' + ch.charCodeAt(0).toString(16); }
    return el;
  });
  return () => { cm.setOption('specialChars', sc); cm.setOption('specialCharPlaceholder', placeholder); };
}
