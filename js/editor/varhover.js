/**
 * @file app/js/editor/varhover.js
 * 持ち主: W6（エディタ）
 * 役割: 変数にマウスを乗せると、その時刻の値（「d = 1.84（3.2 s）」）を出す。タッチでは押して出す小さなカード。
 * SPEC: 3.4（今の行の強調・変数の値）・3.11（マウスを乗せる説明は、押して出す小さなカードに）・4 章の 11・6.11 の varLog
 *
 * 決めた形（W6）
 *  - attachVarHover(cm, getValue): 名前から表示の文を返す getValue は Editor.setVarSource で渡す（無ければ何も出さない）。
 *  - makeVarSource(record, getTime): 記録（6.11 の varLog・lineLog）と今の再生の時刻から getValue を作る。W7 は
 *    editor.setVarSource(makeVarSource(record, () => player.t)) とつなぐだけでよい。
 *  - キーボード: カーソルが変数の上で 0.7 s 止まったら、同じカードを出す（マウスが無くても値が見られる）。
 *  - 出すのは「変数」の字句（CodeMirror の variable・variable-2）だけ。g.lat のような属性は記録に無いので出さない。
 */

const fmtT = (t) => (Number.isFinite(t) ? (Math.round(t * 10) / 10).toFixed(1) : '0.0');

/**
 * 記録から「名前 → 表示の文」を作る。
 * @param {{varLog?: [number, string, string][], lineLog?: [number[], number[]]}|null} record 6.11 の RunRecord
 * @param {() => number} getTime 今の再生の時刻（sim の秒）
 * @returns {((name: string) => string|null)|null}
 */
export function makeVarSource(record, getTime) {
  if (!record || !Array.isArray(record.varLog) || !record.varLog.length) return null;
  const times = (record.lineLog && record.lineLog[1]) || [];
  /** @type {Map<string, {t: number, v: string}[]>} */
  const byName = new Map();
  for (const e of record.varLog) {
    if (!Array.isArray(e) || e.length < 3) continue;
    const [idx, name, disp] = e;
    const t = Number.isFinite(times[idx]) ? times[idx] : 0;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ t, v: String(disp) });
  }
  return (name) => {
    const list = byName.get(name);
    if (!list) return null;
    const t = Number(getTime ? getTime() : Infinity);
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t <= t + 1e-9) { ans = m; lo = m + 1; } else hi = m - 1; }
    const tt = Number.isFinite(t) ? t : list[list.length - 1].t;
    if (ans < 0) return `${name} はまだ決まっていない（${fmtT(tt)} s）`;
    return `${name} = ${list[ans].v}（${fmtT(tt)} s）`;
  };
}

/**
 * @param {object} cm CodeMirror
 * @param {(name: string) => string|null} getValue 名前から表示の文（無ければ null）。Editor.setVarSource で渡す
 * @returns {(() => void) & {hide: () => void, showAt: (pos: {line: number, ch: number}) => boolean}} 外す関数
 */
export function attachVarHover(cm, getValue) {
  const wrapper = cm.getWrapperElement();
  const tip = document.createElement('div');
  tip.className = 'rc-var-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  let raf = 0;
  let lastXY = null;
  let hideTimer = null;
  let keyTimer = null;
  let shownFor = null;

  function tokenAtCoords(x, y) {
    const pos = cm.coordsChar({ left: x, top: y }, 'window');
    if (pos.outside) return null;
    const box = cm.charCoords(pos, 'window');
    const tok = cm.getTokenAt({ line: pos.line, ch: pos.ch + 1 }, true);
    if (!tok || tok.start > pos.ch || tok.end <= pos.ch) return null;
    // 文字の上にいるか（行の右の空いた所では出さない）
    const end = cm.charCoords({ line: pos.line, ch: tok.end }, 'window');
    const start = cm.charCoords({ line: pos.line, ch: tok.start }, 'window');
    if (x < start.left - 1 || x > end.left + 1 || y < box.top - 2 || y > box.bottom + 2) return null;
    return { tok, line: pos.line };
  }

  function tokenAtPos(pos) {
    const tok = cm.getTokenAt({ line: pos.line, ch: pos.ch + 1 }, true);
    if (tok && tok.start <= pos.ch && tok.end > pos.ch) return { tok, line: pos.line };
    const tok2 = cm.getTokenAt(pos, true);            // カーソルが名前のすぐ後ろ
    if (tok2 && tok2.end === pos.ch && tok2.start < pos.ch) return { tok: tok2, line: pos.line };
    return null;
  }

  const isVar = (tok) => /\bvariable(-2)?\b/.test(tok.type || '') && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(tok.string);

  function show(hit) {
    if (!hit || !isVar(hit.tok)) { hide(); return false; }
    const text = getValue(hit.tok.string);
    if (!text) { hide(); return false; }
    const key = hit.line + ':' + hit.tok.start;
    tip.textContent = text;
    tip.hidden = false;
    const c = cm.charCoords({ line: hit.line, ch: hit.tok.start }, 'window');
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = Math.max(8, Math.min(vw - w - 8, c.left - 6));
    let top = c.bottom + 6;
    if (top + h > window.innerHeight - 8) top = c.top - h - 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    shownFor = key;
    return true;
  }

  function hide() {
    tip.hidden = true;
    shownFor = null;
    clearTimeout(hideTimer);
  }

  const onMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    lastXY = [e.clientX, e.clientY];
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!lastXY) return;
      show(tokenAtCoords(lastXY[0], lastXY[1]));
    });
  };
  // タッチは指を離すたびに pointerleave が来るので、マウスの時だけ隠す
  const onLeave = (e) => { if (e.pointerType && e.pointerType !== 'mouse') return; lastXY = null; hide(); };
  // タッチ: 押して離した所が変数なら、小さなカードを 3 s 出す
  let down = null;
  const onDown = (e) => { if (e.pointerType !== 'mouse') down = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const onUp = (e) => {
    if (e.pointerType === 'mouse' || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 10) return;
    if (show(tokenAtCoords(e.clientX, e.clientY))) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 3000);
    }
  };
  // キーボード: カーソルが変数の上で止まったら
  const onCursor = () => {
    clearTimeout(keyTimer);
    if (!cm.hasFocus() || cm.somethingSelected()) return;
    keyTimer = setTimeout(() => {
      if (!cm.hasFocus()) return;
      if (show(tokenAtPos(cm.getCursor()))) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 4000); }
    }, 700);
  };
  const onKey = () => { if (shownFor) hide(); };
  const onScroll = () => hide();

  wrapper.addEventListener('pointermove', onMove);
  wrapper.addEventListener('pointerleave', onLeave);
  wrapper.addEventListener('pointerdown', onDown);
  wrapper.addEventListener('pointerup', onUp);
  cm.on('cursorActivity', onCursor);
  cm.on('keydown', onKey);
  cm.on('scroll', onScroll);
  cm.on('blur', hide);

  const detach = () => {
    wrapper.removeEventListener('pointermove', onMove);
    wrapper.removeEventListener('pointerleave', onLeave);
    wrapper.removeEventListener('pointerdown', onDown);
    wrapper.removeEventListener('pointerup', onUp);
    cm.off('cursorActivity', onCursor);
    cm.off('keydown', onKey);
    cm.off('scroll', onScroll);
    cm.off('blur', hide);
    cancelAnimationFrame(raf);
    clearTimeout(keyTimer);
    clearTimeout(hideTimer);
    tip.remove();
  };
  detach.hide = hide;
  detach.showAt = (pos) => show(tokenAtPos(pos));
  detach.element = tip;
  return detach;
}
