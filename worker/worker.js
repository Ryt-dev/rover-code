/**
 * @file app/worker/worker.js
 * 持ち主: W2（実行エンジン）
 * 役割: ブラウザの Web Worker（type: 'module'）。Pyodide を読み込み、engine.js で実行して画面へ返す。
 * SPEC: 7.4（メッセージ）・7.5（上限）・7.6（読み込みの順番・% の出し方・失敗の見分け）
 * 元にしたもの: spike/worker.js
 *
 * 画面 → Worker:  run（job）・precheck・quickfix・extract_defs・explain_watchdog（・explain_guard: 画面側で止めた時のカード）
 * Worker → 画面:  loading {pct, stage: download|init|runtime}・ready・load_failed {reason: network|blocked|no_wasm|memory|unknown}
 *                 progress（0.1 s ごと）・result（frames.buffer は Transferable）・precheck_result・quickfix_result
 *                 extract_defs_result・watchdog_card・guard_card・fatal
 * % の出し方（7.6）: 0〜70% は pyodide.asm.wasm と python_stdlib.zip を fetch したバイト数、70〜95% は loadPyodide
 *                    （進み具合を出さないので、止まって見えないよう少しずつ進める）、95〜100% は rover_runtime.py・
 *                    error_explain.py・ルールの読み込みと空の実行での温め。
 * URL の ?pyodide=… で Pyodide の置き場所を変えられる（売る版は vendor/、テストは npm の pyodide）。?role=spare は予備。
 */

import { createEngine } from './engine.js';

export const DEFAULT_PYODIDE = '../vendor/pyodide/';
/** 届いたバイト数の割合に使う大きさ（展開した後。Content-Length は圧縮した大きさのことがあるので使わない）。 */
export const KNOWN_SIZES = Object.freeze({ 'pyodide.asm.wasm': 10088051, 'python_stdlib.zip': 2341872 });
export const LOAD_TIMEOUT_MS = 60000;

/**
 * 読み込みの失敗の理由を決める（7.6〔1.1〕）。
 * @param {*} err 起きたこと
 * @param {{timedOut?: boolean, hasWasm?: boolean, online?: boolean, crossOrigin?: boolean, ownOriginOk?: boolean, httpStatus?: number, phase?: string}} ctx
 * @returns {'network'|'blocked'|'no_wasm'|'memory'|'unknown'}
 */
export function classifyLoadError(err, ctx = {}) {
  if (ctx.hasWasm === false) return 'no_wasm';
  if (ctx.timedOut) return 'network';
  const msg = String((err && (err.message || err)) || '');
  const name = err && err.name;
  if (name === 'RangeError' || /out of memory|Out of memory|Cannot allocate|could not allocate|Memory\(\)|WebAssembly\.Memory|memory access out of bounds|Maximum memory/i.test(msg)) {
    return 'memory';
  }
  if (/WebAssembly is not defined|WebAssembly.*not supported|no_wasm/i.test(msg)) return 'no_wasm';
  const netLike = name === 'TypeError' && /fetch|network|Failed|Load failed|NetworkError/i.test(msg);
  const httpErr = Number.isFinite(ctx.httpStatus) && ctx.httpStatus >= 400;
  if (netLike || httpErr || ctx.phase === 'download') {
    if (ctx.online === false) return 'network';
    if (ctx.crossOrigin && ctx.ownOriginOk) return 'blocked';
    if (httpErr && (ctx.httpStatus === 403 || ctx.httpStatus === 451)) return 'blocked';
    return 'network';
  }
  return 'unknown';
}

class LoadError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/**
 * fetch して届いたバイト数を数える。
 * @returns {Promise<Uint8Array>}
 */
async function fetchCounted(fetchImpl, url, onBytes) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new LoadError(String(e && e.message || e), { name: e && e.name || 'TypeError', phase: 'download', url });
  }
  if (!res.ok) throw new LoadError(`HTTP ${res.status} ${url}`, { name: 'HTTPError', httpStatus: res.status, phase: 'download', url });
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (e) {
      throw new LoadError(String(e && e.message || e), { name: e && e.name || 'TypeError', phase: 'download', url });
    }
    if (r.done) break;
    chunks.push(r.value);
    n += r.value.length;
    onBytes(r.value.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Pyodide を読み込んでエンジンを作る（% を送りながら）。Node のテストからも呼べるように、外の物は deps で受ける。
 * @param {object} deps
 * @param {string} deps.base Pyodide の置き場所（末尾 /）
 * @param {string|URL} deps.appBase app/worker/ の場所（Python と data を読む）
 * @param {(msg: object) => void} deps.post 画面へ送る
 * @param {Function} [deps.fetchImpl] @param {Function} [deps.importPyodide] (url) => モジュール（loadPyodide を持つ）
 * @param {boolean} [deps.hasWasm] @param {number} [deps.timeoutMs] @param {boolean} [deps.stdlibBlob] stdlib を Blob で渡す
 * @param {object} [deps.engineOptions] createEngine に足すもの（テスト用の Sim など）
 * @returns {Promise<{engine: object, pyodide: object}>}
 */
export async function boot(deps) {
  const base = deps.base;
  const post = deps.post;
  const fetchImpl = deps.fetchImpl || ((u, o) => fetch(u, o));
  const t0 = nowMs();
  const hasWasm = deps.hasWasm ?? (typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function');
  const timeoutMs = deps.timeoutMs ?? LOAD_TIMEOUT_MS;
  let lastPct = -1;
  let lastPost = 0;
  let stage = 'download';
  const send = (pct, st, force = false) => {
    pct = Math.max(lastPct, Math.min(100, Math.floor(pct)));
    const tNow = nowMs();
    if (!force && pct === lastPct && st === stage) return;
    if (!force && pct - lastPct < 1 && tNow - lastPost < 100 && st === stage) return;
    lastPct = pct; lastPost = tNow; stage = st;
    post({ type: 'loading', pct, stage: st });
  };
  if (!hasWasm) throw new LoadError('WebAssembly が無い', { reason: 'no_wasm' });
  send(0, 'download', true);

  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new LoadError('60 秒たっても準備が終わらない', { timedOut: true })), timeoutMs);
  });
  let creep = null;
  try {
    const work = (async () => {
      // 0〜70%: wasm と標準ライブラリを取る
      const total = KNOWN_SIZES['pyodide.asm.wasm'] + KNOWN_SIZES['python_stdlib.zip'];
      let got = 0;
      const onBytes = (n) => { got += n; send(Math.min(70, (got / total) * 70), 'download'); };
      const [, stdlib] = await Promise.all([
        fetchCounted(fetchImpl, base + 'pyodide.asm.wasm', onBytes),
        fetchCounted(fetchImpl, base + 'python_stdlib.zip', onBytes),
      ]);
      send(70, 'init', true);
      const tDown = nowMs();
      // 70〜95%: loadPyodide（進み具合を出さないので、少しずつ 94% へ近づける）
      let pct = 70;
      creep = setInterval(() => { pct += (94 - pct) * 0.06; send(pct, 'init'); }, 250);
      const mod = deps.importPyodide ? await deps.importPyodide(base + 'pyodide.mjs') : await import(/* @vite-ignore */ base + 'pyodide.mjs');
      send(Math.max(pct, 74), 'init');
      const opts = { indexURL: base };
      if (deps.stdlibBlob !== false && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
        opts.stdLibURL = URL.createObjectURL(new Blob([stdlib], { type: 'application/zip' }));
      }
      const pyodide = await mod.loadPyodide(opts);
      if (opts.stdLibURL) { try { URL.revokeObjectURL(opts.stdLibURL); } catch { /* */ } }
      clearInterval(creep); creep = null;
      send(95, 'runtime', true);
      const tPy = nowMs();
      // 95〜100%: Python のファイルとルール
      const app = new URL(deps.appBase);
      const text = async (rel) => {
        const res = await fetchImpl(new URL(rel, app).href);
        if (!res.ok) throw new LoadError(`HTTP ${res.status} ${rel}`, { name: 'HTTPError', httpStatus: res.status, phase: 'runtime' });
        return res.text();
      };
      const optional = async (rel) => { try { return await text(rel); } catch { return ''; } };
      const [rover_runtime, judge, error_explain, c_subset, rules, api] = await Promise.all([
        text('py/rover_runtime.py'), text('py/judge.py'), optional('py/error_explain.py'), optional('py/c_subset.py'),
        optional('../data/error_rules.json'), optional('../data/api.json'),
      ]);
      send(97, 'runtime');
      const engine = await createEngine(pyodide, {
        sources: { rover_runtime, judge, error_explain, c_subset }, rules: rules || null, api: api || '{}',
        ...(deps.engineOptions || {}),
      });
      send(99, 'runtime');
      // 最初の 1 回は遅いので、空の実行で温めておく
      const tW = nowMs();
      try { engine.run(WARMUP_JOB); } catch { /* 温めの失敗は無視（本番の実行で分かる） */ }
      const tEnd = nowMs();
      send(100, 'runtime', true);
      let heapMB = null;
      try { heapMB = Math.round(pyodide._module.HEAP8.length / 1048576); } catch { /* */ }
      return {
        engine, pyodide,
        ready: {
          type: 'ready', python: engine.info.python, heapMB, explainer: engine.info.explainer,
          ms: { download: round(tDown - t0), loadPyodide: round(tPy - tDown), runtime: round(tW - tPy), warmup: round(tEnd - tW), total: round(tEnd - t0) },
        },
      };
    })();
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (creep) clearInterval(creep);
  }
}

const WARMUP_JOB = Object.freeze({
  id: 0, levelId: 'warmup', chapter: 1, lang: 'python', code: 'motor(0, 0)\nwait(0.1)\nstop()\n', mode: 'free',
  worlds: [{ name: '温め', world: { start: { x: 0, y: 0, heading: 0 }, time_limit: 5, objects: [] }, inject: {}, judge: {} }],
  conditions: null, ui: {}, equipped: null, varWatch: true, keepFrames: 'none',
});

function nowMs() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
function round(x) { return Math.round(x); }

/**
 * 画面からのメッセージ（7.4）を受けて返す関数を作る（Worker の本体と Node のテストで同じものを使う）。
 * @param {object} engine createEngine の結果
 * @param {(msg: object, transfer?: Transferable[]) => void} post
 * @returns {(m: object) => void}
 */
export function makeHandler(engine, post) {
  return (m) => {
    const id = m.id ?? null;
    try {
      switch (m.type) {
        case 'run': {
          const w0 = nowMs();
          const result = engine.run(m.job || {}, {
            onProgress: (p) => post({ type: 'progress', id, run: p.run, of: p.of, t: p.t, lines: p.lines, group: p.group }),
          });
          result.id = id;
          result.stats.workerMs = Math.round(nowMs() - w0);
          const transfer = [];
          for (const r of [...(result.runs || []), ...(result.worldRuns || [])]) {
            if (r.frames && r.frames.buffer && !transfer.includes(r.frames.buffer)) transfer.push(r.frames.buffer);
          }
          post({ type: 'result', id, result }, transfer);
          break;
        }
        case 'precheck':
          post({ type: 'precheck_result', id, items: engine.precheck(m.code || '', m.lang || 'python', m.chapter ?? 1) });
          break;
        case 'quickfix':
          post({ type: 'quickfix_result', id, code: engine.quickfix(m.code || '', m.ruleId || '') });
          break;
        case 'extract_defs':
          post({ type: 'extract_defs_result', id, defs: engine.extractDefs(m.code || '') });
          break;
        case 'explain_watchdog':
          post({ type: 'watchdog_card', id, card: engine.explainWatchdog(m.code || '', m.chapter ?? 1) });
          break;
        case 'explain_guard':
          post({ type: 'guard_card', id, card: engine.explainGuard(m.code || '', m.reason || 'fatal') });
          break;
        default:
          break;
      }
    } catch (e) {
      // Python の外で落ちた（JS のスタックあふれ・Pyodide の致命的なエラーなど）
      post({ type: 'fatal', id, message: String(e && (e.stack || e.message) || e).slice(0, 2000) });
    }
  };
}

// ------------------------------------------------------------------ Worker の本体
const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

if (IN_WORKER) {
  const self_url = new URL(import.meta.url);   // ?pyodide=・?role= はこのファイルの URL に付ける
  const qs = self_url.searchParams;
  const base = (() => {
    const b = qs.get('pyodide') || DEFAULT_PYODIDE;
    return new URL(b.endsWith('/') ? b : b + '/', self_url.href).href;
  })();
  const role = qs.get('role') || 'main';
  const appBase = new URL('./', import.meta.url).href;
  const post = (m, transfer) => self.postMessage(m, transfer || []);
  let engine = null;
  let handler = null;
  let failed = null;
  const queue = [];

  const enginePromise = boot({ base, appBase, post }).then((r) => {
    engine = r.engine;
    handler = makeHandler(engine, post);
    post({ ...r.ready, role });
    return engine;
  }).catch(async (err) => {
    const crossOrigin = new URL(base).origin !== self_url.origin;
    let ownOriginOk = false;
    if (crossOrigin && !err.timedOut && err.reason !== 'no_wasm') {
      try { ownOriginOk = (await fetch(new URL('../data/api.json', appBase).href, { cache: 'no-store' })).ok; } catch { ownOriginOk = false; }
    }
    const reason = err.reason || classifyLoadError(err, {
      timedOut: !!err.timedOut, online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      crossOrigin, ownOriginOk, httpStatus: err.httpStatus, phase: err.phase,
    });
    failed = { reason, message: String(err && err.message || err) };
    post({ type: 'load_failed', reason, message: failed.message, role });
    return null;
  });

  const handle = (m) => {
    if (!engine) {
      post({ type: 'fatal', id: m.id ?? null, message: failed ? `準備できなかった（${failed.reason}）` : '準備ができていない' });
      return;
    }
    handler(m);
  };
  self.onmessage = (e) => {
    const m = e.data || {};
    if (engine || failed) { handle(m); return; }
    queue.push(m);
    if (queue.length === 1) enginePromise.then(() => { while (queue.length) handle(queue.shift()); });
  };
}
