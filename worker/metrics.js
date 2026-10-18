/**
 * @file app/worker/metrics.js
 * 持ち主: W2（実行エンジン）
 * 役割: 記録（RunRecord）から判定に使う値を出す（judge.py が名前空間に入れる。replay_explain.js も使ってよい）。
 * SPEC: 6.12（判定に使う値の語彙）・7.3「W2 worker/metrics.js」・7.8
 *
 * 決まり（refsim の Record.ns と同じ考え。6.12 の 1.1 の直しを入れた）:
 * - すき間は機体の円（0.12 m）と物の円の外側どうし（ふれて 0）。物の r が無ければコーンは 0.19、ほかは 0。
 * - 'start' はスタートの位置、'canopy' は最後のパラの位置（frames の cx・cy）。
 * - 途中の値（min_gap・visited・max_offset・turn_total・travel・t_stop）は 50 Hz の frames から。
 * - 最後の値（gap・dist・x_end…）は record.final（倍精度）から。
 * - stopped: 最後のコマで地面の速さ < 0.02 m/s、かつ左右の指令がどちらも不感帯（|d| < 0.08）の中（◆ 決定 6.12）。
 * - 測れない値（ふれていない時の hit_speed など）は 0、無い時刻（phase_t など）は Infinity。
 * コードから出す値（lines・uses・defs）は judge.py が ast で出す。画面から来る値（prediction_ok・attempt）は job.ui。
 */

const BODY_R = 0.12;
const CONE_R = 0.19;
const DEADBAND = 0.08;
const DEG = Math.PI / 180;
const wrap180 = (a) => { let x = (a + 180) % 360; if (x < 0) x += 360; return x - 180; };

/**
 * @typedef {object} Metrics 判定の語彙（SPEC 6.12。id の既定は 'cone'）
 * @property {(id?: string) => number} gap 最後のすき間 m（機体の円 0.12 m と物の円の外側どうし、ふれて 0）
 * @property {(id?: string) => number} min_gap 走っている間で一番近づいたすき間 m
 * @property {(id: string) => number} dist 最後の、機体の中心と物（旗・start・canopy）の中心の距離 m
 * @property {(deg: number) => number} heading_err 最後の向きと deg の差（0〜180 度）
 * @property {(id?: string) => number} aim_err 最後の向きと、物の方向との差（度）
 * @property {(id?: string) => boolean} touched 物にふれたか
 * @property {(id?: string) => number} hit_speed ふれた時の速さの最大 m/s（ふれなければ 0）
 * @property {number} bumps 岩・壁・斜面にぶつかった回数
 * @property {(id: string, r?: number) => boolean} visited 途中で中心が id の r m（既定 0.4）以内に入った
 * @property {(ids: string[], r?: number) => boolean} visited_in_order 書いた順に r m 以内を通った
 * @property {(id: string) => boolean} entered 区域（池・パラ）に入った
 * @property {(id: string) => number} max_offset 線（line）からの横のずれの最大 m
 * @property {number} turn_total 回った角度の合計（度）
 * @property {number} travel 走った道のり m
 * @property {boolean} stopped 最後のコマで地面の速さ < 0.02 m/s、かつ左右の指令がどちらも 0.08 未満
 * @property {number} t_stop 最後に止まった時刻（動かなければ 0、止まらなければ Infinity）
 * @property {number} t_end プログラムが終わった時刻
 * @property {number} x_end @property {number} y_end @property {number} heading_end
 * @property {(name: string) => number} calls 命令を呼んだ回数
 * @property {number} still_shots 止まっている時に camera() で撮った回数（左右の車輪の速さ < 0.02 m/s・指令が不感帯の中。直し係 6: 8-2 の小目標）
 * @property {string[]} printed print した文字（行ごと）
 * @property {(list: string[]) => boolean} printed_not_in 書いたものと違う文字を print した
 * @property {(v: number, tol: number) => boolean} printed_number_near print した数のどれかが v ± tol
 * @property {number} max_printed print した数の最大（無ければ -Infinity）
 * @property {(text: string) => number} speed_at_print text をふくむ print をした時の速さ（無ければ Infinity）
 * @property {(name: string) => number} phase_t @property {(names: string[]) => boolean} phases_in_order
 * @property {(name: string) => number} n_phase
 * @property {number} landed_t @property {boolean} separated @property {boolean} tangled @property {boolean} crashed
 * @property {boolean} motor_before_land @property {boolean} nichrome_in_air
 * @property {boolean} timeup @property {boolean} ok エラー・無限ループ・時間切れなしで最後まで動いた
 * @property {string|null} error 例外の型の名前
 * @property {(id?: string|null) => number} stalls 〔1.1〕物にふれたまま押し続けた回数（6.5）
 */

/** 区域の中か（rect・circle・poly）。 */
export function inArea(a, x, y) {
  if (a.rect) {
    const [x0, y0, x1, y1] = a.rect;
    return Math.min(x0, x1) <= x && x <= Math.max(x0, x1) && Math.min(y0, y1) <= y && y <= Math.max(y0, y1);
  }
  if (a.circle) {
    const [cx, cy, r] = a.circle;
    return Math.hypot(x - cx, y - cy) <= r;
  }
  if (a.poly) {
    const p = a.poly;
    let ins = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) ins = !ins;
    }
    return ins;
  }
  return false;
}

/** print した文字の中の数（refsim と同じ正規表現）。 */
function numbersIn(texts) {
  const out = [];
  for (const s of texts) {
    const m = String(s).match(/-?\d+(?:\.\d+)?/g);
    if (m) for (const x of m) { const v = parseFloat(x); if (Number.isFinite(v)) out.push(v); }
  }
  return out;
}

/**
 * frames（Float32Array か数の配列）を項目ごとに読む道具。
 * @param {{fields: string[], frames: Float32Array|number[]|null}} record
 */
export function frameReader(record) {
  const fields = record.fields || [];
  const fr = record.frames || [];
  const n = fields.length || 1;
  const count = Math.floor(fr.length / n);
  const idx = Object.fromEntries(fields.map((f, i) => [f, i]));
  const col = (name, k) => (idx[name] === undefined ? NaN : fr[k * n + idx[name]]);
  return { count, col, idx };
}

/**
 * 記録から判定の値を作る。
 * @param {import('./engine.js').RunRecord} record 1 つの世界の記録
 * @param {object} world その世界（6.10。物の位置・半径に使う）
 * @param {string} [code] 生徒のコード（今は使わない。形を SPEC 7.3 に合わせて残す）
 * @returns {Metrics}
 */
export function makeMetrics(record, world, code) {
  const w = world || {};
  const objs = Array.isArray(w.objects) ? w.objects : [];
  const byId = new Map(objs.filter((o) => o && o.id != null).map((o) => [String(o.id), o]));
  const final = record.final || {};
  const events = Array.isArray(record.events) ? record.events : [];
  const prints = Array.isArray(record.prints) ? record.prints : [];
  const phases = Array.isArray(record.phases) ? record.phases : [];
  const F = frameReader(record);
  const hasFrames = F.count > 0;
  const fx = Number.isFinite(final.x) ? final.x : (hasFrames ? F.col('x', F.count - 1) : 0);
  const fy = Number.isFinite(final.y) ? final.y : (hasFrames ? F.col('y', F.count - 1) : 0);
  const fh = (((Number.isFinite(final.heading) ? final.heading : (hasFrames ? F.col('h', F.count - 1) : 0)) % 360) + 360) % 360;

  const canopyEnd = () => {
    if (final.canopy && Number.isFinite(final.canopy[0])) return { x: final.canopy[0], y: final.canopy[1], r: 0 };
    for (let k = F.count - 1; k >= 0; k--) {
      const cx = F.col('cx', k), cy = F.col('cy', k);
      if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy, r: 0 };
    }
    return null;
  };
  const obj = (id = 'cone') => {
    const key = String(id);
    if (key === 'start') { const s = w.start || {}; return { x: +s.x || 0, y: +s.y || 0, r: 0 }; }
    if (key === 'canopy') return canopyEnd();
    const o = byId.get(key);
    if (!o) throw new Error(`判定の式の名前「${key}」の物が世界に無い`);
    return o;
  };
  const radius = (o) => (Number.isFinite(o.r) ? o.r : (o.type === 'cone' ? CONE_R : 0));
  const center = (o) => (o.type === 'line' || o.type === 'wall') ? { x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 } : o;

  const contacts = events.filter((e) => e && e.k === 'contact');
  const coneTouches = events.filter((e) => e && e.k === 'cone_touch');
  const stallsEv = events.filter((e) => e && e.k === 'stall');

  // 止まった時刻
  let tStop = 0;
  {
    let moving = false; let ts = 0;
    for (let k = 0; k < F.count; k++) {
      const v = F.col('v', k);
      if (v > 0.02) { moving = true; ts = null; } else if (moving && ts === null) ts = F.col('t', k);
    }
    tStop = moving ? (ts === null ? Infinity : ts) : 0;
  }
  // 最後のコマ
  let stopped = false;
  if (hasFrames) {
    const k = F.count - 1;
    const v = F.col('v', k), cl = F.col('cmdL', k), cr = F.col('cmdR', k);
    stopped = v < 0.02 && Math.abs(cl) < DEADBAND && Math.abs(cr) < DEADBAND;
  } else if (final.stopped !== undefined) stopped = !!final.stopped;

  let turnTotal = 0; let travel = 0;
  for (let k = 1; k < F.count; k++) {
    turnTotal += Math.abs(wrap180(F.col('h', k) - F.col('h', k - 1)));
    travel += Math.hypot(F.col('x', k) - F.col('x', k - 1), F.col('y', k) - F.col('y', k - 1));
  }
  const printed = prints.map((p) => String(p[2] ?? ''));
  const nums = numbersIn(printed);

  const speedAt = (t) => {
    if (!hasFrames) return 0;
    let best = 0;
    for (let k = 0; k < F.count; k++) { if (F.col('t', k) <= t + 1e-9) best = k; else break; }
    return F.col('v', best);
  };
  const firstVisit = (id, r) => {
    const o = obj(id); const c = center(o);
    for (let k = 0; k < F.count; k++) if (Math.hypot(F.col('x', k) - c.x, F.col('y', k) - c.y) <= r) return F.col('t', k);
    return null;
  };
  // 止まっている時に撮った回数（撮った時刻の直前のコマで、車輪が止まり指令も不感帯の中。回りながら撮った回は数えない）
  // 指令は motor のイベント（記録の順）から読む（同じ時刻に motor → camera と呼んだ時、コマにはまだ指令が入っていない）
  let stillShots = 0;
  {
    let cl = 0, cr = 0;
    for (const e of events) {
      if (!e) continue;
      if (e.k === 'motor') { cl = +e.l || 0; cr = +e.r || 0; continue; }
      if (e.k !== 'camera' || e.broken) continue;
      if (Math.abs(cl) >= DEADBAND || Math.abs(cr) >= DEADBAND) continue;
      const ts = Number.isFinite(e.t_shot) ? e.t_shot : e.t;
      let best = -1;
      for (let k = 0; k < F.count; k++) { if (F.col('t', k) <= ts + 1e-9) best = k; else break; }
      if (best >= 0 && Math.abs(F.col('wl', best)) < 0.02 && Math.abs(F.col('wr', best)) < 0.02) stillShots++;
    }
  }
  const phaseT = (name) => { for (const [t, n] of phases) if (n === String(name)) return t; return Infinity; };
  const isDrop = !!w.drop;
  const landed = final.landed_t;
  const end = record.end;

  /** @type {Metrics} */
  const m = {
    gap(id = 'cone') { const o = obj(id); if (!o) return Infinity; const c = center(o); return Math.max(0, Math.hypot(c.x - fx, c.y - fy) - BODY_R - radius(o)); },
    min_gap(id = 'cone') {
      const o = obj(id); if (!o) return Infinity; const c = center(o);
      let best = Math.hypot(c.x - fx, c.y - fy);
      for (let k = 0; k < F.count; k++) best = Math.min(best, Math.hypot(c.x - F.col('x', k), c.y - F.col('y', k)));
      return Math.max(0, best - BODY_R - radius(o));
    },
    dist(id) { const o = obj(id); if (!o) return Infinity; const c = center(o); return Math.hypot(c.x - fx, c.y - fy); },
    heading_err(deg) { return Math.abs(wrap180(deg - fh)); },
    aim_err(id = 'cone') { const o = obj(id); if (!o) return 180; const c = center(o); const b = Math.atan2(c.x - fx, c.y - fy) / DEG; return Math.abs(wrap180(b - fh)); },
    touched(id = 'cone') {
      const key = String(id);
      return contacts.some((e) => String(e.id) === key) || (key === 'cone' && coneTouches.length > 0) || (key === 'cone' && !!final.touchedCone && !contacts.length);
    },
    hit_speed(id = 'cone') {
      const key = String(id); let best = 0;
      for (const e of contacts) if (String(e.id) === key && Number.isFinite(e.speed)) best = Math.max(best, Math.abs(e.speed));
      if (key === 'cone') for (const e of coneTouches) if (Number.isFinite(e.speed)) best = Math.max(best, Math.abs(e.speed));
      return best;
    },
    bumps: contacts.length ? contacts.filter((e) => ['rock', 'wall', 'hill', 'area'].includes(e.what)).length : (+final.bumps || 0),
    visited(id, r = 0.4) { return firstVisit(id, r) !== null; },
    visited_in_order(ids, r = 0.4) {
      const ts = Array.from(ids || [], (i) => firstVisit(i, r));
      if (ts.some((t) => t === null)) return false;
      for (let i = 0; i + 1 < ts.length; i++) if (!(ts[i] <= ts[i + 1])) return false;
      return true;
    },
    entered(id) {
      const key = String(id);
      if (key === 'canopy') return !!final.tangled;
      if (events.some((e) => e && e.k === 'pond' && String(e.id) === key)) return true;
      const a = byId.get(key); if (!a) return false;
      for (let k = 0; k < F.count; k++) if (inArea(a, F.col('x', k), F.col('y', k))) return true;
      return false;
    },
    max_offset(id) {
      const ln = obj(id); const ex = ln.x2 - ln.x1, ey = ln.y2 - ln.y1; const L = Math.hypot(ex, ey) || 1e-12;
      let best = 0;
      for (let k = 0; k < F.count; k++) {
        const px = F.col('x', k) - ln.x1, py = F.col('y', k) - ln.y1;
        const u = (px * ex + py * ey) / (L * L);
        if (u >= 0 && u <= 1) best = Math.max(best, Math.abs(px * ey - py * ex) / L);
      }
      return best;
    },
    turn_total: turnTotal,
    travel,
    stopped,
    t_stop: tStop,
    t_end: Number.isFinite(record.programEndT) ? record.programEndT : (final.t || 0),
    x_end: fx, y_end: fy, heading_end: fh,
    calls(name) { const c = record.calls || {}; return +(c[name] || 0); },
    still_shots: stillShots,
    printed,
    printed_not_in(list) { const s = new Set(Array.from(list || [], String)); return printed.some((p) => !s.has(p)); },
    printed_number_near(v, tol) { return nums.some((n) => Math.abs(n - v) <= tol); },
    max_printed: nums.length ? Math.max(...nums) : -Infinity,
    speed_at_print(text) { for (const p of prints) if (String(p[2]).includes(String(text))) return speedAt(p[0]); return Infinity; },
    phase_t: phaseT,
    phases_in_order(names) {
      const ts = Array.from(names || [], phaseT);
      if (ts.some((t) => t === Infinity)) return false;
      for (let i = 0; i + 1 < ts.length; i++) if (!(ts[i] <= ts[i + 1])) return false;
      return true;
    },
    n_phase(name) { return phases.filter((p) => p[1] === String(name)).length; },
    landed_t: isDrop ? (Number.isFinite(landed) ? landed : Infinity) : (Number.isFinite(landed) ? landed : 0),
    separated: !!final.separated,
    tangled: !!final.tangled,
    crashed: !!final.crashed,
    motor_before_land: !!final.motor_before_land,
    nichrome_in_air: !!final.nichrome_in_air,
    timeup: end === 'timeup' || !!final.timeUp,
    ok: end === 'end' || end === 'exit',
    error: record.errorType || (record.error ? String(record.error.raw || '').split(':')[0] || 'Error' : null),
    stalls(id = null) { return stallsEv.filter((e) => id == null || String(e.id) === String(id)).length; },
  };
  return m;
}

/** 判定の語彙の名前（judge.py が名前空間に入れる。tests も使う）。 */
export const METRIC_NAMES = Object.freeze(['gap', 'min_gap', 'dist', 'heading_err', 'aim_err', 'touched', 'hit_speed',
  'bumps', 'visited', 'visited_in_order', 'entered', 'max_offset', 'turn_total', 'travel', 'stopped', 't_stop', 't_end',
  'x_end', 'y_end', 'heading_end', 'calls', 'still_shots', 'printed', 'printed_not_in', 'printed_number_near', 'max_printed',
  'speed_at_print', 'phase_t', 'phases_in_order', 'n_phase', 'landed_t', 'separated', 'tangled', 'crashed',
  'motor_before_land', 'nichrome_in_air', 'timeup', 'ok', 'error', 'stalls']);
