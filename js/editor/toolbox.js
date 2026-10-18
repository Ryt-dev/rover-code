/**
 * @file app/js/editor/toolbox.js
 * 持ち主: W6（エディタ）
 * 役割: 〔1.1〕道具箱（自分の関数をコードの先頭の「# ---- 道具箱」の段に入れる）と履歴（実行したコードと見比べて戻す）の、
 *       エディタ側の入れ方。どの関数を出すか・履歴を何本残すかは W7（store.js の toolbox()・history）が決め、ここは「入れ方」だけ。
 * SPEC: 3.4「履歴」「道具箱」・7.3（Engine.extractDefs）・7.9（history・clearedCode）・13.2 W6 ⑦
 *
 * 決めた形（W6）
 *  - 道具箱の段は「# ---- 道具箱」の行から「# ---- 道具箱ここまで」の行まで（無ければコードの一番上に作る）。
 *    終わりの行が無い時は、次の「# ---- 」の見出しの手前まで（9-6 のスターターの段の見出し `# ---- 待機 → 着地` と同じ書き方）。
 *  - 入れる順番: import → 上の段の値（LAT0 = … など）→ 使っている関数 → 選んだ関数。すでにコードのどこかにある名前は入れない。
 *  - 同じ名前の関数がすでにある時は入れずに { conflict } を返す（画面が「入れかえる？」と聞き、replace: true でもう一度呼ぶ）。
 *    入れかえは、その関数があった場所でそのまま差しかえる。
 *  - needs は名前（Engine.extractDefs の形）でも {name, src} でもよい。名前だけの時は、item.code（取り出したクリアしたコード）から
 *    その名前を決めている行（import・代入・def）を探して入れる。needs が足りなくても、関数の中で使っている名前を item.code から補う。
 *
 * この形は Node でも import できる（DOM にさわるのは create…Panel の中だけ）。
 */

export const TOOLBOX_HEAD = '# ---- 道具箱';
export const TOOLBOX_END = '# ---- 道具箱ここまで';
const HEAD_RE = /^#\s*-{2,}\s*道具箱(?!ここまで)/;
const END_RE = /^#\s*-{2,}\s*道具箱ここまで/;
const ANY_HEAD_RE = /^#\s*-{2,}\s*\S/;
const IDENT = /[\p{L}_][\p{L}\p{N}_]*/gu;
const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is ' +
  'lambda nonlocal not or pass raise return try while with yield print').split(' '));

/** 文字列とコメントを空白にした行（名前を数える時に、文字列の中の字を拾わないため）。三重クォートは行をまたいで追う。 */
function maskLines(lines) {
  const out = [];
  let triple = null;
  for (const line of lines) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      if (triple) {
        const end = line.indexOf(triple, i);
        if (end < 0) { s += ' '.repeat(line.length - i); i = line.length; break; }
        s += ' '.repeat(end + 3 - i); i = end + 3; triple = null; continue;
      }
      const c = line[i];
      if (c === '#') { s += ' '.repeat(line.length - i); break; }
      if (c === '"' || c === "'") {
        if (line.startsWith(c.repeat(3), i)) { triple = c.repeat(3); s += '   '; i += 3; continue; }
        let j = i + 1;
        while (j < line.length && line[j] !== c) { if (line[j] === '\\') j++; j++; }
        s += ' '.repeat(Math.min(line.length, j + 1) - i); i = j + 1; continue;
      }
      s += c; i++;
    }
    out.push({ text: s, inTriple: !!triple });
  }
  return out;
}

/**
 * Python のコードをトップレベルの塊に分ける（ast を使わない軽い見分け。道具箱と履歴のため）。
 * @param {string} code
 * @returns {{kind: 'def'|'class'|'import'|'assign'|'comment'|'other', names: string[], from: number, to: number, src: string}[]}
 *   from・to は 0 から数える行（to はふくむ）。src は末尾の空行を除いた塊の文。
 */
export function topLevelBlocks(code) {
  const lines = String(code ?? '').replace(/\r\n?/g, '\n').split('\n');
  const masked = maskLines(lines);
  const blocks = [];
  let cur = null;
  let depth = 0;
  let prevTriple = false;
  let backslash = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const continuing = depth > 0 || prevTriple || backslash;
    const top = !continuing && stripped !== '' && !/^[ \t]/.test(line);
    if (top) {
      if (cur) blocks.push(cur);
      cur = { from: i, to: i, first: line };
    } else if (cur && (stripped !== '' || continuing)) {
      cur.to = i;
    }
    const m = masked[i].text;
    for (const ch of m) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
    }
    backslash = /\\\s*$/.test(m);
    prevTriple = masked[i].inTriple;
  }
  if (cur) blocks.push(cur);
  // 列 0 のコメントのすぐ下（空行なし）に文があれば、その文の塊にふくめる（「# 8-4 のそっとタッチ」のような見出し）
  const merged = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (/^#/.test(b.first) && b.to === b.from) {
      const nx = blocks[k + 1];
      if (nx && nx.from === b.to + 1 && !/^#/.test(nx.first)) { nx.from = b.from; nx.lead = (nx.lead || 0) + 1; continue; }
    }
    merged.push(b);
  }
  return merged.map((b) => {
    const first = lines[b.from + (b.lead || 0)] ?? b.first;
    let kind = 'other';
    let names = [];
    let mm;
    if ((mm = first.match(/^(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(/u))) { kind = 'def'; names = [mm[1]]; }
    else if ((mm = first.match(/^class\s+([\p{L}_][\p{L}\p{N}_]*)/u))) { kind = 'class'; names = [mm[1]]; }
    else if ((mm = first.match(/^import\s+(.+?)\s*(#.*)?$/))) {
      kind = 'import';
      names = mm[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const a = p.split(/\s+as\s+/); return (a[1] || a[0].split('.')[0]).trim(); });
    } else if ((mm = first.match(/^from\s+\S+\s+import\s+\(?(.+?)\)?\s*(#.*)?$/))) {
      kind = 'import';
      names = mm[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => { const a = p.split(/\s+as\s+/); return (a[1] || a[0]).trim(); });
    } else if (/^#/.test(first)) { kind = 'comment'; }
    else if ((mm = first.match(/^([\p{L}_][\p{L}\p{N}_]*(?:\s*,\s*[\p{L}_][\p{L}\p{N}_]*)*)\s*(?::[^=]+)?=(?!=)/u))) {
      kind = 'assign'; names = mm[1].split(',').map((s) => s.trim());
    }
    return { kind, names, from: b.from, to: b.to, src: lines.slice(b.from, b.to + 1).join('\n') };
  });
}

/** 塊の中で使っている名前（文字列・コメント・キーワード・属性の後ろ（.lat）を除く）。 */
export function usedNames(src) {
  const masked = maskLines(String(src).split('\n')).map((x) => x.text).join('\n');
  const out = new Set();
  for (const m of masked.matchAll(IDENT)) {
    const prev = masked[m.index - 1];
    if (prev === '.') continue;
    if (!PY_KEYWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}

/** 道具箱の段の場所（0 から数える行）。無ければ null。 */
export function findToolboxSection(code) {
  const lines = String(code ?? '').split('\n');
  const head = lines.findIndex((l) => HEAD_RE.test(l));
  if (head < 0) return null;
  let end = -1;
  let endIsMarker = false;
  for (let i = head + 1; i < lines.length; i++) {
    if (END_RE.test(lines[i])) { end = i; endIsMarker = true; break; }
    if (ANY_HEAD_RE.test(lines[i])) { end = i; break; }
  }
  if (end < 0) end = lines.length;
  return { head, end, endIsMarker };
}

/**
 * 道具箱の関数をコードに入れる（コードは書きかえずに、新しいコードを返す）。
 * @param {string} code 今のコード
 * @param {{name: string, src: string, needs?: (string|{name: string, src?: string})[], code?: string, levelId?: string}} item
 *   src は関数の文（def から）。code はその関数を取り出したコード（clearedCode や先輩の答え。needs の文を探すのに使う）
 * @param {{replace?: boolean}} [opts]
 * @returns {{code: string, conflict: string|null, inserted: string[], skipped: string[], replaced: string|null, lines: [number, number]|null}}
 *   lines は入れた行の範囲（1 から、ふくむ）。conflict があればコードは元のまま
 */
export function insertToolbox(code, item, opts = {}) {
  const src0 = String(code ?? '');
  const eol = src0.endsWith('\n') || src0 === '' ? '\n' : '';
  const blocks = topLevelBlocks(src0);
  const defined = new Map();
  for (const b of blocks) for (const n of b.names) if (!defined.has(n)) defined.set(n, b);
  const name = item.name;
  const itemSrc = String(item.src ?? '').replace(/\s+$/, '');
  const result = { code: src0, conflict: null, inserted: [], skipped: [], replaced: null, lines: null };
  if (!name || !itemSrc) return result;
  const existing = defined.get(name);
  if (existing && !opts.replace) {
    if (existing.src.replace(/\s+$/, '') === itemSrc) { result.skipped.push(name); return result; }
    result.conflict = name;
    return result;
  }

  // ---- 使う名前（needs）を集める
  const ctxBlocks = topLevelBlocks(item.code || '');
  const ctxDefined = new Map();
  for (const b of ctxBlocks) for (const n of b.names) if (!ctxDefined.has(n)) ctxDefined.set(n, b);
  const wanted = [];                       // {name, src, kind}
  const seen = new Set([name]);
  const addNeed = (n, srcGiven) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (defined.has(n)) { result.skipped.push(n); return; }
    let src = srcGiven;
    let kind = null;
    const b = ctxDefined.get(n);
    if (!src && b) { src = b.src; kind = b.kind; }
    if (!src) return;
    if (!kind) kind = topLevelBlocks(src)[0]?.kind || 'other';
    // 同じ塊（import math, os など）を 2 回入れない
    if (wanted.some((w) => w.src === src)) return;
    wanted.push({ name: n, src: src.replace(/\s+$/, ''), kind });
    // その塊が使う名前もたどる（touch → angle_diff など）
    for (const u of usedNames(src)) if (ctxDefined.has(u) && u !== n) addNeed(u, null);
  };
  for (const nd of item.needs || []) {
    if (typeof nd === 'string') addNeed(nd, null);
    else if (nd && nd.name) addNeed(nd.name, nd.src || null);
  }
  for (const u of usedNames(itemSrc)) if (ctxDefined.has(u)) addNeed(u, null);

  const rank = { import: 0, assign: 1, other: 2, class: 3, def: 3 };
  // 元のコードでの順番に並べる（ふつうは使われる関数が先に書いてある）。元のコードに無いものは後ろに、渡された順で
  const posOf = (w, k) => { const bl = ctxDefined.get(w.name); return bl ? bl.from : 1e9 + k; };
  const ordered = wanted.map((w, k) => ({ w, pos: posOf(w, k) })).sort((x, y) => x.pos - y.pos).map((x) => x.w);
  const imports = ordered.filter((w) => w.kind === 'import');
  const values = ordered.filter((w) => rank[w.kind] === 1 || rank[w.kind] === 2);
  const funcs = ordered.filter((w) => rank[w.kind] === 3);

  let lines = src0.replace(/\n$/, '').split('\n');
  if (src0 === '') lines = [];
  let firstLine = null;
  let lastLine = null;
  const mark = (a, b) => { firstLine = firstLine == null ? a : Math.min(firstLine, a); lastLine = lastLine == null ? b : Math.max(lastLine, b); };

  // ---- 入れかえ（その場で）
  if (existing && opts.replace) {
    const newLines = itemSrc.split('\n');
    // 塊の後ろの空行は残す
    let to = existing.to;
    while (to > existing.from && lines[to].trim() === '') to--;
    lines.splice(existing.from, to - existing.from + 1, ...newLines);
    result.replaced = name;
    mark(existing.from, existing.from + newLines.length - 1);
  }

  // ---- 段を用意する
  let sec = findToolboxSection(lines.join('\n'));
  if (!sec && (wanted.length || !existing)) {
    const add = [TOOLBOX_HEAD, TOOLBOX_END, ''];
    lines.splice(0, 0, ...add);
    if (firstLine != null) { firstLine += add.length; lastLine += add.length; }
    sec = { head: 0, end: 1, endIsMarker: true };
  }
  const insertAt = (at, srcs) => {
    const chunk = [];
    for (const s of srcs) { chunk.push(...s.split('\n')); }
    if (!chunk.length) return 0;
    lines.splice(at, 0, ...chunk);
    if (firstLine != null && firstLine >= at) { firstLine += chunk.length; lastLine += chunk.length; }
    mark(at, at + chunk.length - 1);
    return chunk.length;
  };
  if (sec) {
    // import と値は段の頭（見出しのすぐ下）に、関数は段の終わりの手前に
    let at = sec.head + 1;
    while (at < sec.end && /^(import|from)\s/.test(lines[at])) at++;
    let nTop = insertAt(at, [...imports.map((w) => w.src), ...values.map((w) => w.src)]);
    // import・値のすぐ下が関数なら 1 行あける
    if (nTop && lines[at + nTop] !== undefined && lines[at + nTop].trim() !== '' && !/^(import|from)\s/.test(lines[at + nTop]) &&
        !/^[\p{L}_][\p{L}\p{N}_]*\s*=/u.test(lines[at + nTop]) && at + nTop < sec.end + nTop) {
      lines.splice(at + nTop, 0, '');
      nTop++;
    }
    let end = sec.end + nTop;
    // 段の終わりの手前の空行の上に入れ、関数の間は 1 行あける
    let ins = end;
    while (ins - 1 > sec.head && lines[ins - 1].trim() === '') ins--;
    const defsSrc = [...funcs.map((w) => w.src), ...(!existing ? [itemSrc] : [])];
    if (defsSrc.length) {
      const prevIsCode = ins - 1 > sec.head && lines[ins - 1].trim() !== '';
      const parts = [];
      defsSrc.forEach((s, k) => { if (k > 0 || prevIsCode) parts.push(''); parts.push(s); });
      const chunk = parts.join('\n').split('\n');
      // 終わりの見出しとの間に空行を 1 つ
      const needGapAfter = lines[ins] !== undefined && lines[ins].trim() !== '';
      if (needGapAfter) chunk.push('');
      lines.splice(ins, 0, ...chunk);
      if (firstLine != null && firstLine >= ins) { firstLine += chunk.length; lastLine += chunk.length; }
      const lead = chunk[0] === '' ? 1 : 0;
      mark(ins + lead, ins + chunk.length - 1 - (needGapAfter ? 1 : 0));
    }
  }
  result.inserted = [...ordered.map((w) => w.name), ...(!existing ? [name] : [])];
  result.code = lines.join('\n') + eol;
  result.lines = firstLine == null ? null : [firstLine + 1, lastLine + 1];
  return result;
}

/**
 * 行の違い（履歴の見比べ用）。LCS で出す。大きすぎる時は前後の同じ行だけ見る。
 * @param {string} a 前 @param {string} b 後
 * @returns {{op: '='|'-'|'+', text: string, a: number|null, b: number|null}[]} a・b は 1 から数える行
 */
export function diffLines(a, b) {
  const A = String(a ?? '').replace(/\n$/, '').split('\n');
  const B = String(b ?? '').replace(/\n$/, '').split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const out = [];
  for (let i = 0; i < p; i++) out.push({ op: '=', text: A[i], a: i + 1, b: i + 1 });
  const a2 = A.slice(p, A.length - s);
  const b2 = B.slice(p, B.length - s);
  const n = a2.length;
  const m = b2.length;
  if (n * m > 4e6) {
    a2.forEach((t, i) => out.push({ op: '-', text: t, a: p + i + 1, b: null }));
    b2.forEach((t, j) => out.push({ op: '+', text: t, a: null, b: p + j + 1 }));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { out.push({ op: '=', text: a2[i], a: p + i + 1, b: p + j + 1 }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) { out.push({ op: '+', text: b2[j], a: null, b: p + j + 1 }); j++; }
      else { out.push({ op: '-', text: a2[i], a: p + i + 1, b: null }); i++; }
    }
  }
  for (let k = 0; k < s; k++) out.push({ op: '=', text: A[A.length - s + k], a: A.length - s + k + 1, b: B.length - s + k + 1 });
  return out;
}

/** 違いの数（+ と - の行の数）。 */
export function diffCount(a, b) { return diffLines(a, b).filter((d) => d.op !== '=').length; }

// ------------------------------------------------------------------ 画面の部品（W7 が使ってもよい。使わなくてもよい）

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 履歴の窓の中身: 左に一覧（新しい順・クリアした時）、右に今のコードとの違い、［このコードに戻す］。
 * @param {HTMLElement} el
 * @param {{entries: {label: string, code: string, kind?: 'run'|'cleared', at?: string}[], current: () => string,
 *   onRestore: (code: string, entry: object) => void}} opts
 *   entries は W7 の store（history: 新しい順に 5 つ・clearedCode）から作る。onRestore で editor.restoreCode(code) を呼び、
 *   戻す前のコードを履歴に足すのは W7（3.4「戻す前の今のコードも履歴に残す」）
 * @returns {{destroy: () => void}}
 */
export function createHistoryPanel(el, opts) {
  const root = document.createElement('div');
  root.className = 'rc-history';
  const entries = (opts.entries || []).filter((e) => e && typeof e.code === 'string');
  if (!entries.length) {
    root.innerHTML = '<p class="rc-history-empty">まだ履歴が無いよ。▶ 実行 するたびに、ここに 5 つまで残るよ。</p>';
    el.appendChild(root);
    return { destroy: () => root.remove() };
  }
  root.innerHTML = `<ul class="rc-history-list" role="listbox" aria-label="履歴（新しい順）"></ul>
    <div class="rc-history-view"><div class="rc-history-sum" aria-live="polite"></div><pre class="rc-diff" tabindex="0" aria-label="今のコードとの違い"></pre>
    <button type="button" class="rc-btn rc-history-restore">このコードに戻す</button></div>`;
  const list = root.querySelector('.rc-history-list');
  const view = root.querySelector('.rc-diff');
  const sum = root.querySelector('.rc-history-sum');
  const btn = root.querySelector('.rc-history-restore');
  let sel = 0;
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.tabIndex = i === 0 ? 0 : -1;
    li.className = 'rc-history-item' + (e.kind === 'cleared' ? ' is-cleared' : '');
    li.innerHTML = `<b>${esc(e.label || (e.kind === 'cleared' ? 'クリアした時のコード' : `${i + 1} つ前の実行`))}</b>${e.at ? `<small>${esc(e.at)}</small>` : ''}`;
    li.addEventListener('click', () => pick(i));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const j = Math.max(0, Math.min(entries.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
        pick(j); list.children[j].focus();
      } else if (ev.key === 'Enter') { ev.preventDefault(); btn.click(); }
    });
    list.appendChild(li);
  });
  function pick(i) {
    sel = i;
    [...list.children].forEach((li, k) => { li.setAttribute('aria-selected', String(k === i)); li.tabIndex = k === i ? 0 : -1; });
    const cur = opts.current();
    const d = diffLines(cur, entries[i].code);
    const nAdd = d.filter((x) => x.op === '+').length;
    const nDel = d.filter((x) => x.op === '-').length;
    sum.textContent = nAdd + nDel === 0 ? '今のコードと同じだよ' : `今のコードとちがう行: 戻すと ${nAdd} 行が入り、${nDel} 行が消える`;
    view.innerHTML = d.map((x) => `<span class="rc-diff-${x.op === '=' ? 'same' : x.op === '+' ? 'add' : 'del'}"><i aria-hidden="true">${x.op === '=' ? ' ' : x.op === '+' ? '+' : '−'}</i>${esc(x.text) || ' '}</span>`).join('\n');
    btn.disabled = nAdd + nDel === 0;
  }
  btn.addEventListener('click', () => opts.onRestore(entries[sel].code, entries[sel]));
  el.appendChild(root);
  pick(0);
  return { destroy: () => root.remove() };
}

/**
 * 道具箱の窓の中身: 「名前・作った面・行数」の一覧と［入れる］。同じ名前は新しい面の版を先に、古い版と先輩の版も選べる。
 * @param {HTMLElement} el
 * @param {{items: {name: string, levelId: string, src: string, lines?: number, code?: string, needs?: any[], senpai?: boolean}[],
 *   onInsert: (item: object) => void, order?: (levelId: string) => number}} opts
 *   order は面の順番（新しい面を先に出すため。無ければ levelId の数で比べる）
 * @returns {{destroy: () => void}}
 */
export function createToolboxPanel(el, opts) {
  const root = document.createElement('div');
  root.className = 'rc-toolbox';
  const order = opts.order || ((id) => { const m = String(id).match(/^(\d+|C)-(\d+)/); return m ? (m[1] === 'C' ? 100 : +m[1]) * 100 + +m[2] : 0; });
  const items = (opts.items || []).filter((it) => it && it.name && it.src);
  if (!items.length) {
    root.innerHTML = '<p class="rc-toolbox-empty">まだ道具が無いよ。def で作った関数が、クリアした面から集まってくるよ。</p>';
    el.appendChild(root);
    return { destroy: () => root.remove() };
  }
  const groups = new Map();
  for (const it of items) { if (!groups.has(it.name)) groups.set(it.name, []); groups.get(it.name).push(it); }
  for (const g of groups.values()) g.sort((a, b) => (a.senpai ? 1 : 0) - (b.senpai ? 1 : 0) || order(b.levelId) - order(a.levelId));
  const ul = document.createElement('ul');
  ul.className = 'rc-toolbox-list';
  for (const [name, g] of groups) {
    const li = document.createElement('li');
    li.className = 'rc-toolbox-item';
    const lines = (it) => it.lines ?? String(it.src).replace(/\s+$/, '').split('\n').length;
    const opt = (it, k) => `<option value="${k}">${esc(it.levelId)}${it.senpai ? ' の先輩の版' : ''}（${lines(it)} 行）</option>`;
    li.innerHTML = `<code class="rc-toolbox-name">${esc(name)}()</code>
      ${g.length > 1 ? `<select aria-label="${esc(name)} の版">${g.map(opt).join('')}</select>` : `<span class="rc-toolbox-from">${esc(g[0].levelId)}${g[0].senpai ? ' の先輩の版' : ''}・${lines(g[0])} 行</span>`}
      <button type="button" class="rc-btn">入れる</button>`;
    const select = li.querySelector('select');
    li.querySelector('button').addEventListener('click', () => opts.onInsert(g[select ? +select.value : 0]));
    ul.appendChild(li);
  }
  root.appendChild(ul);
  el.appendChild(root);
  return { destroy: () => root.remove() };
}
