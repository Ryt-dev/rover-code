/**
 * @file app/js/runner.js
 * 持ち主: W2（実行エンジン）
 * 役割: 画面側の Worker の管理（本命の Worker・予備の Worker・番犬 3 s・止める・読み込みの %）。画面から Python を走らせる窓口。
 * SPEC: 7.3「W2 js/runner.js」・7.4（メッセージ）・7.5（止め方: 3 段がまえ＋予備の Worker）・7.6（読み込み）・2.2（準備中の実行）
 *
 * 使い方（W7）:
 *   import { Runner } from './runner.js';
 *   Runner.start();                                   // ページを開いたらすぐ（?pyodide= で置き場所を変えられる）
 *   const off = Runner.onState((s) => …);             // s.state: loading | ready | busy | spare_loading | failed
 *   const res = await Runner.run(job, { onProgress }); // RunResult（止めた時は end: 'stopped'、番犬は 'watchdog'、落ちた時は 'fatal'）
 *   Runner.stop();                                    // 計算中なら 0.1 s 以内に止める。準備待ちの実行なら取り消す
 *
 * 決まり（SPEC 7.3・7.5〔1.1〕）:
 * - stop() は予備の準備が終わっていなくてもすぐ terminate。予備が読み込み済みなら入れかえ（1 ms 未満）、無ければ作り直す
 *   （その間 state は loading・restarting: true。押された実行は準備ができてから走る）。
 * - 計算中に run() が呼ばれたら、今の計算を止めて新しいコードで走らせる（前の Promise は end: 'stopped' で返る）。
 * - 予備の Worker は最初の実行が終わってから裏で作る。メモリの少ない端末（navigator.deviceMemory ≤ 2、
 *   読み込みで memory の失敗）では作らない。
 * - 番犬: 計算中に Worker から 3 s 何も届かなければ terminate → 予備と入れかえ → 予備で explain_watchdog → WATCHDOG のカード。
 * - Worker が落ちた（fatal・error・messageerror）時は予備と入れかえて FATAL のカード。生徒のコードと記録は画面側に残る。
 *
 * 状態（onState に渡す物）: {state, pct, stage, reason, message, restarting, pending, run, of, spare: 'none'|'loading'|'ready', sparePct}
 *   state が ready か spare_loading の時は、すぐ実行できる（spare_loading は「予備を裏で準備中」）。
 */

const WATCHDOG_MS = 3000;
const LOAD_TIMEOUT_MS = 62000;

const FATAL_CARD = Object.freeze({
  id: 'FATAL', stage: 'guard', severity: 'error', line: null, col: null, end_col: null,
  title: 'ぼくの中の Python が倒れちゃった', where: 'プログラム全体',
  why: 'ゲームの中の仕組みが止まってしまったよ。きみのコードのせいとは限らないんだ。',
  fix: 'コードはそのまま残っているから、もう一度実行してね。', term: '', raw: '', example: null,
  quickfix: null, zukan: null, speaker: 'rover', confirm: false, more: 0, vars: {},
});
const WATCHDOG_CARD = Object.freeze({
  ...FATAL_CARD, id: 'WATCHDOG', title: '計算が終わらなくて、ぼくは止められちゃったよ', where: '計算が終わらなかったので止めたよ',
  why: 'ぼくの中の計算が 3 秒たっても終わらなかったので、画面が止めたよ。',
  fix: 'とても大きな数の計算や、時間が進まないくり返しが無いか見直そう。',
});

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Runner を作る（ふつうは下の Runner を使う。テストは別の設定で作れる）。
 * @param {object} [cfg]
 * @param {string|URL} [cfg.workerUrl] worker.js の URL（既定は ../worker/worker.js）
 * @param {string} [cfg.pyodide] Pyodide の置き場所（worker の ?pyodide=）
 * @param {boolean} [cfg.spare] 予備を作るか（既定: navigator.deviceMemory ≤ 2 なら作らない）
 * @param {number} [cfg.watchdogMs] 番犬の時間（既定 3000）
 * @param {(url: URL) => Worker} [cfg.makeWorker] Worker の作り方（テスト用）
 */
export function createRunner(cfg = {}) {
  const listeners = new Set();
  let started = false;
  let main = null;        // { w, state: 'loading'|'ready'|'failed', pct, stage, readyMsg, reason }
  let spare = null;
  let lowMemory = false;
  let firstRunDone = false;
  let restarting = false;
  let nextId = 1;
  let current = null;     // 計算中 { id, job, hooks, resolve, lastBeat, startedAt }
  let pending = null;     // 準備待ち { job, hooks, resolve, id }
  const waiters = new Map();   // id → { resolve, worker, timer, type }
  let watchdogTimer = null;
  let readyResolve;
  let readyPromise = new Promise((r) => { readyResolve = r; });
  let lastState = { state: 'loading', pct: 0, stage: 'download', spare: 'none', pending: false, restarting: false };

  const watchdogMs = cfg.watchdogMs ?? WATCHDOG_MS;
  const wantSpare = () => {
    if (cfg.spare === false || lowMemory) return false;
    const dm = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    if (cfg.spare !== true && Number.isFinite(dm) && dm <= 2) return false;
    return true;
  };

  function workerUrl(role) {
    const u = new URL(cfg.workerUrl || new URL('../worker/worker.js', import.meta.url), typeof location !== 'undefined' ? location.href : undefined);
    const py = cfg.pyodide || pageParam('pyodide');
    if (py) u.searchParams.set('pyodide', py);
    u.searchParams.set('role', role);
    return u;
  }

  function makeWorker(role) {
    const url = workerUrl(role);
    const w = cfg.makeWorker ? cfg.makeWorker(url) : new Worker(url, { type: 'module' });
    const slot = { w, role, state: 'loading', pct: 0, stage: 'download', readyMsg: null, reason: null, born: nowMs() };
    slot.loadTimer = setTimeout(() => {
      if (slot.state === 'loading') onLoadFailed(slot, { reason: 'network', message: '60 秒たっても準備が終わらない' });
    }, LOAD_TIMEOUT_MS);
    // loadPyodide の間（70〜95%）は Worker が % を送れないことがある（Python の起動で手が離せない）。
    // 画面に出す % は止まって見えないよう、ここでも少しずつ進める（届いた % より先には 94% までしか行かない）
    slot.creep = setInterval(() => {
      if (slot.state !== 'loading') { clearInterval(slot.creep); return; }
      if (slot.stage === 'init' && slot.pct < 94) {
        slot.pct = Math.min(94, slot.pct + Math.max(0.4, (94 - slot.pct) * 0.05));
        if (slot === main || slot === spare) emit();
      }
    }, 300);
    w.onmessage = (e) => onMessage(slot, e.data || {});
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); onCrash(slot, `Worker のエラー: ${e && e.message || ''}`); };
    w.onmessageerror = () => onCrash(slot, 'メッセージが壊れていた');
    return slot;
  }

  // ---------------------------------------------------------------- 状態
  function emit() {
    const m = main || { state: 'loading', pct: 0, stage: 'download' };
    let state = m.state;
    if (current) state = 'busy';
    else if (m.state === 'ready' && spare && spare.state === 'loading') state = 'spare_loading';
    const s = {
      state, pct: m.state === 'ready' ? 100 : Math.floor(m.pct || 0), stage: m.stage, reason: m.reason || null, message: m.message || null,
      restarting, pending: !!pending,
      spare: spare ? (spare.state === 'ready' ? 'ready' : spare.state === 'failed' ? 'none' : 'loading') : 'none',
      sparePct: spare ? spare.pct : 0,
      run: current ? current.run || 0 : 0, of: current ? current.of || 0 : 0,
    };
    lastState = s;
    for (const cb of listeners) { try { cb(s); } catch { /* 画面の都合 */ } }
  }

  // ---------------------------------------------------------------- メッセージ
  function onMessage(slot, m) {
    switch (m.type) {
      case 'loading':
        slot.pct = Math.max(m.stage === slot.stage ? slot.pct : 0, m.pct); slot.stage = m.stage;
        if (slot === main || slot === spare) emit();
        break;
      case 'ready':
        clearTimeout(slot.loadTimer);
        clearInterval(slot.creep);
        slot.state = 'ready'; slot.pct = 100; slot.readyMsg = m;
        if (slot === main) onMainReady();
        else emit();
        break;
      case 'load_failed':
        onLoadFailed(slot, m);
        break;
      case 'progress':
        if (current && slot === main && m.id === current.id) {
          current.lastBeat = nowMs();
          current.run = m.run; current.of = m.of;
          if (current.hooks && current.hooks.onProgress) { try { current.hooks.onProgress(m); } catch { /* */ } }
          if (m.run !== current.lastRunEmitted) { current.lastRunEmitted = m.run; emit(); }
        }
        break;
      case 'result':
        if (current && slot === main && m.id === current.id) {
          const c = current;
          current = null;
          stopWatchdog();
          firstRunDone = true;
          c.resolve(m.result);
          emit();
          ensureSpare();
          startPending();
        }
        break;
      case 'fatal':
        if (current && slot === main && (m.id === current.id || m.id == null)) onCrash(slot, m.message || 'fatal');
        else resolveWaiter(m.id, null);
        break;
      case 'precheck_result': resolveWaiter(m.id, m.items || []); break;
      case 'quickfix_result': resolveWaiter(m.id, m.code); break;
      case 'extract_defs_result': resolveWaiter(m.id, m.defs || []); break;
      case 'watchdog_card': resolveWaiter(m.id, m.card || null); break;
      case 'guard_card': resolveWaiter(m.id, m.card || null); break;
      default: break;
    }
  }

  function onMainReady() {
    restarting = false;
    readyResolve();
    emit();
    startPending();
    if (!current) setTimeout(ensureSpare, 0);
  }

  function onLoadFailed(slot, m) {
    clearTimeout(slot.loadTimer);
    clearInterval(slot.creep);
    slot.state = 'failed'; slot.reason = m.reason || 'unknown'; slot.message = m.message || '';
    try { slot.w.terminate(); } catch { /* */ }
    if (slot.reason === 'memory') lowMemory = true;
    if (slot === spare) { spare = null; emit(); return; }
    if (slot === main) {
      if (pending) { const p = pending; pending = null; p.resolve(cancelled(p, 'load_failed', slot.reason)); }
      emit();
    }
  }

  function onCrash(slot, message) {
    if (slot === spare) { try { slot.w.terminate(); } catch { /* */ } spare = null; emit(); return; }
    if (slot !== main) return;
    if (main.state === 'loading') { onLoadFailed(slot, { reason: 'unknown', message }); return; }
    const c = current;
    killMain();
    if (c) finishInterrupted(c, 'fatal', message);
    else emit();
  }

  // ---------------------------------------------------------------- 入れかえ
  function killMain() {
    stopWatchdog();
    if (main) { try { main.w.terminate(); } catch { /* */ } clearTimeout(main.loadTimer); }
    for (const [id, wt] of waiters) if (wt.slot === main) { clearTimeout(wt.timer); waiters.delete(id); wt.resolve(null); }
    current = null;
    if (spare && spare.state !== 'failed') {
      main = spare;
      main.role = 'main';
      spare = null;
      restarting = main.state !== 'ready';
    } else {
      main = makeWorker('main');
      restarting = true;
    }
    if (main.state === 'ready') { restarting = false; }
    else readyPromise = new Promise((r) => { readyResolve = r; });
    emit();
    // 予備がまた要る（読み込み済みの本命になった時だけ。作り直し中は CPU を取り合わないよう待つ）
    if (main.state === 'ready') setTimeout(ensureSpare, 0);
  }

  function ensureSpare() {
    if (spare || !firstRunDone || !wantSpare()) return;
    if (!main || main.state !== 'ready') return;
    spare = makeWorker('spare');
    emit();
  }

  /** 止めた・番犬・落ちた実行を返す（Worker は止まっているので記録は無い）。 */
  function finishInterrupted(c, end, message) {
    const base = {
      id: c.id, levelId: c.job.levelId ?? null, mode: c.job.mode || 'worlds', before: [], compileError: null,
      runs: [], judge: null, senpai: [], end, card: null, message: message || null,
      stats: { workerMs: Math.round(nowMs() - c.startedAt), runs: 0 },
    };
    if (end === 'stopped') { c.resolve(base); emit(); return; }
    const fallback = { ...(end === 'watchdog' ? WATCHDOG_CARD : FATAL_CARD) };
    // 予備（今の本命）が読み込み済みなら、そこでカードを作る（番犬は場所を指す。7.5）
    if (main && main.state === 'ready') {
      const msg = end === 'watchdog'
        ? { type: 'explain_watchdog', code: c.job.code || '', chapter: c.job.chapter ?? 1 }
        : { type: 'explain_guard', code: c.job.code || '', reason: 'fatal' };
      request(main, msg, 1500).then((card) => { base.card = card || fallback; c.resolve(base); emit(); });
    } else {
      base.card = fallback;
      c.resolve(base);
      emit();
    }
  }

  // ---------------------------------------------------------------- 番犬
  function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (!current) { stopWatchdog(); return; }
      if (nowMs() - current.lastBeat > watchdogMs) {
        const c = current;
        killMain();
        finishInterrupted(c, 'watchdog');
        startPending();
      }
    }, 100);
  }
  function stopWatchdog() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; } }

  // ---------------------------------------------------------------- 実行
  function startPending() {
    if (!pending || current || !main || main.state !== 'ready') return;
    const p = pending;
    pending = null;
    current = { ...p, lastBeat: nowMs(), startedAt: nowMs(), run: 0, of: (p.job.worlds || []).length };
    main.w.postMessage({ type: 'run', id: p.id, job: p.job });
    startWatchdog();
    emit();
  }

  function cancelled(p, why, reason) {
    return {
      id: p.id, levelId: p.job.levelId ?? null, mode: p.job.mode || 'worlds', before: [], compileError: null, runs: [],
      judge: null, senpai: [], end: 'cancelled', cancelled: true, why, reason: reason || null, stats: { workerMs: 0, runs: 0 },
    };
  }

  function request(slot, msg, timeoutMs = 10000) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(id); resolve(null); }, timeoutMs);
      waiters.set(id, { resolve, timer, slot });
      try { slot.w.postMessage({ ...msg, id }); } catch { clearTimeout(timer); waiters.delete(id); resolve(null); }
    });
  }
  function resolveWaiter(id, value) {
    const wt = waiters.get(id);
    if (!wt) return;
    clearTimeout(wt.timer);
    waiters.delete(id);
    wt.resolve(value);
  }
  /** 検査などの小さな頼みごと: 本命が空いていれば本命、計算中なら予備、どちらも無ければ本命の準備を待つ。 */
  async function ask(msg, timeoutMs) {
    if (!started) api.start();
    if (current && spare && spare.state === 'ready') return request(spare, msg, timeoutMs);
    if (main.state !== 'ready') {
      if (main.state === 'failed') return null;
      await readyPromise;
    }
    return request(main, msg, timeoutMs);
  }

  const api = {
    /** ページを開いたらすぐ呼ぶ（本命の Worker を作り Pyodide を読み始める。7.6）。何度呼んでもよい。 */
    start(opts = {}) {
      Object.assign(cfg, opts);
      if (started) return api;
      started = true;
      main = makeWorker('main');
      emit();
      return api;
    },
    /** 本命の Worker の準備ができたら解決する Promise（作り直した時は新しい Promise）。 */
    get ready() { return readyPromise; },
    /** 今の状態。 */
    get state() { return lastState; },
    /** 準備の時間など（ready のメッセージ）。 */
    get info() { return main && main.readyMsg; },
    /**
     * 状態が変わるたびに呼ばれる関数を登録する（すぐ 1 回、今の状態で呼ぶ）。
     * @param {(s: object) => void} cb
     * @returns {() => void} 登録を外す関数
     */
    onState(cb) {
      listeners.add(cb);
      try { cb(lastState); } catch { /* */ }
      return () => listeners.delete(cb);
    },
    /**
     * 実行する（準備中なら準備ができてから走らせる。計算中なら今の計算を止めて新しいコードで）。
     * @param {import('../worker/engine.js').Job} job
     * @param {{onProgress?: (p: {run: number, of: number, t: number, lines: number}) => void}} [hooks]
     * @returns {Promise<import('../worker/engine.js').RunResult>}
     */
    run(job, hooks = {}) {
      if (!started) api.start();
      if (current) api.stop();
      if (pending) { const p = pending; pending = null; p.resolve(cancelled(p, 'replaced')); }
      if (main.state === 'failed') {
        return Promise.resolve(cancelled({ id: nextId++, job }, 'load_failed', main.reason));
      }
      return new Promise((resolve) => {
        pending = { id: nextId++, job, hooks, resolve };
        emit();
        startPending();
      });
    },
    /** 計算を止める（0.1 s 以内）。準備待ちの実行は取り消す。再生中の扱いは画面側（7.5〔1.1〕）。 */
    stop() {
      if (pending) { const p = pending; pending = null; p.resolve(cancelled(p, 'stopped')); emit(); }
      if (!current) return false;
      const c = current;
      killMain();
      finishInterrupted(c, 'stopped');
      return true;
    },
    /** 準備待ちの実行だけを取り消す（2.2「もう一度押すと取り消し」）。 */
    cancel() {
      if (!pending) return false;
      const p = pending; pending = null; p.resolve(cancelled(p, 'cancelled')); emit();
      return true;
    },
    /** 読み込みに失敗した後の［もう一度］: 本命を作り直す。 */
    retry() {
      if (!started) return api.start();
      if (main && main.state !== 'failed') return api;
      lowMemory = false;
      main = makeWorker('main');
      restarting = true;
      readyPromise = new Promise((r) => { readyResolve = r; });
      emit();
      return api;
    },
    /** 実行前の検査だけ（打っている途中の確かめにも使える）。 */
    async precheck(code, lang = 'python', chapter = 1) {
      return (await ask({ type: 'precheck', code, lang, chapter })) || [];
    },
    /** カードの［半角に直す］など。直せなければ元のコード。 */
    async quickfix(code, ruleId) {
      const r = await ask({ type: 'quickfix', code, ruleId });
      return typeof r === 'string' ? r : code;
    },
    /** 道具箱用に def を取り出す（7.4 extract_defs）。 */
    async extractDefs(code) { return (await ask({ type: 'extract_defs', code })) || []; },
    /** 番犬のあとのカード（ふつうは run の結果に入っているので呼ばなくてよい）。 */
    async explainWatchdog(code, chapter = 1) { return (await ask({ type: 'explain_watchdog', code, chapter }, 3000)) || { ...WATCHDOG_CARD }; },
    /** テスト用: 中の様子 */
    _debug() {
      return {
        main: main && { state: main.state, pct: main.pct, role: main.role }, spare: spare && { state: spare.state, pct: spare.pct },
        busy: !!current, pending: !!pending, lowMemory, firstRunDone,
      };
    },
  };
  return api;
}

function pageParam(name) {
  try { return new URL(location.href).searchParams.get(name); } catch { return null; }
}

/** 画面で使う 1 つの Runner（SPEC 7.3）。 */
export const Runner = createRunner();
