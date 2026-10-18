/**
 * @file app/js/replay/overlays.js
 * 持ち主: W5（3D と再生）
 * 役割: 地面に描くもの: 今回の跡（黄土色の実線）・前回（白の半透明の細い破線）・先輩（薄い橙の点線）・目標への矢印と cm の札・ゴールの輪（1 m と 30 cm）・
 *       LiDAR の線（細い濃い赤の破線と当たった点）・カメラの視野（薄い扇）・GNSS の点（青）と本当の位置（実線）・凡例。
 * SPEC: 3.4「地面に描くもの」・10.4・4 章の 8 と 9
 *
 * 〔1.1〕色だけで見分けさせない（線の形も変え、3D の右下に凡例）。光らせない（MeshBasic の不透明か半透明だけ。加算の合成は使わない）。
 * 座標: sim の (x, y) → three の (x, 高さ, −y)。
 */
import { normalizeRecord, sampleFrame } from './player.js';
import { ROVER_DIM } from './rover_model.js';

/** 線の色（10.4）。 */
export const OVERLAY_COLORS = Object.freeze({
  trail: 0xa97d33,      // 黄土色
  ghost: 0xffffff,      // 白（半透明）
  senpai: 0xeeaa72,     // 薄い橙
  lidar: 0x8e2a22,      // 濃い赤
  fov: 0xfff4d8,        // 薄いクリーム
  gnss: 0x2f6f9f,       // 青
  truth: 0x23313a,      // 墨
  ring: 0xffffff,
  arrow: 0x23313a,
});

/** 地面に描くものの名前（設定と面の overlays）。 */
export const OVERLAY_KEYS = Object.freeze(['trail', 'ghost', 'senpai', 'lidar', 'cameraFov', 'gnss', 'truth', 'arrow', 'rings']);

const LIFT = { trail: 0.007, ghost: 0.006, senpai: 0.0065, ring: 0.005, arrow: 0.008, fov: 0.004, gnss: 0.009 };

/**
 * 記録の地上の道すじ（細かすぎる点は間引く）。
 * @param {object} N normalizeRecord の戻り値
 * @returns {{pts: Float32Array, frameToPt: Int32Array, times: Float32Array, count: number}}
 *   pts は [x, y, …]。frameToPt[i] は「コマ i までに描く点の数」。
 */
export function groundPath(N, minStep = 0.008) {
  const c = N.col;
  const pts = [], times = [];
  const frameToPt = new Int32Array(N.n);
  let lx = NaN, ly = NaN;
  for (let i = 0; i < N.n; i++) {
    if (c.mode[i] === 0 && Number.isFinite(c.x[i])) {
      const x = c.x[i], y = c.y[i];
      if (!(Math.hypot(x - lx, y - ly) < minStep)) { pts.push(x, y); times.push(c.t[i]); lx = x; ly = y; }
    }
    frameToPt[i] = pts.length / 2;
  }
  return { pts: Float32Array.from(pts), frameToPt, times: Float32Array.from(times), count: pts.length / 2 };
}

/**
 * 条件の式からゴールの輪を読む（`gap('cone') <= 0.3`・`dist('B') <= 0.2`）。
 * gap の輪は「物のふち＋すき間」の半径（機体のふちがこの輪に入れば合格）、dist の輪は物の中心からの半径。
 * @param {object} world @param {object} [level] @returns {Array<{id: string, x: number, y: number, r: number, kind: 'gap'|'dist', v: number}>}
 */
export function goalRings(world, level) {
  const objs = new Map(((world && world.objects) || []).map((o) => [String(o.id), o]));
  const out = [];
  const seen = new Set();
  const exprs = [];
  if (level) for (const k of ['clear', 'stars']) for (const c of level[k] || []) if (c && typeof c.expr === 'string' && !Array.isArray(c.need)) exprs.push(c.expr);
  const re = /\b(gap|dist)\(\s*'([^']+)'\s*\)\s*<=?\s*([0-9.]+)/g;
  const reMin = /min\(\s*((?:dist\('[^']+'\)\s*,?\s*)+)\)\s*<=?\s*([0-9.]+)/g;
  const push = (kind, id, v) => {
    const o = objs.get(id);
    if (!o || !Number.isFinite(o.x) || v > 6) return;
    const k = `${kind}:${id}:${v}`;
    if (seen.has(k)) return;
    seen.add(k);
    const r = kind === 'gap' ? (o.r || 0.19) + v : v;
    out.push({ id, x: o.x, y: o.y, r, kind, v });
  };
  for (const e of exprs) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(e))) push(m[1], m[2], parseFloat(m[3]));
    reMin.lastIndex = 0;
    while ((m = reMin.exec(e))) { for (const id of m[1].match(/'([^']+)'/g) || []) push('dist', id.slice(1, -1), parseFloat(m[2])); }
  }
  if (!out.length) {
    const cone = [...objs.values()].find((o) => o.type === 'cone');
    if (cone) { push('gap', String(cone.id), 1.0); push('gap', String(cone.id), 0.3); }
  }
  return out;
}

/**
 * 目標の物（矢印の行き先）: 最初のコーン、無ければ最後の位置に一番近い旗。
 * 面のゴールが「スタートに戻る」（explain.target が 'start'、またはクリアの式に dist('start')）の時はスタートの所
 * （3-1・C-2 で、完走しても次の角の旗までの「1.5 m」を出していた。直し係 6）。
 */
export function arrowTarget(world, x, y, level) {
  const objs = (world && world.objects) || [];
  const toStart = !!level && ((level.explain && level.explain.target === 'start') ||
    (level.clear || []).some((c) => c && typeof c.expr === 'string' && /dist\(\s*'start'\s*\)/.test(c.expr)));
  if (toStart && world && world.start) return { type: 'start', id: 'start', x: world.start.x || 0, y: world.start.y || 0 };
  const cone = objs.find((o) => o.type === 'cone');
  if (cone) return cone;
  let best = null, bd = Infinity;
  for (const o of objs) if (o.type === 'flag' || o.type === 'marker') { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; best = o; } }
  return best;
}

/** 最後に止まった時刻（地面の速さが 0.02 未満になって、そのまま終わりまで）。止まらなければ最後の時刻。 */
export function finalStopTime(N) {
  const c = N.col;
  let k = N.n - 1;
  while (k > 0 && Math.abs(c.v[k]) < 0.02 && c.mode[k] === 0) k--;
  return k >= N.n - 1 ? c.t[N.n - 1] : c.t[Math.min(N.n - 1, k + 1)];
}

/**
 * @param {typeof import('three')} THREE @param {object} scene three の Scene
 * @param {{container?: HTMLElement, quality?: string}} [opts] container: 札と凡例を入れる要素（3D の区画）
 */
export function createOverlays(THREE, scene, opts = {}) {
  const owned = [];
  const own = (x) => { owned.push(x); return x; };
  const root = new THREE.Group();
  root.name = 'overlays';
  scene.add(root);
  const basic = (color, extra = {}) => own(new THREE.MeshBasicMaterial({ color, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra }));
  // 上からの絵では線と点を太く（遠くても見えるように）。uW: 線、uD: 点
  const uW = { value: 1 }, uD = { value: 1 };
  /** 材質に「太さのつまみ」を付ける。mode: offset（帯の offset 属性）・xz・xy・z・all（形をその軸で拡大）。 */
  const widen = (mat, mode, u = 'W') => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uW = u === 'D' ? uD : uW;
      const code = mode === 'offset' ? 'transformed.x += offset.x * ( uW - 1.0 ); transformed.z += offset.y * ( uW - 1.0 );'
        : mode === 'xz' ? 'transformed.xz *= uW;' : mode === 'xy' ? 'transformed.xy *= uW;' : mode === 'z' ? 'transformed.z *= uW;' : 'transformed *= uW;';
      sh.vertexShader = (mode === 'offset' ? 'attribute vec2 offset;\n' : '') + 'uniform float uW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + code);
    };
    mat.customProgramCacheKey = () => 'widen-' + mode + '-' + u;
    return mat;
  };
  let camMode = 'follow';

  const vis = { trail: true, ghost: true, senpai: true, lidar: true, cameraFov: true, gnss: true, truth: true, arrow: true, rings: true };
  let world = null, level = null, arrowLevel = null, N = null;
  let trail = null, ghostMesh = null, senpaiMesh = null, ringsGroup = null;
  let gnssDots = null, gnssLines = null, gnssTruthDots = null, fixes = [];
  let lidarEvents = [], cameraEvents = [];
  let tStop = Infinity, target = null;
  let hasGhost = false, hasSenpai = false;

  // ---- LiDAR の破線（小さな箱をならべる）と当たった点
  const DASH = 0.05, GAP = 0.035, MAXD = 12.2;
  const nDash = Math.ceil(MAXD / (DASH + GAP)) + 1;
  const dashGeo = own(new THREE.BoxGeometry(0.005, 0.005, DASH));
  const lidarMat = widen(basic(OVERLAY_COLORS.lidar, { polygonOffset: false, depthWrite: true }), 'xy');
  const dashes = new THREE.InstancedMesh(dashGeo, lidarMat, nDash);
  dashes.count = 0;
  dashes.frustumCulled = false;
  root.add(dashes);
  const hitDot = new THREE.Mesh(own(new THREE.SphereGeometry(0.014, 12, 8)), widen(basic(OVERLAY_COLORS.lidar, { polygonOffset: false, depthWrite: true }), 'all'));
  hitDot.visible = false;
  root.add(hitDot);

  // ---- カメラの視野（地面の扇、先へ行くほど薄く）
  const fovGeo = own(fanGeometry(THREE, ROVER_DIM.camHFov, 5.0, 24));
  const fovMat = own(new THREE.MeshBasicMaterial({ color: OVERLAY_COLORS.fov, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const fov = new THREE.Mesh(fovGeo, fovMat);
  fov.visible = false;
  fov.renderOrder = 2;
  root.add(fov);

  // ---- 矢印（地面）と札（DOM）
  const arrowMat = widen(basic(OVERLAY_COLORS.arrow, { transparent: true, opacity: 0.78, side: THREE.DoubleSide }), 'z');
  const headMat = widen(basic(OVERLAY_COLORS.arrow, { transparent: true, opacity: 0.78, side: THREE.DoubleSide }), 'xz');
  const arrow = new THREE.Group();
  const shaft = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 0.018).rotateX(-Math.PI / 2)), arrowMat);
  const headG = own(new THREE.BufferGeometry());
  headG.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.035, 0.07, 0, 0, 0, 0, 0.035], 3));
  const head = new THREE.Mesh(headG, headMat);
  arrow.add(shaft, head);
  arrow.visible = false;
  arrow.renderOrder = 3;
  root.add(arrow);

  const container = opts.container || null;
  const labelEl = container ? mkEl('div', 'ov-label', container) : null;
  if (labelEl) { labelEl.hidden = true; labelEl.setAttribute('aria-hidden', 'true'); }
  const legendEl = container ? mkEl('div', 'legend', container) : null;
  if (legendEl) legendEl.setAttribute('aria-label', '地面の線の見方');
  const labelPos = new THREE.Vector3();
  let labelText = '';

  function clearGroup(g) {
    if (!g) return;
    root.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  /** 世界と面（ゴールの輪・矢印の行き先）。 */
  function setWorld(w, lv, arrowLv) {
    world = w; level = lv || null; arrowLevel = arrowLv || level;
    clearGroup(ringsGroup);
    ringsGroup = new THREE.Group();
    const ringMat = widen(basic(OVERLAY_COLORS.ring, { transparent: true, opacity: 0.85, side: THREE.DoubleSide }), 'offset');
    for (const r of goalRings(world, level)) {
      const g = ringRibbon(THREE, r.r, 0.024, Math.max(48, Math.round(r.r * 90)));
      const m = new THREE.Mesh(g, ringMat);
      m.position.set(r.x, LIFT.ring, -r.y);
      m.renderOrder = 1;
      m.userData.ring = r;
      ringsGroup.add(m);
    }
    ringsGroup.visible = vis.rings;
    root.add(ringsGroup);
    refreshLegend();
  }

  function pathMesh(rec, style) {
    if (!rec) return null;
    const NN = normalizeRecord(rec);
    const p = groundPath(NN);
    if (p.count < 2) return null;
    if (style === 'senpai') return dotted(THREE, p.pts, 0.009, 0.055, widen(basic(OVERLAY_COLORS.senpai, { transparent: true, opacity: 0.9 }), 'xz'), LIFT.senpai);
    return own(dashed(THREE, p.pts, 0.012, 0.08, 0.06, widen(basic(OVERLAY_COLORS.ghost, { transparent: true, opacity: 0.6, side: THREE.DoubleSide }), 'offset'), LIFT.ghost));
  }

  /** 再生する記録（と前回・先輩の記録）。 */
  function setRecord(rec, { ghost = null, senpaiGhost = null } = {}) {
    N = normalizeRecord(rec);
    clearGroup(trail);
    const p = groundPath(N);
    trail = ribbon(THREE, p.pts, 0.018, widen(basic(OVERLAY_COLORS.trail, { side: THREE.DoubleSide }), 'offset'), LIFT.trail);
    trail.userData.frameToPt = p.frameToPt;
    trail.userData.count = p.count;
    trail.visible = vis.trail;
    root.add(trail);
    clearGroup(ghostMesh); ghostMesh = pathMesh(ghost, 'ghost'); hasGhost = !!ghostMesh;
    if (ghostMesh) { ghostMesh.visible = vis.ghost; root.add(ghostMesh); }
    clearGroup(senpaiMesh); senpaiMesh = pathMesh(senpaiGhost, 'senpai'); hasSenpai = !!senpaiMesh;
    if (senpaiMesh) { senpaiMesh.visible = vis.senpai; root.add(senpaiMesh); }
    // センサの出来事
    lidarEvents = (N.byKind.lidar || []);
    cameraEvents = (N.byKind.camera || []);
    // GNSS
    clearGroup(gnssDots); clearGroup(gnssLines); clearGroup(gnssTruthDots);
    fixes = (rec.gnssFixes || []).filter((f) => Array.isArray(f) && f[5] && Number.isFinite(f[3]) && Number.isFinite(f[4]));
    const usesGnss = (N.byKind.gnss || []).length > 0;
    if (fixes.length && usesGnss) {
      const latency = 0.3;
      const dotGeo = own(new THREE.CircleGeometry(0.06, 14).rotateX(-Math.PI / 2));
      gnssDots = new THREE.InstancedMesh(dotGeo, widen(basic(OVERLAY_COLORS.gnss, { transparent: true, opacity: 0.85 }), 'xz', 'D'), fixes.length);
      const tdGeo = own(new THREE.RingGeometry(0.03, 0.045, 12).rotateX(-Math.PI / 2));
      gnssTruthDots = new THREE.InstancedMesh(tdGeo, widen(basic(OVERLAY_COLORS.truth, { transparent: true, opacity: 0.7 }), 'xz', 'D'), fixes.length);
      const m4 = new THREE.Matrix4();
      const lp = new Float32Array(fixes.length * 6);
      fixes.forEach((f, i) => {
        m4.makeTranslation(f[3], LIFT.gnss, -f[4]); gnssDots.setMatrixAt(i, m4);
        m4.makeTranslation(f[1], LIFT.gnss, -f[2]); gnssTruthDots.setMatrixAt(i, m4);
        lp.set([f[3], LIFT.gnss, -f[4], f[1], LIFT.gnss, -f[2]], i * 6);
      });
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      gnssLines = new THREE.LineSegments(lg, own(new THREE.LineBasicMaterial({ color: OVERLAY_COLORS.gnss, transparent: true, opacity: 0.55 })));
      gnssDots.userData.times = fixes.map((f) => f[0] + latency);
      for (const o of [gnssDots, gnssTruthDots, gnssLines]) { o.frustumCulled = false; root.add(o); }
    }
    // 矢印
    tStop = finalStopTime(N);
    const fin = sampleFrame(N, N.T);
    target = arrowTarget(world, fin.x, fin.y, arrowLevel);
    refreshLegend();
  }

  /** 出し入れ。 */
  function setVisible(o = {}) {
    for (const k of OVERLAY_KEYS) if (o[k] !== undefined) vis[k] = !!o[k];
    if (o.ghost !== undefined && o.senpai === undefined) vis.senpai = !!o.ghost;
    if (o.sensors !== undefined) { vis.lidar = vis.cameraFov = !!o.sensors; }
    if (o.gnss !== undefined && o.truth === undefined) vis.truth = !!o.gnss;
    if (trail) trail.visible = vis.trail;
    if (ghostMesh) ghostMesh.visible = vis.ghost;
    if (senpaiMesh) senpaiMesh.visible = vis.senpai;
    if (ringsGroup) ringsGroup.visible = vis.rings;
    refreshLegend();
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  let lidarState = null;

  /**
   * その時刻の姿に。
   * @param {number} t @param {object} pose sampleFrame の戻り値 @param {{lidar?: object, camera?: object}} anchors 世界の位置（Vector3）
   */
  function setTime(t, pose, anchors = {}) {
    if (!N) return;
    // 今回の跡
    if (trail) {
      const k = trail.userData.frameToPt[Math.max(0, Math.min(N.n - 1, pose.i))] || 0;
      trail.geometry.setDrawRange(0, Math.max(0, (k - 1) * 6));
    }
    // LiDAR: 読んでから 0.6 s の間だけ線を出す
    lidarState = null;
    dashes.count = 0; hitDot.visible = false;
    if (vis.lidar && lidarEvents.length && pose.mode === 0 && anchors.lidar && camMode !== 'onboard') {
      const e = lastBefore(lidarEvents, t);
      if (e && t - e.t <= 0.6) {
        const v = Number.isFinite(e.v) ? e.v : null;
        const len = v === null ? 12 : Math.max(0.05, v);
        const h = pose.h * Math.PI / 180;
        const dx = Math.sin(h), dy = Math.cos(h);
        const o = anchors.lidar;
        q.setFromAxisAngle(yAxis, -h);
        let n = 0;
        for (let s = 0; s + 0.001 < len && n < nDash; s += DASH + GAP) {
          const L = Math.min(DASH, len - s);
          const mid = s + L / 2;
          pv.set(o.x + dx * mid, o.y, o.z - dy * mid);
          sc.set(1, 1, L / DASH);
          dashes.setMatrixAt(n++, m4.compose(pv, q, sc));
        }
        dashes.count = n;
        dashes.instanceMatrix.needsUpdate = true;
        if (v !== null) { hitDot.position.set(o.x + dx * len, o.y, o.z - dy * len); hitDot.visible = true; }
        lidarState = { v, t: e.t };
      }
    }
    // カメラの視野
    fov.visible = false;
    if (vis.cameraFov && cameraEvents.length && pose.mode === 0 && anchors.camera && camMode !== 'onboard') {
      const e = lastBefore(cameraEvents, t, 't_shot');
      const shooting = e && t - (e.t_shot ?? e.t) <= 0.4 + 0.25;
      fov.visible = true;
      fov.position.set(anchors.camera.x, LIFT.fov, anchors.camera.z);
      fov.rotation.set(0, -pose.h * Math.PI / 180, 0);
      fovMat.opacity = shooting ? 0.85 : 0.4;
    }
    // GNSS（測位して読めるようになった分だけ）
    if (gnssDots) {
      const times = gnssDots.userData.times;
      let n = 0;
      while (n < times.length && times[n] <= t + 1e-9) n++;
      const on = vis.gnss;
      gnssDots.visible = on; gnssDots.count = n;
      gnssTruthDots.visible = on && vis.truth; gnssTruthDots.count = n;
      gnssLines.visible = on && vis.truth; gnssLines.geometry.setDrawRange(0, n * 2);
    }
    // 矢印と札（最後に止まってから）
    arrow.visible = false;
    labelText = '';
    if (vis.arrow && target && t >= tStop - 1e-6 && pose.mode === 0) {
      const tx = target.x, ty = target.y;
      const d = Math.hypot(tx - pose.x, ty - pose.y);
      const isCone = target.type === 'cone';
      const gap = isCone ? Math.max(0, d - ROVER_DIM.bodyR - (target.r || 0.19)) : d;
      const ux = (tx - pose.x) / (d || 1), uy = (ty - pose.y) / (d || 1);
      const sx = pose.x + ux * (isCone ? ROVER_DIM.bodyR : 0), sy = pose.y + uy * (isCone ? ROVER_DIM.bodyR : 0);
      const L = isCone ? gap : d;
      if (L > 0.02 && L < 60) {
        const ang = Math.atan2(uy, ux);
        arrow.position.set(sx, LIFT.arrow, -sy);
        arrow.rotation.set(0, ang, 0);
        const shaftL = Math.max(0.001, L - 0.07);
        shaft.scale.set(shaftL, 1, 1);
        shaft.position.set(shaftL / 2, 0, 0);
        head.position.set(shaftL, 0, 0);
        arrow.visible = true;
      }
      labelText = gap < 0.005 && isCone ? 'ふれた' : (gap >= 1 ? `${gap.toFixed(1)} m` : `${Math.round(gap * 100)} cm`);   // 1 m 以上は m（「12327 cm」にしない。直し係 5）
      labelPos.set((sx + tx) / 2, 0.2, -(sy + ty) / 2);
      if (!arrow.visible) labelPos.set(pose.x, 0.32, -pose.y);
    }
  }

  /** 札を画面の位置に（描くたびに呼ぶ）。 */
  function updateLabels(camera, w, h, ox = 0, oy = 0) {
    if (!labelEl) return;
    if (!labelText) { labelEl.hidden = true; return; }
    const p = labelPos.clone().project(camera);
    if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) { labelEl.hidden = true; return; }
    labelEl.hidden = false;
    if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
    // 機体カメラは 4:3 の枠の中に描くので、その枠の位置を足す。端で字が切れないよう、枠の中に収める（「500 c」と切れていた。直し B17）
    const half = (labelEl.offsetWidth || 60) / 2 + 4;
    const lx = Math.max(ox + half, Math.min(ox + w - half, ox + (p.x + 1) / 2 * w));
    const ly = Math.max(oy + 26, oy + (1 - p.y) / 2 * h);
    labelEl.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px) translate(-50%, -100%)`;
  }

  function refreshLegend() {
    if (!legendEl) return;
    const rows = [];
    const hasLidar = lidarEvents.length > 0, hasCam = cameraEvents.length > 0, hasG = !!gnssDots;
    if (vis.trail) rows.push(['solid', OVERLAY_COLORS.trail, '今回の跡（実線）']);
    if (vis.ghost && hasGhost) rows.push(['dash', 0xffffff, '前回の跡（破線）']);
    if (vis.senpai && hasSenpai) rows.push(['dot', OVERLAY_COLORS.senpai, '先輩の跡（点線）']);
    if (vis.lidar && hasLidar) rows.push(['lidar', OVERLAY_COLORS.lidar, 'LiDAR の光（細い破線）']);
    if (vis.cameraFov && hasCam) rows.push(['fan', 0xd9c79a, 'カメラの見える範囲']);
    if (vis.gnss && hasG) rows.push(['gnss', OVERLAY_COLORS.gnss, 'GNSS の位置（青い点）']);
    if (vis.gnss && vis.truth && hasG) rows.push(['ring', OVERLAY_COLORS.truth, '本当の位置（線の先）']);
    legendEl.hidden = rows.length === 0;
    legendEl.innerHTML = rows.map(([k, c, label]) => `<div class="lg-row">${legendIcon(k, c)}<span>${label}</span></div>`).join('');
  }

  function dispose() {
    clearGroup(trail); clearGroup(ghostMesh); clearGroup(senpaiMesh); clearGroup(ringsGroup);
    clearGroup(gnssDots); clearGroup(gnssLines); clearGroup(gnssTruthDots);
    scene.remove(root);
    for (const o of owned) { try { o.dispose(); } catch { /* 無視 */ } }
    if (labelEl) labelEl.remove();
    if (legendEl) legendEl.remove();
  }

  /** 線と点の太さ（上からの絵で太くする）。 */
  function setScale(w = 1, d = 1) { uW.value = w; uD.value = d; }
  /** カメラの種類（機体カメラでは LiDAR の線と扇を出さない。カメラの絵そのものを見せる）。 */
  function setCameraMode(m) { camMode = m; }

  return {
    root, setWorld, setRecord, setVisible, setTime, updateLabels, dispose, setScale, setCameraMode,
    get scale() { return { w: uW.value, d: uD.value }; },
    get visible() { return { ...vis }; },
    get lidarState() { return lidarState; },
    get label() { return labelText; },
    get rings() { return ringsGroup ? ringsGroup.children.map((m) => m.userData.ring) : []; },
    get legendEl() { return legendEl; },
    get trailPoints() { return trail ? trail.userData.count : 0; },
    get trailDrawn() { return trail ? trail.geometry.drawRange.count / 6 + 1 : 0; },
  };
}

function mkEl(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
function legendIcon(kind, c) {
  const col = hex(c);
  const svg = (inner) => `<svg viewBox="0 0 28 10" width="28" height="10" aria-hidden="true">${inner}</svg>`;
  switch (kind) {
    case 'solid': return svg(`<line x1="1" y1="5" x2="27" y2="5" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`);
    case 'dash': return svg(`<line x1="1" y1="5" x2="27" y2="5" stroke="#8a8a84" stroke-width="2" stroke-dasharray="5 3"/>`);
    case 'dot': return svg(`<line x1="2" y1="5" x2="27" y2="5" stroke="${col}" stroke-width="2.6" stroke-dasharray="0.1 4.4" stroke-linecap="round"/>`);
    case 'lidar': return svg(`<line x1="1" y1="5" x2="22" y2="5" stroke="${col}" stroke-width="1.4" stroke-dasharray="3 2"/><circle cx="24.5" cy="5" r="2.2" fill="${col}"/>`);
    case 'fan': return svg(`<path d="M2 5 L27 0.5 L27 9.5 Z" fill="${col}" opacity="0.7"/>`);
    case 'gnss': return svg(`<circle cx="8" cy="5" r="3" fill="${col}"/><circle cx="19" cy="4" r="3" fill="${col}"/>`);
    case 'ring': return svg(`<line x1="5" y1="5" x2="20" y2="5" stroke="#2f6f9f" stroke-width="1.2"/><circle cx="5" cy="5" r="2.6" fill="#2f6f9f"/><circle cx="22" cy="5" r="2.6" fill="none" stroke="${col}" stroke-width="1.3"/>`);
    default: return '';
  }
}

/** t より前の最後の出来事（key の時刻で）。 */
function lastBefore(arr, t, key = 't') {
  let lo = 0, hi = arr.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; const v = arr[m][key] ?? arr[m].t; if (v <= t + 1e-9) { ans = arr[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** 地面の帯（幅 w、点の並び pts = [x, y, …]）。drawRange で途中まで描ける（1 区間 = 6 添え字）。 */
function ribbon(THREE, pts, w, mat, lift) {
  const n = pts.length / 2;
  const pos = new Float32Array(Math.max(n, 2) * 2 * 3);
  const off = new Float32Array(Math.max(n, 2) * 2 * 2);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let dx = pts[b * 2] - pts[a * 2], dy = pts[b * 2 + 1] - pts[a * 2 + 1];
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const nx = -dy * w / 2, ny = dx * w / 2;
    const x = pts[i * 2], y = pts[i * 2 + 1];
    pos.set([x + nx, lift, -(y + ny), x - nx, lift, -(y - ny)], i * 6);
    off.set([nx, -ny, -nx, ny], i * 4);
    if (i < n - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('offset', new THREE.BufferAttribute(off, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 2;
  return m;
}

/** 破線の帯。 */
function dashed(THREE, pts, w, dash, gap, mat, lift) {
  const n = pts.length / 2;
  const pos = [], off = [];
  let s = 0, on = true, left = dash;
  let cur = null;
  const quad = (ax, ay, bx, by) => {
    const L = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / L * w / 2, ny = (bx - ax) / L * w / 2;
    pos.push(ax + nx, lift, -(ay + ny), ax - nx, lift, -(ay - ny), bx + nx, lift, -(by + ny),
      ax - nx, lift, -(ay - ny), bx - nx, lift, -(by - ny), bx + nx, lift, -(by + ny));
    off.push(nx, -ny, -nx, ny, nx, -ny, -nx, ny, -nx, ny, nx, -ny);
  };
  for (let i = 0; i < n - 1; i++) {
    let ax = pts[i * 2], ay = pts[i * 2 + 1];
    const bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
    let L = Math.hypot(bx - ax, by - ay);
    while (L > 1e-9) {
      const step = Math.min(left, L);
      const f = step / L;
      const cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f;
      if (on) { if (!cur) cur = [ax, ay]; quad(ax, ay, cx, cy); }
      ax = cx; ay = cy; L -= step; left -= step; s += step;
      if (left <= 1e-9) { on = !on; left = on ? dash : gap; cur = null; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('offset', new THREE.Float32BufferAttribute(off, 2));
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 2;
  return m;
}

/** 輪の帯（中心が原点、半径 r、幅 w）。offset 属性つき。 */
function ringRibbon(THREE, r, w, seg) {
  const pos = new Float32Array((seg + 1) * 6), off = new Float32Array((seg + 1) * 4);
  const idx = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.set([c * (r + w / 2), 0, -s * (r + w / 2), c * (r - w / 2), 0, -s * (r - w / 2)], k * 6);
    off.set([c * w / 2, -s * w / 2, -c * w / 2, s * w / 2], k * 4);
    if (k < seg) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('offset', new THREE.BufferAttribute(off, 2));
  g.setIndex(idx);
  return g;
}

/** 点線（小さな円をならべる）。 */
function dotted(THREE, pts, r, step, mat, lift) {
  const n = pts.length / 2;
  const centers = [];
  let left = 0;
  for (let i = 0; i < n - 1; i++) {
    let ax = pts[i * 2], ay = pts[i * 2 + 1];
    const bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
    let L = Math.hypot(bx - ax, by - ay);
    while (L >= left) {
      const f = L > 0 ? left / L : 0;
      ax += (bx - ax) * f; ay += (by - ay) * f; L -= left;
      centers.push(ax, ay);
      left = step;
      if (L < step) break;
    }
    left -= L;
  }
  const geo = new THREE.CircleGeometry(r, 10).rotateX(-Math.PI / 2);
  const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, centers.length / 2));
  const m4 = new THREE.Matrix4();
  for (let k = 0; k < centers.length / 2; k++) inst.setMatrixAt(k, m4.makeTranslation(centers[k * 2], lift, -centers[k * 2 + 1]));
  inst.count = centers.length / 2;
  inst.frustumCulled = false;
  inst.renderOrder = 2;
  return inst;
}

/** 扇（地面、頂点の色の濃さで先へ薄く）。−Z が前。 */
function fanGeometry(THREE, deg, len, seg) {
  const half = deg / 2 * Math.PI / 180;
  const pos = [0, 0, 0], col = [1, 1, 1, 0.55];
  for (let i = 0; i <= seg; i++) {
    const a = -half + (2 * half) * (i / seg);
    pos.push(Math.sin(a) * len, 0, -Math.cos(a) * len);
    col.push(1, 1, 1, 0.0);
  }
  const idx = [];
  for (let i = 1; i <= seg; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
