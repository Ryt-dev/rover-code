/**
 * @file app/js/ui/deps.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: ほかの単位の部品（W2 runner・W3 error_card・W5 replay・W6 editor・W8 export_sil・W1 validateWorld）を
 *       安全に読む。読めない（途中で文法の誤り）・まだ空の実装（「未実装」で止まる）なら null を返し、画面は W7 の代わりの部品を使う。
 *       相手ができあがれば、ここを変えずにそのまま本物に切りかわる（13.1: 画面の単位は相手が途中でも作り始める）。
 * SPEC: 13.1・13.3 の段 2（つなぐ）・7.3（各単位の公開する形）
 */

/**
 * 関数が段 0 の空の実装（呼ぶと「未実装」で止まる）か。
 * @param {Function} fn @returns {boolean}
 */
export function isStub(fn) {
  if (typeof fn !== 'function') return true;
  // コメントの中の「未実装」で本物を空の実装と取り違えないよう、コメントを除いてから見る（つなぎ込みで W3 のカードが使われていなかった）
  try {
    const src = Function.prototype.toString.call(fn).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
    return /\btodo\(|未実装/.test(src);
  } catch { return true; }
}

async function tryImport(rel) {
  try { return await import(new URL(rel, import.meta.url).href); } catch (e) {
    console.warn(`読めなかった: ${rel}（代わりの部品を使う）`, e && e.message);
    return null;
  }
}

let cache = null;

/**
 * 部品をまとめて読む（1 回だけ）。
 * @returns {Promise<{createEditor: Function|null, loadCodeMirror: Function|null, createHistoryPanel: Function|null, createToolboxPanel: Function|null,
 *   createScene: Function|null, Player: Function|null,
 *   Timeline: Function|null, Graphs: Function|null, createErrorCard: Function|null, buildSilPy: Function|null, downloadSilPy: Function|null,
 *   validateWorld: Function|null}>}
 */
export function loadDeps() {
  if (cache) return cache;
  cache = (async () => {
    const [ed, sc, pl, tl, gr, ec, sil, sim, tb] = await Promise.all([
      tryImport('../editor/editor.js'), tryImport('../replay/scene.js'), tryImport('../replay/player.js'),
      tryImport('../replay/timeline.js'), tryImport('../replay/graphs.js'), tryImport('./error_card.js'),
      tryImport('../export_sil.js'), tryImport('../../worker/sim/sim.js'), tryImport('../editor/toolbox.js'),
    ]);
    const pick = (m, name) => (m && typeof m[name] === 'function' && !isStub(m[name]) ? m[name] : null);
    const pickClass = (m, name, method) => {
      const C = m && m[name];
      if (typeof C !== 'function') return null;
      const p = C.prototype && C.prototype[method];
      return p && !isStub(p) ? C : null;
    };
    return {
      createEditor: pick(ed, 'createEditor'),
      loadCodeMirror: pick(ed, 'loadCodeMirror'),
      createHistoryPanel: pick(tb, 'createHistoryPanel'),
      createToolboxPanel: pick(tb, 'createToolboxPanel'),
      createScene: pick(sc, 'createScene'),
      Player: pickClass(pl, 'Player', 'play'),
      Timeline: pickClass(tl, 'Timeline', 'destroy'),
      Graphs: pickClass(gr, 'Graphs', 'destroy'),
      createErrorCard: pick(ec, 'createErrorCard'),
      buildSilPy: pick(sil, 'buildSilPy'),
      downloadSilPy: pick(sil, 'downloadSilPy'),
      validateWorld: pick(sim, 'validateWorld'),
    };
  })();
  return cache;
}

/** テスト用: 読み直す。 */
export function _resetDeps() { cache = null; }
