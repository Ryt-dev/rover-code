/**
 * @file app/js/editor/editor.js
 * 持ち主: W6（エディタ）
 * 役割: コードのエディタ（CodeMirror 5.65.18、暗い地）。自由に書く・穴埋め・並べるの 3 つの形を同じ窓口で出す。
 * SPEC: 7.3「W6 js/editor/*」・3.4「右下左: エディタ」・3.1（キー操作・Esc の順番）・3.11（小さい画面）・10.2（エディタの色）・10.3（BIZ UDGothic）
 *
 * 使い方（W7）:
 *   import { loadCodeMirror, createEditor } from './editor/editor.js';
 *   await loadCodeMirror();                       // CDN（売る版は vendor/）から CodeMirror を読む。読み済みなら何もしない
 *   const ed = createEditor(el, { lang, value, mode, locked, blanks, parsons, palette, fontSize, starter });
 *   ed.on('run', run); ed.on('change', (code) => store.setCode(id, code));
 *   ed.on('zenkaku', ({ message }) => toast(message)); ed.on('marksCleared', ({ message }) => out(message));
 *
 * 決めた形（W6。7.3 の 9 つの関数に足したもの）
 *  - CodeMirror は必ず inputStyle: "textarea"（スマホ・タブレットでも明示。tech_spike 4 章）。Tab は空白（4 文字の位置まで）、
 *    Shift+Tab は字下げを減らす、行の頭の空白の中の Backspace は 1 段（4 つ）ずつ消す。
 *  - 実行キー: Ctrl / ⌘ + Enter で 'run'。日本語入力の変換中（isComposing か keyCode 229）は何もしない。
 *  - 〔1.1〕Esc: まず 'escape' を出し、受け取った側が true を返したら（ダイアログを閉じた・計算や再生を止めた）それで終わり。
 *    だれも受け取らなければ「次の Tab でエディタの外へ」の状態にして「Tab でエディタの外へ」を出す。ほかのキーで取り消し。
 *  - 〔1.1〕再生の印（今の行・回数・変数の値）を出している間にコードを変えたら、印を消して 'marksCleared' を出す
 *    （message は「コードが変わったので、行の印を消したよ」。W7 が出力の欄に 1 行出す）。
 *  - showCard(card) はカードの行と文字に下線を引き、{ line, locked, note } を返す。鍵の行なら空欄の箱を目立たせ、
 *    note に「（鍵の行。原因は空欄に入れた値かもしれないよ）」を入れる（W3 のカードの where に足す）。
 *  - 足した関数: insertSnippet（パレット）・insertText（記号バー）・setReadOnly（予想の前）・setFontSize（14〜20 px）・
 *    setAutoZenkaku・fixZenkaku・unlockAll・setUnlockable・shuffleCards・setMode・restoreCode（履歴）・insertToolbox（道具箱）・
 *    isLockedLine・getCM・destroy。
 */

import { attachZenkaku, fixMessage } from './zenkaku.js';
import { applyLocked } from './locked.js';
import { createPalette, paletteItems, CARET } from './palette.js';
import { createSymbolBar, isTouchDevice } from './symbolbar.js';
import { createParsons, splitParsons } from './parsons.js';
import { attachVarHover } from './varhover.js';
import { insertToolbox as planToolbox } from './toolbox.js';

export const CM_VERSION = '5.65.18';
export const CM_CDN = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/${CM_VERSION}/`;

/** 画面に出す文（11 章のきまり）。W7 がトースト・出力の欄に出す。 */
export const MESSAGES = Object.freeze({
  marksCleared: 'コードが変わったので、行の印を消したよ',
  lockedNote: '（鍵の行。原因は空欄に入れた値かもしれないよ）',
  exitHint: 'Tab でエディタの外へ（ほかのキーで取り消し）',
  blocked: '鍵つきの行は書きかえられないよ。黄色の空欄に書いてね',
  blockedNoBlank: '鍵つきの行は書きかえられないよ。鍵の無い行（↓ ここから書く の下）に書いてね',
  unlockBar: 'クリアしたので、鍵を外して全部書きかえてもいいよ',
  unlockButton: '鍵を外す',
  readOnly: '予想を選ぶまで、コードは読むだけだよ',
});

/** 命令の名前（Python のモードで関数の色にする。5.1 の表）。 */
export const API_NAMES = ['motor', 'stop', 'wait', 'distance_to_cone', 'now', 'lidar', 'heading', 'odometer', 'encoder', 'gnss',
  'camera', 'phase', 'altitude', 'accel', 'nichrome', 'marker'];

const FILES = {
  cdnjs: { css: 'codemirror.min.css', js: 'codemirror.min.js',
    more: ['mode/python/python.min.js', 'mode/clike/clike.min.js', 'addon/edit/matchbrackets.min.js', 'addon/selection/active-line.min.js'] },
  npm: { css: 'lib/codemirror.css', js: 'lib/codemirror.js',
    more: ['mode/python/python.js', 'mode/clike/clike.js', 'addon/edit/matchbrackets.js', 'addon/selection/active-line.js'] },
};

let cmPromise = null;

function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`読み込めなかった: ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * CodeMirror（本体・python と clike のモード・かっこの対応・今の行）を読む。読み済みならすぐ返す。
 * @param {{base?: string, layout?: 'cdnjs'|'npm'}} [opts] base は置き場所（既定は cdnjs。売る版は 'vendor/codemirror/'）。
 *   layout は置き方（cdnjs の .min.js か、npm の lib/ と .js）。globalThis.ROVERCODE_CM_BASE でも base を変えられる
 * @returns {Promise<object>} CodeMirror
 */
export function loadCodeMirror(opts = {}) {
  const g = globalThis;
  const ready = () => g.CodeMirror && g.CodeMirror.modes && g.CodeMirror.modes.python && g.CodeMirror.modes.clike;
  if (ready()) return Promise.resolve(g.CodeMirror);
  if (cmPromise) return cmPromise;
  const base = String(opts.base || g.ROVERCODE_CM_BASE || CM_CDN).replace(/\/?$/, '/');
  const layout = FILES[opts.layout || (/node_modules/.test(base) ? 'npm' : 'cdnjs')];
  cmPromise = (async () => {
    if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /codemirror(\.min)?\.css/.test(l.href))) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = base + layout.css;
      document.head.appendChild(link);
    }
    if (!g.CodeMirror) await addScript(base + layout.js);
    await Promise.all(layout.more.map((f) => addScript(base + f)));
    if (!ready()) throw new Error('CodeMirror のモードが読めなかった');
    return g.CodeMirror;
  })();
  cmPromise.catch(() => { cmPromise = null; });
  return cmPromise;
}

/**
 * @typedef {object} Editor
 * @property {() => string} getCode
 * @property {(code: string, opts?: {clearHistory?: boolean}) => void} setCode
 * @property {(n: number|null) => void} setActiveLine 再生に合わせた今の行（null で消す）
 * @property {(hits: number[]|null) => void} setHits 行ごとの実行回数（行番号の右に「×10」。添え字＝行番号）
 * @property {(card: import('../../worker/engine.js').Card) => {line: number|null, locked: boolean, note: string|null}} showCard カードの行と文字に下線
 * @property {() => void} clearMarks 下線・今の行・回数・変数の値を消す（〔1.1〕再生の後にコードを変えた時は自動で消える）
 * @property {(name: 'change'|'run'|'escape'|'zenkaku'|'blocked'|'marksCleared'|'mode'|'unlock', fn: Function) => () => void} on
 *   'change'(code) は打つたび、'run' は Ctrl/⌘+Enter（変換中は無視）、'escape' は Esc（true を返すと「外へ」の状態にしない）、
 *   'zenkaku'({list, message, afterComposition}) は全角を自動で直した時（トースト用）、'blocked'({message}) は鍵の行を書こうとした時、
 *   'marksCleared'({message}) は再生の印を消した時、'mode'(mode) は並べる→ふつうに書く、'unlock'() は鍵を外した時
 * @property {(fn: ((name: string) => string|null)|null) => void} setVarSource 変数にマウスを乗せた時の値（「d = 1.84（3.2 s）」）
 * @property {() => void} focus
 */

/**
 * エディタを作る（先に loadCodeMirror() を済ませておく）。el の中の後ろに足す。
 * @param {HTMLElement} el
 * @param {object} opts
 * @param {'python'|'c'} [opts.lang='python']
 * @param {string} opts.value 最初のコード（保存したコードか、スターター）
 * @param {'free'|'blanks'|'parsons'} [opts.mode='free'] 自由に書く・穴埋め・並べる
 * @param {string} [opts.starter] 面のスターター（鍵と空欄の場所を決める。value と違う時に、保存したコードへ写すのに使う）
 * @param {number[][]} [opts.locked] 鍵つきの行の範囲 [[1, 4], [7, 7]]（starter の行、7.7）。穴埋めで空なら全部の行に鍵
 * @param {({line: number, label: string}|string)[]} [opts.blanks] 空欄 ___ の場所と説明
 * @param {{fixed_lines: number, answer?: string, distractors?: string[]}|null} [opts.parsons]
 * @param {{label: string, insert: string, summary: string, kind?: string}[]|{level: object, api: object, learnedNew: string[]}} [opts.palette]
 *   パレットのチップ（paletteItems で作ったもの）か、それを作る材料
 * @param {number} [opts.fontSize=15] 14〜20 px（3.9）
 * @param {boolean} [opts.autoZenkaku=true] 設定「全角の自動直し」（しなくても波線は出す）
 * @param {boolean|'auto'} [opts.symbolBar='auto'] 記号バー（auto はタッチ端末だけ）
 * @param {boolean} [opts.unlockable=false] クリア後の「鍵を外す」を出すか（setUnlockable でも変えられる）
 * @param {string} [opts.label='コード（main.py）'] 読み上げの名前
 * @param {object} [opts.CodeMirror] CodeMirror（無ければ globalThis.CodeMirror）
 * @returns {Editor & object}
 */
export function createEditor(el, opts = {}) {
  const CM = opts.CodeMirror || globalThis.CodeMirror;
  if (!CM) throw new Error('CodeMirror がまだ読み込まれていない（先に await loadCodeMirror() を呼ぶ）');
  const lang = opts.lang === 'c' ? 'c' : 'python';
  let mode = opts.mode === 'parsons' || opts.mode === 'blanks' ? opts.mode : 'free';
  const starter = typeof opts.starter === 'string' ? opts.starter : null;
  const initial = String(opts.value ?? starter ?? '');
  const listeners = new Map();
  /** 並べる面のカード（createParsons） */
  let parsons = null;

  // ---- 組み立て
  const root = document.createElement('div');
  root.className = 'rc-editor';
  root.dataset.mode = mode;
  root.innerHTML = `
    <div class="rc-palette-host"></div>
    <div class="rc-strip rc-readonly-strip" hidden></div>
    <div class="rc-strip rc-unlock-strip" hidden><span>${MESSAGES.unlockBar}</span><button type="button" class="rc-btn rc-unlock-btn">${MESSAGES.unlockButton}</button></div>
    <div class="rc-cm-host"></div>
    <div class="rc-parsons-host" hidden></div>
    <div class="rc-exit-hint" role="status" aria-live="polite" hidden></div>`;
  el.appendChild(root);
  const paletteHost = root.querySelector('.rc-palette-host');
  const cmHost = root.querySelector('.rc-cm-host');
  const parsonsHost = root.querySelector('.rc-parsons-host');
  const exitHint = root.querySelector('.rc-exit-hint');
  const readOnlyStrip = root.querySelector('.rc-readonly-strip');
  const unlockStrip = root.querySelector('.rc-unlock-strip');

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  }
  function emit(name, ...args) {
    let handled = false;
    for (const fn of [...(listeners.get(name) || [])]) {
      try { if (fn(...args) === true) handled = true; } catch (e) { console.error(`エディタの ${name} の受け手でエラー`, e); }
    }
    return handled;
  }

  // ---- CodeMirror
  let escArmed = false;
  let readOnly = false;
  const cm = CM(cmHost, {
    value: mode === 'parsons' ? '' : initial,
    mode: lang === 'c' ? 'text/x-csrc' : { name: 'python', version: 3, singleLineStringErrors: false, extra_builtins: API_NAMES },
    theme: 'rc',
    inputStyle: 'textarea',                 // IME 対策（7.10）。スマホ・タブレットでも明示する
    lineNumbers: true,
    gutters: ['CodeMirror-linenumbers', 'rc-gutter-hits', 'rc-gutter-lock'],
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    smartIndent: true,
    electricChars: true,
    lineWrapping: false,                    // 〔1.1〕長い行はエディタの中だけ横にスクロール
    matchBrackets: true,
    styleActiveLine: true,
    viewportMargin: 30,
    spellcheck: false,
    autocorrect: false,
    autocapitalize: false,
    screenReaderLabel: opts.label || (lang === 'c' ? 'コード（main.c）' : 'コード（main.py）'),
    extraKeys: {
      Tab: (c) => {
        if (locked && locked.active() && locked.nextBlank(1)) return;
        if (c.somethingSelected() && c.getSelection().includes('\n')) c.execCommand('indentMore');
        else c.execCommand('insertSoftTab');
      },
      'Shift-Tab': (c) => {
        if (locked && locked.active() && locked.nextBlank(-1)) return;
        c.execCommand('indentLess');
      },
      Backspace: (c) => {
        if (c.somethingSelected()) return CM.Pass;
        const cur = c.getCursor();
        const before = c.getLine(cur.line).slice(0, cur.ch);
        if (cur.ch > 0 && /^ +$/.test(before)) {
          const n = ((cur.ch - 1) % 4) + 1;
          c.replaceRange('', { line: cur.line, ch: cur.ch - n }, cur, '+delete');
          return undefined;
        }
        return CM.Pass;
      },
    },
  });
  cm.getWrapperElement().classList.add('rc-cm');

  // ---- 全角
  const zen = attachZenkaku(cm, {
    autoFix: opts.autoZenkaku !== false,
    onFix: (list, afterComposition) => emit('zenkaku', { list, message: fixMessage(list), afterComposition }),
  });

  // ---- 鍵と空欄
  let locked = null;
  let unlockedByUser = false;
  const lockRanges = (() => {
    const r = Array.isArray(opts.locked) ? opts.locked.filter((x) => Array.isArray(x) && x.length) : [];
    if (r.length) return r;
    if (mode === 'blanks') return [[1, String(starter ?? initial).split('\n').length]];   // 穴埋めは空欄だけ開いている（3.4）
    return [];
  })();
  const hasBlanks = /_{3,}/.test(starter ?? initial);
  function setupLocks() {
    if (locked) { locked.destroy(); locked = null; }
    if (unlockedByUser || mode === 'parsons') { refreshUnlockStrip(); return; }
    if (!lockRanges.length && !hasBlanks) { refreshUnlockStrip(); return; }
    locked = applyLocked(cm, {
      starter, locked: lockRanges, blanks: opts.blanks,
      onBlocked: () => emit('blocked', { message: (locked && locked.blanks().length) || hasBlanks ? MESSAGES.blocked : MESSAGES.blockedNoBlank }),
    });
    if (!locked.active()) { locked.destroy(); locked = null; }
    root.classList.toggle('has-locks', !!locked);
    refreshUnlockStrip();
  }
  let unlockable = !!opts.unlockable;
  function refreshUnlockStrip() { unlockStrip.hidden = !(unlockable && locked && locked.active() && mode !== 'parsons'); }
  unlockStrip.querySelector('button').addEventListener('click', () => unlockAll());
  function unlockAll() {
    if (!locked) return;
    locked.unlockAll();
    locked.destroy();
    locked = null;
    unlockedByUser = true;
    root.classList.remove('has-locks');
    refreshUnlockStrip();
    emit('unlock');
  }

  // ---- 再生の印・カードの下線
  let activeHandle = null;
  let replayShown = false;
  let varSource = null;
  /** @type {{mark: object|null, handle: object, cls: string}[]} */
  let cardMarks = [];

  function clearActive() {
    if (activeHandle) {
      cm.removeLineClass(activeHandle, 'background', 'rc-run-line');
      cm.removeLineClass(activeHandle, 'gutter', 'rc-run-gutter');
      activeHandle = null;
    }
    if (parsons) parsons.setActiveLine(null);
  }
  function setActiveLine(n) {
    clearActive();
    if (n == null || !(n >= 1)) return;
    replayShown = true;
    if (mode === 'parsons' && parsons) { parsons.setActiveLine(n); return; }
    const h = cm.getLineHandle(n - 1);
    if (!h) return;
    cm.addLineClass(h, 'background', 'rc-run-line');
    cm.addLineClass(h, 'gutter', 'rc-run-gutter');
    activeHandle = h;
    // 見えていなければ、真ん中より少し上に来るように送る（カーソルは動かさない）
    const top = cm.heightAtLine(n - 1, 'local');
    const info = cm.getScrollInfo();
    const lh = cm.defaultTextHeight() * 1.75;
    if (top < info.top || top + lh > info.top + info.clientHeight) cm.scrollTo(null, Math.max(0, top - info.clientHeight / 3));
  }
  const fmtHits = (k) => (k >= 100000 ? `${Math.round(k / 10000)}万` : k >= 10000 ? `${(k / 10000).toFixed(1)}万` : String(k));
  function setHits(hits) {
    cm.clearGutter('rc-gutter-hits');
    root.classList.remove('has-hits');
    if (!Array.isArray(hits) || mode === 'parsons') return;
    let any = false;
    cm.operation(() => {
      for (let i = 1; i < hits.length && i <= cm.lineCount(); i++) {
        const k = hits[i] | 0;
        if (k <= 0) continue;
        const s = document.createElement('span');
        s.className = 'rc-hits' + (k === 1 ? ' is-one' : '');
        s.textContent = '×' + fmtHits(k);
        s.title = `この行は ${k} 回 動いた`;
        cm.setGutterMarker(i - 1, 'rc-gutter-hits', s);
        any = true;
      }
    });
    if (any) { root.classList.add('has-hits'); replayShown = true; cm.refresh(); }
  }
  function clearCardMarks() {
    for (const m of cardMarks) {
      if (m.mark) m.mark.clear();
      if (cm.getLineNumber(m.handle) != null) { cm.removeLineClass(m.handle, 'wrap', m.cls); cm.removeLineClass(m.handle, 'gutter', m.cls + '-gutter'); }
    }
    cardMarks = [];
    if (parsons) parsons.clearLineMarks();
  }
  function showCard(card) {
    clearCardMarks();
    const out = { line: null, locked: false, note: null };
    if (!card) return out;
    const sev = card.severity === 'error' || !card.severity ? 'error' : 'warn';
    const spots = [];
    if (Array.isArray(card.hits) && card.hits.length) for (const h of card.hits) spots.push({ line: h.line, col: h.col, end: (h.col || 0) + 1 });
    else if (card.line) spots.push({ line: card.line, col: card.col, end: card.end_col });
    if (!spots.length) return out;
    out.line = spots[0].line;
    if (mode === 'parsons' && parsons) {
      for (const s of spots) parsons.markLine(s.line, sev);
      return out;
    }
    const cls = sev === 'error' ? 'rc-line-error' : 'rc-line-warn';
    cm.operation(() => {
      for (const s of spots) {
        const ln = s.line - 1;
        if (ln < 0 || ln >= cm.lineCount()) continue;
        const text = cm.getLine(ln);
        let from;
        let to;
        if (s.col) {
          from = Math.min(text.length, Math.max(0, s.col - 1));
          to = s.end && s.end > s.col ? Math.min(text.length, s.end - 1) : Math.min(text.length, from + 1);
        } else {
          from = text.length - text.replace(/^\s+/, '').length;
          to = text.replace(/\s+$/, '').length;
        }
        const handle = cm.getLineHandle(ln);
        cm.addLineClass(handle, 'wrap', cls);
        cm.addLineClass(handle, 'gutter', cls + '-gutter');
        const mark = to > from ? cm.markText({ line: ln, ch: from }, { line: ln, ch: to }, {
          className: sev === 'error' ? 'rc-mark-error' : 'rc-mark-warn', attributes: { title: card.title || '' },
        }) : null;
        cardMarks.push({ mark, handle, cls });
      }
    });
    cm.scrollIntoView({ line: spots[0].line - 1, ch: 0 }, 60);
    if (locked && locked.isLockedLine(spots[0].line)) {
      out.locked = true;
      out.note = MESSAGES.lockedNote;
      locked.flashBlanks();
    }
    return out;
  }
  function clearReplay() {
    clearActive();
    cm.clearGutter('rc-gutter-hits');
    if (root.classList.contains('has-hits')) { root.classList.remove('has-hits'); cm.refresh(); }
    varSource = null;
    hover.hide();
    replayShown = false;
  }
  function clearMarks() {
    clearReplay();
    clearCardMarks();
  }
  const hover = attachVarHover(cm, (name) => (varSource ? varSource(name) : null));

  // ---- 変更
  let lastCode = mode === 'parsons' ? null : cm.getValue();
  function afterUserChange() {
    if (replayShown) { clearReplay(); emit('marksCleared', { message: MESSAGES.marksCleared }); }
  }
  cm.on('changes', (_c, changes) => {
    const programmatic = changes.every((c) => c.origin === 'setValue' || c.origin === '+rcset');
    if (!programmatic) {
      afterUserChange();
      if (escArmed) disarm();
      // 書きかえた行のカードの下線は消す（直したのに線が残らないように）
      if (cardMarks.length) {
        const touched = new Set();
        for (const c of changes) for (let l = c.from.line; l <= c.from.line + Math.max(c.text.length - 1, c.to.line - c.from.line); l++) touched.add(l);
        cardMarks = cardMarks.filter((m) => {
          const n = cm.getLineNumber(m.handle);
          if (n == null || touched.has(n)) {
            if (m.mark) m.mark.clear();
            if (n != null) { cm.removeLineClass(m.handle, 'wrap', m.cls); cm.removeLineClass(m.handle, 'gutter', m.cls + '-gutter'); }
            return false;
          }
          return true;
        });
      }
    }
    if (mode === 'parsons') return;
    const code = cm.getValue();
    if (code === lastCode) return;
    lastCode = code;
    emit('change', code);
  });

  // ---- キー
  function arm() {
    escArmed = true;
    exitHint.textContent = MESSAGES.exitHint;
    exitHint.hidden = false;
  }
  function disarm() {
    if (!escArmed) return;
    escArmed = false;
    exitHint.hidden = true;
    exitHint.textContent = '';
  }
  const composing = (e) => e.isComposing || e.keyCode === 229 || zen.state.composing;
  cm.on('keydown', (_c, e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (composing(e)) return;                       // 変換の確定の Enter はさわらない
      e.preventDefault();
      disarm();
      emit('run');
      return;
    }
    if (e.key === 'Escape') {
      if (composing(e)) return;
      if (escArmed) { disarm(); return; }
      if (!emit('escape')) arm();
      return;
    }
    if (escArmed) {
      if (e.key === 'Tab') { disarm(); e.codemirrorIgnore = true; return; }   // ブラウザのふつうの Tab（次の場所へ）
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) disarm();
    }
  });
  cm.on('blur', () => disarm());
  // 並べる面のカード・パレットの上でも Ctrl/⌘+Enter で実行
  root.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('.CodeMirror')) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); emit('run'); }
  });

  // ---- 並べる面
  function buildParsons(code) {
    if (parsons) { parsons.destroy(); parsons = null; }
    const p = opts.parsons || { fixed_lines: 0 };
    const sp = splitParsons(code, p);
    const have = new Set(sp.cards.map((c) => c.text));
    const extra = (p.distractors || []).map((t) => String(t).trim()).filter((t) => t && !have.has(t));
    parsons = createParsons(parsonsHost, {
      fixedLines: sp.fixedLines, cards: [...sp.cards, ...extra.map((t) => ({ text: t, level: 0 }))],
      allowAside: (p.distractors || []).length > 0,
      onChange: (c) => { afterUserChange(); clearCardMarks(); emit('change', c); },
      onFreeEdit: () => setMode('free'),
    });
    if (readOnly) parsons.setReadOnly(true);
  }
  function setMode(next) {
    if (next === mode) return;
    const code = getCode();
    clearMarks();
    if (next === 'parsons') {
      mode = 'parsons';
      if (locked) { locked.destroy(); locked = null; }
      buildParsons(code);
      cmHost.hidden = true;
      parsonsHost.hidden = false;
    } else {
      mode = next === 'blanks' ? 'blanks' : 'free';
      if (parsons) { parsons.destroy(); parsons = null; }
      parsonsHost.hidden = true;
      cmHost.hidden = false;
      cm.setValue(code);
      lastCode = code;
      cm.clearHistory();
      setupLocks();
      cm.refresh();
      cm.focus();
      cm.setCursor(cm.lastLine(), 0);
    }
    root.dataset.mode = mode;
    if (palette) palette.element.hidden = mode === 'parsons' || !paletteList.length;
    emit('mode', mode);
  }

  // ---- パレットと記号バー
  let paletteList = [];
  if (Array.isArray(opts.palette)) paletteList = opts.palette;
  else if (opts.palette && opts.palette.level) paletteList = paletteItems(opts.palette.level, opts.palette.api, opts.palette.learnedNew);
  let palette = null;
  if (paletteList.length) {
    palette = createPalette(paletteHost, { items: paletteList, onInsert: (it) => insertSnippet(it), onHelp: opts.onHelp });
    if (mode === 'parsons') palette.element.hidden = true;
  }

  const api = {};
  let symbolBar = null;
  if (opts.symbolBar === true || (opts.symbolBar !== false && isTouchDevice())) {
    symbolBar = createSymbolBar(document.body, { insertText: (t) => api.insertText(t), getCM: () => cm }, { force: opts.symbolBar === true, viewport: opts.viewport });
  }

  /** 選ぶ所（最初の数か、" の中）を探す。 */
  function pickSelection(text) {
    const num = text.match(/(?<![\w.])-?\d+(?:\.\d+)?/);
    if (num) return [num.index, num.index + num[0].length];
    const str = text.match(/"([^"]*)"/);
    if (str) return [str.index + 1, str.index + 1 + str[1].length];
    return null;
  }

  /**
   * パレットのチップを入れる（3.4: 押すとカーソルの所に既定の値つきで入る）。
   * 文（stmt・block・dedent）は自分の行に、式（expr）はカーソルの所に入る。
   * @param {{insert: string, kind?: string}} item
   * @returns {boolean}
   */
  function insertSnippet(item) {
    if (mode === 'parsons' || readOnly || !item) return false;
    const kind = item.kind || 'stmt';
    const wasFocused = cm.hasFocus();
    let text = String(item.insert);
    cm.operation(() => {
      const from = cm.getCursor('from');
      const to = cm.getCursor('to');
      const line = cm.getLine(from.line);
      const indent = line.match(/^[ \t]*/)[0];
      if (kind === 'expr') {
        const caret = text.indexOf(CARET);
        text = text.replace(CARET, '');
        cm.replaceRange(text, from, to, '+palette');
        if (caret >= 0) cm.setCursor({ line: from.line, ch: from.ch + caret });
        else {
          const inner = text.match(/\(([\p{L}_][\p{L}\p{N}_]*)/u);
          const sel = pickSelection(text) || (inner ? [inner.index + 1, inner.index + 1 + inner[1].length] : null);
          if (sel && /\(/.test(text)) cm.setSelection({ line: from.line, ch: from.ch + sel[0] }, { line: from.line, ch: from.ch + sel[1] });
          else cm.setCursor({ line: from.line, ch: from.ch + text.length });
        }
        return;
      }
      let base = indent;
      const emptyLine = line.trim() === '';
      if (kind === 'dedent') base = indent.length >= 4 ? indent.slice(0, indent.length - 4) : '';
      else if (!emptyLine && /:\s*(#.*)?$/.test(line)) base = indent + '    ';
      if (lang === 'c' && !emptyLine && /\{\s*$/.test(line)) base = indent + '    ';
      let body = text.split('\n').map((t, k) => (k === 0 ? t : base + t)).join('\n');
      if (kind === 'block' || (lang === 'python' && /:\s*$/.test(text))) body += '\n' + base + '    ' + CARET;   // else: など
      const caret = body.indexOf(CARET);
      body = body.replace(CARET, '');
      let startLine;
      let startCh;
      if (emptyLine) {
        cm.replaceRange(base + body, { line: from.line, ch: 0 }, { line: from.line, ch: line.length }, '+palette');
        startLine = from.line;
        startCh = base.length;
      } else {
        cm.replaceRange('\n' + base + body, { line: from.line, ch: line.length }, undefined, '+palette');
        startLine = from.line + 1;
        startCh = base.length;
      }
      if (caret >= 0) {
        const before = body.slice(0, caret).split('\n');
        const l = startLine + before.length - 1;
        cm.setCursor({ line: l, ch: before.length === 1 ? startCh + before[0].length : before[before.length - 1].length });
      } else {
        const first = body.split('\n')[0];
        const sel = pickSelection(first);
        if (sel) cm.setSelection({ line: startLine, ch: startCh + sel[0] }, { line: startLine, ch: startCh + sel[1] });
        else cm.setCursor({ line: startLine, ch: startCh + first.length });
      }
    });
    if (wasFocused || !isTouchDevice()) cm.focus();
    return true;
  }

  /** 記号バー: カーソルの所に入れる（選んでいれば置きかえる）。 */
  function insertText(text) {
    if (mode === 'parsons' || readOnly) return false;
    cm.replaceSelection(String(text), 'end', '+input');
    if (!cm.hasFocus()) cm.focus();
    return true;
  }

  /** 今のコードを新しいコードに変える（前後の同じ行は残し、間だけ置きかえる。1 回の undo で戻せる。鍵は付け直す）。 */
  function applyCode(next) {
    const cur = cm.getValue();
    if (cur === next) return;
    const a = cur.split('\n');
    const b = next.split('\n');
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const aEnd = a.length - s;            // a の置きかえる行 [p, aEnd)
    const bMid = b.slice(p, b.length - s);
    if (locked) { locked.destroy(); locked = null; }
    const last = a.length - 1;
    if (aEnd <= p) {
      // 足すだけ
      if (p <= last) cm.replaceRange(bMid.join('\n') + '\n', { line: p, ch: 0 }, undefined, '+rcset');
      else cm.replaceRange('\n' + bMid.join('\n'), { line: last, ch: a[last].length }, undefined, '+rcset');
    } else if (!bMid.length) {
      // 消すだけ（行の終わりの改行もふくめる）
      if (aEnd <= last) cm.replaceRange('', { line: p, ch: 0 }, { line: aEnd, ch: 0 }, '+rcset');
      else if (p > 0) cm.replaceRange('', { line: p - 1, ch: a[p - 1].length }, { line: last, ch: a[last].length }, '+rcset');
      else cm.replaceRange('', { line: 0, ch: 0 }, { line: last, ch: a[last].length }, '+rcset');
    } else {
      cm.replaceRange(bMid.join('\n'), { line: p, ch: 0 }, { line: aEnd - 1, ch: a[aEnd - 1].length }, '+rcset');
    }
    setupLocks();
  }

  function getCode() { return mode === 'parsons' && parsons ? parsons.getCode() : cm.getValue(); }
  function setCode(code, o = {}) {
    clearMarks();
    const v = String(code ?? '');
    if (mode === 'parsons') { buildParsons(v); emit('change', getCode()); return; }
    cm.setValue(v);
    if (o.clearHistory) cm.clearHistory();
    setupLocks();
  }

  Object.assign(api, {
    element: root,
    getCode, setCode, setActiveLine, setHits, showCard, clearMarks, on,
    setVarSource(fn) {
      varSource = typeof fn === 'function' ? fn : null;
      if (varSource) replayShown = true;
      else hover.hide();
    },
    focus() { if (mode === 'parsons' && parsons) parsons.focus(); else cm.focus(); },
    getCM: () => cm,
    getMode: () => mode,
    setMode,
    insertSnippet,
    insertText,
    setReadOnly(v, message = MESSAGES.readOnly) {
      readOnly = !!v;
      cm.setOption('readOnly', readOnly);
      if (parsons) parsons.setReadOnly(readOnly);
      if (palette) palette.setDisabled(readOnly);
      readOnlyStrip.textContent = readOnly ? message || '' : '';
      readOnlyStrip.hidden = !readOnly || !message;
      root.classList.toggle('is-readonly', readOnly);
    },
    setFontSize(px) {
      const n = Math.max(14, Math.min(20, Math.round(Number(px) || 15)));
      root.style.setProperty('--rc-code-size', n + 'px');
      cm.refresh();
      return n;
    },
    setAutoZenkaku(v) { zen.setAutoFix(!!v); },
    fixZenkaku() { return zen.fixAll(); },
    zenkakuFound: () => zen.state.lastFound.slice(),
    isComposing: () => !!zen.state.composing,
    isLockedLine: (n) => !!(locked && locked.isLockedLine(n)),
    hasLocks: () => !!(locked && locked.active()),
    blanks: () => (locked ? locked.blanks() : []),
    flashBlanks() { if (locked) locked.flashBlanks(); },
    nextBlank: (dir = 1) => !!(locked && locked.nextBlank(dir)),
    unlockAll,
    setUnlockable(v) { unlockable = !!v; refreshUnlockStrip(); },
    shuffleCards(seed) { if (parsons) parsons.shuffle(seed); },
    parsons: () => parsons,
    setPalette(items) {
      paletteList = Array.isArray(items) ? items : [];
      if (!palette && paletteList.length) palette = createPalette(paletteHost, { items: paletteList, onInsert: (it) => insertSnippet(it), onHelp: opts.onHelp });
      else if (palette) palette.setItems(paletteList);
      if (palette) palette.element.hidden = mode === 'parsons' || !paletteList.length;
    },
    /**
     * 〔1.1〕履歴から戻す。1 回の undo で戻せる。戻す前のコードを返す（W7 が履歴に残す）。
     * @param {string} code @returns {string}
     */
    restoreCode(code) {
      const prev = getCode();
      if (mode === 'parsons') { setCode(code); return prev; }
      applyCode(String(code ?? ''));
      cm.focus();
      return prev;
    },
    /**
     * 〔1.1〕道具箱の関数を「# ---- 道具箱」の段に入れる。同じ名前があれば confirm(name) で聞く（無ければ入れない）。
     * @param {{name: string, src: string, needs?: any[], code?: string}} item
     * @param {{replace?: boolean, confirm?: (name: string) => (boolean|Promise<boolean>)}} [o]
     * @returns {Promise<{ok: boolean, conflict: string|null, inserted: string[], skipped: string[], replaced: string|null, lines: [number, number]|null}>}
     */
    async insertToolbox(item, o = {}) {
      if (mode === 'parsons') setMode('free');
      let r = planToolbox(getCode(), item, { replace: !!o.replace });
      if (r.conflict && o.confirm) {
        const yes = await o.confirm(r.conflict);
        if (yes) r = planToolbox(getCode(), item, { replace: true });
      }
      if (r.conflict) return { ok: false, ...r };
      if (r.code !== getCode()) {
        applyCode(r.code);
        if (r.lines) {
          cm.scrollIntoView({ from: { line: r.lines[0] - 1, ch: 0 }, to: { line: r.lines[1] - 1, ch: 0 } }, 40);
          cm.setCursor({ line: r.lines[1] - 1, ch: cm.getLine(r.lines[1] - 1).length });
          // 入れた行を少しの間だけ目立たせる（色だけ、光らせない）
          const hs = [];
          for (let l = r.lines[0] - 1; l <= r.lines[1] - 1; l++) { const h = cm.getLineHandle(l); if (h) { cm.addLineClass(h, 'background', 'rc-inserted'); hs.push(h); } }
          setTimeout(() => hs.forEach((h) => { if (cm.getLineNumber(h) != null) cm.removeLineClass(h, 'background', 'rc-inserted'); }), 1600);
        }
      }
      return { ok: true, ...r };
    },
    destroy() {
      clearMarks();
      zen();
      hover();
      if (locked) locked.destroy();
      if (parsons) parsons.destroy();
      if (palette) palette.destroy();
      if (symbolBar) symbolBar.destroy();
      listeners.clear();
      root.remove();
    },
    symbolBar: () => symbolBar,
  });

  // ---- 最初の形
  if (mode === 'parsons') {
    cmHost.hidden = true;
    parsonsHost.hidden = false;
    buildParsons(initial);
  } else {
    cm.clearHistory();
    setupLocks();
  }
  api.setFontSize(opts.fontSize ?? 15);
  if (opts.readOnly) api.setReadOnly(true);
  return api;
}
