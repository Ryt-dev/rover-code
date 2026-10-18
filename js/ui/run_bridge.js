/**
 * @file app/js/ui/run_bridge.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 画面と W2 の Runner（js/runner.js）の間。読み込みの % と「準備中に押された実行」の待ち・取り消し、
 *       遅い回線（15 s）と失敗（60 s・load_failed）の見分けを、画面が使いやすい 1 つの状態にまとめる。
 * SPEC: 2.2（はじめての 5 分・うまくいかない時の台本）・7.3「W2 js/runner.js」・7.6（読み込み・失敗の見分け）
 *
 * 状態（onState で届く）:
 *   { state: 'loading', pct, slow }   準備中（slow は 15 s たっても 100% にならない時 true）
 *   { state: 'ready' }                実行できる
 *   { state: 'busy' }                 計算中
 *   { state: 'respawn', pct }         ■ 止める の後で作り直している（予備が無い端末）
 *   { state: 'failed', reason }       network | blocked | no_wasm | memory | unknown（60 s たっても終わらない時は network）
 * 待ち（queue）: 準備中に実行が押されたら job を預かり、ready になったらすぐ走らせる。もう一度押すと取り消す（cancelQueued）。
 */

import { isStub } from './deps.js';

export const SLOW_MS = 15000;
export const FAIL_MS = 60000;

/**
 * @param {object|null} runnerMod js/runner.js のモジュール（読めなければ null）
 * @param {{now?: () => number, setTimer?: (fn: Function, ms: number) => any, clearTimer?: (h: any) => void, slowMs?: number, failMs?: number}} [o]
 *   slowMs・failMs はテストで時計を早める時だけ変える（既定 15 s・60 s）
 */
export function createBridge(runnerMod, { now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h), slowMs = SLOW_MS, failMs = FAIL_MS } = {}) {
  const R = runnerMod && runnerMod.Runner;
  const usable = !!R && !isStub(R.start) && !isStub(R.run);
  let st = { state: 'loading', pct: 0, slow: false };
  const fns = new Set();
  let started = 0;
  let slowT = null;
  let failT = null;
  let queued = null;     // { job, hooks, resolve, reject }

  const emit = () => { for (const f of [...fns]) { try { f({ ...st }); } catch (e) { console.error(e); } } };
  function set(s) {
    const prev = st.state;
    st = { ...s, slow: s.state === 'loading' ? !!(s.slow || (started && now() - started >= slowMs)) : false };
    emit();
    if (st.state === 'ready' && prev !== 'ready') runQueued();
    if (st.state === 'failed' && queued) { const q = queued; queued = null; q.reject(Object.assign(new Error('load_failed'), { reason: st.reason })); }
  }
  function armTimers() {
    clearTimers();
    slowT = setTimer(() => { if (st.state === 'loading') set({ ...st, slow: true }); }, slowMs);
    failT = setTimer(() => { if (st.state === 'loading') set({ state: 'failed', reason: 'network' }); }, failMs);
  }
  function clearTimers() { if (slowT) clearTimer(slowT); if (failT) clearTimer(failT); slowT = failT = null; }

  function mapState(s) {
    if (!s || typeof s !== 'object') return;
    switch (s.state) {
      case 'loading': set({ state: 'loading', pct: Math.max(0, Math.min(100, Math.round(s.pct || 0))), stage: s.stage }); break;
      case 'ready': clearTimers(); set({ state: 'ready' }); break;
      case 'busy': set({ state: 'busy' }); break;
      case 'spare_loading': if (st.state !== 'busy') set({ state: 'ready', spare: true }); break;
      case 'respawn': set({ state: 'respawn', pct: Math.round(s.pct || 0) }); break;
      case 'failed': clearTimers(); set({ state: 'failed', reason: s.reason || 'unknown' }); break;
      default: break;
    }
  }

  async function runQueued() {
    if (!queued) return;
    const q = queued;
    queued = null;
    try { q.resolve(await api.run(q.job, q.hooks)); } catch (e) { q.reject(e); }
  }

  const api = {
    usable,
    get state() { return { ...st }; },
    onState(cb) { fns.add(cb); cb({ ...st }); return () => fns.delete(cb); },
    /** ページを開いたらすぐ呼ぶ（7.6）。 */
    start() {
      started = now();
      armTimers();
      if (!usable) {
        // W2 の Runner がまだ空の実装: 準備中のまま（60 s で失敗のカード）
        return;
      }
      try {
        if (!isStub(R.onState)) R.onState(mapState);
        R.start();
        if (R.ready && typeof R.ready.then === 'function') R.ready.then(() => { clearTimers(); if (st.state === 'loading') set({ state: 'ready' }); }, () => {});
      } catch (e) {
        console.warn('Runner.start で止まった', e);
        set({ state: 'failed', reason: 'unknown' });
      }
    },
    /** ［もう一度］: 作り直す。 */
    retry() {
      set({ state: 'loading', pct: 0 });
      started = now();
      armTimers();
      if (!usable) return;
      try { R.start(); } catch (e) { set({ state: 'failed', reason: 'unknown' }); }
    },
    /** 実行（ready の時だけ。それ以外は queue を使う）。 */
    async run(job, hooks) {
      if (!usable) throw Object.assign(new Error('runner_unavailable'), { reason: 'unknown' });
      return R.run(job, hooks);
    },
    /** 準備中に押された実行を預かる。ready になったら走らせる。 @returns {Promise<object>} */
    queue(job, hooks) {
      if (queued) queued.reject(Object.assign(new Error('replaced'), { cancelled: true }));
      return new Promise((resolve, reject) => { queued = { job, hooks, resolve, reject }; if (st.state === 'ready') runQueued(); });
    },
    /** 預かった実行を取り消す（もう一度押した時）。 @returns {boolean} 取り消したか */
    cancelQueued() {
      if (!queued) return false;
      const q = queued;
      queued = null;
      q.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      return true;
    },
    hasQueued() { return !!queued; },
    stop() { if (usable && !isStub(R.stop)) { try { R.stop(); } catch (e) { console.warn(e); } } },
    async precheck(code, lang, chapter) {
      if (!usable || isStub(R.precheck) || st.state !== 'ready') return [];
      try { return (await R.precheck(code, lang, chapter)) || []; } catch { return []; }
    },
    async quickfix(code, ruleId) {
      if (!usable || isStub(R.quickfix)) return null;
      try { return await R.quickfix(code, ruleId); } catch { return null; }
    },
    async extractDefs(code) {
      if (!usable || isStub(R.extractDefs)) return null;
      try { return await R.extractDefs(code); } catch { return null; }
    },
    /** テスト用: 状態を外から入れる。 */
    _set: mapState,
  };
  return api;
}
