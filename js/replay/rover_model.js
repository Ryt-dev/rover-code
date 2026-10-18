/**
 * @file app/js/replay/rover_model.js
 * 持ち主: W5（3D と再生）
 * 役割: ローバーの 3D の形（実寸の簡単な形: 白っぽい胴・黒い車輪・灰色のハブ・緑の基板・後ろのスタビライザーと先の円板・前の LiDAR とカメラ）。
 * SPEC: 10.4（物）・13.2 W5（車輪が回る・さかさま・溶断の時の絵）・6.2（機体の数字）
 *
 * 座標（このファイルの中）: 前が −Z、右が +X、上が +Y（three のカメラと同じ向き）。原点は車軸の真下の地面。
 * 数字は 6.2 節: 車輪の直径 0.127 m・左右の車輪の中心間 0.162 m・LiDAR は中心から前 0.10 m・高さ 0.08 m・カメラは高さ 0.12 m。
 * 見た目は自然な色。発光（emissive）は使わない（10.1）。
 */

/** 機体の数字（6.2 節）。 */
export const ROVER_DIM = Object.freeze({
  wheelR: 0.127 / 2,
  track: 0.162,
  wheelW: 0.032,
  bodyR: 0.12,            // 当たり判定の円
  lidarFwd: 0.10, lidarH: 0.08,
  camH: 0.12, camFwd: 0.035,
  camHFov: 62.2, camVFov: 48.8,
});

/**
 * ローバーの 3D を作る。
 * @param {typeof import('three')} THREE three のモジュール
 * @param {{quality?: 'light'|'normal'|'fine'}} [opts]
 * @returns {{group: object, pivot: object, setWheels: (angleL: number, angleR: number) => void, setInverted: (inv: boolean) => void,
 *            setNichrome: (on: boolean, t?: number) => void, update: (dt: number) => void,
 *            lidarAnchor: object, cameraAnchor: object, tetherAnchor: object, dispose: () => void}}
 *   group: 世界に置く入れ物（位置と向きは scene.js が決める）。pivot: 車軸の高さで回す入れ物（さかさま・揺れる・首をかしげる）。
 *   lidarAnchor・cameraAnchor・tetherAnchor: LiDAR の光の出る所・機体カメラの位置・パラのひもの付く所。
 */
export function createRoverModel(THREE, opts = {}) {
  const D = ROVER_DIM;
  const seg = opts.quality === 'light' ? 16 : 28;
  const owned = [];
  const own = (x) => { owned.push(x); return x; };
  // 「軽い」では光の計算の軽い材質（venues3d.js の surfaceMaterial と同じ考え）
  const M = (color, extra = {}) => {
    if (opts.quality !== 'light') return own(new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.0, ...extra }));
    const { roughness, metalness, ...rest } = extra; void roughness; void metalness;
    return own(new THREE.MeshLambertMaterial({ color, ...rest }));
  };

  const mat = {
    tire: M(0x2b2e30, { roughness: 0.92 }),
    tread: M(0x1f2224, { roughness: 0.95 }),
    hub: M(0xd8d6cf, { roughness: 0.5 }),
    hubDark: M(0x8f9294, { roughness: 0.55 }),
    body: M(0xe7e3d8, { roughness: 0.62 }),
    bodyEdge: M(0xcfcac0, { roughness: 0.7 }),
    pcb: M(0x2f6a3c, { roughness: 0.6 }),
    chip: M(0x23262a, { roughness: 0.5 }),
    gold: M(0xb89a5a, { roughness: 0.45, metalness: 0.4 }),
    patch: M(0xd9cfb6, { roughness: 0.6 }),
    rod: M(0x2c3034, { roughness: 0.55 }),
    disc: M(0xbfc3c4, { roughness: 0.5 }),
    sensor: M(0x34383c, { roughness: 0.55 }),
    lens: M(0x101214, { roughness: 0.18 }),
    camPcb: M(0x2c5f3a, { roughness: 0.6 }),
    wire: M(0x9c6b3a, { roughness: 0.6 }),
    smoke: own(new THREE.MeshBasicMaterial({ color: 0xb9b6ae, transparent: true, opacity: 0.0, depthWrite: false })),
  };
  const box = (w, h, d) => own(new THREE.BoxGeometry(w, h, d));
  const cylX = (r, len, s = seg) => { const g = own(new THREE.CylinderGeometry(r, r, len, s)); g.rotateZ(Math.PI / 2); return g; };

  const group = new THREE.Group();
  group.name = 'rover';
  // 車軸の高さで回す（さかさま・揺れ）
  const pivot = new THREE.Group();
  pivot.position.y = D.wheelR;
  group.add(pivot);
  const body = new THREE.Group();   // 車軸の中心が原点
  pivot.add(body);

  const add = (geo, m, x = 0, y = 0, z = 0, parent = body) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // ---- 車輪（左 = −X、右 = +X）。回る部分は wheel グループ
  const wheels = [];
  const tireGeo = cylX(D.wheelR, D.wheelW, seg + 8);
  const treadGeo = box(D.wheelW * 1.02, 0.006, 0.012);
  const hubGeo = cylX(0.03, D.wheelW + 0.006, 6);
  const spokeGeo = box(0.004, 0.08, 0.008);
  const capGeo = cylX(0.009, D.wheelW + 0.012, 12);
  for (const side of [-1, 1]) {
    const w = new THREE.Group();
    w.position.set(side * D.track / 2, 0, 0);
    body.add(w);
    add(tireGeo, mat.tire, 0, 0, 0, w);
    // 溝（回るのが見えるように）
    const nTread = 18;
    for (let k = 0; k < nTread; k++) {
      const a = (k / nTread) * Math.PI * 2;
      const tr = add(treadGeo, mat.tread, 0, Math.cos(a) * (D.wheelR + 0.001), Math.sin(a) * (D.wheelR + 0.001), w);
      tr.rotation.x = -a;
      tr.castShadow = false;
    }
    add(hubGeo, mat.hub, 0, 0, 0, w);
    for (let k = 0; k < 3; k++) {
      const s = add(spokeGeo, mat.hubDark, side * (D.wheelW / 2 + 0.004), 0, 0, w);
      s.rotation.x = (k / 3) * Math.PI;
    }
    add(capGeo, mat.hubDark, 0, 0, 0, w);
    wheels.push(w);
  }

  // ---- 胴（車輪の間）
  const bodyW = D.track - D.wheelW - 0.012;
  add(box(bodyW, 0.074, 0.088), mat.body, 0, 0.004, 0);
  add(box(bodyW + 0.004, 0.008, 0.092), mat.bodyEdge, 0, -0.033, 0);
  // 車軸のカバー
  add(cylX(0.012, D.track - D.wheelW + 0.002, 12), mat.hubDark, 0, 0, 0);
  // 上の基板と部品
  const pcbY = 0.043;
  add(box(bodyW - 0.004, 0.003, 0.084), mat.pcb, 0, pcbY, 0);
  add(box(0.022, 0.004, 0.022), mat.chip, -0.02, pcbY + 0.003, 0.012);
  add(box(0.012, 0.003, 0.016), mat.chip, 0.03, pcbY + 0.003, 0.018);
  add(box(0.03, 0.006, 0.01), mat.chip, 0.018, pcbY + 0.004, -0.025);
  add(box(0.006, 0.003, 0.006), mat.gold, -0.04, pcbY + 0.003, -0.03);
  // GNSS のパッチアンテナ
  add(box(0.025, 0.006, 0.025), mat.patch, 0.025, pcbY + 0.005, 0.02);
  // パラのひもを結ぶ輪（溶断のニクロム線もここ）
  const tetherAnchor = new THREE.Object3D();
  tetherAnchor.position.set(0, pcbY + 0.012, 0.03);
  body.add(tetherAnchor);
  const wire = add(own(new THREE.TorusGeometry(0.008, 0.0016, 6, 14)), mat.wire, 0, pcbY + 0.01, 0.03);
  wire.rotation.y = Math.PI / 2;

  // ---- 前: LiDAR（TSD20）。中心から前 0.10 m・高さ 0.08 m（地面から）
  const lidarY = D.lidarH - D.wheelR;
  add(box(0.012, 0.004, 0.07), mat.rod, 0, lidarY - 0.016, -0.06);     // 腕
  add(box(0.034, 0.024, 0.022), mat.sensor, 0, lidarY, -D.lidarFwd + 0.011);
  for (const sx of [-0.008, 0.008]) {
    const l = add(own(new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 14)), mat.lens, sx, lidarY, -D.lidarFwd - 0.0005);
    l.rotation.x = Math.PI / 2;
  }
  const lidarAnchor = new THREE.Object3D();
  lidarAnchor.position.set(0, lidarY, -D.lidarFwd);
  body.add(lidarAnchor);

  // ---- 上: カメラ（Camera Module v2）。高さ 0.12 m
  const camY = D.camH - D.wheelR;
  add(box(0.006, camY - pcbY, 0.006), mat.rod, 0, (camY + pcbY) / 2 - 0.006, -D.camFwd + 0.008);
  add(box(0.025, 0.024, 0.003), mat.camPcb, 0, camY, -D.camFwd + 0.003);
  const lens = add(own(new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 14)), mat.lens, 0, camY, -D.camFwd - 0.002);
  lens.rotation.x = Math.PI / 2;
  const cameraAnchor = new THREE.Object3D();
  cameraAnchor.position.set(0, camY, -D.camFwd - 0.006);
  body.add(cameraAnchor);

  // ---- 後ろ: スタビライザー（棒と、先の円板）。先は地面すれすれ
  const rodStart = new THREE.Vector3(0, -0.01, 0.044);
  const tipZ = 0.21, tipY = -D.wheelR + 0.006;
  const rodEnd = new THREE.Vector3(0, tipY + 0.004, tipZ);
  const rodLen = rodStart.distanceTo(rodEnd);
  const rod = add(own(new THREE.CylinderGeometry(0.0035, 0.0035, rodLen, 8)), mat.rod, 0, (rodStart.y + rodEnd.y) / 2, (rodStart.z + rodEnd.z) / 2);
  rod.rotation.x = Math.atan2(rodEnd.z - rodStart.z, rodEnd.y - rodStart.y);
  const disc = add(own(new THREE.CylinderGeometry(0.024, 0.024, 0.004, 20)), mat.disc, 0, tipY + 0.002, tipZ);
  disc.rotation.x = 0.12;

  // ---- 溶断の煙（灰色の小さな玉。光らない）
  const smoke = [];
  const puffGeo = own(new THREE.SphereGeometry(0.012, 8, 6));
  for (let k = 0; k < 6; k++) {
    const p = new THREE.Mesh(puffGeo, mat.smoke.clone());
    owned.push(p.material);
    p.visible = false;
    p.userData.phase = k / 6;
    body.add(p);
    smoke.push(p);
  }

  let inverted = false;
  let nichromeOn = false;
  let smokeT = 0;

  function setWheels(angleL, angleR) {
    // 前（−Z）へ転がる時、車輪の上は −Z へ動く = X 軸まわりに負の向き
    wheels[0].rotation.x = -angleL;
    wheels[1].rotation.x = -angleR;
  }

  /** さかさま: 前の向きの軸（Z）まわりに 180°（6.3 の gl = −mR, gr = −mL と同じ: 左右が入れかわり、前後はそのまま）。 */
  function setInverted(inv) {
    inverted = !!inv;
    body.rotation.z = inverted ? Math.PI : 0;
  }

  function setNichrome(on) { nichromeOn = !!on; }

  function update(dt) {
    smokeT += dt;
    for (const p of smoke) {
      if (!nichromeOn) { p.visible = false; continue; }
      const ph = ((smokeT * 0.9 + p.userData.phase) % 1);
      p.visible = true;
      // 上へゆっくり昇って薄くなる（さかさまでも世界の上へ）
      const up = inverted ? -1 : 1;
      p.position.set(Math.sin(ph * 9 + p.userData.phase * 6) * 0.012, pcbY + 0.015 * up + ph * 0.12 * up, 0.03 - ph * 0.02);
      const s = 0.6 + ph * 1.8;
      p.scale.set(s, s, s);
      p.material.opacity = 0.55 * (1 - ph);
    }
    wire.material.color.setHex(nichromeOn ? 0x7a4a2e : 0x9c6b3a);
  }

  function dispose() {
    for (const o of owned) { try { o.dispose(); } catch { /* 片づけの失敗は無視 */ } }
  }

  return { group, pivot, body, setWheels, setInverted, setNichrome, update, lidarAnchor, cameraAnchor, tetherAnchor, dispose,
    get inverted() { return inverted; }, get smoking() { return nichromeOn; } };
}
