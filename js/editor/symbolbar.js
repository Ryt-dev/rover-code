/**
 * @file app/js/editor/symbolbar.js
 * 持ち主: W6（エディタ）
 * 役割: 記号バー（タッチ端末だけ）: ( ) : , " # = [ ] _ . と motor wait if for while をタップで入れる帯。
 * SPEC: 3.4「記号バー」・3.11・13.2 W6 ④⑥
 *
 * 決めた形（W6）
 *  - 帯は position: fixed。〔1.1〕visualViewport の高さに合わせて、画面のキーボードのすぐ上に付ける
 *    （iPad・iPhone はキーボードが出ても layout viewport が縮まないので、top = vv.offsetTop + vv.height − 帯の高さ）。
 *    キーボードが無い時は画面の下。帯の高さは CSS 変数 --rc-symbolbar-h（:root）に書く（W7 が下の余白に使える）。
 *  - 出すのはタッチ端末（pointer: coarse か hover: none）で、エディタにフォーカスがある間だけ（opts.always で常に）。
 *    ボタンは pointerdown を止めてフォーカスをエディタに残す（押してもキーボードが閉じない）。
 *  - 記号は 1 文字ずつ入れる（キーボードと同じ）。言葉は「motor(」「wait(」「if 」「for 」「while 」を入れる。
 *  - エディタのカーソルが帯に隠れないように、CodeMirror の cursorScrollMargin を帯の高さにする。
 */

export const SYMBOLS = ['(', ')', ':', ',', '"', '#', '=', '[', ']', '_', '.'];
export const WORDS = [
  { label: 'motor', insert: 'motor(' }, { label: 'wait', insert: 'wait(' },
  { label: 'if', insert: 'if ' }, { label: 'for', insert: 'for ' }, { label: 'while', insert: 'while ' },
];

/** タッチ端末か（記号バーを出すか）。 */
export function isTouchDevice() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches || (matchMedia('(hover: none)').matches && (navigator.maxTouchPoints || 0) > 0);
}

/**
 * @param {HTMLElement} el 帯を入れる要素（無ければ document.body）
 * @param {{insertText: (text: string) => void, getCM?: () => object, hasFocus?: () => boolean}} editor
 * @param {{always?: boolean, viewport?: object, force?: boolean}} [opts]
 *   always はフォーカスに関係なく出す、force はタッチ端末でなくても使う（テスト用）、viewport は visualViewport の代わり（テスト用）
 * @returns {{show: () => void, hide: () => void, place: () => void, destroy: () => void, element: HTMLElement, isVisible: () => boolean}}
 */
export function createSymbolBar(el, editor, opts = {}) {
  const host = el || document.body;
  const bar = document.createElement('div');
  bar.className = 'rc-symbolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '記号を入れる');
  bar.hidden = true;
  const row = document.createElement('div');
  row.className = 'rc-symbolbar-row';
  const mk = (label, insert, cls, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rc-sym ' + cls;
    b.textContent = label;
    b.setAttribute('aria-label', aria || `${label} を入れる`);
    b.addEventListener('pointerdown', (e) => e.preventDefault());       // フォーカスをエディタに残す
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => editor.insertText(insert));
    row.appendChild(b);
  };
  const names = { '(': 'かっこ（ひらく）', ')': 'かっこ（とじる）', ':': 'コロン', ',': 'カンマ', '"': 'ダブルクォート', '#': 'シャープ（コメント）',
    '=': 'イコール', '[': '角かっこ（ひらく）', ']': '角かっこ（とじる）', '_': 'アンダーバー', '.': 'ピリオド' };
  for (const s of SYMBOLS) mk(s, s, 'is-sym', `${names[s] || s} を入れる`);
  for (const w of WORDS) mk(w.label, w.insert, 'is-word', `${w.label} を入れる`);
  bar.appendChild(row);
  host.appendChild(bar);

  const enabled = opts.force || isTouchDevice();
  let visible = false;
  let blurTimer = null;
  const vv = opts.viewport || (typeof window !== 'undefined' ? window.visualViewport : null);

  function place() {
    if (!visible) return;
    const h = bar.offsetHeight;
    if (vv && Number.isFinite(vv.height)) {
      const top = (vv.offsetTop || 0) + vv.height - h;
      bar.style.top = Math.round(top) + 'px';
      bar.style.bottom = 'auto';
      bar.style.left = Math.round(vv.offsetLeft || 0) + 'px';
      bar.style.width = Math.round(vv.width) + 'px';
      const kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
      bar.classList.toggle('is-over-keyboard', kb > 80);
    } else {
      bar.style.top = 'auto';
      bar.style.bottom = '0px';
    }
    document.documentElement.style.setProperty('--rc-symbolbar-h', h + 'px');
    const cm = editor.getCM && editor.getCM();
    if (cm) cm.setOption('cursorScrollMargin', h + 8);
  }

  function show() {
    if (!enabled) return;
    clearTimeout(blurTimer);
    if (visible) { place(); return; }
    visible = true;
    bar.hidden = false;
    place();
  }
  function hide() {
    if (!visible) return;
    visible = false;
    bar.hidden = true;
    document.documentElement.style.setProperty('--rc-symbolbar-h', '0px');
    const cm = editor.getCM && editor.getCM();
    if (cm) cm.setOption('cursorScrollMargin', 0);
  }

  const onVV = () => place();
  if (vv && vv.addEventListener) { vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV); }
  window.addEventListener('resize', onVV);
  window.addEventListener('orientationchange', onVV);

  // エディタのフォーカスに合わせて出す
  const cm = editor.getCM && editor.getCM();
  const onFocus = () => show();
  const onBlur = () => { if (opts.always) return; clearTimeout(blurTimer); blurTimer = setTimeout(hide, 250); };
  if (cm && enabled) { cm.on('focus', onFocus); cm.on('blur', onBlur); }
  if (opts.always && enabled) show();

  return {
    element: bar,
    show, hide, place,
    isVisible: () => visible,
    destroy() {
      clearTimeout(blurTimer);
      if (vv && vv.removeEventListener) { vv.removeEventListener('resize', onVV); vv.removeEventListener('scroll', onVV); }
      window.removeEventListener('resize', onVV);
      window.removeEventListener('orientationchange', onVV);
      if (cm) { cm.off('focus', onFocus); cm.off('blur', onBlur); }
      document.documentElement.style.setProperty('--rc-symbolbar-h', '0px');
      bar.remove();
    },
  };
}
