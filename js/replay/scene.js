/**
 * @file app/js/replay/scene.js
 * 持ち主: W5（3D と再生）
 * 役割: 3D の場面（会場・ローバー・物・地面に描くもの・カメラ）をまとめて持ち、記録の時刻に合わせて動かす。
 *       あわせて 3D の区画の HUD・カメラの切りかえ・世界の切りかえ、タイトルの背景の 3D、全部を組み合わせる mountReplay を出す。
 * SPEC: 7.3「W5 js/replay/*」・3.4「右上: 3D」・10.4（3D）・3.5（演出）・3.2（タイトルの背景）・3.9（画質）・12 章（3D の fps）
 *
 * 見た目は自然な空・砂・芝の色と質感。ネオン・光る線・発光（bloom・emissive）・加算の合成は使わない（10.1）。
 * three は import map の "three"（0.160.0、7.2）から読む。
 */
import * as THREE from 'three';
import { createRoverModel, ROVER_DIM } from './rover_model.js';
import { buildVenue, buildObjects, createParachute, createTextureBank, courseBounds, venueStyle } from './venues3d.js';
import { createOverlays, arrowTarget, finalStopTime } from './overlays.js';
import { createCameraRig, CAMERA_LABELS, CAMERA_MODES, horizontalFov } from './camera_rig.js';
import { normalizeRecord, sampleFrame, Player } from './player.js';
import { Timeline, defaultSpeedFor } from './timeline.js';
import { Graphs, defaultGraphKinds } from './graphs.js';

const DEG = Math.PI / 180;
export const CANVAS_LABEL = 'ローバーとコーンの 3D。結果は下の欄に文字で出ます';

/** 画質（3.9）。軽い = 影なし・木を減らす・画素を粗く。 */
export const QUALITY = Object.freeze({
  // 軽い: 画素を 0.75 倍で描いて広げる（遅い端末・ソフトウェアの描画で 30 fps を保つ。12 章）
  light: { shadows: false, shadowMap: 0, pixelRatio: 0.75, antialias: false, env: false },
  normal: { shadows: true, shadowMap: 1024, pixelRatio: 1.5, antialias: true, env: true },
  fine: { shadows: true, shadowMap: 2048, pixelRatio: 2, antialias: true, env: true },
});

/** 動きを減らす設定か（OS の prefers-reduced-motion か、設定の「動きを減らす」= html[data-reduced-motion]）。 */
export function prefersReducedMotion() {
  try {
    if (document.documentElement.dataset.reducedMotion === 'true') return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch { return false; }
}

/**
 * 遅い端末か（自動の画質で「軽い」にする）。ソフトウェアの描画・2 コア以下・メモリ 2 GB 以下。
 * @param {object} [renderer] three の WebGLRenderer（描画の装置の名前を見る）
 */
export function detectSlowDevice(renderer) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const reasons = [];
  if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) reasons.push('cpu');
  if (nav.deviceMemory && nav.deviceMemory <= 2) reasons.push('memory');
  try {
    const gl = renderer && renderer.getContext();
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(name)) reasons.push('software');
  } catch { /* 無視 */ }
  return reasons;
}

/**
 * @typedef {object} Scene
 * @property {(world: object, venue: object|string, opts?: {level?: object}) => void} loadWorld 世界（6.10）と会場（data/venues.json の 1 つ）を置く
 * @property {(record: object, opts?: {ghost?: object|null, senpaiGhost?: object|null}) => void} setRecord 再生する記録（前回・先輩の記録を重ねる）
 * @property {(t: number) => void} setTime その時刻の姿にする（frames を補間）
 * @property {(mode: 'follow'|'top'|'onboard') => void} setCamera 追従・上から・機体カメラ（水平 62.2°）
 * @property {(o: object) => void} setOverlays 地面に描くものの出し入れ
 * @property {(kind: 'wiggle'|'tilt'|'leaves') => Promise<void>} celebrate 揺れる・首をかしげる・葉が舞う
 * @property {() => void} dispose 片づけ（WebGL の資源を返す）
 */

/**
 * 3D の場面を作る。canvas は role="img"・aria-label「ローバーとコーンの 3D。結果は下の欄に文字で出ます」（3.4）。
 * @param {HTMLElement} el 入れる要素（中に .canvas-slot があればそこに canvas を入れる）
 * @param {{quality?: 'light'|'normal'|'fine'|'auto', reducedMotion?: boolean, onQuality?: (q: string, why: string[]) => void}} [opts]
 * @returns {Scene & object}
 */
export function createScene(el, opts = {}) {
  const wanted = opts.quality || 'auto';
  const reduced = () => (opts.reducedMotion !== undefined ? !!opts.reducedMotion : prefersReducedMotion());
  const slot = (el.querySelector && el.querySelector('.canvas-slot')) || el;
  // 画質は WebGL を作ってから決める（自動の時は描画の装置を見る）
  let quality = wanted === 'auto' ? 'normal' : wanted;
  let Q = QUALITY[quality] || QUALITY.normal;
  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'light', powerPreference: 'high-performance', alpha: false, stencil: false });
  let autoReasons = [];
  if (wanted === 'auto') {
    autoReasons = detectSlowDevice(renderer);
    if (autoReasons.length) { quality = 'light'; Q = QUALITY.light; }
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', CANVAS_LABEL);
  canvas.classList.add('replay-canvas');
  canvas.tabIndex = -1;
  slot.appendChild(canvas);
  const placeholder = el.querySelector && el.querySelector('.placeholder');
  if (placeholder) placeholder.hidden = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.03, 1500);
  let dirty = true;
  const invalidate = () => { dirty = true; };
  const bank = createTextureBank(THREE, renderer, { quality, onChange: invalidate });

  // ---- 空（上が淡い青・地平線が白っぽい）と霧
  const skyU = { top: { value: new THREE.Color(0xbcd8ec) }, horizon: { value: new THREE.Color(0xeef2ee) }, ground: { value: new THREE.Color(0xc9c6b4) } };
  // 空の球はいつもカメラの所に置く（高い所から見ても遠くの面で切れない）
  const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vP;
      void main(){ float y = vP.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(clamp(y * 1.6, 0.0, 1.0), 0.75)) : mix(horizon, ground, clamp(-y * 6.0, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
      }`,
  }));
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  scene.fog = new THREE.Fog(0xeef2ee, 50, 220);
  const farGround = new THREE.Mesh(new THREE.CircleGeometry(4000, 48), new THREE.MeshLambertMaterial({ color: 0x6f8e4c }));
  farGround.rotation.x = -Math.PI / 2;
  farGround.position.y = -0.3;      // 一番低い海（-0.2）より下
  farGround.userData.noOcclude = true;
  farGround.renderOrder = -5;
  scene.add(farGround);
  scene.background = new THREE.Color(0xeef2ee);

  // ---- 光: 空からの柔らかい光＋太陽の平行光（影は柔らかく）
  const hemi = new THREE.HemisphereLight(0xe4eef5, 0x76704f, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
  sun.castShadow = Q.shadows;
  scene.add(sun);
  scene.add(sun.target);
  let sunDir = new THREE.Vector3(-0.5, 0.8, 0.35).normalize();
  function applyShadowQuality() {
    renderer.shadowMap.enabled = Q.shadows;
    sun.castShadow = Q.shadows;
    if (Q.shadows) {
      sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
      const r = quality === 'fine' ? 9 : 6.5;
      Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 80 });
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.015;
      sun.shadow.radius = 3;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
  }
  applyShadowQuality();

  // 水面の弱い反射用の空の絵（ふつう・きれい）
  let envTex = null;
  function buildEnv() {
    if (envTex || !Q.env) return;
    try {
      const pm = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(sky.clone());
      envTex = pm.fromScene(envScene, 0.02).texture;
      pm.dispose();
    } catch { envTex = null; }
  }

  // ---- ローバー・パラ
  let rover = createRoverModel(THREE, { quality });
  scene.add(rover.group);
  const chute = createParachute(THREE, { quality });
  scene.add(chute.group);
  scene.add(chute.tether);
  chute.setMode('hidden');
  const pack = chute.pack;
  rover.body.add(pack);
  pack.position.set(0, 0.075, 0.02);

  // ---- カメラ・地面に描くもの
  // from（ローバー）から to（カメラ）までの間にある物（壁・生け垣・木・建物）までの距離（直し A-3・B12・直し係 5）。
  // 何回測るかはカメラの係が決める（少し動いた時だけ）。低い物（地面・草・線・小石）は見下ろせるので数えない。
  // 前は「当たった点の高さ 0.3 m 未満」で外していたので、斜め下を通る線が生け垣（高さ 0.62 m）の下のほうに当たっても数えなかった
  const ray = new THREE.Raycaster();
  const boxTmp = new THREE.Box3();
  /** 物の上の端の高さ（世界の座標。物は動かないので覚えておく）。 */
  function topOf(obj) {
    const u = obj.userData || (obj.userData = {});
    if (Number.isFinite(u._topY)) return u._topY;
    let top = Infinity;
    try {
      if (obj.isInstancedMesh) { if (!obj.boundingBox) obj.computeBoundingBox(); boxTmp.copy(obj.boundingBox); }
      else { const g = obj.geometry; if (!g.boundingBox) g.computeBoundingBox(); boxTmp.copy(g.boundingBox); }
      obj.updateWorldMatrix(true, false);
      boxTmp.applyMatrix4(obj.matrixWorld);
      top = boxTmp.max.y;
    } catch { /* 分からない時は高い物とみなす */ }
    u._topY = top;
    return top;
  }
  // 上の端がこれより低い物は隠す物に数えない（地面・草・小石）。前は 0.3 m で、低いカメラから見ると高さ 0.25 m の岩の
  // 向こうのローバーが隠れても数えなかった（6-4 の間違い・動きを減らす設定。直し係 6）。ローバーの胴の上の端（約 0.13 m）より低い物だけ
  const LOW_TOP = 0.12;
  function clipCam(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-3) return Infinity;
    ray.set(from, dir.normalize());
    ray.far = len;
    const targets = [venueObj && venueObj.group, objects && objects.group].filter(Boolean);
    try {
      for (const h of ray.intersectObjects(targets, true)) {
        if (h.object.userData && h.object.userData.noOcclude) continue;
        if (!h.object.visible) continue;
        const m = h.object.userData._fadeOrig || h.object.material;   // 半透明にした物は元の材質で数える（直し係 6）
        if (m && (m.transparent && m.opacity < 0.6)) continue;  // 薄い物（輪・線・水）
        if (topOf(h.object) < LOW_TOP) continue;                // 低い物（地面・草・小石）は見下ろせる
        return h.distance;
      }
    } catch { /* 無視 */ }
    return Infinity;
  }
  // ---- どの候補でもローバーが隠れる時、隠している物（その物のまとまりごと）を半透明にする（直し係 6）
  // 9-4 のスターターで、世界 2 のローバーが高所作業車の下に入り、カメラが車体の中に入って画面が黄色一色になった
  const faded = new Map();          // Mesh → 元の材質
  const fadeMat = new Map();        // 元の材質 → 半透明の写し
  const fadeOf = (m) => {
    if (!fadeMat.has(m)) {
      const f = m.clone();
      f.transparent = true; f.opacity = 0.3; f.depthWrite = false;
      fadeMat.set(m, f);
    }
    return fadeMat.get(m);
  };
  /** 会場か物の入れ物の、すぐ下のまとまり（作業車・木・建物）。 */
  function unitOf(o) {
    const tops = [venueObj && venueObj.group, objects && objects.group];
    let x = o;
    while (x.parent && !tops.includes(x.parent) && x.parent !== scene) x = x.parent;
    return x;
  }
  const revealRay = new THREE.Raycaster();
  const rvA = new THREE.Vector3(), rvB = new THREE.Vector3();
  function blockersBetween(a, b, out) {
    const dir = rvB.copy(b).sub(a);
    const len = dir.length();
    if (len < 1e-3) return;
    revealRay.set(a, dir.normalize());
    revealRay.far = len;
    const targets = [venueObj && venueObj.group, objects && objects.group].filter(Boolean);
    for (const h of revealRay.intersectObjects(targets, true)) {
      const o = h.object;
      if (!o.isMesh || (o.userData && o.userData.noOcclude) || !o.visible) continue;
      const m = o.userData._fadeOrig || o.material;
      if (m && m.transparent && m.opacity < 0.6) continue;
      if (topOf(o) < LOW_TOP) continue;
      out.add(unitOf(o));
    }
  }
  function reveal(target, camPos) {
    const units = new Set();
    if (target) {
      for (const dy of [0.06, -0.07]) {
        rvA.copy(target); rvA.y += dy;
        blockersBetween(rvA, camPos, units);
        blockersBetween(camPos.clone(), rvA.clone(), units);   // カメラが物の中にある時（外向きの面は当たらない）
      }
    }
    const want = new Set();
    for (const u of units) u.traverse((x) => { if (x.isMesh && !Array.isArray(x.material)) want.add(x); });
    let changed = false;
    for (const [mesh, orig] of faded) {
      if (want.has(mesh)) continue;
      mesh.material = orig; delete mesh.userData._fadeOrig; faded.delete(mesh); changed = true;
    }
    for (const mesh of want) {
      if (faded.has(mesh)) continue;
      faded.set(mesh, mesh.material); mesh.userData._fadeOrig = mesh.material; mesh.material = fadeOf(mesh.material); changed = true;
    }
    if (changed) invalidate();
  }
  function clearReveal() {
    for (const [mesh, orig] of faded) { mesh.material = orig; delete mesh.userData._fadeOrig; }
    faded.clear();
    for (const f of fadeMat.values()) f.dispose();
    fadeMat.clear();
  }
  const rig = createCameraRig(THREE, camera, canvas, { reducedMotion: reduced, onChange: invalidate, clip: clipCam, reveal });
  // 上から見た時の物の名札（旗・コーン・マーカー。点にしか見えないので名前を出す。直し B12）
  const tagLayer = document.createElement('div');
  tagLayer.className = 'top-tags';
  el.appendChild(tagLayer);
  let tagItems = [];
  function buildTags(w) {
    tagLayer.textContent = '';
    tagItems = [];
    for (const o of (w && w.objects) || []) {
      if (!['flag', 'cone', 'marker'].includes(o.type) || !Number.isFinite(o.x)) continue;
      const d = document.createElement('span');
      d.className = `top-tag tt-${o.type}`;
      d.textContent = o.label || (o.type === 'cone' ? 'コーン' : o.type === 'marker' ? `マーカー ${o.code ?? ''}` : `旗 ${o.id}`);
      tagLayer.appendChild(d);
      tagItems.push({ el: d, p: new THREE.Vector3(o.x, o.type === 'cone' ? 0.45 : 0.6, -o.y) });
    }
  }
  function updateTags(w, h) {
    const on = rig.mode === 'top';
    tagLayer.hidden = !on;
    if (!on) return;
    for (const it of tagItems) {
      const p = it.p.clone().project(camera);
      const vis = p.z <= 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      it.el.hidden = !vis;
      if (vis) it.el.style.transform = `translate(${((p.x + 1) / 2 * w).toFixed(1)}px, ${((1 - p.y) / 2 * h).toFixed(1)}px) translate(-50%, -130%)`;
    }
  }
  const overlays = createOverlays(THREE, scene, { container: el, quality });
  const capEl = document.createElement('div');
  capEl.className = 'onboard-cap';
  capEl.textContent = `機体カメラ（水平 ${ROVER_DIM.camHFov}°・高さ ${ROVER_DIM.camH} m）`;
  capEl.hidden = true;
  el.appendChild(capEl);

  // ---- 状態
  let world = null, venueObj = null, venueRef = null, levelRef = null, arrowLevelRef = null, objects = null;
  let N = null, record = null, ghosts = {};
  let curT = 0;
  let pose = sampleFrame(normalizeRecord({ fields: ['t'], frames: [0] }), 0);
  let nichromeSpans = [], sepT = Infinity, chuteOpenT = Infinity, landedT = Infinity;
  const anchors = { lidar: new THREE.Vector3(), camera: new THREE.Vector3(), cameraQuat: new THREE.Quaternion(), tether: new THREE.Vector3() };
  const listeners = { quality: new Set(), render: new Set() };
  const emit = (n, v) => { for (const f of listeners[n]) { try { f(v); } catch (e) { console.error(e); } } };
  const anims = [];

  /** 世界と会場を置く。 */
  function loadWorld(w, venue, { level, arrowLevel } = {}) {
    world = w || { objects: [] };
    venueRef = venue || world.venue_key;
    levelRef = level || levelRef;
    arrowLevelRef = arrowLevel || level || arrowLevelRef;   // 札の行き先だけに使う面（遊ぶ画面。ゴールの輪は変えない。直し係 6）
    clearReveal();
    if (venueObj) { scene.remove(venueObj.group); venueObj.dispose(); }
    if (objects) { scene.remove(objects.group); objects.dispose(); }
    const vkey = typeof venueRef === 'string' ? venueRef : (venueRef && (venueRef.key || venueRef.venue_key)) || world.venue_key || 'funabashi';
    const style = venueStyle(vkey);
    // 夕方の色の設定（html[data-theme="dusk"]）では、空と光も夕方に（直し C13）
    const dusk = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dusk';
    const skyTop = dusk ? 0x7f8db0 : style.sky[0], skyHor = dusk ? 0xefc8a2 : style.sky[1];
    skyU.top.value.setHex(skyTop);
    skyU.horizon.value.setHex(skyHor);
    scene.fog.color.setHex(skyHor);
    scene.background.setHex(skyHor);
    scene.fog.near = style.fog[0]; scene.fog.far = style.fog[1];
    sunDir = dusk ? new THREE.Vector3(style.sun[0] * 1.6, 0.32, style.sun[2] * 1.6).normalize() : new THREE.Vector3(...style.sun).normalize();
    hemi.intensity = dusk ? 0.95 : 1.35;
    hemi.color.setHex(dusk ? 0xe8d6c8 : 0xe4eef5);
    sun.color.setHex(dusk ? 0xffc48a : 0xfff1dc);
    sun.intensity = dusk ? 1.7 : 2.3;
    // 遠くまで続く地面（投下の高い所から見ても、地面の端が見えて宙に浮いた島に見えないように。霧に溶ける。直し C9）
    const gcol = { grass: 0x6f8e4c, concrete: 0x9a978c, dune: 0xcdb48a }[style.ground] || 0x7d8a5a;
    farGround.material.color.setHex(gcol);
    skyU.ground.value.setHex(dusk ? 0x8a7d62 : gcol);
    venueObj = buildVenue(THREE, vkey, { quality, world, bank });
    scene.add(venueObj.group);
    objects = buildObjects(THREE, world, { quality, bank });
    scene.add(objects.group);
    // 1 枚目を描く前に物の位置の行列を作る（追従カメラがすぐに生け垣・壁を光線で調べられるように。直し係 5）
    venueObj.group.updateMatrixWorld(true);
    objects.group.updateMatrixWorld(true);
    buildEnv();
    scene.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) if (m && m.userData && m.userData.water && envTex) { m.envMap = envTex; m.needsUpdate = true; }
    });
    overlays.setWorld(world, levelRef, arrowLevelRef);
    buildTags(world);
    const b = courseBounds(world, 1.2);
    rig.fitTop(b, aspectNow());
    rig.snap();
    if (record) setRecord(record, ghosts);
    else {
      // 実行の前: ローバーはスタートの位置と向き（6-1・6-2・7-1・9-3 は北以外を向いて始まる）
      const st = world.start || {};
      pose = { ...pose, x: Number(st.x) || 0, y: Number(st.y) || 0, z: 0, h: Number(st.heading) || 0, v: 0, mode: 0, inv: 0, cx: NaN, cy: NaN };
      applyPose(pose, 0);
    }
    invalidate();
  }

  /** 再生する記録。 */
  function setRecord(rec, g = {}) {
    record = rec;
    ghosts = { ghost: g.ghost || null, senpaiGhost: g.senpaiGhost || null };
    N = normalizeRecord(rec);
    overlays.setRecord(rec, ghosts);
    // 溶断の時間（on〜off）・分離・パラが開いた・着地
    nichromeSpans = [];
    let on = null;
    for (const e of N.byKind.nichrome || []) {
      if (e.on && on === null) on = e.t;
      else if (!e.on && on !== null) { nichromeSpans.push([on, e.t]); on = null; }
    }
    if (on !== null) nichromeSpans.push([on, Infinity]);
    sepT = ((N.byKind.separated || [])[0] || { t: Infinity }).t;
    chuteOpenT = ((N.byKind.chute_open || [])[0] || { t: Infinity }).t;
    landedT = ((N.byKind.landed || [])[0] || { t: Infinity }).t;
    // 吊るす所（最初のコマが つり下げ なら）
    if (venueObj && venueObj.carrier && N.col.mode[0] === 1) venueObj.carrier.setTarget(N.col.x[0], N.col.y[0], N.col.z[0]);
    // 上からの絵: 世界と走った所を全部入れる（余白は小さめ。ローバーと旗が小さくなりすぎないように。直し A-19）
    const b = courseBounds(world || { objects: [] }, 1.2);
    for (let i = 0; i < N.n; i += 5) {
      if (N.col.mode[i] !== 0) continue;
      b.x0 = Math.min(b.x0, N.col.x[i] - 0.8); b.x1 = Math.max(b.x1, N.col.x[i] + 0.8);
      b.y0 = Math.min(b.y0, N.col.y[i] - 0.8); b.y1 = Math.max(b.y1, N.col.y[i] + 0.8);
    }
    rig.fitTop(b, aspectNow());
    rig.snap();
    resetCelebration();
    setTime(0);
  }

  const qTmp = new THREE.Quaternion();
  /** その時刻の姿にする。 */
  function setTime(t) {
    if (!N) return;
    curT = t;
    pose = sampleFrame(N, t, pose);
    resetCelebration();
    applyPose(pose, t);
    dirty = true;
  }

  function applyPose(p, t) {
    rover.group.position.set(p.x, Math.max(0, p.z || 0), -p.y);
    rover.group.rotation.set(0, -p.h * DEG, 0);
    rover.setInverted(p.inv > 0.5);
    rover.setWheels(p.angL, p.angR);
    const nich = nichromeSpans.some(([a, b]) => t >= a && t < b) && t < sepT + 0.25;
    rover.setNichrome(nich);
    rover.group.updateMatrixWorld(true);
    rover.lidarAnchor.getWorldPosition(anchors.lidar);
    rover.cameraAnchor.getWorldPosition(anchors.camera);
    rover.body.getWorldQuaternion(anchors.cameraQuat);
    rover.tetherAnchor.getWorldPosition(anchors.tether);
    // パラと吊りひも
    const mode = p.mode | 0;
    const carrier = venueObj && venueObj.carrier;
    if (carrier) carrier.setRope(mode === 1 ? anchors.tether : null);
    pack.visible = mode === 1 || mode === 2;
    if (mode === 3) {
      chute.setMode('air');
      const open = Math.max(0.15, Math.min(1, (t - chuteOpenT) / 0.6 + 0.15));
      chute.group.position.set(p.x, (p.z || 0) + 0.25 + 1.25 * open, -p.y);
      chute.canopy.scale.set(open, 0.62 * open, open);
      chute.setLinesTo(anchors.tether);
      chute.setTether(null);
    } else if (mode === 0 && Number.isFinite(p.cx) && Number.isFinite(p.cy)) {
      chute.setMode('ground');
      chute.group.position.set(p.cx, 0, -p.cy);
      chute.canopy.scale.set(1, 0.62, 1);
      // ひも（分離まで）。布のふちの、機体に近い所へ
      if (t < sepT) {
        const dx = p.x - p.cx, dy = p.y - p.cy, d = Math.hypot(dx, dy) || 1;
        const ex = p.cx + dx / d * chute.R * 0.9, ey = p.cy + dy / d * chute.R * 0.9;
        chute.setTether(anchors.tether, new THREE.Vector3(ex, 0.03, -ey));
      } else chute.setTether(null);
    } else {
      chute.setMode('hidden');
      chute.setTether(null);
    }
    overlays.setTime(t, p, anchors);
  }

  function setCamera(mode) {
    if (!CAMERA_MODES.includes(mode)) return;
    rig.setMode(mode);
    overlays.setCameraMode(mode);
    if (N) applyPose(pose, curT);
    rig.update(0, pose, anchors);     // すぐに新しいカメラの位置へ（次のコマを待たない）
    capEl.hidden = mode !== 'onboard';
    resize();
    invalidate();
  }

  function setOverlays(o) { overlays.setVisible(o || {}); invalidate(); }

  // ---- 演出（3.5）: 揺れる・首をかしげる・葉が舞う。reduced-motion では止める
  function resetCelebration() {
    if (!anims.length) { rover.pivot.rotation.set(0, 0, 0); return; }
  }
  function celebrate(kind) {
    if (reduced()) return Promise.resolve();
    return new Promise((resolve) => {
      if (kind === 'wiggle') {
        const dur = 0.9;
        anims.push({ t: 0, dur, step(a) { rover.pivot.rotation.y = Math.sin(a * Math.PI * 2 * 2.5) * 0.2 * (1 - a); rover.pivot.rotation.z = Math.sin(a * Math.PI * 2 * 2.5 + 0.6) * 0.06 * (1 - a); }, end() { rover.pivot.rotation.set(0, 0, 0); resolve(); } });
      } else if (kind === 'tilt') {
        const tg = arrowTarget(world, pose.x, pose.y, arrowLevelRef);
        let turn = Math.PI;
        if (tg) {
          const want = Math.atan2(tg.x - pose.x, tg.y - pose.y);      // 北 0・時計回り
          turn = -(((want - pose.h * DEG) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
        }
        anims.push({ t: 0, dur: 1.0, step(a) {
          const k = Math.min(1, a / 0.5);
          const e = 1 - Math.pow(1 - k, 3);
          rover.pivot.rotation.y = turn * e;
          const tilt = a < 0.5 ? 0 : Math.sin(Math.min(1, (a - 0.5) / 0.25) * Math.PI / 2) * 0.28;
          rover.pivot.rotation.z = tilt;
        }, end() { resolve(); } });
      } else if (kind === 'leaves') {
        spawnLeaves(resolve);
      } else resolve();
      invalidate();
    });
  }
  function spawnLeaves(done) {
    const n = quality === 'light' ? 36 : 70;
    const geo = new THREE.PlaneGeometry(0.035, 0.022);
    const colors = [0x6f9a48, 0x88ad57, 0x5d8a3d, 0xf0d2d8, 0xf5ece0, 0xe9c9cf];
    const mats = colors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }));
    const g = new THREE.Group();
    const parts = [];
    const cx = pose.x, cy = pose.y, cz = Math.max(0, pose.z || 0);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mats[i % mats.length]);
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.9;
      m.position.set(cx + Math.cos(a) * r, cz + 0.9 + Math.random() * 0.9, -(cy + Math.sin(a) * r));
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      m.userData.v = { vy: -(0.45 + Math.random() * 0.4), ph: Math.random() * 6, sw: 0.25 + Math.random() * 0.3, spin: (Math.random() - 0.5) * 6 };
      g.add(m); parts.push(m);
    }
    scene.add(g);
    let last = 0;
    anims.push({ t: 0, dur: 1.7, step(a, dt) {
      void last;
      for (const m of parts) {
        const v = m.userData.v;
        m.position.y = Math.max(0.01, m.position.y + v.vy * dt);
        m.position.x += Math.sin(a * 9 + v.ph) * v.sw * dt;
        m.rotation.x += v.spin * dt; m.rotation.z += v.spin * 0.7 * dt;
      }
      g.traverse((o) => { if (o.material && a > 0.75) { o.material.transparent = true; o.material.opacity = Math.max(0, (1 - a) / 0.25); } });
    }, end() { scene.remove(g); geo.dispose(); for (const m of mats) m.dispose(); done(); } });
  }

  // ---- 描く
  let raf = null, lastNow = 0, alive = true;
  const frameTimes = [];
  let slowSince = null;
  function aspectNow() { const w = slot.clientWidth || el.clientWidth || 640, h = slot.clientHeight || el.clientHeight || 360; return w / Math.max(1, h); }
  function resize() {
    const w = Math.max(1, slot.clientWidth || el.clientWidth || 640), h = Math.max(1, slot.clientHeight || el.clientHeight || 360);
    const pr = Math.min(window.devicePixelRatio || 1, Q.pixelRatio);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    canvas.style.width = '100%'; canvas.style.height = '100%';
    if (rig.mode !== 'onboard') { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    dirty = true;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(slot); else window.addEventListener('resize', resize);
  resize();

  function render() {
    // setViewport・setScissor は CSS の画素で渡す（three が画素の倍率を掛ける。倍率が 1 でない時に絵がずれないように）
    const pr = renderer.getPixelRatio();
    const w = canvas.width / pr, h = canvas.height / pr;
    const vp = rig.getViewport(w, h);
    // 上からの絵では線と点を太く
    if (rig.mode === 'top') { const th = rig.top.height; overlays.setScale(Math.min(14, Math.max(1, th / 5)), Math.min(6, Math.max(1, th / 12))); }
    else overlays.setScale(1, 1);
    overlays.setCameraMode(rig.mode);
    // 太陽と影の範囲を見ている所に
    const focus = rig.mode === 'top' ? new THREE.Vector3(rig.top.cx, 0, -rig.top.cy) : rover.group.position;
    sun.position.copy(focus).addScaledVector(sunDir, 40);
    sun.target.position.copy(focus);
    sun.target.updateMatrixWorld();
    if (rig.mode === 'onboard') {
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
      renderer.setClearColor(0x2b2f33, 1); renderer.clear();
      renderer.setViewport(vp.x, vp.y, vp.w, vp.h); renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
      rover.group.visible = false;       // 自分の機体は映らない
      pack.visible = false;
    } else {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      rover.group.visible = true;
    }
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
    rover.group.visible = true;
    overlays.updateLabels(camera, vp.w, vp.h, vp.x, h - vp.y - vp.h);
    updateTags(w, h);
    emit('render', curT);
  }

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    let busy = false;
    if (rig.update(dt, pose, anchors)) busy = true;
    rover.update(dt);
    if (rover.smoking) busy = true;
    if (anims.length) {
      busy = true;
      for (let i = anims.length - 1; i >= 0; i--) {
        const a = anims[i];
        a.t += dt;
        const k = Math.min(1, a.t / a.dur);
        a.step(k, dt);
        if (k >= 1) { anims.splice(i, 1); a.end(); }
      }
    }
    if (titleMotion) { titleMotion(dt); busy = true; }
    if (!(dirty || busy)) { frameTimes.length = 0; return; }
    dirty = false;
    render();
    // fps を数える（続けて描いている時だけ）
    frameTimes.push(now);
    while (frameTimes.length > 120) frameTimes.shift();
    if (wanted === 'auto' && quality !== 'light' && frameTimes.length >= 90) {
      const fps = currentFps();
      if (fps < 36) { if (slowSince === null) slowSince = now; else if (now - slowSince > 3000) setQuality('light', ['fps']); }
      else slowSince = null;
    }
  }
  function currentFps() {
    if (frameTimes.length < 10) return null;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    return span > 0 ? (frameTimes.length - 1) * 1000 / span : null;
  }
  raf = requestAnimationFrame(frame);

  /** 画質を変える（設定・自動）。 */
  function setQuality(q, why = []) {
    if (!QUALITY[q] || q === quality) return;
    quality = q; Q = QUALITY[q];
    applyShadowQuality();
    resize();
    // 木の数・影が変わるので作り直す
    scene.remove(rover.group); rover.dispose();
    rover = createRoverModel(THREE, { quality });
    rover.body.add(pack);
    scene.add(rover.group);
    if (world) loadWorld(world, venueRef, { level: levelRef, arrowLevel: arrowLevelRef });
    else invalidate();
    emit('quality', { quality, why });
    if (opts.onQuality) opts.onQuality(quality, why);
  }

  // ---- タイトルの背景（ローバーがゆっくり往復・カメラがゆっくり回る）
  let titleMotion = null;
  function startTitleMotion() {
    const cone = ((world && world.objects) || []).find((o) => o.type === 'cone') || { x: 0, y: 3 };
    let tt = 0;
    const look = new THREE.Vector3();
    const L = Math.max(1.5, Math.hypot(cone.x, cone.y) - 0.8);
    const fake = { x: 0, y: 0, z: 0, h: 0, v: 0, mode: 0, inv: 0, cx: NaN, cy: NaN, angL: 0, angR: 0, i: 0 };
    rig.setMode('follow');
    titleMotion = (dt) => {
      tt += dt;
      // 0〜L を行って帰る（端でゆっくりその場で回る）
      const period = 2 * (L / 0.25) + 2 * 4;
      const ph = tt % period;
      const goT = L / 0.25;
      let s, h;
      if (ph < goT) { s = ph * 0.25; h = 0; }
      else if (ph < goT + 4) { s = L; h = (ph - goT) / 4 * 180; }
      else if (ph < 2 * goT + 4) { s = L - (ph - goT - 4) * 0.25; h = 180; }
      else { s = 0; h = 180 + (ph - 2 * goT - 4) / 4 * 180; }
      const dir = Math.atan2(cone.x, cone.y);
      fake.x = Math.sin(dir) * s; fake.y = Math.cos(dir) * s; fake.h = (dir / DEG + h) % 360;
      fake.angL = fake.angR = tt * 0.25 / ROVER_DIM.wheelR;
      if (ph >= goT && ph < goT + 4) { fake.angL = tt * 2; fake.angR = -tt * 2; }
      pose = fake;
      applyPose(fake, tt);
      // カメラはゆっくり回る（1 周 90 s）。見る所は道のまん中と機体の間
      const a = tt * (2 * Math.PI / 90) + 4.1;
      const cx = Math.sin(dir) * L / 2, cy = Math.cos(dir) * L / 2;
      camera.position.set(cx + Math.cos(a) * 2.3, 0.7, -(cy + Math.sin(a) * 2.3));
      look.lerp(new THREE.Vector3(cx * 0.4 + fake.x * 0.6, 0.12, -(cy * 0.4 + fake.y * 0.6)), tt < 0.05 ? 1 : 0.05);
      camera.lookAt(look);
    };
    // 追従のカメラの動きは使わない
    rig.update = ((orig) => (dtt, p, an) => (titleMotion ? false : orig(dtt, p, an)))(rig.update);
  }

  function dispose() {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    rig.dispose();
    overlays.dispose();
    clearReveal();
    if (venueObj) venueObj.dispose();
    if (objects) objects.dispose();
    rover.dispose();
    chute.dispose();
    bank.dispose();
    if (envTex) envTex.dispose();
    sky.geometry.dispose(); sky.material.dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch { /* 無視 */ }
    canvas.remove();
    capEl.remove();
    if (placeholder) placeholder.hidden = false;
  }

  return {
    loadWorld, setRecord, setTime, setCamera, setOverlays, celebrate, dispose,
    setQuality, render: () => { dirty = true; }, resize, startTitleMotion,
    /** テクスチャを全部読み終わったら解決する。 */
    ready: () => bank.ready(),
    on(name, fn) { listeners[name].add(fn); return () => listeners[name].delete(fn); },
    get quality() { return quality; },
    get autoReasons() { return autoReasons.slice(); },
    get cameraMode() { return rig.mode; },
    /** 今の水平の画角（度）。 */
    get cameraHFov() { return horizontalFov(camera.fov, camera.aspect); },
    get pose() { return { ...pose }; },
    get t() { return curT; },
    get fps() { return currentFps(); },
    get record() { return record; },
    get world() { return world; },
    /** 確かめ用の中身（テスト・写真）。 */
    _debug: { THREE, renderer, scene, camera, rig, rover: () => rover, chute, overlays, anchors, venue: () => venueObj, objects: () => objects, bank },
  };
}

// ------------------------------------------------------------------------------------------------
// HUD（3D の左上）
// ------------------------------------------------------------------------------------------------

/** 章ごとの HUD の既定（3.4: 4 章から LiDAR、6 章から方位、7 章から GNSS のずれ、9 章からフェーズと高さ、10 章は 20 分の残り）。 */
export function defaultHudFor(chapter) {
  const c = Number(chapter) || 1;
  if (c >= 10) return ['remain', 'phase', 'gnss', 'speed'];
  if (c >= 9) return ['time', 'phase', 'alt', 'speed'];
  if (c >= 7) return ['time', 'gnss', 'heading', 'speed'];
  if (c >= 6) return ['time', 'heading', 'lidar', 'speed'];
  if (c >= 4) return ['time', 'lidar', 'target', 'speed'];
  return ['time', 'target', 'speed'];
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
function lastEv(arr, t) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1, ans = null;
  // 読みは 1 コマ（0.01 s）あとの時刻で記録される（0.0 s の lidar() は t = 0.01。直し係 6）
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t + 0.011) { ans = arr[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/**
 * HUD（左上のチップ）。面の hud（7.7）か章の既定で項目を変える。
 */
export class Hud {
  /**
   * @param {HTMLElement} el .hud の要素 @param {{level?: object, world?: object, items?: string[]}} [o]
   */
  constructor(el, { level = null, world = null, items = null } = {}) {
    this.el = el;
    this.level = level;
    this.world = world;
    this.items = items || (level && level.hud) || defaultHudFor(level && level.chapter);
    this.N = null;
    this.chips = new Map();
    this._build();
  }
  _build() {
    this.el.innerHTML = '';
    this.chips.clear();
    for (const k of this.items) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.dataset.k = k;
      c.innerHTML = '<span class="lb"></span> <b></b>';
      this.el.appendChild(c);
      this.chips.set(k, c);
    }
  }
  setWorld(world) { this.world = world; }
  setRecord(rec) { this.N = rec ? normalizeRecord(rec) : null; this.target = null; if (this.N) { const p = sampleFrame(this.N, this.N.T); this.target = arrowTarget(this.world, p.x, p.y); } }
  /** その時刻の値を出す。 @returns {Object<string, string>} 項目ごとの文字（テスト用） */
  update(t, pose) {
    const N = this.N;
    const out = {};
    if (!N) return out;
    const p = pose || sampleFrame(N, t);
    for (const k of this.items) {
      let label = '', val = '';
      switch (k) {
        case 'time': label = '時刻'; val = `${fmt(t, 1)} s`; break;
        case 'remain': {
          const lim = (this.world && this.world.time_limit) || 1200;
          const r = Math.max(0, lim - t);
          label = 'のこり'; val = `${Math.floor(r / 60)}:${String(Math.floor(r % 60)).padStart(2, '0')}`; break;
        }
        case 'speed': label = '速さ'; val = `${fmt(Math.abs(p.v), 2)} m/s`; break;
        case 'target': {
          const tg = this.target;
          if (!tg) { label = '目標まで'; val = '—'; break; }
          const d = Math.hypot(tg.x - p.x, tg.y - p.y);
          if (tg.type === 'cone') { label = 'コーンまで'; val = `${fmt(Math.max(0, d - ROVER_DIM.bodyR - (tg.r || 0.19)), 2)} m`; }
          else { label = `${tg.type === 'flag' ? '旗' : '目印'} ${tg.id ?? ''} まで`; val = `${fmt(d, 2)} m`; }
          break;
        }
        case 'gap': {
          const cone = ((this.world && this.world.objects) || []).find((o) => o.type === 'cone');
          label = 'コーンまで';
          val = cone ? `${fmt(Math.max(0, Math.hypot(cone.x - p.x, cone.y - p.y) - ROVER_DIM.bodyR - (cone.r || 0.19)), 2)} m` : '—';
          break;
        }
        case 'lidar': { const e = lastEv(N.byKind.lidar, t); label = 'LiDAR'; val = e ? (Number.isFinite(e.v) ? `${fmt(e.v, 2)} m` : 'なし') : '—'; break; }
        case 'heading': { const e = lastEv(N.byKind.heading, t); label = '方位'; val = e && Number.isFinite(e.v) ? `${fmt(e.v, 1)}°` : `${fmt(p.h, 1)}°`; break; }
        case 'gnss': {
          const fx = (N.rec.gnssFixes || []).filter((f) => f[5] && f[0] + 0.3 <= t);
          const f = fx[fx.length - 1];
          label = 'GNSS のずれ'; val = f ? `${fmt(Math.hypot(f[3] - f[1], f[4] - f[2]), 1)} m` : '—'; break;
        }
        case 'phase': { const e = lastEv(N.byKind.phase, t); label = 'フェーズ'; val = e ? String(e.name) : '—'; break; }
        case 'alt': { label = '高さ'; val = `${fmt(Math.max(0, p.z || 0), 1)} m`; break; }
        default: label = k; val = '';
      }
      out[k] = `${label} ${val}`;
      const c = this.chips.get(k);
      if (c) { const lb = c.firstChild, b = c.lastChild; if (lb.textContent !== label) lb.textContent = label; if (b.textContent !== val) b.textContent = val; }
    }
    return out;
  }
  destroy() { this.el.innerHTML = ''; }
}

// ------------------------------------------------------------------------------------------------
// 切りかえ（カメラ・世界）
// ------------------------------------------------------------------------------------------------

/** 右上のカメラの切りかえ（追従・上から・機体カメラ）。el は .camsw。 */
export function createCameraSwitch(el, onPick, initial = 'follow') {
  el.innerHTML = '';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'カメラ');
  const btns = CAMERA_MODES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = CAMERA_LABELS[m];
    b.dataset.mode = m;
    b.addEventListener('click', () => { set(m); onPick(m); });
    el.appendChild(b);
    return b;
  });
  function set(m) { for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.mode === m)); }
  set(initial);
  return { set, destroy() { el.innerHTML = ''; } };
}

/**
 * 左下の世界の切りかえ（「世界 1 ✓ ／ 世界 2 ✗」）。押すとその世界の記録を再生。世界が 1 つなら出さない。
 * @param {HTMLElement} el @param {object[]} runs RunRecord の並び @param {object} judge RunResult.judge @param {(i: number) => void} onPick
 */
export function createWorldSwitch(el, runs, judge, onPick, current = 0) {
  el.innerHTML = '';
  el.hidden = !runs || runs.length < 2;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', '世界の切りかえ');
  const ok = (i) => worldOk(judge, i, runs[i]);
  const btns = (runs || []).map((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const good = ok(i);
    b.className = good === null ? '' : good ? 'ok' : 'ng';
    b.innerHTML = `${escapeHtml(r.name || `世界${i + 1}`).replace(/^世界(\d+)$/, '世界 $1')} <span aria-hidden="true">${good === null ? '' : good ? '✓' : '✗'}</span>`;
    b.setAttribute('aria-label', `${(r.name || `世界${i + 1}`).replace(/^世界(\d+)$/, '世界 $1')}${good === null ? '' : good ? '（クリア）' : '（クリアしていない）'}`);
    b.addEventListener('click', () => { set(i); onPick(i); });
    el.appendChild(b);
    return b;
  });
  function set(i) { btns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i))); }
  set(current);
  return { set, destroy() { el.innerHTML = ''; } };
}

/** 世界 i がクリアの条件を全部満たしたか（判定が無ければ null）。 */
export function worldOk(judge, i, run) {
  const conds = judge && judge.clear && judge.clear.conds;
  if (Array.isArray(conds) && conds.length) {
    let any = false;
    for (const c of conds) { if (Array.isArray(c.pass) && c.pass.length > i) { any = true; if (!c.pass[i]) return false; } }
    if (any) return true;
  }
  if (run && run.end && run.end !== 'end' && run.end !== 'exit') return false;
  return null;
}

/** 最初に再生する世界（失敗した世界があれば最初に失敗した世界。2.4 の 5）。 */
export function firstWorldToShow(result) {
  const runs = (result && result.runs) || [];
  for (let i = 0; i < runs.length; i++) if (worldOk(result.judge, i, runs[i]) === false) return i;
  return 0;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------------------------------------
// 全部を組み合わせる（W7 の遊ぶ画面から使う）
// ------------------------------------------------------------------------------------------------

/**
 * 3D の区画と時間のつまみを組み合わせて再生する。W7 の遊ぶ画面はこれを呼ぶだけでよい（部品を個別に使ってもよい）。
 * @param {HTMLElement} viewEl 3D の区画（#view。中の .canvas-slot・.hud・.camsw・.worldsw を使い、無ければ作る）
 * @param {{timelineEl?: HTMLElement, graphsEl?: HTMLElement, level?: object, result: object, worlds?: object[], venue?: object|string,
 *   quality?: string, overlays?: object, speed?: number|'line'|'result'|'auto', ghost?: object[], senpaiGhost?: object[],
 *   scene?: object, onLine?: (n: number|null) => void, onTime?: (t: number) => void, onEnd?: (i: number) => void, onWorld?: (i: number) => void,
 *   autoplay?: boolean}} o
 *   worlds: result.runs と同じ順の世界（6.10）。無ければ level.worlds（本番テストは level.test.worlds）。
 *   ghost・senpaiGhost: 世界ごとの前回・先輩の記録（無ければ重ねない）。
 */
export function mountReplay(viewEl, o) {
  const level = o.level || null;
  const result = o.result;
  const runs = (result && result.runs) || [];
  const worlds = o.worlds || (result && result.mode === 'test' && level && level.test ? level.test.worlds : level && level.worlds) || [];
  const worldOf = (i) => { const w = worlds[i] || worlds[0]; return (w && (w.world || w)) || { objects: [] }; };
  const need = (cls, tag = 'div') => { let e = viewEl.querySelector('.' + cls); if (!e) { e = document.createElement(tag); e.className = cls; viewEl.appendChild(e); } return e; };
  const scene = o.scene || createScene(viewEl, { quality: o.quality || 'auto' });
  const hud = new Hud(need('hud'), { level, world: worldOf(0) });
  const camsw = createCameraSwitch(need('camsw'), (m) => scene.setCamera(m), scene.cameraMode);
  let index = firstWorldToShow(result);
  let player = null, timeline = null, graphs = null;
  let ended = false;
  const speed0 = o.speed && o.speed !== 'auto' ? o.speed : defaultSpeedFor(level);
  const worldsw = createWorldSwitch(need('worldsw'), runs, result && result.judge, (i) => select(i), index);
  if (o.overlays) scene.setOverlays(o.overlays);
  if (level && Array.isArray(level.overlays)) {
    const want = new Set(level.overlays);
    scene.setOverlays({ lidar: want.has('lidar') || want.has('sensors') || !want.size, cameraFov: want.has('cameraFov') || want.has('camera') || want.has('sensors') || !want.size });
  }

  function select(i) {
    if (!runs.length) return;
    index = Math.max(0, Math.min(runs.length - 1, i));
    const rec = runs[index];
    const w = worldOf(index);
    const keepSpeed = player ? player.speed : speed0;
    const wasCamera = scene.cameraMode;
    if (scene.world !== w) scene.loadWorld(w, o.venue || w.venue_key, { level });
    scene.setRecord(rec, { ghost: o.ghost ? o.ghost[index] : null, senpaiGhost: o.senpaiGhost ? o.senpaiGhost[index] : null });
    scene.setCamera(wasCamera);
    hud.setWorld(w); hud.setRecord(rec);
    if (player) player.destroy();
    player = new Player(rec, { speed: keepSpeed });
    ended = false;
    player.on('time', (t) => { scene.setTime(t); hud.update(t, scene.pose); if (o.onTime) o.onTime(t); });
    player.on('line', (n) => { if (o.onLine) o.onLine(n); });
    player.on('end', () => { ended = true; if (o.onEnd) o.onEnd(index); });
    if (o.timelineEl) { if (timeline) timeline.setPlayer(player, rec); else timeline = new Timeline(o.timelineEl, rec, level, player); }
    if (o.graphsEl) { if (graphs) graphs.destroy(); graphs = new Graphs(o.graphsEl, rec, (level && level.graphs) || defaultGraphKinds(level, rec), player); }
    worldsw.set(index);
    player.seek(0);
    hud.update(0, scene.pose);
    if (o.onWorld) o.onWorld(index);
  }
  select(index);
  if (o.autoplay !== false) player.play();

  return {
    scene, hud,
    get player() { return player; },
    get timeline() { return timeline; },
    get graphs() { return graphs; },
    get worldIndex() { return index; },
    get ended() { return ended; },
    selectWorld: select,
    setSpeed(s) { if (player) player.setSpeed(s); },
    /** クリアの演出（3.5）: 揺れる＋★3 なら葉。通りすぎは tilt。 */
    celebrate: (kind) => scene.celebrate(kind),
    /** ■ 止める（再生中）: 最後のコマへ。 */
    stop() { if (player) player.toEnd(); },
    destroy() {
      if (player) player.destroy();
      if (timeline) timeline.destroy();
      if (graphs) graphs.destroy();
      hud.destroy(); camsw.destroy(); worldsw.destroy();
      if (!o.scene) scene.dispose();
    },
  };
}

/**
 * タイトルの背景の 3D（朝の芝生でローバーがゆっくり往復し、カメラがゆっくり回る。3.2）。
 * 「軽い」・prefers-reduced-motion では 1 枚だけ描いて止める（W7 は静止画のままにしてもよい）。
 * @param {HTMLElement} el @param {{quality?: string}} [o]
 */
export function createTitleScene(el, o = {}) {
  const scene = createScene(el, { quality: o.quality || 'auto' });
  const world = { venue_key: 'bushitsu', start: { x: 0, y: 0, heading: 0 }, objects: [{ id: 'cone', type: 'cone', x: 0.4, y: 3.4, r: 0.19 }, { id: 'A', type: 'flag', x: -0.9, y: 2.0 }] };
  scene.loadWorld(world, 'bushitsu');
  scene.setRecord({ fields: ['t', 'x', 'y', 'h'], frames: [0, 0, 0, 0, 0.02, 0, 0, 0] });
  scene.setOverlays({ rings: false, arrow: false, trail: false });
  const still = scene.quality === 'light' || prefersReducedMotion();
  if (!still) scene.startTitleMotion();
  return { scene, still, dispose: () => scene.dispose() };
}

export { finalStopTime };
