/**
 * @file app/js/replay/camera_rig.js
 * 持ち主: W5（3D と再生）
 * 役割: カメラ 3 種: 追従（後ろ斜め上、ゆっくり追う）・上から（真上、拡大縮小とドラッグ）・機体カメラ（高さ 0.12 m・水平 62.2°）。
 * SPEC: 10.4（カメラ）・3.4（右上のカメラの切りかえ）・13.2 W5 ④・10.1（prefers-reduced-motion では追従カメラのゆれを止める）
 *
 * 機体カメラは水平 62.2°・垂直 48.8°（6.2 節。横:縦 = tan 31.1° : tan 24.4° ≒ 4:3）。区画の形に関係なく画角を変えないように、
 * 区画の中に 4:3 の枠（のこりは帯）で描く（getViewport）。
 */
import { ROVER_DIM } from './rover_model.js';

export const CAMERA_MODES = Object.freeze(['follow', 'top', 'onboard']);
/** カメラの名前（画面の文言）。 */
export const CAMERA_LABELS = Object.freeze({ follow: '追従', top: '上から', onboard: '機体カメラ' });

const DEG = Math.PI / 180;
/** 追従の縦の画角（度）。ローバーが画面の中心から下に見える角（ブラッシュアップ 3: 地平線 39%・ローバー 60%）。 */
const FOLLOW_FOV = 50;
const ROVER_BELOW = Math.atan((0.60 - 0.5) * 2 * Math.tan(FOLLOW_FOV / 2 * DEG));
/** 地平線を上から hf の高さに置く時の、下向きの角（ラジアン）。タイトルのカメラも使う。 */
export const horizonPitch = (hf = 0.37, fovDeg = FOLLOW_FOV) => Math.atan((0.5 - hf) * 2 * Math.tan(fovDeg / 2 * DEG));
/** 機体カメラの縦横比（水平 62.2°・垂直 48.8°）。 */
export const ONBOARD_ASPECT = Math.tan(ROVER_DIM.camHFov / 2 * DEG) / Math.tan(ROVER_DIM.camVFov / 2 * DEG);

/** 縦の画角と縦横比から、水平の画角（度）。 */
export const horizontalFov = (vfovDeg, aspect) => 2 * Math.atan(Math.tan(vfovDeg / 2 * DEG) * aspect) / DEG;

/**
 * @param {typeof import('three')} THREE @param {object} camera three の PerspectiveCamera @param {HTMLElement} dom ドラッグを受ける要素
 * @param {{reducedMotion?: boolean, onChange?: () => void}} [opts]
 * @returns {{setMode: (m: 'follow'|'top'|'onboard') => void, mode: string, update: (dt: number, pose: object, anchors?: object) => boolean,
 *   getViewport: (w: number, h: number) => {x: number, y: number, w: number, h: number}, fitTop: (b: object) => void, dispose: () => void}}
 */
export function createCameraRig(THREE, camera, dom, opts = {}) {
  let mode = 'follow';
  const reduced = () => (typeof opts.reducedMotion === 'function' ? opts.reducedMotion() : !!opts.reducedMotion);
  const onChange = opts.onChange || (() => {});
  // 追従: 後ろ斜め上。ドラッグで回りこみ、ホイールで近づく
  // ブラッシュアップ 3: 低く・少し離れて、ほぼ水平に見る（地平線が上から 39% あたり。ローバーは上から 60% あたり）
  const follow = { dist: 1.6, height: 0.40, az: 0, pitchAdd: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, init: false };
  // 上から: 中心と高さ
  const top = { cx: 0, cy: 0, height: 12, fitted: false };
  let last = null;          // 前の姿
  let snapNext = true;      // 次の update で一気に合わせる
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

  function setMode(m) {
    if (!CAMERA_MODES.includes(m)) return;
    mode = m;
    snapNext = true;
    applyLens();
    onChange();
  }

  function applyLens() {
    if (mode === 'onboard') {
      camera.fov = ROVER_DIM.camVFov;
      camera.aspect = ONBOARD_ASPECT;
      camera.near = 0.01; camera.far = 900;
      camera.up.set(0, 1, 0);
    } else if (mode === 'top') {
      camera.fov = 35;
      camera.near = 0.5; camera.far = 2000;
      camera.up.set(0, 0, -1);    // 北が上
    } else {
      camera.fov = FOLLOW_FOV;
      camera.near = 0.03; camera.far = 1500;
      camera.up.set(0, 1, 0);
    }
    camera.updateProjectionMatrix();
  }

  /** 区画の中の描く場所（機体カメラは 4:3 の枠）。y は下から。 */
  function getViewport(w, h) {
    if (mode !== 'onboard') return { x: 0, y: 0, w, h };
    let vw = w, vh = w / ONBOARD_ASPECT;
    if (vh > h) { vh = h; vw = h * ONBOARD_ASPECT; }
    return { x: Math.round((w - vw) / 2), y: Math.round((h - vh) / 2), w: Math.round(vw), h: Math.round(vh) };
  }

  /** 上からの絵を四角（sim の座標 x0..x1, y0..y1）に合わせる。 */
  function fitTop(b, aspect = camera.aspect || 1.6) {
    if (!b) return;
    const w = Math.max(1.6, b.x1 - b.x0), h = Math.max(1.6, b.y1 - b.y0);
    top.cx = (b.x0 + b.x1) / 2; top.cy = (b.y0 + b.y1) / 2;
    const vf = 35 * DEG;
    const needH = h / 2 / Math.tan(vf / 2);
    const needW = w / 2 / (Math.tan(vf / 2) * aspect);
    top.height = Math.min(600, Math.max(2.5, Math.max(needH, needW) * 1.15));   // 上の札の帯（46 px）のぶん少し余白
    top.fitted = true;
    snapNext = true;
    onChange();
  }

  /**
   * 毎コマ呼ぶ。pose: {x, y, z, h, inv, mode}。anchors: {camera: Vector3（世界）, cameraQuat: Quaternion（機体の向き）}
   * @returns {boolean} まだ動いている（もう一度描く必要がある）
   */
  function update(dt, pose, anchors = {}) {
    revealOn = false;
    const moving = updateView(dt, pose, anchors);
    // どの候補でもローバーが隠れる時（高所作業車の下に入った など）は、隠している物を半透明にする（直し係 6）
    if (opts.reveal) opts.reveal(revealOn ? roverAt : null, camera.position);
    return moving;
  }
  let revealOn = false;
  function updateView(dt, pose, anchors = {}) {
    if (!pose) return false;
    last = pose;
    const k = snapNext ? 1 : 1 - Math.exp(-Math.max(0, dt) * 3.2);
    let moving = false;
    if (mode === 'onboard') {
      if (anchors.camera) camera.position.copy(anchors.camera);
      if (anchors.cameraQuat) camera.quaternion.copy(anchors.cameraQuat);
      // 地面より下に入らない（さかさまの時）
      camera.position.y = Math.max(0.03, camera.position.y);
      snapNext = false;
      return false;
    }
    if (mode === 'top') {
      const aspect = camera.aspect || 1.6;
      camera.aspect = aspect;
      camera.position.set(top.cx, top.height + Math.max(0, pose.z || 0) * 0, -top.cy);
      camera.lookAt(top.cx, 0, -top.cy);
      snapNext = false;
      return false;
    }
    // 追従
    const h = pose.h * DEG;
    const air = (pose.z || 0) > 0.3;
    // 空中は北東から（高所作業車は南西にあるので、腕が手前をふさがない）。動きを減らす: 機体と一緒に回らない
    const targetYaw = air ? 225 * DEG : reduced() ? 0 : h;
    if (!follow.init || snapNext) { follow.yaw = targetYaw; follow.init = true; }
    else {
      let d = ((targetYaw - follow.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      follow.yaw += d * (1 - Math.exp(-Math.max(0, dt) * 2.2));
      if (Math.abs(d) > 0.002) moving = true;
    }
    const yaw = follow.yaw + follow.az;
    const dist = air ? Math.max(3.6, follow.dist * 3.4) : follow.dist;
    const height = air ? 0.7 : follow.height * (1 + follow.pitchAdd);
    const fx = Math.sin(yaw), fy = Math.cos(yaw);
    const px = pose.x - fx * dist, py = pose.y - fy * dist;
    tmp.set(px, (pose.z || 0) + height, -py);
    if (air) tmp2.set(pose.x, (pose.z || 0) + 0.75, -pose.y);
    else {
      // 見る向き: カメラの向き（yaw）のまま、ローバーが画面の決まった高さ（上から 60%）に来るだけ下を向く。横には傾けない
      const al = Math.atan2(height - 0.08, dist);
      const th = Math.max(0, al - ROVER_BELOW);
      const far = dist + 3;
      tmp2.set(px + fx * far, (pose.z || 0) + height - far * Math.tan(th), -(py + fy * far));
    }
    if (snapNext) { follow.pos.copy(tmp); follow.look.copy(tmp2); }
    else {
      const kk = reduced() ? 1 : k;
      follow.pos.lerp(tmp, kk); follow.look.lerp(tmp2, kk);
      if (follow.pos.distanceToSquared(tmp) > 1e-6 || follow.look.distanceToSquared(tmp2) > 1e-6) moving = true;
    }
    camera.position.copy(follow.pos);
    camera.position.y = Math.max(0.05, camera.position.y);
    // 壁・生け垣・木でローバーが隠れない（直し係 5）: ローバーの胴からカメラまでの線に物があれば、
    // 高くする → 近づける の順に候補を試し、ローバーが見える最初の位置へ寄せる。初めの 1 枚目（開いた直後・再生の前）から判定する
    if (opts.clip && !air) {
      roverAt.set(pose.x, (pose.z || 0) + 0.1, -pose.y);
      const want = solveView(roverAt, camera.position);
      if (snapNext || reduced()) { follow.lift = want.lift; follow.pull = want.pull; }
      else {
        const kk = 1 - Math.exp(-Math.max(0, dt) * 6);
        follow.lift += (want.lift - follow.lift) * kk; follow.pull += (want.pull - follow.pull) * kk;
        if (Math.abs(want.lift - follow.lift) > 1e-3 || Math.abs(want.pull - follow.pull) > 1e-3) moving = true;
      }
      if (want.stale) moving = true;      // まだ測り直していない（次のコマでもう一度）
      revealOn = memo.blocked;
      if (follow.lift > 1e-3 || follow.pull < 0.999) {
        placeCandidate(roverAt, camera.position, follow.pull, follow.lift, camera.position);
        // 近く・高くから見る時は、少し先ではなく機体のほうを見る
        const s = Math.min(1, follow.lift / 0.6 + (1 - follow.pull) * 1.5);
        tmp2.copy(follow.look).lerp(roverAt, s);
        camera.lookAt(tmp2);
        snapNext = false;
        return moving;
      }
    }
    camera.lookAt(follow.look);
    snapNext = false;
    return moving;
  }

  // ---- ローバーが隠れない位置を探す（直し係 5）
  // 候補 [近さ（今の距離に掛ける）, 高さを足す m]。前のほうほど、いつもの見え方に近い
  const CANDS = [[1, 0], [1, 0.35], [1, 0.8], [0.75, 0.35], [0.75, 0.8], [0.5, 0.35], [0.5, 0.8], [0.3, 0.25], [0.3, 0.6],
    [1, 1.6], [0.6, 1.6], [0.2, 1.0], [0.12, 1.4]];
  const roverAt = new THREE.Vector3(), cand = new THREE.Vector3();
  const memo = { base: new THREE.Vector3(1e9, 0, 0), rover: new THREE.Vector3(1e9, 0, 0), lift: 0, pull: 1, blocked: false };
  follow.lift = 0; follow.pull = 1;
  /** base（いつものカメラの位置）を、ローバー（target）に向けて水平に pull 倍・高さを lift 足した位置。 */
  function placeCandidate(target, base, pull, lift, out) {
    const x = target.x + (base.x - target.x) * pull, z = target.z + (base.z - target.z) * pull;
    out.set(x, base.y + lift, z);
    return out;
  }
  /** ローバー（胴の上と下・左と右の 4 点）から cand までの間に物があるか。左右も見るのは、旗の布が胴の半分だけを隠す時のため（直し係 6）。 */
  const lowPt = new THREE.Vector3();
  const SAMPLES = [[0, 0.06], [0, -0.035], [0, -0.07], [0.075, 0], [-0.075, 0]];   // [横 m, 高さ m]（-0.035 は胴の中心）
  function blocked(target, c) {
    const dx = c.x - target.x, dz = c.z - target.z, L = Math.hypot(dx, dz) || 1;
    const sx = -dz / L, sz = dx / L;          // カメラから見て横の向き（水平）
    for (const [side, dy] of SAMPLES) {
      lowPt.set(target.x + sx * side, target.y + dy, target.z + sz * side);
      const hit = opts.clip(lowPt, c);
      if (Number.isFinite(hit) && hit < lowPt.distanceTo(c) - 0.003) return true;   // カメラのすぐ前の旗の布も見る（ブラッシュアップでカメラが低くなった）
    }
    return false;
  }
  let solveAt = 0;
  /** 今のカメラの位置 base から、ローバーが見える位置（pull・lift）。少し動いた時だけ測り直す。 */
  function solveView(target, base) {
    const moved = memo.base.distanceToSquared(base) > 0.0025 || memo.rover.distanceToSquared(target) > 0.0025;
    if (!moved && !snapNext) return { lift: memo.lift, pull: memo.pull, stale: false };
    // 続けて動いている間は 1 秒に 10 回まで（遅い端末の fps を落とさない）。止まった後と 1 枚目は必ず測る
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!snapNext && now - solveAt < 100) return { lift: memo.lift, pull: memo.pull, stale: true };
    solveAt = now;
    memo.base.copy(base); memo.rover.copy(target);
    let pick = null;
    for (const [p, l] of CANDS) {
      if (!blocked(target, placeCandidate(target, base, p, l, cand))) { pick = [p, l]; break; }
    }
    memo.blocked = !pick;
    // どれもだめ（物に囲まれた・作業車の下）: 少し近く高い所から見て、隠している物は scene が半透明にする（opts.reveal。直し係 6）
    if (!pick) pick = [0.75, 0.8];
    memo.pull = pick[0]; memo.lift = pick[1];
    return { lift: memo.lift, pull: memo.pull, stale: false };
  }

  // ---- 指とマウス: 追従は回りこみ・近づく、上からは動かす・拡大縮小
  const pointers = new Map();
  let pinch0 = 0;
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { dom.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
  }
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0) zoom(pinch0 / d);
      pinch0 = d;
      return;
    }
    const h = dom.clientHeight || 400;
    if (mode === 'top') {
      const scale = 2 * top.height * Math.tan(35 * DEG / 2) / h;
      top.cx -= dx * scale; top.cy += dy * scale;
    } else if (mode === 'follow') {
      follow.az -= dx * 0.008;
      follow.pitchAdd = Math.max(-0.6, Math.min(2.5, follow.pitchAdd + dy * 0.006));
    }
    onChange();
  }
  function onUp(e) { pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = 0; }
  function zoom(f) {
    if (mode === 'top') top.height = Math.max(2, Math.min(800, top.height * f));
    else if (mode === 'follow') follow.dist = Math.max(0.35, Math.min(12, follow.dist * f));
    onChange();
  }
  function onWheel(e) {
    if (mode === 'onboard') return;
    e.preventDefault();
    zoom(Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0018));
  }
  function onDbl() { follow.az = 0; follow.pitchAdd = 0; follow.dist = 1.6; onChange(); }
  if (dom) {
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('dblclick', onDbl);
    dom.style.touchAction = 'none';
  }
  applyLens();

  return {
    setMode, update, getViewport, fitTop, zoom,
    get mode() { return mode; },
    get top() { return { ...top }; },
    /** 水平の画角（度）。機体カメラは 62.2。 */
    get hfov() { return horizontalFov(camera.fov, camera.aspect); },
    snap() { snapNext = true; },
    /** 追従で、どの候補でもローバーが隠れた（確かめ用）。 */
    get viewBlocked() { return memo.blocked; },
    /** 追従の見え方を変える（dist m・pitchAdd・az 度）。 */
    setView({ dist, pitchAdd, az, height } = {}) {
      if (Number.isFinite(dist)) follow.dist = dist;
      if (Number.isFinite(height)) follow.height = height;
      if (Number.isFinite(pitchAdd)) follow.pitchAdd = pitchAdd;
      if (Number.isFinite(az)) follow.az = az * DEG;
      snapNext = true; onChange();
    },
    dispose() {
      if (!dom) return;
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('dblclick', onDbl);
    },
  };
}
