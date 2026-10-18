/**
 * @file app/js/editor/palette.js
 * 持ち主: W6（エディタ）
 * 役割: パレット: その面までに習った命令のチップ（motor(0.5, 0.5)・wait(2)・for i in range(4): など）。押すとカーソルの所に既定の値つきで入る。
 * SPEC: 3.4「パレット」・4 章の 7・5.4（並べるのは equipped のうち new に出てきたもの。import time は出さない）・3.11（タッチは押して出す小さなカード）
 *
 * 決めた形（W6）
 *  - チップは {name, label, insert, summary, kind}。kind は 'stmt'（文: 自分の行に入る）・'block'（: で終わる文。次の行は字下げ）・
 *    'dedent'（else・elif・except: 1 段もどして入る）・'expr'（式: カーソルの所に入る）。
 *  - insert の中の「‸」（U+2038）は、入れたあとのカーソルの場所。無ければ最初の数（無ければ " の中）を選んだ状態にする
 *    （そのまま数字を打てば入れかわる。スマホでも直しやすい）。
 *  - 命令のチップは data/api.json の palette の文、文法のチップは下の SYNTAX。C の面は C の書き方のチップにする。
 *  - マウスを乗せると summary（ずかんの 1 行）。タッチ端末では押して入れたあと、その summary を小さなカードで 2.5 s 出す。
 *  - チップを押してもエディタのフォーカスは動かさない（スマホで画面のキーボードが閉じないように、pointerdown で止める）。
 */

export const CARET = '‸';

/** 文法のチップ（levels の new に出てくる名前 → チップ）。1 つの名前から複数のチップを出してよい。 */
export const SYNTAX = {
  python: {
    '変数': [{ label: 'd = 1.0', insert: 'd = 1.0', kind: 'stmt', summary: '変数: 名前に値を入れておく' }],
    '計算（+ − * /）': [
      { label: '+', insert: ' + ', kind: 'expr', summary: 'たし算' }, { label: '-', insert: ' - ', kind: 'expr', summary: 'ひき算' },
      { label: '*', insert: ' * ', kind: 'expr', summary: 'かけ算（× の代わりに *）' }, { label: '/', insert: ' / ', kind: 'expr', summary: 'わり算（÷ の代わりに /）' }],
    'for': [{ label: 'for i in range(4):', insert: 'for i in range(4):', kind: 'block', summary: 'for: 字下げした行を決まった回数くり返す' }],
    'range': [],
    'if': [{ label: 'if d < 0.5:', insert: 'if d < 0.5:', kind: 'block', summary: 'if: 条件が正しい時だけ、字下げした行をする' }],
    'else': [{ label: 'else:', insert: 'else:', kind: 'dedent', summary: 'else: if の条件が正しくない時にする' }],
    'elif': [{ label: 'elif d < 1.0:', insert: 'elif d < 1.0:', kind: 'dedent', summary: 'elif: 上の条件がだめな時の、次の条件' }],
    'None': [
      { label: 'None', insert: 'None', kind: 'expr', summary: 'None: 「値が無い」のしるし（測れなかった時など）' },
      { label: 'is None', insert: ' is None', kind: 'expr', summary: 'None かどうかは == ではなく is で比べる' }],
    'while': [{ label: 'while d > 0.3:', insert: 'while d > 0.3:', kind: 'block', summary: 'while: 条件が正しい間、字下げした行をくり返す' }],
    'while True': [{ label: 'while True:', insert: 'while True:', kind: 'block', summary: 'while True: ずっとくり返す（break で抜ける）' }],
    'break': [{ label: 'break', insert: 'break', kind: 'stmt', summary: 'break: くり返しをすぐに抜ける' }],
    'def': [{ label: 'def go(sec):', insert: 'def go(sec):', kind: 'block', summary: 'def: 自分の命令（関数）を作る' }],
    '引数': [],
    'abs': [{ label: 'abs(x)', insert: 'abs(x)', kind: 'expr', summary: 'abs: 数の大きさ（マイナスを取る）' }],
    'return': [{ label: 'return x', insert: 'return x', kind: 'stmt', summary: 'return: 関数の答えを返す' }],
    'リスト': [{ label: 'xs = [1, 2, 3]', insert: 'xs = [1, 2, 3]', kind: 'stmt', summary: 'リスト: 値をいくつも並べて持つ' }],
    'タプル': [{ label: 'p = (0.0, 1.0)', insert: 'p = (0.0, 1.0)', kind: 'stmt', summary: 'タプル: 組にした値（x, y など）' }],
    'for ... in リスト': [{ label: 'for x in xs:', insert: 'for x in xs:', kind: 'block', summary: 'リストの値を 1 つずつ取り出してくり返す' }],
    '%': [{ label: '%', insert: ' % ', kind: 'expr', summary: '%: わり算のあまり（角度を 0〜360 に入れる時など）' }],
    'import math': [{ label: 'import math', insert: 'import math', kind: 'stmt', summary: 'import math: 三角関数などの道具を使えるようにする' }],
    'P 制御': [],
    'math.cos': [{ label: 'math.cos(x)', insert: 'math.cos(x)', kind: 'expr', summary: 'math.cos: コサイン（角度はラジアン）' }],
    'math.radians': [{ label: 'math.radians(deg)', insert: 'math.radians(deg)', kind: 'expr', summary: 'math.radians: 度をラジアンに直す' }],
    'math.atan2': [{ label: 'math.atan2(dx, dy)', insert: 'math.atan2(dx, dy)', kind: 'expr', summary: 'math.atan2: 向きの角度（北 0・時計回りは atan2(東, 北)）' }],
    'math.degrees': [{ label: 'math.degrees(r)', insert: 'math.degrees(r)', kind: 'expr', summary: 'math.degrees: ラジアンを度に直す' }],
    'math.hypot': [{ label: 'math.hypot(dx, dy)', insert: 'math.hypot(dx, dy)', kind: 'expr', summary: 'math.hypot: 2 点の間の距離' }],
    'max': [{ label: 'max(a, b)', insert: 'max(a, b)', kind: 'expr', summary: 'max: 大きい方' }],
    'min': [{ label: 'min(a, b)', insert: 'min(a, b)', kind: 'expr', summary: 'min: 小さい方' }],
    'g.course': [{ label: 'g.course', insert: 'g.course', kind: 'expr', summary: 'GNSS の進んでいる向き（度）' }],
    'g.speed': [{ label: 'g.speed', insert: 'g.speed', kind: 'expr', summary: 'GNSS の速さ（m/s）' }],
    'c.size': [{ label: 'c.size', insert: 'c.size', kind: 'expr', summary: 'カメラに写ったコーンの大きさ（0〜1）' }],
    '状態機械': [{ label: 'state = "待機"', insert: 'state = "待機"', kind: 'stmt', summary: '状態機械: 今のフェーズを文字で持つ' }],
    'リストの append・pop': [
      { label: 'xs.append(v)', insert: 'xs.append(v)', kind: 'stmt', summary: 'append: リストの最後に足す' },
      { label: 'xs.pop(0)', insert: 'xs.pop(0)', kind: 'expr', summary: 'pop: リストから取り出す' }],
    'global': [{ label: 'global state', insert: 'global state', kind: 'stmt', summary: 'global: 関数の中で外の変数を書きかえる' }],
    'try': [{ label: 'try:', insert: 'try:', kind: 'block', summary: 'try: エラーが起きるかもしれない行を包む' }],
    'except': [{ label: 'except OSError:', insert: 'except OSError:', kind: 'dedent', summary: 'except: エラーが起きた時にする' }],
  },
  c: {
    '#include': [{ label: '#include "rover.h"', insert: '#include "rover.h"', kind: 'stmt', summary: 'rover.h: ローバーの命令を使えるようにする' }],
    'main': [{ label: 'int main(void) { }', insert: 'int main(void) {\n    ' + CARET + '\n    return 0;\n}', kind: 'stmt', summary: 'main: プログラムはここから始まる' }],
    'printf': [{ label: 'printf("%f\\n", d);', insert: 'printf("%f\\n", d);', kind: 'stmt', summary: 'printf: 文字と数を出す（%f は小数、%d は整数）' }],
    'int': [{ label: 'int n = 0;', insert: 'int n = 0;', kind: 'stmt', summary: 'int: 整数の変数' }],
    'double': [{ label: 'double d = 0.0;', insert: 'double d = 0.0;', kind: 'stmt', summary: 'double: 小数の変数' }],
    'for（C）': [{ label: 'for (int i = 0; i < 4; i++) { }', insert: 'for (int i = 0; i < 4; i++) {\n    ' + CARET + '\n}', kind: 'stmt', summary: 'for: { } の中を決まった回数くり返す' }],
    'void': [{ label: 'void go(double sec) { }', insert: 'void go(double sec) {\n    ' + CARET + '\n}', kind: 'stmt', summary: 'void: 答えを返さない関数' }],
    'while（C）': [{ label: 'while (d > 0.3) { }', insert: 'while (d > 0.3) {\n    ' + CARET + '\n}', kind: 'stmt', summary: 'while: 条件が正しい間 { } の中をくり返す' }],
    '&&': [{ label: '&&', insert: ' && ', kind: 'expr', summary: '&&: 「かつ」（Python の and）' }],
  },
};

/** C の面で使う命令のチップ（rover.h。5.6 節）。 */
const C_API = {
  motor: 'motor(0.5, 0.5);', wait: 'wait(2);', stop: 'stop();', distance_to_cone: 'double d = distance_to_cone();',
  lidar: 'double d = lidar();', heading: 'double h = heading();', now: 'double t = now();', print: null,
};

const isTouch = () => typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches);

/** チップの文が文か式か（命令の palette の文から）。 */
function kindOf(insert) {
  const s = insert.trim();
  if (/:$/.test(s)) return 'block';
  return 'stmt';
}

/**
 * レベルからチップの一覧を作る（data/api.json の palette と、文法のチップ）。
 * @param {object} level 7.7 の Level（lang・equipped・new を見る）
 * @param {object} api data/api.json
 * @param {string[]} learnedNew その面までの new を全部（古い順。W7 が chapters と levels から集める）
 * @returns {{name: string, label: string, insert: string, summary: string, kind: string}[]}
 */
export function paletteItems(level, api, learnedNew) {
  const lang = level && level.lang === 'c' ? 'c' : 'python';
  const fns = (api && api.functions) || {};
  const equipped = Array.isArray(level && level.equipped) && level.equipped.length ? new Set(level.equipped) : null;
  // 今の面の新しいものを先に（1 章の命令ばかりが先に並んで、今使う命令が右で切れていた。帯は折り返す。直し A-15）
  const names = [...((level && level.new) || []), ...(learnedNew || [])];
  const out = [];
  const seen = new Set();
  const push = (it) => { if (!it || seen.has(it.label)) return; seen.add(it.label); out.push(it); };
  for (const n of names) {
    if (n === 'import time' || n === 'time') continue;
    if (fns[n]) {
      if (equipped && !equipped.has(n)) continue;          // 外した命令（4 章からの distance_to_cone など）は出さない
      const f = fns[n];
      let insert = f.palette || f.sig || `${n}()`;
      if (lang === 'c') { insert = C_API[n]; if (!insert) continue; }
      push({ name: n, label: insert, insert, summary: `${f.sig || n} … ${f.summary || ''}`.trim(), kind: kindOf(insert) });
      continue;
    }
    const syn = (SYNTAX[lang] && SYNTAX[lang][n]) || (lang === 'c' ? null : null);
    if (syn) for (const s of syn) push({ name: n, ...s });
  }
  return out;
}

/**
 * パレットの帯を作る。
 * @param {HTMLElement} el
 * @param {{items: {label: string, insert: string, summary: string, kind?: string, name?: string}[], onInsert: (item: object) => void,
 *   onHelp?: (name: string) => void}} opts
 *   onInsert はチップを押した時（エディタの insertSnippet を呼ぶ）。onHelp は右クリック・長押しでずかんへ（無ければ何もしない）
 * @returns {{setItems: (items: object[]) => void, setDisabled: (v: boolean) => void, destroy: () => void, element: HTMLElement}}
 */
export function createPalette(el, opts) {
  const root = document.createElement('div');
  root.className = 'rc-palette';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', '使える命令（押すとコードに入る）');
  const card = document.createElement('div');
  card.className = 'rc-palette-card';
  card.hidden = true;
  card.setAttribute('role', 'status');
  el.appendChild(root);
  el.appendChild(card);
  let items = [];
  let cardTimer = null;
  let disabled = false;

  function showCard(text, anchor) {
    card.textContent = text;
    card.hidden = false;
    const r = anchor.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    card.style.left = Math.max(4, Math.min(host.width - card.offsetWidth - 4, r.left - host.left)) + 'px';
    card.style.top = (r.bottom - host.top + 4) + 'px';
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { card.hidden = true; }, 2500);
  }

  function render() {
    root.textContent = '';
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rc-chip' + (it.kind === 'expr' ? ' is-expr' : '');
      b.textContent = it.label;
      b.title = it.summary || '';
      b.setAttribute('aria-label', `${it.label} を入れる。${it.summary || ''}`);
      b.tabIndex = i === 0 ? 0 : -1;               // 帯の中は ← → で動く（Tab の止まる所は 1 つ）
      b.disabled = disabled;
      // フォーカスをエディタから動かさない（スマホのキーボードを閉じない）
      b.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' || document.activeElement?.closest?.('.CodeMirror')) e.preventDefault(); });
      b.addEventListener('click', () => {
        if (disabled) return;
        opts.onInsert(it);
        if (isTouch() && it.summary) showCard(it.summary, b);
      });
      b.addEventListener('contextmenu', (e) => { if (opts.onHelp && it.name) { e.preventDefault(); opts.onHelp(it.name); } });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const bs = [...root.querySelectorAll('.rc-chip')];
        let j = bs.indexOf(b);
        j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : Math.max(0, Math.min(bs.length - 1, j + (e.key === 'ArrowRight' ? 1 : -1)));
        bs.forEach((x, k) => { x.tabIndex = k === j ? 0 : -1; });
        bs[j].focus();
      });
      root.appendChild(b);
    });
    root.hidden = items.length === 0;
  }

  function setItems(list) { items = Array.isArray(list) ? list.slice() : []; render(); }
  setItems(opts.items);
  return {
    element: root,
    setItems,
    setDisabled(v) { disabled = !!v; root.querySelectorAll('.rc-chip').forEach((b) => { b.disabled = disabled; }); },
    destroy() { clearTimeout(cardTimer); root.remove(); card.remove(); },
  };
}
