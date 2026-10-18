/**
 * @file app/js/editor/locked.js
 * 持ち主: W6（エディタ）
 * 役割: 鍵つきの行（薄い色＋鍵の印、編集できない）と空欄 ___（薄い黄色の箱）。穴埋めの面と 9 章。
 * SPEC: 3.4「鍵つきの行」・4 章の 19・7.7 の locked と blanks・13.2 W6 ③
 *
 * 作り（W6 が決めた形）
 *  - 鍵は行の「handle」で覚える（上の行を足し引きしても、鍵は同じ行についていく）。
 *  - 書きかえを止めるのは CodeMirror の beforeChange で行う（readOnly の印は undo の記録を消してしまうため）。
 *    鍵の行にふれる変更は取り消す。ただし空欄の箱の中だけは書ける（改行は入れられない）。
 *  - 空欄は starter の中の ___（下線 3 つ）。blanks[].line（1 から）の行にある ___ を箱にする。
 *    箱の中を全部消すと ___ に戻して選んだ状態にする（箱が見えなくならないように）。
 *  - 保存したコード（空欄に値を入れたもの）を読み直した時は、opts.starter（面のスターター）の鍵の行を順番どおりに今のコードの中に探し、
 *    ___ だった所に入っている値を箱にする（planLocks）。見つからない時（鍵を外して書きかえたコード）は鍵を付けない。
 *  - 箱に貼り付けた改行は空白にする（箱は 1 行）。
 *  - 鍵の行のどこかを押す・Tab を押すと、次の空欄へ移る（空欄が無い時はふつうの Tab）。
 */

const BLANK = '___';

/**
 * @param {object} cm CodeMirror
 * @param {{locked?: number[][], blanks?: ({line: number, label?: string}|string)[], onBlocked?: () => void, starter?: string|null}} opts
 *   locked は starter の 1 から数える行の範囲 [[1, 4], [7, 7]]。onBlocked は鍵の行を書きかえようとした時（画面に知らせる）。
 *   starter は鍵と空欄を決めたコード（今のコードと同じなら省いてよい）
 * @returns {{unlockAll: () => void, flashBlanks: () => void, isLockedLine: (n: number) => boolean,
 *   blanks: () => {line: number, from: number, to: number, text: string, label: string}[], nextBlank: (dir?: number) => boolean,
 *   active: () => boolean, destroy: () => void}}
 *   unlockAll はクリア後の「鍵を外す」、flashBlanks は〔1.1〕鍵の行でエラーが起きた時に空欄の箱を目立たせる（色を変えるだけ、発光はしない）
 */
export function applyLocked(cm, opts = {}) {
  const lockedHandles = new Set();
  /** @type {{mark: object, label: string}[]} */
  let blankMarks = [];
  let enabled = true;

  // ---- どの行に鍵を付け、どこを箱にするか（starter から今のコードへ写す）
  const plan = planLocks(opts.starter ?? null, cm.getValue(), opts.locked || []);
  if (!plan) enabled = false;     // 写せない（鍵を外したあとに書きかえたコード）→ 鍵なし
  const lockLines = plan ? plan.locked : [];
  const spots = plan ? plan.blanks : [];

  // ---- 鍵の行
  for (const n0 of lockLines) {
    const h = cm.getLineHandle(n0);
    if (!h || lockedHandles.has(h)) continue;
    lockedHandles.add(h);
    cm.addLineClass(h, 'wrap', 'cm-locked-line');
    const g = document.createElement('span');
    g.className = 'rc-lock';
    g.title = '鍵つきの行（書きかえられない）';
    g.setAttribute('aria-label', '鍵つきの行');
    g.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/></svg>';
    cm.setGutterMarker(h, 'rc-gutter-lock', g);
  }

  // ---- 空欄（___ か、starter で ___ だった所に入れた値）
  const labels = (opts.blanks || []).map((b, i) => (typeof b === 'string' ? { line: null, label: b, i } : { line: b.line ?? null, label: b.label || '', i }));
  const found = spots.map((sp) => ({ ...sp }));
  // 説明の割り当て: line（starter の行）が合うものを先に、残りは順番に
  const used = new Set();
  for (const f of found) {
    let lab = labels.find((l) => !used.has(l.i) && l.line === f.starterLine + 1);
    if (!lab) lab = labels.find((l) => !used.has(l.i) && l.line == null);
    if (!lab) lab = labels.find((l) => !used.has(l.i));
    if (lab) used.add(lab.i);
    f.label = lab ? lab.label : '';
  }
  if (enabled) for (const f of found) addBlankMark(f.line, f.from, f.to, f.label);

  function addBlankMark(line, from, to, label) {
    const mark = cm.markText({ line, ch: from }, { line, ch: to }, {
      className: 'cm-blank', inclusiveLeft: true, inclusiveRight: true, clearWhenEmpty: false,
      attributes: { title: label ? `空欄: ${label}` : '空欄（ここに書く）' },
    });
    blankMarks.push({ mark, label });
    return mark;
  }

  const isLockedHandle = (h) => enabled && lockedHandles.has(h);
  const isLockedLine = (n) => { const h = cm.getLineHandle(n - 1); return !!h && isLockedHandle(h); };

  function blankRangeContaining(from, to) {
    for (const b of blankMarks) {
      const r = b.mark.find();
      if (!r) continue;
      if (r.from.line !== from.line || r.to.line !== to.line) continue;
      if (from.ch >= r.from.ch && to.ch <= r.to.ch) return r;
    }
    return null;
  }

  // ---- 書きかえを止める
  let lastBlockedAt = 0;
  const onBeforeChange = (_cm, change) => {
    if (!enabled || change.origin === 'setValue') return;
    let touchesLock = false;
    for (let l = change.from.line; l <= change.to.line; l++) {
      if (isLockedHandle(cm.getLineHandle(l))) { touchesLock = true; break; }
    }
    if (!touchesLock) return;
    const inBox = change.from.line === change.to.line && blankRangeContaining(change.from, change.to);
    if (inBox && change.text.length === 1) return;
    if (inBox && (change.origin === 'paste' || change.origin === 'drop') && change.update) {
      change.update(change.from, change.to, [change.text.map((t) => t.trim()).join(' ')]);   // 箱には改行を入れない
      return;
    }
    change.cancel();
    if (opts.onBlocked && change.origin !== '+zenkaku' && Date.now() - lastBlockedAt > 2500) {
      lastBlockedAt = Date.now();
      opts.onBlocked();
    }
  };
  cm.on('beforeChange', onBeforeChange);

  // 箱の中を全部消したら ___ に戻す
  const onChanges = () => {
    if (!enabled) return;
    for (const b of blankMarks) {
      const r = b.mark.find();
      if (!r) continue;
      if (r.from.line === r.to.line && r.from.ch === r.to.ch) {
        setTimeout(() => {
          const rr = b.mark.find();
          if (!rr || rr.from.ch !== rr.to.ch) return;
          cm.replaceRange(BLANK, rr.from, rr.to, '+blank');
          const r2 = b.mark.find();
          if (r2) cm.setSelection(r2.from, r2.to);
        }, 0);
      }
    }
  };
  cm.on('changes', onChanges);

  // ___ のままの箱を押したら、箱ごと選ぶ（打てばそのまま入れかわる）
  const onMouseDown = (_cm, e) => {
    if (!enabled || e.button !== 0) return;
    setTimeout(() => {
      if (cm.somethingSelected()) return;
      const pos = cm.getCursor();
      for (const b of blankMarks) {
        const r = b.mark.find();
        if (!r || r.from.line !== pos.line || pos.ch < r.from.ch || pos.ch > r.to.ch) continue;
        if (/^_+$/.test(cm.getRange(r.from, r.to))) cm.setSelection(r.from, r.to);
        return;
      }
      // 鍵の行を押したら、その行の空欄（無ければ次の空欄）へ
      const h = cm.getLineHandle(pos.line);
      if (isLockedHandle(h)) {
        const onLine = blankMarks.map((b) => b.mark.find()).filter((r) => r && r.from.line === pos.line);
        if (onLine.length === 1) selectBlank(onLine[0]);
      }
    }, 0);
  };
  cm.on('mousedown', onMouseDown);

  function selectBlank(r) {
    const text = cm.getRange(r.from, r.to);
    if (/^_+$/.test(text)) cm.setSelection(r.from, r.to);
    else cm.setCursor(r.to);
    cm.scrollIntoView({ from: r.from, to: r.to }, 40);
  }

  function sortedBlanks() {
    return blankMarks.map((b) => ({ r: b.mark.find(), label: b.label })).filter((x) => x.r)
      .sort((a, b) => (a.r.from.line - b.r.from.line) || (a.r.from.ch - b.r.from.ch));
  }

  /** 次（dir=-1 で前）の空欄へ移る。空欄が無ければ false。 */
  function nextBlank(dir = 1) {
    const list = sortedBlanks();
    if (!list.length) return false;
    const cur = cm.getCursor(dir > 0 ? 'to' : 'from');
    const cmp = (p, q) => (p.line - q.line) || (p.ch - q.ch);
    let target;
    if (dir > 0) target = list.find((x) => cmp(x.r.from, cur) > 0 && cmp(x.r.to, cur) !== 0) || list[0];
    else target = [...list].reverse().find((x) => cmp(x.r.to, cur) < 0) || list[list.length - 1];
    selectBlank(target.r);
    return true;
  }

  let flashTimer = null;
  function flashBlanks() {
    const w = cm.getWrapperElement();
    w.classList.remove('rc-flash-blanks');
    void w.offsetWidth;
    w.classList.add('rc-flash-blanks');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => w.classList.remove('rc-flash-blanks'), 2400);
  }

  function unlockAll() {
    if (!enabled) return;
    enabled = false;
    cm.operation(() => {
      for (const h of lockedHandles) {
        if (cm.getLineNumber(h) == null) continue;
        cm.removeLineClass(h, 'wrap', 'cm-locked-line');
        cm.setGutterMarker(h, 'rc-gutter-lock', null);
      }
      for (const b of blankMarks) b.mark.clear();
    });
    lockedHandles.clear();
    blankMarks = [];
  }

  function destroy() {
    unlockAll();
    cm.off('beforeChange', onBeforeChange);
    cm.off('changes', onChanges);
    cm.off('mousedown', onMouseDown);
    clearTimeout(flashTimer);
  }

  return {
    unlockAll, flashBlanks, isLockedLine, nextBlank, destroy,
    active: () => enabled && (lockedHandles.size > 0 || blankMarks.length > 0),
    hasLocks: () => enabled && lockedHandles.size > 0,
    blanks: () => sortedBlanks().map((x) => ({ line: x.r.from.line + 1, from: x.r.from.ch, to: x.r.to.ch, text: cm.getRange(x.r.from, x.r.to), label: x.label })),
  };
}

/** 正規表現の特別な字を逃がす。 */
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * starter の鍵の行と空欄を、今のコードの行に写す（保存したコードを読み直した時も、箱が入れた値を包むように）。
 * @param {string|null} starter 鍵と空欄を決めたコード（null なら今のコードがそのまま starter）
 * @param {string} current 今のコード
 * @param {number[][]} ranges starter の行の範囲（1 から、[[1, 4], [7, 7]]）
 * @returns {{locked: number[], blanks: {line: number, from: number, to: number, starterLine: number}[]}|null}
 *   行は 0 から。写せない時（鍵の行が見つからない）は null
 */
export function planLocks(starter, current, ranges) {
  const cur = String(current ?? '').split('\n');
  const st = starter == null ? cur : String(starter).split('\n');
  const lockSet = new Set();
  for (const r of ranges || []) {
    const a = Math.max(1, r[0] | 0);
    const b = Math.min(st.length, (r[1] ?? r[0]) | 0);
    for (let n = a; n <= b; n++) lockSet.add(n - 1);
  }
  const blankRe = /_{3,}/g;
  const patternOf = (line) => {
    const parts = line.split(/_{3,}/);
    if (parts.length === 1) return null;
    return new RegExp('^' + parts.map(reEsc).join('(.*?)') + '$', 'd');
  };
  const locked = [];
  const blanks = [];
  const same = starter == null || String(starter) === String(current);
  if (same) {
    for (const n of [...lockSet].sort((x, y) => x - y)) locked.push(n);
    cur.forEach((line, n) => {
      blankRe.lastIndex = 0;
      let m;
      while ((m = blankRe.exec(line))) blanks.push({ line: n, from: m.index, to: m.index + m[0].length, starterLine: n });
    });
    return { locked, blanks };
  }
  // starter の鍵の行を、順番を保って今のコードの中に探す（鍵の行は書きかえられないので、そのまま残っているはず）
  let p = 0;
  for (const n of [...lockSet].sort((x, y) => x - y)) {
    const pat = patternOf(st[n]);
    let found = -1;
    for (let k = p; k < cur.length; k++) {
      if (pat ? pat.test(cur[k]) : cur[k] === st[n]) { found = k; break; }
    }
    if (found < 0) return null;
    locked.push(found);
    if (pat) {
      const m = pat.exec(cur[found]);
      for (let g = 1; g < m.length; g++) {
        const [from, to] = m.indices[g];
        blanks.push({ line: found, from, to, starterLine: n });
      }
    }
    p = found + 1;
  }
  // 鍵の無い行に残っている ___ も箱にする
  const lockedSet2 = new Set(locked);
  cur.forEach((line, n) => {
    if (lockedSet2.has(n)) return;
    blankRe.lastIndex = 0;
    let m;
    while ((m = blankRe.exec(line))) blanks.push({ line: n, from: m.index, to: m.index + m[0].length, starterLine: -1 });
  });
  return { locked, blanks };
}

/**
 * starter から空欄の場所を探す（Node でも使える。テストと W7 の確かめ用）。
 * @param {string} code @returns {{line: number, col: number}[]} line・col は 1 から
 */
export function findBlanks(code) {
  const out = [];
  String(code).split('\n').forEach((text, i) => {
    let at = text.indexOf(BLANK);
    while (at >= 0) {
      out.push({ line: i + 1, col: at + 1 });
      let end = at + BLANK.length;
      while (text[end] === '_') end++;
      at = text.indexOf(BLANK, end);
    }
  });
  return out;
}
