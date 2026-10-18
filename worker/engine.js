/**
 * @file app/worker/engine.js
 * 持ち主: W2（実行エンジン）
 * 役割: Pyodide と sim（W1）と判定（judge.py・metrics.js）とエラー説明（W3）をつなぐ。
 *       Node（tests/*.mjs）と Worker（worker.js）の両方で同じものを使う。run は同期。
 * SPEC: 7.1（全体の図）・7.3「W2 worker/engine.js」・7.4（job と RunResult）・7.5（上限）・6.9（種）・6.11（RunRecord）
 * 元にしたもの: spike/engine.js
 *
 * 下の @typedef は画面の単位（W5・W6・W7）も使う共通の形（SPEC 7.4・6.11・9.3）。変える時は SPEC を先に直す。
 * SPEC に無い細部で W2 が決めたこと（progress/W2.md の「ほかの単位への連絡」にも書いた）:
 *  - 本番テスト（mode "test"）の job は、ふつうの世界を job.worlds に、本番テストの回を job.testWorlds に入れる。
 *    ふつうの世界をクリアした時だけ本番テストに進む（2.4 節 8）。testWorlds が無ければ worlds を本番テストの回として走らせる。
 *    結果: runs = 本番テストの回、worldRuns = ふつうの世界。クリアしなければ runs = ふつうの世界・testSkipped = true。
 *  - 本番テスト全体の 60 s を超えたら、そこまでの回で結果を出す（testCut = {done, of, card}）。
 *  - frames を返さない回（keepFrames）は frames = null・framesDropped = true（同じ種で走らせ直せば同じ記録になる）。
 *  - 種が job に無い時は hash32(面 + ":" + 世界の番号) ／ hash32(面 + ":t" + 回の番号)、GNSS は hash32(… + ":gnss")（6.9）。
 *  - now() の 0.001 s は sim.now(line) があればそれ、無ければ sim.wait(COST.now, line, 'now') で進める（W1 と決めた）。
 */

import * as SimModule from './sim/sim.js';
import * as RngModule from './sim/rng.js';
import { makeMetrics } from './metrics.js';
import * as ReplayExplain from './replay_explain.js';

/**
 * @typedef {object} Job 画面 → Worker の run の job（SPEC 7.4）
 * @property {string} levelId 例 "1-3"
 * @property {number|string} chapter 1〜10 か "C"
 * @property {'python'|'c'} lang
 * @property {string} code 生徒のコード
 * @property {'worlds'|'test'|'free'} mode ふつうの実行・本番テスト・自由走行場
 * @property {{name: string, world: object, inject: object, judge: object, seed?: number}[]} worlds
 * @property {{name: string, world: object, inject: object, judge: object, seed?: number}[]} [testWorlds] 本番テストの回（W2 の決め）
 * @property {{clear: object[], stars: object[], show: object, steps?: object[]}|null} conditions free では null（7.7）
 * @property {{predictionOk?: boolean, attempt?: number}} ui 画面から来る値（6.12 の prediction_ok・attempt）
 * @property {string[]} equipped 使える命令（5.4）
 * @property {{lineLimit: number, wallLimitS: number, printCap: number, logCap: number, eventCap: number, testWallS?: number}} limits
 * @property {number} tailS 終わった後の惰性 s（6.1）
 * @property {'all'|'first_failed'|'none'} keepFrames 本番テストで frames を返す回
 * @property {{goal: string, goalRadius: number, expectTurn: number|null}} explain 先輩のひとことの見分け方（9.4）
 * @property {boolean} varWatch 変数の値を記録するか
 * @property {object[]} [mistakes] レベルの mistakes（先輩のひとことで面の言葉を使う時。無くてよい）
 */

/**
 * @typedef {object} Card エラー・注意のカード（SPEC 9.3。error_explain.py の Diag と同じ形）
 * @property {string} id ルールの ID（FW_PAREN など）
 * @property {string} stage precheck | compile | compile_warning | lint | api | runtime | guard | fallback
 * @property {string} severity error | warn | info
 * @property {number|null} line @property {number|null} col @property {number|null} end_col
 * @property {string} title @property {string} where @property {string} why @property {string} fix
 * @property {object|null} term @property {string|null} raw 本物のエラー文
 * @property {{bad: string, good: string}|null} example
 * @property {object|null} quickfix @property {string|null} zukan @property {object|null} more
 */

/** @typedef {{id: string, say: string, t?: number, line?: number, vars?: object}} Hint 先輩のひとこと（SPEC 9.4） */

/**
 * @typedef {object} RunRecord 1 つの世界の 1 回の走行の記録（SPEC 6.11）
 * @property {number} world @property {string} name @property {number} seed @property {boolean} [test]
 * @property {'end'|'exit'|'error'|'loop'|'wall'|'busy'|'timeup'|'stopped'|'watchdog'|'fatal'} end
 *   wall = sim の時刻が進まないまま 8 s（重い計算）・busy = 1 回が実時間の安全の上限（PC が混んでいた。直し係 4）
 * @property {Card|null} error @property {string|null} [errorType] @property {Card|null} guard
 * @property {{card: Card, t: number, line: number}[]} warnings
 * @property {number} programEndT
 * @property {string[]} fields @property {Float32Array|null} frames @property {object[]} events
 * @property {Array<[number, number, number, string]>} segments
 * @property {Array<[number, number, string]>} prints @property {number} printDropped
 * @property {number[]} hits @property {[number[], number[]]} lineLog @property {number} lineCount
 * @property {Array<[number, string, string]>} varLog @property {Array<[number, string]>} phases
 * @property {Object<string, number>} calls @property {Array<Array<number|boolean>>} gnssFixes
 * @property {object} final @property {Object<string, number>} metrics @property {object} stats
 */

/**
 * @typedef {object} RunResult Worker → 画面の result（SPEC 7.4）
 * @property {number} id @property {string} levelId @property {string} mode
 * @property {Card[]} before 実行前の注意（止めない。2 つまで）
 * @property {Card|null} compileError 書き方のエラー（このときは runs が空）
 * @property {RunRecord[]} runs 世界ごと（本番テストは回ごと）
 * @property {RunRecord[]} [worldRuns] 本番テストの時のふつうの世界
 * @property {object|null} judge clear・stars・show・steps（judge.py）
 * @property {Hint[]} senpai 先輩のひとこと（失敗したとき）
 * @property {boolean} [testSkipped] 本番テストの前のふつうの世界をクリアしなかった
 * @property {{done: number, of: number, card: Card}|null} [testCut] 本番テスト全体の 180 s で切った
 * @property {{world: number, test: boolean, name: string, card: Card}|null} [busy] PC が混んでいて 1 回が実時間の安全の上限に
 *   来たので止めた（judge は null。画面は「もう一度」と出し、回数・★に数えない。直し係 4）
 * @property {{workerMs: number, runs: number}} stats
 */

/**
 * @typedef {object} Engine
 * @property {(job: Job, hooks?: {onProgress?: (p: {run: number, of: number, t: number, lines: number}) => void}) => RunResult} run
 *   同期。世界の数・本番テストの回数だけくり返す。onProgress は 0.1 s ごと（番犬をなでる）
 * @property {(code: string, lang: 'python'|'c', chapter: number|string) => Card[]} precheck 実行前の検査だけ
 * @property {(code: string, ruleId: string) => string} quickfix ［半角に直す］などの直したコード
 * @property {(code: string) => {name: string, kind: string, src: string, needs: string[], lines: number}[]} extractDefs
 *   〔1.1〕道具箱用。ast でトップレベルの def と、それが使う上の段の import・代入を取り出す（kind: def | value | import）
 * @property {(code: string, chapter: number|string) => Card} explainWatchdog
 *   〔1.1〕番犬で止めた後に予備の Worker で呼ぶ。AST から「時間が進まないくり返し」などを探して where を埋める
 * @property {(code: string, reason: string) => Card} explainGuard  FATAL など画面側で止めた時のカード
 * @property {{python: string, explainer: boolean, explainerError: string|null}} info
 */

export const DEFAULT_LIMITS = Object.freeze({
  // 直し係 4: 上限の主は sim の時間（time_limit）と行数。実時間は「sim の時刻が進まないまま 8 s」（wallLimitS。重い計算）と、
  // 1 回 45 s・本番テスト全体 180 s の大きな安全の上限（固まり防止。PC が混んでいた時。失敗に数えない＝result.busy）だけ
  lineLimit: 2_000_000, wallLimitS: 8, wallSafetyS: 45, printCap: 3000, logCap: 20000, eventCap: 20000, testWallS: 180,
});
const FALLBACK_COST = Object.freeze({ now: 0.001 });
/** 再生しない回で捨てるイベント（センサを読んだ・指令を出した）。 */
const SENSOR_EVENT_KINDS = new Set(['lidar', 'heading', 'gnss', 'camera', 'marker', 'odometer', 'encoder', 'altitude', 'accel',
  'motor', 'now', 'wait']);

/** 32 ビットの種（W1 の rng.js の hash32。まだ無ければ同じ式の自前の版）。 */
export function hash32(text) {
  try {
    if (typeof RngModule.hash32 === 'function') return RngModule.hash32(text);
  } catch { /* 段 0 の空の実装 */ }
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const PY_DIR = '/home/pyodide/rover';

/** 面の id を並べる鍵（"4-1" → [4, 1]、"C-2" → [5.5, 2]）。 */
function levelKey(id) {
  const [a, b] = String(id || '').split('-');
  const ch = a === 'C' ? 5.5 : Number(a);
  return [Number.isFinite(ch) ? ch : 99, Number(b) || 0];
}
const levelGte = (a, b) => { const x = levelKey(a), y = levelKey(b); return x[0] > y[0] || (x[0] === y[0] && x[1] >= y[1]); };

function isTimeUp(r) {
  return (SimModule.TimeUpSignal && r instanceof SimModule.TimeUpSignal) || (r && typeof r === 'object' && r.timeUp === true);
}

/**
 * エンジンを作る（Pyodide の読み込みは呼ぶ側。Python のファイルを FS に書いて import する）。
 * @param {object} pyodide 読み込み済みの Pyodide 0.26.4
 * @param {object} deps
 * @param {{rover_runtime: string, judge: string, error_explain?: string, c_subset?: string}} deps.sources Python のファイルの中身
 * @param {object|string} [deps.rules] data/error_rules.json
 * @param {object|string} [deps.api] data/api.json
 * @param {Function} [deps.Sim] RoverSim の代わり（テスト用。既定は W1 の sim.js）
 * @param {object} [deps.cost] COST の代わり（既定は W1 の COST）
 * @returns {Promise<Engine>}
 */
export async function createEngine(pyodide, { sources, rules, api, Sim, cost } = {}) {
  const SimClass = Sim || SimModule.RoverSim;
  const COST = cost || SimModule.COST || FALLBACK_COST;
  const rulesObj = typeof rules === 'string' ? safeJson(rules) : (rules || null);
  const apiObj = typeof api === 'string' ? safeJson(api) : (api || {});
  const apiFuncs = (apiObj && apiObj.functions) || {};

  // ---- Python のファイルを置いて import する
  const FS = pyodide.FS;
  try { FS.mkdirTree(PY_DIR); } catch { /* ある */ }
  for (const [name, src] of Object.entries(sources || {})) {
    if (typeof src === 'string') FS.writeFile(`${PY_DIR}/${name}.py`, src);
  }
  let sim = null;
  let simFault = null;
  let progressHook = null;
  const guard = (fn) => function (...a) {
    try { return fn(...a); } catch (e) { if (!simFault) simFault = e; throw e; }
  };
  const js = {
    get t() { return sim.timeUp ? -1 : sim.t; },
    motor: guard((l, r, line) => { const res = sim.setMotor(l, r, line); return !!(res && res.clamped); }),
    wait: guard((s, line) => { const r = sim.wait(s, line); return (isTimeUp(r) || sim.timeUp) ? -1 : sim.t; }),
    now: guard((line) => {
      const r = typeof sim.now === 'function' ? sim.now(line) : sim.wait(COST.now ?? 0.001, line, 'now');
      return (isTimeUp(r) || sim.timeUp) ? -1 : sim.t;
    }),
    lidar: guard((line) => nn(sim.lidar(line))),
    heading: guard((line) => nn(sim.heading(line))),
    odometer: guard((line) => nn(sim.odometer(line))),
    encoder: guard((line) => sim.encoder(line)),
    gnss: guard((line) => { const g = sim.gnss(line) || {}; return [!!g.valid, nn(g.lat), nn(g.lon), nn(g.speed), nn(g.course), nn(g.t)]; }),
    camera: guard((line) => { const c = sim.camera(line) || {}; return [!!c.found, nn(c.angle), nn(c.size), nn(c.t), !!c.broken]; }),
    marker: guard((line) => { const m = sim.marker(line) || {}; return [!!m.found, nn(m.id), nn(m.angle), nn(m.dist), nn(m.t), !!m.broken]; }),
    altitude: guard((line) => nn(sim.altitude(line))),
    accel: guard((line) => sim.accel(line)),
    distanceToCone: guard(() => nn(sim.distanceToCone())),
    nichrome: guard((on, line) => { sim.nichrome(!!on, line); }),
    phase: guard((name, line) => { sim.phase(String(name), line); }),
    progress: (t, lines) => { if (progressHook) progressHook(t, lines); },
  };
  pyodide.registerJsModule('_rover_js', js);
  pyodide.runPython(`
import sys, importlib
if ${JSON.stringify(PY_DIR)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(PY_DIR)})
for _m in ("rover_runtime", "judge", "error_explain", "c_subset"):
    sys.modules.pop(_m, None)
importlib.invalidate_caches()
del _m
`);
  const rt = pyodide.pyimport('rover_runtime');
  const judgePy = pyodide.pyimport('judge');
  const setupInfo = safeJson(rt.setup(rulesObj ? JSON.stringify(rulesObj) : '', JSON.stringify(apiObj || {}))) || {};
  const pythonVersion = rt.python_version();

  // ---- 1 つの世界を 1 回走らせる
  function runOne({ code, lang, chapter, world, inject, judgeVars, seed, seedKey, gnssSeed, name, index, isTest,
    limits, equipped, turnedOff, tailS, varWatch, lineMap, wallLimitS }) {
    const w0 = nowMs();
    simFault = null;
    sim = new SimClass(world, { seed, gnssSeed, seedKey, dt: 0.002, frameHz: 50, eventCap: limits.eventCap });
    const opts = {
      lang, inject: inject || {}, equipped, turnedOff, chapter, seed, varWatch, ...(limits.monitor === false ? { monitor: false } : {}),
      limits: { ...limits, wallSafetyS: wallLimitS, wallLimitS: Math.min(limits.wallLimitS, wallLimitS), ...(isTest ? { logCap: 0 } : {}) }, timeLimit: world && world.time_limit, lineMap,
    };
    const py = JSON.parse(rt.run(code, JSON.stringify(opts)));
    const w1 = nowMs();
    const programEndT = sim.t;
    let tailFault = null;
    try { if (!sim.timeUp && !simFault) sim.finish(tailS); } catch (e) { tailFault = e; }
    const ex = sim.export();
    const w2 = nowMs();
    let end = py.end;
    let error = py.error || null;
    const fault = simFault || tailFault;
    if (fault) {
      end = 'fatal';
      error = fatalCard(`シミュレータの中でエラー: ${fault && fault.message}`);
    }
    if (lineMap) remapCards(py, lineMap);
    const fields = ex.fields || [];
    const frames = ex.frames instanceof Float32Array ? ex.frames : Float32Array.from(ex.frames || []);
    return {
      world: index, name, seed, seedKey, test: !!isTest,
      end, error, errorType: py.errorType || null, errorCode: py.errorCode || null, errorLine: py.errorLine || null,
      guard: py.guard || null,
      warnings: py.warnings || [],
      programEndT,
      fields, frames,
      events: ex.events || [], segments: ex.segments || [],
      prints: py.prints || [], printDropped: py.printDropped || 0,
      hits: py.hits || [], lineLog: py.lineLog || [[], []], lineCount: py.lineCount || 0, varLog: py.varLog || [],
      phases: ex.phases || [], calls: py.calls || {}, gnssFixes: ex.gnssFixes || [],
      final: ex.final || {},
      metrics: {},
      uncalled: py.uncalled || [],
      ...(py.flood ? { flood: py.flood } : {}),
      ...(fault ? { fault: String(fault && fault.stack || fault) } : {}),
      stats: {
        compileMs: py.stats ? py.stats.compileMs : 0, execMs: py.stats ? py.stats.execMs : 0,
        pyMs: round3(w1 - w0), tailMs: round3(w2 - w1), simT: ex.final ? ex.final.t : sim.t,
        frames: fields.length ? Math.floor(frames.length / fields.length) : 0, events: (ex.events || []).length,
      },
      _world: world, _inject: inject || {}, _judge: judgeVars || {},
    };
  }

  function runGroup(list, base, ctx, hooks, group) {
    const out = [];
    const n = list.length;
    const t0 = nowMs();
    let cut = null;
    let busy = null;
    for (let i = 0; i < n; i++) {
      const wd = list[i] || {};
      const key = wd.seedKey || (group === 'test' ? `${base}:t${i + 1}` : `${base}:${i + 1}`);
      const seed = Number.isFinite(wd.seed) ? wd.seed >>> 0 : hash32(key);
      const gnssSeed = Number.isFinite(wd.gnssSeed) ? wd.gnssSeed >>> 0 : hash32(`${key}:gnss`);
      // ここでの wallLimitS は 1 回の実時間の安全の上限（runOne が wallSafetyS として渡す）
      const safety = Number.isFinite(ctx.limits.wallSafetyS) ? ctx.limits.wallSafetyS : Math.max(45, ctx.limits.wallLimitS);
      let wallLimitS = safety;
      let remaining = Infinity;
      if (group === 'test') {
        remaining = ctx.limits.testWallS - (nowMs() - t0) / 1000;
        if (remaining <= 0.05) { cut = { done: i, of: n }; break; }
        wallLimitS = Math.min(wallLimitS, remaining);
      }
      progressHook = (t, lines) => { if (hooks.onProgress) hooks.onProgress({ run: i + 1, of: n, t, lines, group }); };
      if (hooks.onProgress) hooks.onProgress({ run: i + 1, of: n, t: 0, lines: 0, group });
      const world = wd.world || {};
      const turnedOff = computeTurnedOff(ctx, world);
      const rec = runOne({
        code: ctx.runCode, lang: ctx.lang, chapter: ctx.chapter, world, inject: wd.inject, judgeVars: wd.judge,
        seed, seedKey: key, gnssSeed, name: wd.name || (group === 'test' ? `テスト${i + 1}` : `世界${i + 1}`),
        index: i, isTest: group === 'test', limits: ctx.limits, equipped: ctx.equipped, turnedOff, tailS: ctx.tailS,
        varWatch: ctx.varWatch && group !== 'test', lineMap: ctx.lineMap, wallLimitS,
      });
      if (group === 'test' && ((rec.end === 'busy' && wallLimitS < safety - 1e-9)
        || (rec.end === 'wall' && remaining < ctx.limits.wallLimitS - 1e-9))) {
        cut = { done: i, of: n };      // 全体の上限で切った回は数えない（ここまでの i 回で結果を出す）
        break;
      }
      out.push(rec);
      if (rec.end === 'busy') { busy = { world: i, group, name: rec.name, card: rec.guard }; break; }   // PC が混んでいた: 残りは走らせない
    }
    progressHook = null;
    return { runs: out, cut, busy };
  }

  function computeTurnedOff(ctx, world) {
    const off = new Set();
    const eq = ctx.equipped ? new Set(ctx.equipped) : null;
    for (const name of (world && world.api_off) || []) if (!eq || !eq.has(name)) off.add(name);
    for (const [name, f] of Object.entries(apiFuncs)) {
      if (f && f.off_from && ctx.levelId && levelGte(ctx.levelId, f.off_from) && !String(ctx.levelId).startsWith('C')
        && (!eq || !eq.has(name))) off.add(name);
    }
    return [...off];
  }

  function judgeRuns(job, ctx, worldRuns, testRuns) {
    if (!job.conditions) return null;
    const toCtx = (r) => ({
      metrics: makeMetrics(r, r._world, ctx.code),
      inject: r._inject || {}, judge: r._judge || {}, seed: r.world + 1,
    });
    const jctx = {
      runs: worldRuns.map(toCtx), testRuns: (testRuns || []).map(toCtx),
      code: ctx.code, lang: ctx.lang, pyCode: ctx.lang === 'c' ? ctx.runCode : null,
      ui: job.ui || {}, mode: job.mode || 'worlds',
    };
    const out = safeJson(judgePy.evaluate(JSON.stringify(job.conditions), jctx));
    return out;
  }

  function fillRecordMetrics(runs, judge, isTest) {
    runs.forEach((r, i) => {
      const m = makeMetrics(r, r._world, null);
      const hasCone = ((r._world && r._world.objects) || []).some((o) => o && o.id === 'cone');
      const mm = { t_stop: finiteOr(m.t_stop, null), stopped: m.stopped };
      if (hasCone) { mm['gap:cone'] = m.gap('cone'); mm['min_gap:cone'] = m.min_gap('cone'); }
      if (judge) {
        if (judge.show && judge.show.world === i && !isTest && judge.show.value != null) mm.show = judge.show.value;
        (judge.stars || []).forEach((s, k) => {
          if (s.measure && s.byTest === !!isTest && s.measure.byWorld) mm[`star${k + 2}`] = s.measure.byWorld[i] ?? null;
        });
        if (judge.values) mm.lines = judge.values.lines;
      }
      r.metrics = mm;
    });
  }

  function senpaiFor(job, ctx, runs, judge) {
    const fn = ReplayExplain && ReplayExplain.analyzeReplay;
    if (typeof fn !== 'function' || !runs.length) return [];
    const failed = judge && judge.clear && !judge.clear.ok;
    const anyBad = runs.some((r) => r.end === 'error' || r.end === 'loop' || r.end === 'wall' || r.end === 'timeup');
    if (judge && !failed && !anyBad) return [];
    const wi = judge && judge.clear ? (judge.clear.failedWorld || 0) : 0;
    const rec = runs[Math.min(wi, runs.length - 1)];
    try {
      // 世界（コーンの位置など）とクリアの式も渡す。渡さないと「コーンにぶつかった」「通りすぎた」を見分けられない（直し A-1）
      const wdef = (Array.isArray(job.worlds) && job.worlds[Math.min(wi, job.worlds.length - 1)]) || {};
      const level = { id: job.levelId, chapter: job.chapter, explain: job.explain || {}, mistakes: job.mistakes || [],
        world: rec._world || wdef.world || undefined, clear: (job.conditions && job.conditions.clear) || [],
        show: (job.conditions && job.conditions.show) || null, lang: ctx.lang };
      // コードも渡す: 面の mistakes[].when（「stop() が無い」など）と、決まり文句を面の種類で選ぶため（直し係 3）
      const hints = fn(rec, level, rulesObj || {}, { chapter: job.chapter, uncalledFuncs: rec.uncalled || [], code: ctx.code, lang: ctx.lang,
        fallback: !!(failed || anyBad) });
      return Array.isArray(hints) ? hints.slice(0, 2) : [];
    } catch {
      return [];
    }
  }

  function strip(runs, keep, isTest) {
    let keptFailed = false;
    runs.forEach((r, i) => {
      const failed = !(r.end === 'end' || r.end === 'exit') || r._failed === true;
      let keepIt = keep !== 'none';
      if (keep === 'first_failed' && isTest) keepIt = i === 0 || (failed && !keptFailed);
      if (failed && keepIt) keptFailed = true;
      if (!keepIt) {
        // 再生しない回は軽くする（同じ種で走らせ直せば同じ記録になる）。判定と理由に使うイベントだけ残す
        r.frames = null; r.framesDropped = true;
        r.events = (r.events || []).filter((e) => e && !SENSOR_EVENT_KINDS.has(e.k));
        r.segments = []; r.lineLog = [[], []]; r.varLog = []; r.logsDropped = true;
      }
      delete r._world; delete r._inject; delete r._judge; delete r._failed;
    });
  }

  /** @type {Engine['run']} */
  function run(job, hooks = {}) {
    const t0 = nowMs();
    const lang = job.lang === 'c' ? 'c' : 'python';
    const code = String(job.code ?? '');
    const chapter = job.chapter ?? 1;
    const chapterNum = Number.isFinite(Number(chapter)) ? Number(chapter) : 5;
    const limits = { ...DEFAULT_LIMITS, ...(job.limits || {}) };
    const mode = job.mode || 'worlds';
    const base = String(job.levelId || 'free');
    const result = {
      id: job.id ?? null, levelId: job.levelId ?? null, mode,
      before: [], compileError: null, runs: [], judge: null, senpai: [], stats: {},
    };

    // ① 実行前の検査（C は訳す）
    let runCode = code;
    let lineMap = null;
    if (lang === 'c') {
      const tr = safeJson(rt.translate_c(code)) || { ok: false, errors: [] };
      if (!tr.ok) {
        result.compileError = (tr.errors && tr.errors[0]) || fatalCard('C を読めなかったよ');
        result.stats = { engineMs: round3(nowMs() - t0), runs: 0 };
        return result;
      }
      runCode = tr.py;
      lineMap = tr.lineMap || null;
    } else {
      const pre = safeJson(rt.before_run(code, lang, chapterNum)) || { stop: null, items: [] };
      // 実行前の注意は止めない。同じ ID は 1 つ（L_SLEEP_NOT_WAIT を 1 回、5.1）・2 つまで（display.max_warnings_before_run）
      const seen = new Set();
      result.before = (pre.items || []).filter((c) => c && c.severity !== 'error' && !seen.has(c.id) && seen.add(c.id)).slice(0, 2);
      if (pre.stop) {
        result.compileError = pre.stop;
        result.stats = { engineMs: round3(nowMs() - t0), runs: 0 };
        return result;
      }
    }
    const ctx = {
      code, runCode, lang, chapter: chapterNum, levelId: job.levelId, limits,
      equipped: Array.isArray(job.equipped) ? job.equipped : null,
      tailS: Number.isFinite(job.tailS) ? job.tailS : 3.0,
      varWatch: job.varWatch !== false, lineMap,
    };
    const tPre = nowMs();

    // ② 世界ごと（本番テストは回ごと）に走らせる
    const worlds = Array.isArray(job.worlds) ? job.worlds : [];
    let judge = null;
    if (mode === 'test') {
      const tests = Array.isArray(job.testWorlds) ? job.testWorlds : null;
      let worldRuns = [];
      if (tests) {
        const gw = runGroup(worlds, base, ctx, hooks, 'worlds');
        worldRuns = gw.runs;
        if (gw.busy) return busyResult(result, gw, worldRuns, t0, tPre);
        judge = judgeRuns(job, ctx, worldRuns, []);
        if (!(judge && judge.clear && judge.clear.ok)) {
          result.runs = worldRuns;
          result.testSkipped = true;
          result.judge = judge;
          fillRecordMetrics(worldRuns, judge, false);
          result.senpai = senpaiFor(job, ctx, worldRuns, judge);
          strip(worldRuns, 'all', false);
          return finish(result, t0, tPre, worldRuns.length);
        }
      }
      const g = runGroup(tests || worlds, base, ctx, hooks, 'test');
      const testRuns = g.runs;
      if (g.busy) { strip(worldRuns, 'none', false); return busyResult(result, g, testRuns, t0, tPre); }
      judge = judgeRuns(job, ctx, worldRuns.length ? worldRuns : testRuns, testRuns);
      if (g.cut) {
        g.cut.card = guardCardTestCut(g.cut.done, g.cut.of);
        result.testCut = g.cut;
      }
      markTestFailures(testRuns, judge);
      fillRecordMetrics(testRuns, judge, true);
      if (worldRuns.length) fillRecordMetrics(worldRuns, judge, false);
      result.runs = testRuns;
      if (worldRuns.length) result.worldRuns = worldRuns;
      result.judge = judge;
      result.senpai = [];
      strip(testRuns, job.keepFrames || 'first_failed', true);
      strip(worldRuns, 'all', false);
      return finish(result, t0, tPre, testRuns.length + worldRuns.length);
    }
    const g = runGroup(worlds, base, ctx, hooks, 'worlds');
    if (g.busy) return busyResult(result, g, g.runs, t0, tPre);
    judge = mode === 'free' ? null : judgeRuns(job, ctx, g.runs, []);
    fillRecordMetrics(g.runs, judge, false);
    result.runs = g.runs;
    result.judge = judge;
    result.senpai = mode === 'free' ? [] : senpaiFor(job, ctx, g.runs, judge);
    strip(g.runs, job.keepFrames || 'all', false);
    return finish(result, t0, tPre, g.runs.length);
  }

  /** 1 回の実時間が安全の上限に来た（PC が混んでいた）: 判定も先輩のひとこともしない。失敗に数えない（直し係 4）。 */
  function busyResult(result, g, runs, t0, tPre) {
    fillRecordMetrics(runs, null, g.busy.group === 'test');
    result.runs = runs;
    result.judge = null;
    result.senpai = [];
    result.busy = { world: g.busy.world, of: null, test: g.busy.group === 'test', name: g.busy.name,
      card: g.busy.card || { id: 'WALL_BUSY', stage: 'guard', severity: 'info', line: null, col: null, end_col: null,
        title: 'PC が混んでいたので止めたよ。もう一度［実行］してね', where: '', why: '', fix: '', term: '', raw: '', example: null,
        quickfix: null, zukan: null, speaker: 'rover', confirm: false, more: 0, vars: {} } };
    strip(runs, 'all', g.busy.group === 'test');
    return finish(result, t0, tPre, runs.length);
  }

  function markTestFailures(testRuns, judge) {
    // 本番テストの回が「失敗」か: ★の本番テストの条件で偽になった回（keepFrames: first_failed のため）
    const testStars = ((judge && judge.stars) || []).filter((s) => s.byTest && Array.isArray(s.pass));
    testRuns.forEach((r, i) => { r._failed = testStars.some((s) => s.pass[i] === false); });
  }

  function finish(result, t0, tPre, n) {
    try { rt.cleanup(); } catch { /* gc */ }
    const t1 = nowMs();
    result.stats = { engineMs: round3(t1 - t0), preMs: round3(tPre - t0), runs: n };
    return result;
  }

  function guardCardTestCut(done, of) {
    return {
      id: 'WALL_LIMIT', stage: 'guard', severity: 'warn', line: null, col: null, end_col: null,
      title: `本番テストの計算が長すぎたので、ここまでの ${done} 回で結果を出すね`,
      where: `本番テスト ${of} 回のうち ${done} 回`, why: '本番テスト全体の計算時間には、固まらないための上限があるよ。',
      fix: '1 回の走行で、とても細かい wait やセンサの読みすぎが無いか見直そう。', term: '', raw: '', example: null,
      quickfix: null, zukan: null, speaker: 'rover', confirm: false, more: 0, vars: { done, of },
    };
  }

  function remapCards(py, lineMap) {
    const fix = (c) => {
      if (!c || !Number.isFinite(c.line)) return;
      const to = lineMap[c.line];
      if (to && to !== c.line) {
        if (typeof c.where === 'string') c.where = c.where.replace(new RegExp(`(^|[^0-9])${c.line} 行目`), `$1${to} 行目`);
        c.line = to;
      }
    };
    fix(py.error); fix(py.guard);
    for (const w of py.warnings || []) fix(w.card);
  }

  return {
    run,
    precheck(code, lang = 'python', chapter = 1) {
      if (lang === 'c') {
        const tr = safeJson(rt.translate_c(String(code))) || { ok: false, errors: [] };
        return tr.ok ? [] : (tr.errors || []);
      }
      return safeJson(rt.precheck(String(code), lang, Number(chapter) || 1)) || [];
    },
    quickfix(code, ruleId) { return String(rt.quickfix(String(code), String(ruleId))); },
    extractDefs(code) { return safeJson(judgePy.extract_defs(String(code))) || []; },
    explainWatchdog(code, chapter = 1) { return safeJson(rt.explain_watchdog(String(code), Number(chapter) || 1)); },
    explainGuard(code, reason) { return safeJson(JSON.stringify(rtGuard(String(code || ''), String(reason)))); },
    info: { python: pythonVersion, explainer: !!setupInfo.explainer, explainerError: setupInfo.error || null },
    /** テスト用: 中の Python のモジュール */
    _py: { rt, judge: judgePy },
  };

  function rtGuard(code, reason) {
    try { return safeJson(rt.explain_guard_json(code, reason)); } catch { return fatalCard('ぼくの中の Python が倒れちゃった'); }
  }
}

function nn(v) { return v === undefined ? null : v; }
function round3(x) { return Math.round(x * 1000) / 1000; }
function finiteOr(x, d) { return Number.isFinite(x) ? x : d; }
function safeJson(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}
function fatalCard(msg) {
  return {
    id: 'FATAL', stage: 'guard', severity: 'error', line: null, col: null, end_col: null,
    title: 'ぼくの中の Python が倒れちゃった', where: 'プログラム全体',
    why: 'ゲームの中の仕組みが止まってしまったよ。きみのコードのせいとは限らないんだ。',
    fix: 'コードはそのまま残っているから、もう一度実行してね。', term: '', raw: msg || '', example: null,
    quickfix: null, zukan: null, speaker: 'rover', confirm: false, more: 0, vars: {},
  };
}
export { fatalCard };

/** 記録を JSON にできる形へ（frames を数の配列に）。fixtures の書き出しと Worker の外への保存に使う。 */
export function recordToJSON(rec) {
  const o = { ...rec };
  if (rec.frames) o.frames = Array.from(rec.frames, (x) => (Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : null));
  return o;
}

/** JSON から戻した記録の frames を Float32Array に（fixtures を読む画面の単位も使える）。 */
export function recordFromJSON(o) {
  const r = { ...o };
  if (Array.isArray(o.frames)) r.frames = Float32Array.from(o.frames, (x) => (x === null ? NaN : x));
  return r;
}
