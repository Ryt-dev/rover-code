/**
 * @file app/js/replay/venues3d.js
 * 持ち主: W5（3D と再生）
 * 役割: 会場 8 つの 3D（地面のテクスチャ・木・建物・フェンス・高所作業車など）と、世界の物（コーン・旗・岩・生け垣・壁・池・パラ・AR マーカー）。
 * SPEC: 10.4（3D）・6.10（objects）・8.1（会場のキー）・13.2 W5
 *
 * 座標: sim の (x 東, y 北) を three の (X = x, Z = −y) に置く。上は +Y。向き h（北 0・時計回り）は rotation.y = −h。
 * 色はくすんだ自然色。発光（emissive）・加算の合成・光る線は使わない（10.1）。
 * 会場の見た目は会場のキーごとにこのファイルの中で決める（data/venues.json の ground・sky・props が書かれていれば上書きに使う）。
 */

/** 会場のキー（data/venues.json）。 */
export const VENUE_KEYS = Object.freeze(['bushitsu', 'funabashi', 'ura', 'kasen', 'drop', 'takezaki_a', 'takezaki_b', 'lunar']);

/** テクスチャ（assets/textures）。avg は読み込む前に出す色（sRGB）。 */
export const TEXTURES = Object.freeze({
  grass: { file: 'grass.jpg', avg: 0x5d8a3d, tile: 3.0 },
  sand: { file: 'sand.jpg', avg: 0xcdb791, tile: 2.0 },
  dune: { file: 'dune.jpg', avg: 0xd3b98d, tile: 3.0 },
  soil: { file: 'soil.jpg', avg: 0x7c6248, tile: 2.5 },
  pavement: { file: 'pavement.jpg', avg: 0x5a5c5e, tile: 3.0 },
  concrete: { file: 'concrete.jpg', avg: 0xaba89f, tile: 4.0 },
  leaves: { file: 'leaves.jpg', avg: 0x456c35, tile: 0.8 },
});

const TEX_BASE = new URL('../../assets/textures/', import.meta.url);

/** sim の (x, y) → three の位置。 */
export const toV3 = (THREE, x, y, h = 0) => new THREE.Vector3(x, h, -y);

/** 決まった種の乱数（会場の飾りが毎回同じ所に出るように）。 */
export function rng32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/**
 * 物の材質。「軽い」では光の計算が軽い MeshLambertMaterial にする（遅い端末・ソフトウェアの描画で 30 fps を保つ。12 章）。
 * 色・テクスチャ・両面などはそのまま。roughness・metalness は Lambert に無いので捨てる。
 * @param {typeof import('three')} THREE @param {string} quality @param {object} params
 */
export function surfaceMaterial(THREE, quality, params) {
  if (quality !== 'light') return new THREE.MeshStandardMaterial(params);
  const { roughness, metalness, envMapIntensity, ...rest } = params;
  void roughness; void metalness; void envMapIntensity;
  return new THREE.MeshLambertMaterial(rest);
}

/**
 * テクスチャの置き場（同じ絵は 1 回だけ読む）。読み込めたら onChange を呼ぶ（もう一度描く）。
 * @param {typeof import('three')} THREE @param {object} renderer @param {{quality?: string, onChange?: () => void}} [opts]
 */
export function createTextureBank(THREE, renderer, { quality = 'normal', onChange = () => {}, software = false } = {}) {
  const loader = new THREE.TextureLoader();
  const cache = new Map();
  const maxAniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;
  const aniso = quality === 'light' ? 1 : Math.min(quality === 'fine' ? 16 : 8, maxAniso);
  let pending = 0;
  const waiters = [];
  // 大きな明暗のむら（macro.jpg）。読み込むまでは灰色 1 画素
  const gray = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  gray.needsUpdate = true;
  const macroUniform = { value: gray };
  let macroAsked = false;
  function askMacro() {
    if (macroAsked) return;
    macroAsked = true;
    pending++;
    loader.load(new URL('macro.jpg', TEX_BASE).href, (tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      macroUniform.value = tex;
      pending--; onChange(); settle();
    }, undefined, () => { pending--; settle(); });
  }
  const settle = () => { if (pending === 0) { while (waiters.length) waiters.shift()(); } };
  /**
   * 材質にテクスチャを付ける（読み込めるまでは平均の色）。
   * @param {string} name TEXTURES のキー @param {object} material MeshStandardMaterial @param {{tint?: number, macro?: boolean}} [o]
   */
  function apply(name, material, { tint = 0xffffff, macro = false } = {}) {
    const spec = TEXTURES[name];
    if (!spec) return material;
    if (macro) askMacro();
    material.color.setHex(mulHex(spec.avg, tint));
    const done = (tex) => {
      material.map = tex;
      material.color.setHex(tint);
      if (macro) addMacro(material, macroUniform, name === 'grass', quality === 'light');
      material.needsUpdate = true;
      onChange();
    };
    let entry = cache.get(name);
    if (!entry) {
      entry = { tex: null, cbs: [], failed: false };
      cache.set(name, entry);
      pending++;
      loader.load(new URL(spec.file, TEX_BASE).href, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = name === 'grass' && !software ? Math.min(8, maxAniso) : aniso;   // ソフトウェアの描画（GPU なし）では異方性が重いので 1   // 芝は遠くまで見えるので「軽い」でも 8（ブラッシュアップ 1）
        entry.tex = tex;
        for (const cb of entry.cbs) cb(tex);
        entry.cbs = [];
        pending--; settle();
      }, undefined, () => { entry.failed = true; entry.cbs = []; pending--; settle(); });
    }
    if (entry.tex) done(entry.tex); else if (!entry.failed) entry.cbs.push(done);
    return material;
  }
  return {
    apply,
    /** 全部読み終わったら解決する（テストと写真用）。 */
    ready: () => new Promise((res) => { waiters.push(res); settle(); }),
    get pending() { return pending; },
    dispose() { for (const e of cache.values()) if (e.tex) e.tex.dispose(); cache.clear(); if (macroUniform.value) macroUniform.value.dispose(); },
  };
}

function mulHex(a, b) {
  const r = ((a >> 16) & 255) * ((b >> 16) & 255) / 255, g = ((a >> 8) & 255) * ((b >> 8) & 255) / 255, bl = (a & 255) * (b & 255) / 255;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/**
 * 広い地面でタイルのくり返しが目立たないように、別の大きなむらの絵（macro.jpg）を 100 m と 350 m ほどの大きさで重ねる。
 * 少し黄みがかった所も作る（枯れた芝・乾いた砂のような自然なむら）。
 */
// 芝（ブラッシュアップ 2）: くすんだ黄緑にして、細かい色むら（1 m・30 cm ほど）を重ねる。tile 3 m なので vMapUv × 3 が m
const GRASS_TONE = `
  { float gl = dot( sampledDiffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
    vec3 gc = mix( vec3( gl ), sampledDiffuseColor.rgb, 0.56 ) * vec3( 1.13, 1.06, 0.72 );
    vec2 gp = vMapUv * 3.0;
#ifdef RC_GRASS_LIGHT
    float gn = rcVn( gp * 0.9 );
#else
    float gn = rcVn( gp * 0.9 ) * 0.6 + rcVn( gp * 3.1 ) * 0.4;
    gc = mix( gc, gc * vec3( 1.06, 1.02, 0.86 ), smoothstep( 0.55, 0.85, rcVn( gp * 0.35 ) ) );
#endif
    gc *= mix( 0.88, 1.09, gn );
    float gd = length( vec2( gp.x, -gp.y ) - cameraPosition.xz );
    gc = mix( gc, vec3( dot( gc, vec3( 0.333 ) ) ) * vec3( 1.05, 1.04, 0.9 ) + gc * 0.3, smoothstep( 6.0, 40.0, gd ) * 0.35 );
    sampledDiffuseColor.rgb = gc; }`;
const GRASS_FN = `
float rcHsh( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float rcVn( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rcHsh( i ), rcHsh( i + vec2( 1.0, 0.0 ) ), f.x ), mix( rcHsh( i + vec2( 0.0, 1.0 ) ), rcHsh( i + vec2( 1.0, 1.0 ) ), f.x ), f.y ); }
`;
function addMacro(material, macroUniform, grass = false, light = false) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.macroMap = macroUniform;
    sh.fragmentShader = 'uniform sampler2D macroMap;\n' + (grass && light ? '#define RC_GRASS_LIGHT\n' : '') + (grass ? GRASS_FN : '') + sh.fragmentShader.replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  float mA = texture2D( macroMap, vMapUv * 0.031 ).r;
  float mB = texture2D( macroMap, vMapUv * 0.0087 + vec2( 0.31, 0.57 ) ).r;
  float ml = ( mA - 0.5 ) * 1.0 + ( mB - 0.5 ) * 0.8;
  sampledDiffuseColor.rgb *= clamp( 1.0 + ml, 0.7, 1.3 );
  sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * vec3( 1.10, 1.03, 0.80 ), clamp( ( mB - 0.52 ) * 2.5, 0.0, 0.6 ) );${grass ? GRASS_TONE : ''}
  diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  material.customProgramCacheKey = () => (grass ? (light ? 'macro2gl' : 'macro2g') : 'macro2');
}

/** 世界の物とスタートを囲む四角（会場の飾りをこの外に置く）。 */
export function courseBounds(world, margin = 3) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const addP = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } };
  const s = (world && world.start) || { x: 0, y: 0 };
  addP(s.x || 0, s.y || 0);
  for (const o of (world && world.objects) || []) {
    addP(o.x, o.y); addP(o.x1, o.y1); addP(o.x2, o.y2);
    if (o.rect) { addP(o.rect[0], o.rect[1]); addP(o.rect[2], o.rect[3]); }
    if (o.circle) { addP(o.circle[0] - o.circle[2], o.circle[1] - o.circle[2]); addP(o.circle[0] + o.circle[2], o.circle[1] + o.circle[2]); }
    if (o.poly) for (const p of o.poly) addP(p[0], p[1]);
  }
  return { x0: x0 - margin, x1: x1 + margin, y0: y0 - margin, y1: y1 + margin };
}

// ------------------------------------------------------------------------------------------------
// 会場ごとの決まり（空・地面・飾り）
// ------------------------------------------------------------------------------------------------

/** @typedef {{ground: string, tint?: number, sky: [number, number], fog: [number, number], sun: [number, number, number], build: Function}} VenueStyle */

const SKY_DAY = [0xbcd8ec, 0xeef2ee];

/** @type {Object<string, VenueStyle>} */
const STYLES = {
  bushitsu: { ground: 'grass', sky: SKY_DAY, fog: [45, 190], sun: [-0.5, 0.8, 0.35], build: buildBushitsu, label: '部室の前の芝生' },
  funabashi: { ground: 'grass', tint: 0xf2f6ea, sky: [0xb7d4ea, 0xf0f2ec], fog: [70, 320], sun: [-0.45, 0.82, 0.4], build: buildFunabashi, label: '滑走路の隣の芝生' },
  ura: { ground: 'concrete', sky: [0xc4d8e6, 0xeef0ec], fog: [40, 160], sun: [0.35, 0.85, -0.4], build: buildUra, label: '建物の裏の通路' },
  kasen: { ground: 'grass', tint: 0xf4eedc, sky: [0xb9d6ec, 0xf1f1ea], fog: [70, 330], sun: [-0.55, 0.75, 0.38], build: buildKasen, label: '河川敷の練習場' },
  drop: { ground: 'grass', tint: 0xe9e2c8, sky: [0xc0d9ea, 0xf0efe8], fog: [80, 340], sun: [-0.5, 0.78, 0.35], build: buildDrop, label: '落下試験の練習場' },
  takezaki_a: { ground: 'grass', tint: 0xeef5e2, sky: [0xa9cfe8, 0xeef4f2], fog: [110, 520], sun: [0.4, 0.85, 0.3], build: (c) => buildTakezaki(c, 'a'), label: '種子島 竹崎 A' },
  takezaki_b: { ground: 'grass', tint: 0xf2f0dc, sky: [0xa9cfe8, 0xeef4f2], fog: [110, 520], sun: [0.4, 0.85, 0.3], build: (c) => buildTakezaki(c, 'b'), label: '種子島 竹崎 B' },
  lunar: { ground: 'dune', sky: [0xa8cde9, 0xf3f1ea], fog: [90, 460], sun: [-0.35, 0.7, 0.55], build: buildLunar, label: 'ルナテラス' },
};

/** 会場の見た目の決まり（キーが知らないものなら芝の原っぱ）。 */
export function venueStyle(key) { return STYLES[key] || STYLES.funabashi; }

/**
 * 会場を作る（芝は色むらのある写真ふうのテクスチャ。木・建物は低ポリゴンでくすんだ自然色）。
 * @param {typeof import('three')} THREE
 * @param {object} venue data/venues.json の 1 つ（{key?, name, ...}）か会場のキーの文字
 * @param {{quality?: string, world?: object, bank: ReturnType<typeof createTextureBank>}} opts
 * @returns {{group: object, style: VenueStyle, key: string, carrier: object|null, dispose: () => void}}
 */
export function buildVenue(THREE, venue, opts = {}) {
  const key = typeof venue === 'string' ? venue : (venue && (venue.key || venue.venue_key)) || (opts.world && opts.world.venue_key) || 'funabashi';
  const style = venueStyle(key);
  const group = new THREE.Group();
  group.name = 'venue:' + key;
  const owned = [];
  const ctx = makeCtx(THREE, group, owned, opts, key);
  // 地面（2 km 四方。霧の向こうまで。UV は m で、テクスチャ 1 枚 = tile m）
  const groundMat = ctx.std(0xffffff, { roughness: 1 });
  ctx.bank.apply(style.ground, groundMat, { tint: style.tint || 0xffffff, macro: true });
  const ground = ctx.flat(-1000, -1000, 1000, 1000, groundMat, TEXTURES[style.ground].tile, 0);
  ground.name = 'ground';
  ground.receiveShadow = true;
  style.build(ctx);
  return {
    group, style, key, carrier: ctx.carrier || null,
    dispose() { for (const o of owned) { try { o.dispose(); } catch { /* 無視 */ } } },
  };
}

function makeCtx(THREE, group, owned, opts, key) {
  const quality = opts.quality || 'normal';
  const world = opts.world || { objects: [] };
  const b = courseBounds(world);
  const own = (x) => { owned.push(x); return x; };
  const rnd = rng32(hashStr(key) ^ 0x9e3779b9);
  const ctx = {
    THREE, group, quality, world, bounds: b, rnd, own, bank: opts.bank,
    density: quality === 'light' ? 0.45 : quality === 'fine' ? 1.4 : 1,
    std(color, extra = {}) { return own(surfaceMaterial(THREE, quality, { color, roughness: 0.9, metalness: 0, ...extra })); },
    /** 地面に平らな四角（UV は m / tile）。 */
    flat(x0, y0, x1, y1, mat, tile = 1, lift = 0.002) {
      // 大きな面は細かく分ける（2 km の三角形 2 枚だと、ソフトウェアの描画や一部の GPU で奥行きの精度が落ち、
      // 地面に描く線やコーンの台が地面に沈んで見えなくなる）
      const sx = Math.max(1, Math.min(20, Math.ceil(Math.abs(x1 - x0) / 25))), sy = Math.max(1, Math.min(20, Math.ceil(Math.abs(y1 - y0) / 25)));
      const g = own(new THREE.PlaneGeometry(x1 - x0, y1 - y0, sx, sy));
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, lift, -(y0 + y1) / 2);
      worldUV(g, tile);
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      group.add(m);
      return m;
    },
    box(w, h, d, mat, x, y, z = 0, rotY = 0) {
      const m = new THREE.Mesh(own(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, z + h / 2, -y);
      m.rotation.y = rotY;
      m.castShadow = quality !== 'light';
      m.receiveShadow = true;
      group.add(m);
      return m;
    },
    add(obj) { group.add(obj); return obj; },
    /** p が飾りを置いてよい所か（コースの外）。 */
    free(x, y, pad = 0) { return x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad; },
  };
  return ctx;
}

/** UV を「m / tile」に（どの面も同じ大きさの模様になる）。XZ 平面用。 */
function worldUV(geo, tile) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, -p.getZ(i) / tile);
  uv.needsUpdate = true;
}

// ---- 木（まとめて描く: 幹と葉の InstancedMesh） ---------------------------------------------------
/**
 * @param {object} ctx @param {Array<{x: number, y: number, h: number, kind?: 'broad'|'conifer'|'shrub'|'palm', c?: number}>} list
 */
function forest(ctx, list) {
  const { THREE } = ctx;
  if (!list.length) return;
  const byKind = { broad: [], conifer: [], shrub: [], palm: [] };
  for (const t of list) (byKind[t.kind || 'broad'] || byKind.broad).push(t);
  const trunkMat = ctx.std(0x6b5640, { roughness: 1 });
  const leafMat = ctx.std(0xffffff, { roughness: 0.95, flatShading: true });
  const palmMat = ctx.std(0xffffff, { roughness: 0.9, side: THREE.DoubleSide });
  const trunkGeo = ctx.own(new THREE.CylinderGeometry(0.12, 0.2, 1, 6));
  trunkGeo.translate(0, 0.5, 0);
  const crowns = {
    broad: (() => { const g = ctx.own(new THREE.IcosahedronGeometry(1, 1)); jitterGeo(g, 0.14, 7); return g; })(),
    conifer: (() => { const g = ctx.own(new THREE.ConeGeometry(1, 2.4, 7, 3)); jitterGeo(g, 0.08, 11); g.translate(0, 1.2, 0); return g; })(),
    shrub: (() => { const g = ctx.own(new THREE.IcosahedronGeometry(1, 1)); jitterGeo(g, 0.2, 13); return g; })(),
    palm: ctx.own(palmCrown(THREE)),
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const shadows = ctx.quality !== 'light';
  for (const [kind, arr] of Object.entries(byKind)) {
    if (!arr.length) continue;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, arr.length);
    const leaves = new THREE.InstancedMesh(crowns[kind], kind === 'palm' ? palmMat : leafMat, arr.length);
    arr.forEach((t, i) => {
      const h = t.h;
      const th = kind === 'shrub' ? 0.15 * h : kind === 'palm' ? 0.85 * h : kind === 'conifer' ? 0.25 * h : 0.42 * h;
      const tw = kind === 'palm' ? 0.6 : kind === 'shrub' ? 0.5 : 1 + h * 0.04;
      q.setFromAxisAngle(up, (t.x * 13.1 + t.y * 7.3) % 6.28);
      p.set(t.x, 0, -t.y); s.set(tw, th, tw);
      trunks.setMatrixAt(i, m4.compose(p, q, s));
      let cr, cy;
      if (kind === 'broad') { cr = 0.33 * h; cy = th + cr * 0.75; s.set(cr, cr * 0.85, cr); }
      else if (kind === 'conifer') { cr = 0.22 * h; cy = th * 0.6; s.set(cr, (h - th * 0.6) / 2.4, cr); }
      else if (kind === 'shrub') { cr = 0.5 * h; cy = cr * 0.7; s.set(cr, cr * 0.75, cr); }
      else { cr = 0.28 * h; cy = th; s.set(cr, cr * 0.8, cr); }
      p.set(t.x, cy, -t.y);
      leaves.setMatrixAt(i, m4.compose(p, q, s));
      leaves.setColorAt(i, col.setHex(t.c || 0x4a6b36));
    });
    trunks.castShadow = leaves.castShadow = shadows;
    leaves.receiveShadow = true;
    ctx.add(trunks); ctx.add(leaves);
  }
}

/** ヤシの葉（垂れ下がる細い葉を 8 枚。半径 1 の大きさ）。 */
function palmCrown(THREE) {
  const pos = [], idx = [];
  const leaves = 8, seg = 5;
  for (let k = 0; k < leaves; k++) {
    const a = (k / leaves) * Math.PI * 2 + (k % 2) * 0.2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const r = u * 1.6, y = 0.25 * u - 0.75 * u * u;     // 上へ少し出てから垂れる
      const w = 0.22 * Math.sin(Math.PI * Math.min(1, u * 1.1 + 0.05));
      const px = ca * r, pz = sa * r;
      pos.push(px - sa * w, y, pz + ca * w, px + sa * w, y - 0.02, pz - ca * w);
      if (i < seg) { const b = base + i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 頂点を決まった乱数で少しずらす（低ポリゴンの自然な形）。同じ位置の頂点は同じだけずらす。 */
function jitterGeo(g, amt, seed) {
  const p = g.attributes.position;
  const r = rng32(seed);
  const memo = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = memo.get(k);
    if (!d) { d = [(r() - 0.5) * 2 * amt, (r() - 0.5) * 2 * amt, (r() - 0.5) * 2 * amt]; memo.set(k, d); }
    p.setXYZ(i, p.getX(i) * (1 + d[0]), p.getY(i) * (1 + d[1]), p.getZ(i) * (1 + d[2]));
  }
  g.computeVertexNormals();
}

const GREENS = [0x4a6b36, 0x557a3c, 0x3f5f31, 0x5f7f42, 0x4d7040, 0x61804a];
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/** 輪のように木を並べる（コースの外、半径 r0〜r1）。 */
function treeRing(ctx, cx, cy, r0, r1, n, kinds = ['broad'], greens = GREENS, hRange = [5, 11], gap = null) {
  const out = [];
  const N = Math.round(n * ctx.density);
  for (let i = 0; i < N * 3 && out.length < N; i++) {
    const a = ctx.rnd() * Math.PI * 2, r = r0 + ctx.rnd() * (r1 - r0);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (gap && gap(x, y)) continue;
    if (!ctx.free(x, y, 3)) continue;
    out.push({ x, y, h: hRange[0] + ctx.rnd() * (hRange[1] - hRange[0]), kind: pick(ctx.rnd, kinds), c: pick(ctx.rnd, greens) });
  }
  return out;
}

/** 木の列（線に沿って）。 */
function treeLine(ctx, x0, y0, x1, y1, step, kinds, hRange, jitter = 1.5, greens = GREENS) {
  const out = [];
  const L = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(L / (step / ctx.density)));
  for (let i = 0; i <= n; i++) {
    const a = i / n;
    const x = x0 + (x1 - x0) * a + (ctx.rnd() - 0.5) * jitter * 2, y = y0 + (y1 - y0) * a + (ctx.rnd() - 0.5) * jitter * 2;
    if (!ctx.free(x, y, 2)) continue;
    out.push({ x, y, h: hRange[0] + ctx.rnd() * (hRange[1] - hRange[0]), kind: pick(ctx.rnd, kinds), c: pick(ctx.rnd, greens) });
  }
  return out;
}

// ---- 建物 -------------------------------------------------------------------------------------------
const facadeCache = new Map();
function facadeTexture(THREE, { wall = '#d9d2c2', glass = '#5d6e78', frame = '#8b8a85', floors = 3, cols = 8, door = false } = {}) {
  const k = [wall, glass, frame, floors, cols, door].join('|');
  if (facadeCache.has(k)) return facadeCache.get(k);
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = wall; g.fillRect(0, 0, 256, 256);
  // 汚れ（下の方が少し暗い）
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(60,50,40,0.12)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const fh = 256 / floors, cw = 256 / cols;
  for (let f = 0; f < floors; f++) {
    g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, f * fh + fh - 3, 256, 2);
    for (let c = 0; c < cols; c++) {
      if (door && f === floors - 1 && c === Math.floor(cols / 2)) {
        g.fillStyle = '#6d6a64'; g.fillRect(c * cw + cw * 0.2, f * fh + fh * 0.25, cw * 0.6, fh * 0.75); continue;
      }
      g.fillStyle = frame; g.fillRect(c * cw + cw * 0.16, f * fh + fh * 0.22, cw * 0.68, fh * 0.5);
      g.fillStyle = glass; g.fillRect(c * cw + cw * 0.2, f * fh + fh * 0.26, cw * 0.6, fh * 0.42);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(c * cw + cw * 0.2, f * fh + fh * 0.26, cw * 0.25, fh * 0.42);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  facadeCache.set(k, tex);
  return tex;
}

/** 建物（壁に窓の絵）。x, y は中心、w は東西・d は南北の長さ（m）。 */
function building(ctx, x, y, w, d, h, o = {}) {
  const { THREE } = ctx;
  const floors = o.floors || Math.max(1, Math.round(h / 3.4));
  const texW = facadeTexture(THREE, { ...o, floors, cols: Math.max(2, Math.round(w / 3.2)) });
  const texD = facadeTexture(THREE, { ...o, floors, cols: Math.max(2, Math.round(d / 3.2)), door: false });
  // 壁は少し暖かい色に（ブラッシュアップ 3）
  const mW = ctx.std(0xfbf3e2, { map: texW, roughness: 0.92 });
  const mD = ctx.std(0xfbf3e2, { map: texD, roughness: 0.92 });
  const roof = ctx.std(o.roof || 0x7d7266, { roughness: 0.95 });
  const mesh = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(w, h, d)), [mD, mD, roof, roof, mW, mW]);
  mesh.position.set(x, h / 2, -y);
  mesh.rotation.y = o.rot || 0;
  mesh.castShadow = ctx.quality !== 'light';
  mesh.receiveShadow = true;
  ctx.add(mesh);
  // 屋根のふち（少し張り出す）と、その下の影色の帯・足もとの帯（ブラッシュアップ 3。建物の向き rot に合わせて子にする）
  const part = (bw, bh, bd, color, cy) => {
    const m = new THREE.Mesh(ctx.own(new THREE.BoxGeometry(bw, bh, bd)), ctx.std(color, { roughness: 0.95 }));
    m.position.y = cy;
    m.castShadow = ctx.quality !== 'light';
    m.receiveShadow = true;
    mesh.add(m);
    return m;
  };
  if (h > 2) {
    part(w + 0.9, 0.42, d + 0.9, o.edge || 0x8a7c6a, h / 2 + 0.2);
    part(w + 1.0, 0.1, d + 1.0, 0xb9ab95, h / 2 + 0.44);
    part(w + 0.04, 0.55, d + 0.04, 0xa79c8b, h / 2 - 0.27);
    part(w + 0.06, 0.45, d + 0.06, 0x9c9282, -h / 2 + 0.22);
  } else {
    part(w + 0.3, 0.3, d + 0.3, o.edge || 0xa3a39e, h / 2 + 0.15);
  }
  return mesh;
}

// ---- フェンス（網の絵を透かす） ----------------------------------------------------------------------
let meshTex = null;
function chainTexture(THREE) {
  if (meshTex) return meshTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.strokeStyle = 'rgba(120,124,124,1)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64);
  g.moveTo(-32, 32); g.lineTo(32, -32); g.moveTo(32, 96); g.lineTo(96, 32); g.moveTo(-32, 32); g.lineTo(32, 96); g.moveTo(32, -32); g.lineTo(96, 32);
  g.stroke();
  meshTex = new THREE.CanvasTexture(cv);
  meshTex.wrapS = meshTex.wrapT = THREE.RepeatWrapping;
  meshTex.colorSpace = THREE.SRGBColorSpace;
  return meshTex;
}

function fence(ctx, x1, y1, x2, y2, h = 1.8, post = 2.5) {
  const { THREE } = ctx;
  const L = Math.hypot(x2 - x1, y2 - y1);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const postMat = ctx.std(0x8d918f, { roughness: 0.6, metalness: 0.3 });
  const n = Math.max(1, Math.round(L / post));
  const postGeo = ctx.own(new THREE.CylinderGeometry(0.025, 0.025, h, 6));
  for (let i = 0; i <= n; i++) {
    const a = i / n;
    const m = new THREE.Mesh(postGeo, postMat);
    m.position.set(x1 + (x2 - x1) * a, h / 2, -(y1 + (y2 - y1) * a));
    m.castShadow = ctx.quality !== 'light';
    ctx.add(m);
  }
  const tex = chainTexture(THREE).clone();
  tex.repeat.set(L / 0.12, h / 0.12);
  tex.needsUpdate = true;
  ctx.own(tex);
  const pm = ctx.std(0xffffff, { map: tex, alphaTest: 0.35, transparent: false, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.2 });
  const panel = new THREE.Mesh(ctx.own(new THREE.PlaneGeometry(L, h * 0.96)), pm);
  panel.position.set((x1 + x2) / 2, h * 0.5, -(y1 + y2) / 2);
  panel.rotation.y = ang;
  panel.castShadow = ctx.quality !== 'light';
  ctx.add(panel);
  const rail = new THREE.Mesh(ctx.own(new THREE.CylinderGeometry(0.02, 0.02, L, 6)), postMat);
  rail.rotation.z = Math.PI / 2;
  rail.rotation.y = ang;
  rail.position.set((x1 + x2) / 2, h, -(y1 + y2) / 2);
  ctx.add(rail);
}

/** 地面の上の平たい多角形（舗装・砂の区域など）。pts は sim の座標。 */
function groundPoly(ctx, pts, mat, tile, lift = 0.003) {
  const { THREE } = ctx;
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = ctx.own(new THREE.ShapeGeometry(shape, 2));
  g.rotateX(-Math.PI / 2);   // (x, y) → (x, 0, −y)
  g.translate(0, lift, 0);
  worldUV(g, tile);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  ctx.add(m);
  return m;
}

/** 縁をでこぼこにした四角（自然な砂の区域・舗装のはげ）。 */
function roughRect(x0, y0, x1, y1, amt, rnd, step = 0.25) {
  const pts = [];
  const edge = (ax, ay, bx, by) => {
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.round(L / step));
    const nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let i = 0; i < n; i++) {
      const a = i / n, j = (i === 0 ? 0 : (rnd() - 0.5) * 2 * amt);
      pts.push([ax + (bx - ax) * a + nx * j, ay + (by - ay) * a + ny * j]);
    }
  };
  edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
  return pts;
}

/** 遠くの丘（なだらかな山）。 */
function hillMound(ctx, x, y, rx, ry, h, mat) {
  const { THREE } = ctx;
  const g = ctx.own(new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2));
  jitterGeo(g, 0.05, Math.round(x * 7 + y * 3) & 0xffff);
  const m = new THREE.Mesh(g, mat);
  m.scale.set(rx, h, ry);
  m.position.set(x, -0.05, -y);
  m.receiveShadow = true;
  ctx.add(m);
  return m;
}

/** 水面（川・海・池）。弱い反射（roughness を下げるだけ。光らせない）。 */
function waterMat(ctx, color = 0x5a8a88) {
  const m = ctx.std(color, { roughness: 0.16, metalness: 0.0, envMapIntensity: 0.55 });
  m.userData.water = true;
  return m;
}

// ---- 会場: 部室の前の芝生 ---------------------------------------------------------------------------
function buildBushitsu(ctx) {
  const b = ctx.bounds;
  const yB = Math.min(b.y0 - 7, -8);   // 部室棟は南（スタートの後ろ）
  const walk = ctx.std(0xffffff, { roughness: 0.95 });
  ctx.bank.apply('concrete', walk);
  ctx.flat(-40, yB + 1.0, 40, yB + 3.2, walk, TEXTURES.concrete.tile, 0.004);
  building(ctx, 0, yB - 4.5, 26, 7.5, 3.4, { wall: '#ddd5c3', glass: '#5f6f78', floors: 1, door: true, roof: 0x7d7f7c });
  building(ctx, -22, yB - 6, 12, 9, 7, { wall: '#cfc9bb', floors: 2 });
  // 自転車置き場の屋根
  const roofM = ctx.std(0x9aa3a6, { roughness: 0.7, metalness: 0.2 });
  ctx.box(8, 0.08, 2.2, roofM, 18, yB - 1.5, 2.2);
  for (const dx of [-3.8, 3.8]) ctx.box(0.08, 2.2, 0.08, roofM, 18 + dx, yB - 1.5, 0);
  // 植えこみと木
  const trees = [
    ...treeLine(ctx, Math.max(b.x1 + 9, 14), yB + 5, Math.max(b.x1 + 9, 14), b.y1 + 14, 6, ['broad'], [5, 8]),
    ...treeLine(ctx, Math.min(b.x0 - 9, -12), yB + 5, Math.min(b.x0 - 9, -12), b.y1 + 14, 6, ['broad', 'conifer'], [5, 9]),
    ...treeLine(ctx, -30, yB + 4, 30, yB + 4, 3.5, ['shrub'], [0.9, 1.4], 0.3),
    ...treeRing(ctx, 0, 10, 45, 80, 70, ['broad', 'conifer'], GREENS, [7, 13]),
  ];
  forest(ctx, trees);
  // 遠くの校舎（北）
  building(ctx, -20, b.y1 + 48, 40, 14, 15, { wall: '#d8d3c8', floors: 4 });
  building(ctx, 30, b.y1 + 55, 30, 14, 18, { wall: '#cbc6bb', floors: 5 });
}

// ---- 会場: 滑走路の隣の芝生 ---------------------------------------------------------------------------
function buildFunabashi(ctx) {
  const b = ctx.bounds;
  const rx0 = Math.max(b.x1 + 14, 48), rx1 = rx0 + 30;
  const asph = ctx.std(0xffffff, { roughness: 0.95 });
  ctx.bank.apply('pavement', asph);
  ctx.flat(rx0, -260, rx1, 260, asph, TEXTURES.pavement.tile, 0.004);
  // 白線（つや消しの塗料）
  const paint = ctx.std(0xe9e6dc, { roughness: 0.9 });
  for (let y = -250; y < 250; y += 12) ctx.flat(rx0 + 14.8, y, rx0 + 15.2, y + 6, paint, 1, 0.006);
  ctx.flat(rx0 + 1.2, -260, rx0 + 1.5, 260, paint, 1, 0.006);
  ctx.flat(rx1 - 1.5, -260, rx1 - 1.2, 260, paint, 1, 0.006);
  // 吹き流し（赤白の布の筒）
  const pole = ctx.std(0xb9bcbc, { roughness: 0.6 });
  ctx.box(0.08, 5, 0.08, pole, rx0 - 6, b.y1 - 4, 0);
  const sockC = [0xd0603a, 0xece6da];
  for (let i = 0; i < 4; i++) {
    const r0 = 0.32 - i * 0.05;
    const s = new ctx.THREE.Mesh(ctx.own(new ctx.THREE.CylinderGeometry(r0 - 0.05, r0, 0.5, 10, 1, true)), ctx.std(sockC[i % 2], { side: ctx.THREE.DoubleSide }));
    s.rotation.z = Math.PI / 2 + 0.25;
    s.position.set(rx0 - 6 + 0.3 + i * 0.48, 4.85 - i * 0.12, -(b.y1 - 4));
    ctx.add(s);
  }
  // 格納庫（東）
  building(ctx, rx1 + 30, 0, 20, 34, 9, { wall: '#c9c6bd', glass: '#6a7276', floors: 1, cols: 3, roof: 0x8c8f8f });
  building(ctx, rx1 + 30, 50, 18, 24, 7, { wall: '#d3cfc4', floors: 2 });
  // 木（西・北・南）と遠くの校舎
  forest(ctx, [
    ...treeLine(ctx, Math.min(b.x0 - 22, -55), -120, Math.min(b.x0 - 22, -55), 140, 5, ['broad', 'conifer'], [7, 13], 2.5),
    ...treeLine(ctx, -90, Math.max(b.y1 + 30, 75), rx0 - 12, Math.max(b.y1 + 30, 75), 6, ['broad'], [6, 11], 3),
    ...treeLine(ctx, -90, Math.min(b.y0 - 30, -70), rx0 - 12, Math.min(b.y0 - 30, -70), 6, ['broad', 'conifer'], [6, 12], 3),
  ]);
  building(ctx, -110, -60, 40, 18, 16, { wall: '#d5d0c5', floors: 4 });
  building(ctx, -100, 90, 30, 16, 12, { wall: '#cdc8bd', floors: 3 });
}

// ---- 会場: 建物の裏の通路 -----------------------------------------------------------------------------
function buildUra(ctx) {
  const b = ctx.bounds;
  const xw = Math.min(b.x0 - 1.5, -5), xe = Math.max(b.x1 + 2, 8.5);
  const yS = Math.min(b.y0 - 8, -8), yN = Math.max(b.y1 + 10, 26);
  building(ctx, xw - 8, (yS + yN) / 2, 16, yN - yS + 10, 14, { wall: '#d2cbbb', glass: '#56646d', floors: 4 });
  building(ctx, xe + 6, (yS + yN) / 2 - 2, 12, yN - yS + 4, 8, { wall: '#c9c3b5', glass: '#5a6870', floors: 2 });
  // 側溝のふた（壁ぎわ）
  const grate = ctx.std(0x6f7270, { roughness: 0.6, metalness: 0.3 });
  ctx.flat(xw + 0.0, yS, xw + 0.35, yN, grate, 1, 0.005);
  ctx.flat(xe - 0.35, yS, xe, yN, grate, 1, 0.005);
  // 室外機・配管（東の建物の壁ぎわ）
  const unit = ctx.std(0xc8c9c4, { roughness: 0.7 });
  const fan = ctx.std(0x55595a, { roughness: 0.6 });
  for (let y = yS + 4; y < yN - 4; y += 6.5) {
    if (!ctx.free(xe - 0.6, y, 0.2) && xe - 0.6 < b.x1 + 0.5) continue;
    ctx.box(0.4, 0.62, 0.85, unit, xe - 0.25, y, 0);
    ctx.box(0.02, 0.44, 0.44, fan, xe - 0.46, y, 0.09);
  }
  const pipe = ctx.std(0xa4a39d, { roughness: 0.6 });
  for (const z of [2.6, 2.9]) {
    const p = new ctx.THREE.Mesh(ctx.own(new ctx.THREE.CylinderGeometry(0.05, 0.05, yN - yS, 8)), pipe);
    p.rotation.x = Math.PI / 2; p.position.set(xe - 0.1, z, -(yS + yN) / 2); ctx.add(p);
  }
  // 北の出口のフェンスと木
  fence(ctx, xw, yN, xe, yN, 1.8);
  forest(ctx, [
    ...treeLine(ctx, xw - 2, yN + 5, xe + 10, yN + 5, 3.5, ['broad'], [5, 9], 1.2),
    ...treeRing(ctx, (xw + xe) / 2, yN + 20, 10, 40, 25, ['broad', 'conifer'], GREENS, [6, 11]),
  ]);
  // 南は駐輪場の屋根
  const roofM = ctx.std(0x9aa3a6, { roughness: 0.7, metalness: 0.2 });
  ctx.box(xe - xw - 1, 0.08, 2.4, roofM, (xw + xe) / 2, yS - 2, 2.3);
}

// ---- 会場: 河川敷の練習場 -----------------------------------------------------------------------------
function buildKasen(ctx) {
  const b = ctx.bounds;
  const rx0 = Math.max(b.x1 + 26, 32);
  // 川（東）。手前に砂の岸
  const sandM = ctx.std(0xffffff, { roughness: 1 });
  ctx.bank.apply('sand', sandM, { tint: 0xece4d2 });
  ctx.flat(rx0 - 6, -300, rx0 + 1, 300, sandM, TEXTURES.sand.tile, 0.004);
  const water = new ctx.THREE.Mesh(ctx.own(new ctx.THREE.PlaneGeometry(90, 600, 4, 24)), waterMat(ctx, 0x5f8682));
  water.rotation.x = -Math.PI / 2; water.position.set(rx0 + 45, 0.02, 0);
  ctx.add(water);
  // 葦（岸ぞい）
  forest(ctx, treeLine(ctx, rx0 - 3, -150, rx0 - 3, 150, 3, ['shrub'], [0.9, 1.6], 1.5, [0x8a9a55, 0x7d9150, 0x9aa462]));
  // 土手（西）: 長い台形の盛り土に芝。上に舗装の道
  const { THREE } = ctx;
  const lx = Math.min(b.x0 - 22, -28);
  const levee = new THREE.Shape([new THREE.Vector2(-9, 0), new THREE.Vector2(-3, 4.5), new THREE.Vector2(3, 4.5), new THREE.Vector2(9, 0)]);
  const lg = ctx.own(new THREE.ExtrudeGeometry(levee, { depth: 600, bevelEnabled: false }));
  lg.translate(0, 0, -300);
  const lp = lg.attributes.position, luv = lg.attributes.uv;
  for (let i = 0; i < lp.count; i++) luv.setXY(i, lp.getZ(i) / 3, (lp.getX(i) + lp.getY(i)) / 3);
  const lm = ctx.std(0xffffff, { roughness: 1 });
  ctx.bank.apply('grass', lm, { tint: 0xf0f2e2 });
  const lev = new THREE.Mesh(lg, lm);
  lev.position.x = lx;
  lev.receiveShadow = true;
  ctx.add(lev);
  const road = ctx.std(0xffffff, { roughness: 0.95 });
  ctx.bank.apply('pavement', road);
  ctx.flat(lx - 2.2, -300, lx + 2.2, 300, road, TEXTURES.pavement.tile, 4.52);
  // 橋（北の遠く）
  const conc = ctx.std(0xb4b1a8, { roughness: 0.9 });
  const yBr = Math.max(b.y1 + 110, 120);
  ctx.box(140, 1.4, 9, conc, rx0 + 10, yBr, 8);
  for (let x = lx; x < rx0 + 80; x += 22) ctx.box(2.2, 8, 3, conc, x, yBr, 0);
  ctx.box(140, 1.1, 0.3, ctx.std(0x8e9190, { metalness: 0.3, roughness: 0.6 }), rx0 + 10, yBr - 4.3, 9.4);
  // 砂の所・木
  const tufts = [];
  for (let i = 0; i < 80 * ctx.density; i++) {
    const x = b.x0 - 12 + ctx.rnd() * (rx0 - b.x0 + 4), y = -60 + ctx.rnd() * 140;
    if (ctx.free(x, y, 1.5)) tufts.push({ x, y, h: 0.5 + ctx.rnd() * 0.6, kind: 'shrub', c: pick(ctx.rnd, [0x6f8a45, 0x7c934c, 0x8f9d58]) });
  }
  forest(ctx, [...tufts, ...treeLine(ctx, lx - 14, -200, lx - 14, 200, 7, ['broad'], [6, 11], 3)]);
  // 対岸の木
  forest(ctx, treeLine(ctx, rx0 + 95, -260, rx0 + 95, 260, 6, ['broad', 'conifer'], [6, 12], 4));
}

// ---- 会場: 落下試験の練習場 ---------------------------------------------------------------------------
function buildDrop(ctx) {
  const b = ctx.bounds;
  // ところどころ土の出た芝
  const soilM = ctx.std(0xffffff, { roughness: 1 });
  ctx.bank.apply('soil', soilM);
  const r = rng32(77);
  for (let i = 0; i < 9; i++) {
    const cx = -40 + r() * 80, cy = -30 + r() * 70, w = 3 + r() * 7, h = 2 + r() * 6;
    groundPoly(ctx, roughRect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, 0.5, r, 0.6), soilM, TEXTURES.soil.tile, 0.003 + i * 0.0002);
  }
  // 高所作業車（スタートの真上 30 m から吊るす）
  const s = ctx.world.start || { x: 0, y: 0 };
  const h0 = (ctx.world.drop && ctx.world.drop.height) || 30;
  ctx.carrier = buildCarrier(ctx, s.x || 0, s.y || 0, h0);
  // テントと机
  const tent = ctx.std(0x6f8796, { roughness: 0.85, side: ctx.THREE.DoubleSide });
  const leg = ctx.std(0xa9adae, { metalness: 0.3, roughness: 0.6 });
  const tx = Math.min(b.x0 - 8, -16), ty = Math.min(b.y0 - 4, -10);
  ctx.box(3.2, 0.06, 3.2, tent, tx, ty, 2.3);
  const roofG = ctx.own(new ctx.THREE.ConeGeometry(2.3, 0.6, 4, 1, true));
  const roof = new ctx.THREE.Mesh(roofG, tent); roof.rotation.y = Math.PI / 4; roof.position.set(tx, 2.63, -ty); ctx.add(roof);
  for (const [dx, dy] of [[-1.55, -1.55], [1.55, -1.55], [-1.55, 1.55], [1.55, 1.55]]) ctx.box(0.05, 2.3, 0.05, leg, tx + dx, ty + dy, 0);
  ctx.box(1.8, 0.04, 0.7, ctx.std(0xd8d4c8), tx, ty + 0.4, 0.72);
  for (const dx of [-0.8, 0.8]) ctx.box(0.04, 0.72, 0.6, leg, tx + dx, ty + 0.4, 0);
  // 立入禁止のくい（黄と黒は使わず、白と灰の杭とロープ）
  const stake = ctx.std(0xe2ded2, { roughness: 0.8 });
  const R = 8;
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2;
    const x = (s.x || 0) + Math.cos(a) * R, y = (s.y || 0) + Math.sin(a) * R;
    if (!ctx.free(x, y, -2.5)) continue;
    ctx.box(0.05, 0.9, 0.05, stake, x, y, 0);
  }
  forest(ctx, [
    ...treeRing(ctx, 0, 0, Math.max(60, Math.hypot(b.x1, b.y1) + 25), 110, 110, ['broad', 'conifer'], GREENS, [7, 14]),
  ]);
  building(ctx, 70, -60, 24, 12, 6, { wall: '#d6d0c3', floors: 2 });
}

/** 高所作業車（黄色）。バケットの下が (x, y, h + 1.2) に来るように腕をのばす。 */
function buildCarrier(ctx, x, y, h) {
  const { THREE } = ctx;
  const g = new THREE.Group();
  g.name = 'carrier';
  const yellow = ctx.std(0xe0b437, { roughness: 0.55 });
  const white = ctx.std(0xe9e6de, { roughness: 0.6 });
  const dark = ctx.std(0x2f3234, { roughness: 0.9 });
  const steel = ctx.std(0x9a9d9c, { roughness: 0.5, metalness: 0.4 });
  const glass = ctx.std(0x56656d, { roughness: 0.25 });
  const add = (geo, m, px, py, pz, parent = g) => { const me = new THREE.Mesh(ctx.own(geo), m); me.position.set(px, py, pz); me.castShadow = ctx.quality !== 'light'; me.receiveShadow = true; parent.add(me); return me; };
  // 車体（車の長さ 8 m・幅 2.3 m。ローカルで +X が前）
  add(new THREE.BoxGeometry(7.6, 0.5, 2.3), dark, 0, 0.95, 0);
  add(new THREE.BoxGeometry(2.0, 2.0, 2.3), white, 3.0, 2.15, 0);       // 運転席
  add(new THREE.BoxGeometry(0.05, 0.8, 1.9), glass, 4.01, 2.5, 0);
  add(new THREE.BoxGeometry(5.4, 0.6, 2.3), yellow, -0.9, 1.5, 0);      // 荷台
  for (const wx of [-2.6, -1.4, 2.8]) for (const wz of [-1.05, 1.05]) {
    const wgeo = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 16); wgeo.rotateX(Math.PI / 2);
    add(wgeo, dark, wx, 0.5, wz);
  }
  // アウトリガー
  for (const ox of [-3.2, 1.6]) for (const oz of [-1, 1]) { add(new THREE.BoxGeometry(0.25, 0.25, 1.2), yellow, ox, 1.0, oz * 1.6); add(new THREE.BoxGeometry(0.4, 0.9, 0.4), steel, ox, 0.45, oz * 2.15); }
  const turret = new THREE.Group();
  turret.position.set(-2.2, 1.8, 0);
  g.add(turret);
  add(new THREE.CylinderGeometry(0.7, 0.8, 0.6, 16), yellow, 0, 0.3, 0, turret);
  const boom = new THREE.Group();
  boom.position.set(0, 0.8, 0);
  turret.add(boom);
  const bucket = new THREE.Group();
  g.add(bucket);
  add(new THREE.BoxGeometry(1.2, 1.0, 0.9), white, 0, 0.5, 0, bucket);
  add(new THREE.BoxGeometry(1.24, 0.1, 0.94), yellow, 0, 1.0, 0, bucket);
  const sections = [];
  for (let k = 0; k < 3; k++) {
    const w = 0.55 - k * 0.12;
    sections.push(add(new THREE.BoxGeometry(1, w, w), k === 0 ? yellow : k === 1 ? white : yellow, 0, 0, 0, boom));
  }
  const ropeMat = ctx.own(new THREE.LineBasicMaterial({ color: 0x4a4440 }));
  const ropeGeo = ctx.own(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]));
  const rope = new THREE.Line(ropeGeo, ropeMat);
  rope.frustumCulled = false;
  ctx.add(rope);
  ctx.add(g);
  const tmp = new THREE.Vector3();
  /** 吊るす所を (x, y) の高さ h に（sim の座標）。バケットはその 1.2 m 上。 */
  function setTarget(tx, ty, th) {
    // 車は吊るす所から南西に 7 m（向きは北東を向く）
    const ang = Math.PI / 4;   // 車の前 = 北東
    const bx = tx - Math.cos(ang) * 7.5, by = ty - Math.sin(ang) * 7.5;
    g.position.set(bx, 0, -by);
    g.rotation.y = ang;        // ローカル +X → 北東
    // 腕の付け根（世界）→ バケットの所
    turret.rotation.set(0, 0, 0);
    boom.rotation.set(0, 0, 0);
    g.updateMatrixWorld(true);
    const base = turret.localToWorld(tmp.set(0, 0.8, 0)).clone();
    const top = new THREE.Vector3(tx, th + 2.2, -ty);
    const dir = top.clone().sub(base);
    const L = dir.length();
    // 付け根から見た向き（ローカルの turret の中で）
    const local = turret.worldToLocal(top.clone());
    const yaw = Math.atan2(-local.z, local.x);
    turret.rotation.y = yaw;
    const horiz = Math.hypot(local.x, local.z);
    const pitch = Math.atan2(local.y - 0.8, horiz);
    boom.rotation.set(0, 0, pitch);
    const part = L / 3;
    sections.forEach((s, k) => { s.scale.x = part + 0.6; s.position.set(part * (k + 0.5), 0, 0); });
    bucket.position.set(top.x, top.y - 1.0 + 0.0, top.z);
    bucket.rotation.y = g.rotation.y;
    void dir;
  }
  setTarget(x, y, h);
  return {
    group: g, rope, setTarget,
    /** 吊りひもの下の端（sim の座標の高さ z の所）。null で隠す。 */
    setRope(p) {
      if (!p) { rope.visible = false; return; }
      rope.visible = true;
      const pos = ropeGeo.attributes.position;
      pos.setXYZ(0, bucket.position.x, bucket.position.y, bucket.position.z);
      pos.setXYZ(1, p.x, p.y, p.z);
      pos.needsUpdate = true;
      ropeGeo.computeBoundingSphere();
    },
    bucketPos: () => bucket.position.clone(),
  };
}

// ---- 会場: 種子島 竹崎 ---------------------------------------------------------------------------------
function buildTakezaki(ctx, which) {
  const b = ctx.bounds;
  const { THREE } = ctx;
  const sandM = ctx.std(0xffffff, { roughness: 1 });
  ctx.bank.apply('sand', sandM, { tint: 0xf4efe2 });
  // A は南に海、B は東に海（会場の向きを変えて見分けやすく）
  const seaGap = which === 'a' ? Math.min(b.y0 - 30, -80) : Math.max(b.x1 + 35, 100);
  if (which === 'a') {
    ctx.flat(-400, seaGap - 26, 400, seaGap, sandM, TEXTURES.sand.tile, 0.004);
    const sea = new THREE.Mesh(ctx.own(new THREE.PlaneGeometry(1600, 900, 32, 18)), waterMat(ctx, 0x4f8a98));
    sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.03, -(seaGap - 26 - 450)); ctx.add(sea);
  } else {
    ctx.flat(seaGap, -400, seaGap + 26, 400, sandM, TEXTURES.sand.tile, 0.004);
    const sea = new THREE.Mesh(ctx.own(new THREE.PlaneGeometry(900, 1600, 18, 32)), waterMat(ctx, 0x4f8a98));
    sea.rotation.x = -Math.PI / 2; sea.position.set(seaGap + 26 + 450, 0.03, 0); ctx.add(sea);
    // B は芝に砂の所が多い
    const r = rng32(91);
    for (let i = 0; i < 7; i++) {
      const cx = b.x0 - 10 + r() * (b.x1 - b.x0 + 20), cy = b.y0 - 10 + r() * (b.y1 - b.y0 + 20);
      if (!ctx.free(cx, cy, -6) && r() < 0.6) continue;
      const w = 6 + r() * 12, h = 4 + r() * 10;
      groundPoly(ctx, roughRect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, 0.8, r, 0.8), sandM, TEXTURES.sand.tile, 0.0032 + i * 0.0002);
    }
  }
  // 南国の木・丘
  const darkGreens = [0x3c5e30, 0x46693a, 0x355428, 0x4f7240];
  const hillM = ctx.std(0x56743f, { roughness: 1, flatShading: true });
  const far = which === 'a' ? [[-260, 300], [40, 360], [300, 280], [-420, 120]] : [[-300, -200], [-320, 160], [-150, 380], [120, 420]];
  for (const [hx, hy] of far) hillMound(ctx, hx, hy, 120 + ctx.rnd() * 60, 90 + ctx.rnd() * 40, 28 + ctx.rnd() * 20, hillM);
  forest(ctx, [
    ...treeRing(ctx, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.max(70, (b.x1 - b.x0) / 2 + 30), 170, 140, ['broad', 'palm', 'broad'], darkGreens, [6, 12],
      (x, y) => (which === 'a' ? y < seaGap + 6 : x > seaGap - 6)),
  ]);
  // 岬の白い塔（どこかの団体のものではない、ただの灯台ふう）
  const white = ctx.std(0xe8e6df, { roughness: 0.7 });
  const tx = which === 'a' ? 380 : seaGap + 60, ty = which === 'a' ? seaGap - 20 : -360;
  const tower = new THREE.Mesh(ctx.own(new THREE.CylinderGeometry(2.2, 3.4, 26, 12)), white);
  tower.position.set(tx, 13, -ty); ctx.add(tower);
  ctx.box(6, 3, 6, ctx.std(0x8f9693), tx, ty, 26);
  // 観客用のテントとフェンス
  const tent = ctx.std(0x7e93a0, { roughness: 0.85 });
  const ex = b.x0 - 12, ey = (b.y0 + b.y1) / 2;
  for (let k = 0; k < 3; k++) ctx.box(4, 0.08, 4, tent, ex, ey - 6 + k * 6, 2.4);
  const leg = ctx.std(0xa9adae, { metalness: 0.3, roughness: 0.6 });
  for (let k = 0; k < 3; k++) for (const [dx, dy] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) ctx.box(0.05, 2.4, 0.05, leg, ex + dx, ey - 6 + k * 6 + dy, 0);
}

// ---- 会場: 鳥取砂丘 ルナテラス -------------------------------------------------------------------------
function buildLunar(ctx) {
  const b = ctx.bounds;
  const duneM = ctx.std(0xffffff, { roughness: 1, flatShading: false });
  ctx.bank.apply('dune', duneM);
  const { THREE } = ctx;
  // 大きな砂丘（コースの外）
  const dunes = [[-80, 60, 70, 40, 12], [70, 90, 60, 50, 16], [0, 160, 120, 45, 22], [-140, -40, 60, 70, 10], [120, -30, 50, 60, 9], [-30, -110, 90, 40, 8]];
  for (const [dx, dy, rx, ry, h] of dunes) {
    if (!ctx.free(dx, dy, Math.max(rx, ry) * 0.6)) continue;
    const g = ctx.own(new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2));
    jitterGeo(g, 0.06, Math.round(dx * 3 + dy) & 0xffff);
    // UV を世界の m に
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) * rx + dx) / 3, (p.getZ(i) * ry - dy) / 3);
    const m = new THREE.Mesh(g, duneM);
    m.scale.set(rx, h, ry); m.position.set(dx, -0.1, -dy);
    m.receiveShadow = true; m.castShadow = ctx.quality === 'fine';
    ctx.add(m);
  }
  // 海（北の遠く）
  const sea = new THREE.Mesh(ctx.own(new THREE.PlaneGeometry(2000, 800, 40, 16)), waterMat(ctx, 0x4d8597));
  sea.rotation.x = -Math.PI / 2; sea.position.set(0, -0.2, -(480 + 400)); ctx.add(sea);
  // まばらな草
  const tufts = [];
  for (let i = 0; i < 70 * ctx.density; i++) {
    const x = -90 + ctx.rnd() * 180, y = -60 + ctx.rnd() * 160;
    if (ctx.free(x, y, 2)) tufts.push({ x, y, h: 0.3 + ctx.rnd() * 0.5, kind: 'shrub', c: pick(ctx.rnd, [0x7d8f4c, 0x8c9a58, 0x6e8446]) });
  }
  forest(ctx, tufts);
  forest(ctx, treeLine(ctx, -400, -200, 400, -200, 8, ['conifer', 'broad'], [7, 12], 6, [0x3e5c34, 0x48693c]));
  void b;
}

// ------------------------------------------------------------------------------------------------
// 世界の物（6.10 の objects）
// ------------------------------------------------------------------------------------------------

/** コーンの寸法（6.2）。 */
export const CONE = Object.freeze({ h: 0.70, r: 0.19 });

/**
 * 世界の物を作る（コーンは朱色に白い帯・高さ 0.70 m、旗は小さな布の三角、パラは紫で中心に穴）。
 * @param {typeof import('three')} THREE @param {object} world 世界（6.10）
 * @param {{quality?: string, bank: ReturnType<typeof createTextureBank>}} [opts]
 * @returns {{group: object, byId: Map<string, object>, dispose: () => void}}
 */
export function buildObjects(THREE, world, opts = {}) {
  const group = new THREE.Group();
  group.name = 'objects';
  const owned = [];
  const own = (x) => { owned.push(x); return x; };
  const byId = new Map();
  const shadows = opts.quality !== 'light';
  const std = (color, extra = {}) => own(surfaceMaterial(THREE, opts.quality || 'normal', { color, roughness: 0.8, metalness: 0, ...extra }));
  const bank = opts.bank;
  const ctx = { THREE, group, own, quality: opts.quality || 'normal', bank, rnd: rng32(7), std, density: 1, world, bounds: courseBounds(world),
    add: (o) => { group.add(o); return o; }, free: () => true };

  const mats = {
    cone: std(0xd8562a, { roughness: 0.55 }),
    coneBand: std(0xeeebe2, { roughness: 0.5 }),
    coneBase: std(0x2c2f31, { roughness: 0.9 }),
    pole: std(0xd9d6cc, { roughness: 0.6 }),
    rock: [std(0x8b8780, { flatShading: true, roughness: 0.95 }), std(0x9a958b, { flatShading: true, roughness: 0.95 }), std(0x7b7872, { flatShading: true, roughness: 0.95 })],
    hedge: (() => { const m = std(0xffffff, { roughness: 0.95 }); if (bank) bank.apply('leaves', m); return m; })(),
    hedgeDark: std(0x2f4a28, { roughness: 1 }),
    wall: (() => { const m = std(0xffffff, { roughness: 0.95 }); if (bank) bank.apply('concrete', m); return m; })(),
    sand: (() => { const m = std(0xffffff, { roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); if (bank) bank.apply('sand', m); return m; })(),
    hill: (() => { const m = std(0xffffff, { roughness: 1 }); if (bank) bank.apply('dune', m, { tint: 0xe9dfcc }); return m; })(),
    mud: (() => { const m = std(0xffffff, { roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); if (bank) bank.apply('soil', m, { tint: 0xd8cfc0 }); return m; })(),
    water: (() => { const m = std(0x4f7f7b, { roughness: 0.12, envMapIntensity: 0.6 }); m.userData.water = true; return m; })(),
    chalk: own(new THREE.MeshBasicMaterial({ color: 0xf2efe6, transparent: true, opacity: 0.55, depthWrite: false })),
    markerLeg: std(0x6c6a64, { roughness: 0.8 }),
  };
  const mk = (geo, mat, x, y, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, z, -y);
    m.castShadow = shadows; m.receiveShadow = true;
    return m;
  };

  // 共有する形
  const coneBody = own(new THREE.CylinderGeometry(0.028, CONE.r * 0.92, CONE.h - 0.03, 32, 1, true));
  coneBody.translate(0, 0.03 + (CONE.h - 0.03) / 2, 0);
  const coneTop = own(new THREE.CylinderGeometry(0.02, 0.028, 0.012, 16));
  coneTop.translate(0, CONE.h + 0.006, 0);
  const bandAt = (y0, y1) => {
    const f = (y) => 0.028 + (CONE.r * 0.92 - 0.028) * (1 - (y - 0.03) / (CONE.h - 0.03));
    const g = own(new THREE.CylinderGeometry(f(y1) + 0.0015, f(y0) + 0.0015, y1 - y0, 32, 1, true));
    g.translate(0, (y0 + y1) / 2, 0);
    return g;
  };
  const band1 = bandAt(0.40, 0.50);
  // 台の板は当たりの円（r）の内側に収める（前は下の端が r + 5 mm で、ふれて止まったローバーがめり込んで見えた。直し係 6）
  const coneBaseG = own(new THREE.CylinderGeometry(CONE.r - 0.012, CONE.r - 0.006, 0.03, 32));
  coneBaseG.translate(0, 0.015, 0);
  const rockGeos = [0, 1, 2, 3].map((k) => { const g = own(new THREE.IcosahedronGeometry(1, 1)); jitterGeo(g, 0.22, 101 + k * 17); g.translate(0, 0.35, 0); return g; });

  let rockN = 0;
  for (const o of (world && world.objects) || []) {
    let node = null;
    switch (o.type) {
      case 'cone': {
        node = new THREE.Group();
        const r = o.r || CONE.r;
        const s = r / CONE.r;
        node.add(mk(coneBaseG, mats.coneBase, 0, 0));
        node.add(mk(coneBody, mats.cone, 0, 0));
        node.add(mk(band1, mats.coneBand, 0, 0));
        node.add(mk(coneTop, mats.cone, 0, 0));
        node.scale.set(s, 1, s);
        node.position.set(o.x, 0, -o.y);
        break;
      }
      case 'flag': node = makeFlag(THREE, o, own, std, shadows, mats); break;
      case 'rock': {
        if (String(o.kind || '').includes('花だん')) { node = makeFlowerBed(THREE, o, own, std, shadows, bank); break; }
        const r = o.r || 0.25, h = o.h || 0.3;
        node = mk(rockGeos[rockN++ % rockGeos.length], mats.rock[rockN % 3], o.x, o.y, -0.02);
        node.scale.set(r * 1.02, h / 1.35, r * 1.02);
        node.rotation.y = (o.x * 3.1 + o.y * 1.7) % 6.28;
        break;
      }
      case 'wall': node = makeWall(THREE, o, own, std, mats, shadows, ctx); break;
      case 'area': node = makeArea(THREE, o, own, mats, ctx); break;
      case 'line': {
        const L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        const g = own(new THREE.PlaneGeometry(L, 0.04));
        g.rotateX(-Math.PI / 2);
        node = new THREE.Mesh(g, mats.chalk);
        node.position.set((o.x1 + o.x2) / 2, 0.006, -(o.y1 + o.y2) / 2);
        node.rotation.y = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        node.renderOrder = 1;
        break;
      }
      case 'marker': node = makeMarker(THREE, o, world, own, std, mats, shadows); break;
      default: break;
    }
    if (node) {
      node.name = `${o.type}:${o.id ?? ''}`;
      node.userData.obj = o;
      group.add(node);
      if (o.id !== undefined) byId.set(String(o.id), node);
    }
  }
  return { group, byId, dispose() { for (const o of owned) { try { o.dispose(); } catch { /* 無視 */ } } } };
}

/**
 * 旗の布の字（中の ID の f33・c1 などは出さない。直し係 4）: 1 文字の大文字の名前（A・B・F）はそのまま、
 * label が「3.3 m」なら距離、「角 1」「点 2」のように数で終わるなら数、ほかは無地。
 */
export function flagText(o) {
  const id = String((o && o.id) ?? '');
  if (/^[A-Z]$/.test(id)) return id;
  const label = String((o && o.label) || '').trim();
  if (/^\d+(\.\d+)?\s*m$/.test(label)) return label.replace(/\s+/, ' ');
  const m = label.match(/(\d+)$/);
  return m ? m[1] : '';
}

function makeFlag(THREE, o, own, std, shadows, mats) {
  const node = new THREE.Group();
  const pole = new THREE.Mesh(own(new THREE.CylinderGeometry(0.005, 0.007, 0.42, 8)), mats.pole);
  pole.position.y = 0.21; pole.castShadow = shadows; node.add(pole);
  const foot = new THREE.Mesh(own(new THREE.CylinderGeometry(0.035, 0.04, 0.015, 12)), std(0x7d7a73));
  foot.position.y = 0.0075; node.add(foot);
  // 地面に色付きの輪（上から見ても旗の場所が分かる。ブラッシュアップ 12）
  const ring = new THREE.Mesh(own(new THREE.RingGeometry(0.15, 0.2, 40)),
    own(new THREE.MeshLambertMaterial({ color: 0xd9922b, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.004; ring.renderOrder = 1; ring.userData.noOcclude = true; ring.name = 'flag-ring';
  node.add(ring);
  // 布（三角）に名前の字。少し波うたせる
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 96;
  const g = cv.getContext('2d');
  g.fillStyle = '#e3b54a'; g.fillRect(0, 0, 128, 96);
  g.fillStyle = 'rgba(120,80,20,0.18)'; g.fillRect(0, 0, 6, 96);
  const name = flagText(o);
  if (name) {
    g.fillStyle = '#5a3f12'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 44;
    g.font = `bold ${fs}px sans-serif`;
    while (fs > 18 && g.measureText(name).width > 84) { fs -= 2; g.font = `bold ${fs}px sans-serif`; }
    g.fillText(name, 46, 50);
  }
  const tex = own(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace;
  const geo = own(new THREE.BufferGeometry());
  const W = 0.14, H = 0.1, n = 8;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n;
    const x = a * W, wave = Math.sin(a * 5) * 0.012 * a;
    const top = H / 2 * (1 - a), bot = -H / 2 * (1 - a);
    pos.push(x, top, wave, x, bot, wave);
    uv.push(a, 1 - a / 2, a, a / 2);
  }
  for (let i = 0; i < n; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const cloth = new THREE.Mesh(geo, std(0xffffff, { map: tex, side: THREE.DoubleSide, roughness: 0.9 }));
  cloth.position.set(0.005, 0.36, 0);
  cloth.castShadow = shadows;
  node.add(cloth);
  node.position.set(o.x, 0, -o.y);
  node.rotation.y = 0.5;
  // 細い棒と足はローバーを隠す物に数えない（追従カメラが旗をよけて高く上がりすぎないように。直し係 5）。
  // 布は数える（手前の旗の布がローバーを半分隠した。直し係 6）
  node.traverse((x) => { if (x !== cloth) x.userData.noOcclude = true; });
  cloth.userData.occludeCloth = true;
  return node;
}

/**
 * 花だん（3-1。sim では当たりの丸 r の「石」と同じ）: 低い木の枠に土、草の株と小さな花。色は落ち着いた自然な色（直し係 5）。
 */
function makeFlowerBed(THREE, o, own, std, shadows, bank) {
  const node = new THREE.Group();
  const r = o.r || 0.3, side = r * 2, wallH = 0.16, th = 0.045;
  const wood = std(0x8b6b4a, { roughness: 0.9 });
  const woodDark = std(0x6f5439, { roughness: 0.95 });
  const plank = (w, d, x, z, mat) => {
    const m = new THREE.Mesh(own(new THREE.BoxGeometry(w, wallH, d)), mat);
    m.position.set(x, wallH / 2, z); m.castShadow = shadows; m.receiveShadow = true; node.add(m);
  };
  plank(side + th, th, 0, -side / 2, wood); plank(side + th, th, 0, side / 2, wood);
  plank(th, side - th, -side / 2, 0, woodDark); plank(th, side - th, side / 2, 0, woodDark);
  // 角の杭（枠より少し高い）
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = new THREE.Mesh(own(new THREE.BoxGeometry(th * 1.3, wallH + 0.03, th * 1.3)), woodDark);
    p.position.set(sx * side / 2, (wallH + 0.03) / 2, sz * side / 2); p.castShadow = shadows; node.add(p);
  }
  const soilMat = std(0xffffff, { roughness: 1 });
  if (bank) bank.apply('soil', soilMat, { tint: 0x9b8366 }); else soilMat.color.setHex(0x5e4a36);
  const soil = new THREE.Mesh(own(new THREE.BoxGeometry(side - th, 0.02, side - th)), soilMat);
  soil.position.y = wallH - 0.025; soil.receiveShadow = true; node.add(soil);
  // 草の株と花（同じ形を使い回す）
  const rnd = rng32(Math.round((o.x * 13 + o.y * 7) * 100) >>> 0 || 5);
  const leafG = own(new THREE.IcosahedronGeometry(0.05, 0)); leafG.scale(1, 0.7, 1);
  const stemG = own(new THREE.CylinderGeometry(0.004, 0.005, 1, 5));
  const headG = own(new THREE.IcosahedronGeometry(0.022, 1)); headG.scale(1, 0.6, 1);
  const leafMats = [0x5d7f3c, 0x6c8c44, 0x4f6f34].map((c) => std(c, { roughness: 0.95, flatShading: true }));
  const stemMat = std(0x5b7a3a, { roughness: 0.9 });
  const petal = [0xe7c3c8, 0xf1ede3, 0xe2c062, 0xb7a3cf, 0xd88a6a].map((c) => std(c, { roughness: 0.8 }));
  const base = wallH - 0.015, half = side / 2 - th * 1.2;
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(leafG, leafMats[i % 3]);
    m.position.set((rnd() * 2 - 1) * half, base + 0.02, (rnd() * 2 - 1) * half);
    const s = 0.7 + rnd() * 0.6; m.scale.set(s, s, s); m.rotation.y = rnd() * 6;
    m.castShadow = shadows; node.add(m);
  }
  for (let i = 0; i < 26; i++) {
    const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half, h = 0.08 + rnd() * 0.12;
    const st = new THREE.Mesh(stemG, stemMat);
    st.scale.y = h; st.position.set(x, base + h / 2, z); node.add(st);
    const hd = new THREE.Mesh(headG, petal[i % petal.length]);
    hd.position.set(x, base + h, z); hd.castShadow = shadows; node.add(hd);
  }
  node.position.set(o.x, 0, -o.y);
  return node;
}

function makeWall(THREE, o, own, std, mats, shadows, ctx) {
  const L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const node = new THREE.Group();
  node.position.set((o.x1 + o.x2) / 2, 0, -(o.y1 + o.y2) / 2);
  node.rotation.y = ang;
  const kind = String(o.kind || '');
  if (kind.includes('フェンス')) {
    const sub = { ...ctx, group: node, add: (x) => { node.add(x); return x; } };
    // node のローカルで描く（x 方向に長さ L）
    fence(sub, -L / 2, 0, L / 2, 0, 1.2, 2.0);
    return node;
  }
  if (kind.includes('生け垣') || kind.includes('垣')) {
    const T = 0.26, H = 0.62;
    const n = Math.max(1, Math.round(L / 0.7));
    const r = rng32(Math.round((o.x1 * 31 + o.y1 * 17 + o.x2 * 7) * 100) >>> 0);
    for (let i = 0; i < n; i++) {
      const seg = L / n;
      const h = H * (0.9 + r() * 0.18), t = T * (0.92 + r() * 0.16);
      const g = own(new THREE.BoxGeometry(seg * 1.08, h, t));
      // 葉の模様を m 単位で
      const p = g.attributes.position, uv = g.attributes.uv, nm = g.attributes.normal;
      // 上の面は x・z で貼る（y で貼ると、上から見た時に葉が筋に伸びて見えた。直し係 5）
      for (let k = 0; k < p.count; k++) {
        if (Math.abs(nm.getY(k)) > 0.5) uv.setXY(k, p.getX(k) / 0.8, p.getZ(k) / 0.8);
        else uv.setXY(k, (p.getX(k) + p.getZ(k)) / 0.8, p.getY(k) / 0.8);
      }
      const m = new THREE.Mesh(g, mats.hedge);
      m.position.set(-L / 2 + seg * (i + 0.5), h / 2, (r() - 0.5) * 0.02);
      m.castShadow = shadows; m.receiveShadow = true;
      node.add(m);
    }
    const base = new THREE.Mesh(own(new THREE.BoxGeometry(L, 0.06, T * 1.02)), mats.hedgeDark);
    base.position.y = 0.03; node.add(base);
    return node;
  }
  // そのほかの壁: 低いコンクリートの塀
  const g = own(new THREE.BoxGeometry(L, 0.45, 0.14));
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let k = 0; k < p.count; k++) uv.setXY(k, (p.getX(k) + p.getZ(k)) / 4, p.getY(k) / 4);
  const m = new THREE.Mesh(g, mats.wall);
  m.position.y = 0.225; m.castShadow = shadows; m.receiveShadow = true;
  node.add(m);
  return node;
}

function areaPoints(o) {
  if (o.rect) { const [x0, y0, x1, y1] = o.rect; return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (o.poly) return o.poly.map((p) => [p[0], p[1]]);
  if (o.circle) { const [cx, cy, r] = o.circle; const out = []; for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return out; }
  return null;
}

function makeArea(THREE, o, own, mats, ctx) {
  const pts = areaPoints(o);
  if (!pts) return null;
  const kind = o.kind || 'sand';
  const node = new THREE.Group();
  const sub = { ...ctx, group: node, own, add: (x) => { node.add(x); return x; } };
  if (kind === 'sand' || kind === 'slope') {
    if (kind === 'slope') return null;    // 坂は見た目を変えない（HUD とずかんで伝える）
    let rp = pts;
    if (o.rect) { const [x0, y0, x1, y1] = o.rect; rp = roughRect(x0, y0, x1, y1, 0.035, rng32(hashStr(o.id || 's')), 0.12); }
    const m = groundPoly(sub, rp, mats.sand, TEXTURES.sand.tile, 0.004);
    m.renderOrder = 1;
    return node;
  }
  if (kind === 'pond') {
    // 岸の泥（少し広い）→ 水面
    const c = o.circle;
    if (c) {
      const [cx, cy, r] = c;
      const ring = own(new THREE.RingGeometry(r * 0.96, r + 0.35, 64, 1));
      ring.rotateX(-Math.PI / 2);
      ring.translate(cx, 0.004, -cy);
      worldUV(ring, TEXTURES.soil.tile);
      const mud = new THREE.Mesh(ring, mats.mud); mud.receiveShadow = true; node.add(mud);
      const disc = own(new THREE.CircleGeometry(r, 64));
      disc.rotateX(-Math.PI / 2);
      const w = new THREE.Mesh(disc, mats.water);
      w.position.set(cx, 0.008, -cy);
      w.receiveShadow = true;
      node.add(w);
      // 葦
      const r2 = rng32(hashStr(o.id || 'p'));
      const reeds = [];
      for (let i = 0; i < 26; i++) { const a = r2() * Math.PI * 2, d = r + 0.15 + r2() * 0.4; reeds.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, h: 0.4 + r2() * 0.5, kind: 'shrub', c: pick(r2, [0x7b8f4a, 0x8a9a55, 0x6d8442]) }); }
      forest({ ...sub, rnd: r2, density: 1 }, reeds);
    } else {
      groundPoly(sub, pts, mats.water, 1, 0.008);
    }
    return node;
  }
  if (kind === 'hill') {
    node.add(hillFromPoly(THREE, pts, o.deg || 15, own, mats.hill));
    return node;
  }
  return null;
}

/** 登れない斜面: 多角形の中を盛り上げた砂の山（縁から deg の傾きで上がり、1.6 m で平ら）。 */
function hillFromPoly(THREE, pts, deg, own, mat) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 0.2;
  const nx = Math.max(8, Math.min(80, Math.round((x1 - x0) / 0.3))), ny = Math.max(8, Math.min(80, Math.round((y1 - y0) / 0.3)));
  const g = own(new THREE.PlaneGeometry(x1 - x0 + pad * 2, y1 - y0 + pad * 2, nx, ny));
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, -(y0 + y1) / 2);
  const inside = (x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const edgeDist = (x, y) => { let d = Infinity; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [ax, ay] = pts[j], [bx, by] = pts[i]; const vx = bx - ax, vy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1))); d = Math.min(d, Math.hypot(x - ax - vx * t, y - ay - vy * t)); } return d; };
  const p = g.attributes.position, uv = g.attributes.uv;
  const slope = Math.tan(Math.max(20, deg * 2) * Math.PI / 180);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = -p.getZ(i);
    let h = 0;
    if (inside(x, y)) h = Math.min(1.6, edgeDist(x, y) * slope) + 0.02;
    h += Math.sin(x * 1.7) * Math.cos(y * 1.3) * 0.03 * Math.min(1, h * 3);
    p.setY(i, h - 0.01);
    uv.setXY(i, x / 3, y / 3);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true; m.castShadow = true;
  return m;
}

/** AR マーカー（白黒の板）。スタートの方を向く。 */
function makeMarker(THREE, o, world, own, std, mats, shadows) {
  const node = new THREE.Group();
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#f4f2ec'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#16181a'; g.fillRect(6, 6, 52, 52);
  // 4×4 のビット（番号から決まった模様）
  const r = rng32(1000 + (o.code | 0) * 7919);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (r() < 0.5) { g.fillStyle = '#f4f2ec'; g.fillRect(14 + i * 9, 14 + j * 9, 9, 9); }
  const tex = own(new THREE.CanvasTexture(cv));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  const face = std(0xffffff, { map: tex, roughness: 0.7 });
  const back = std(0xd9d5cb, { roughness: 0.8 });
  const board = new THREE.Mesh(own(new THREE.BoxGeometry(0.3, 0.3, 0.012)), [back, back, back, back, face, back]);
  board.position.y = 0.32; board.castShadow = shadows; node.add(board);
  for (const dx of [-0.1, 0.1]) { const l = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, 0.18, 0.018)), mats.markerLeg); l.position.set(dx, 0.09, -0.01); l.castShadow = shadows; node.add(l); }
  const s = (world && world.start) || { x: 0, y: 0 };
  node.position.set(o.x, 0, -o.y);
  // 板の表（+Z）をスタートの方へ
  const dx = (s.x || 0) - o.x, dy = (s.y || 0) - o.y;
  node.rotation.y = Math.atan2(dx, -dy);
  return node;
}

// ------------------------------------------------------------------------------------------------
// パラシュート（空で開いた形と、地面の平たい布）
// ------------------------------------------------------------------------------------------------

/**
 * パラシュート。紫で中心に穴（ベント）。
 * @returns {{group: object, canopy: object, flat: object, lines: object, setOpen: (k: number) => void, setLines: (a: object|null, b: object|null) => void, dispose: () => void}}
 */
export function createParachute(THREE, { quality = 'normal' } = {}) {
  const owned = [];
  const own = (x) => { owned.push(x); return x; };
  const group = new THREE.Group();
  group.name = 'parachute';
  const R = 0.55;     // 開いた時の半径（直径 1.1 m）
  const gores = 12;
  // 布の色: 紫と薄い紫を交互（くすんだ色）
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
  const g = cv.getContext('2d');
  for (let i = 0; i < gores; i++) { g.fillStyle = i % 2 ? '#7a5d9e' : '#9a84b8'; g.fillRect(i * 256 / gores, 0, 256 / gores + 1, 32); }
  const tex = own(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
  // 空の形: 半球の上（穴の分を残す）
  const dome = own(new THREE.SphereGeometry(R, 36, 10, 0, Math.PI * 2, 0.16, Math.PI / 2 - 0.16));
  const canopy = new THREE.Mesh(dome, mat);
  canopy.scale.y = 0.62;
  canopy.castShadow = quality !== 'light';
  group.add(canopy);
  // 地面の形: 平たい輪（しわを少し）
  const ringG = own(new THREE.RingGeometry(0.07, R * 1.15, 36, 3));
  const p = ringG.attributes.position;
  const r = rng32(5);
  for (let i = 0; i < p.count; i++) { const rr = Math.hypot(p.getX(i), p.getY(i)); p.setZ(i, (r() - 0.5) * 0.03 * rr + Math.sin(Math.atan2(p.getY(i), p.getX(i)) * 6) * 0.012 * rr); }
  ringG.computeVertexNormals();
  ringG.rotateX(-Math.PI / 2);
  const uvA = ringG.attributes.uv;
  for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getZ(i), p.getX(i)); uvA.setXY(i, (a / (Math.PI * 2) + 1) % 1, 0.5); }
  const flat = new THREE.Mesh(ringG, mat);
  flat.position.y = 0.02;
  flat.receiveShadow = true;
  group.add(flat);
  // 吊りひも（空）と、地面のひも（機体とつながっている間）
  const lineMat = own(new THREE.LineBasicMaterial({ color: 0x4b4650 }));
  const lp = new Float32Array(gores * 2 * 3);
  const lineGeo = own(new THREE.BufferGeometry());
  lineGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  group.add(lines);
  const tetherGeo = own(new THREE.BufferGeometry());
  tetherGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const tether = new THREE.Line(tetherGeo, lineMat);
  tether.frustumCulled = false;
  // 包み（つり下げ・落下の間）
  const pack = new THREE.Mesh(own(new THREE.CylinderGeometry(0.04, 0.045, 0.09, 12)), mat);
  pack.visible = false;

  const tmp = new THREE.Vector3();
  return {
    group, canopy, flat, lines, tether, pack, R,
    /** 'air'（開いて空）・'ground'（地面の布）・'hidden' */
    setMode(mode) {
      canopy.visible = mode === 'air';
      lines.visible = mode === 'air';
      flat.visible = mode === 'ground';
    },
    /** 空の形の吊りひもを、傘のふちから機体の点 p（世界）へ。 */
    setLinesTo(p) {
      group.updateMatrixWorld(true);
      for (let i = 0; i < gores; i++) {
        const a = i / gores * Math.PI * 2;
        canopy.localToWorld(tmp.set(Math.cos(a) * R * 0.99, R * Math.cos(Math.PI / 2 - 0.02) * 0.02, Math.sin(a) * R * 0.99));
        group.worldToLocal(tmp);
        lp.set([tmp.x, tmp.y, tmp.z], i * 6);
        const q = group.worldToLocal(p.clone());
        lp.set([q.x, q.y, q.z], i * 6 + 3);
      }
      lineGeo.attributes.position.needsUpdate = true;
    },
    /** 地面のひも（a → b、世界の点）。null で隠す。 */
    setTether(a, b) {
      if (!a || !b) { tether.visible = false; return; }
      tether.visible = true;
      const arr = tetherGeo.attributes.position.array;
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z]);
      tetherGeo.attributes.position.needsUpdate = true;
    },
    dispose() { for (const o of owned) { try { o.dispose(); } catch { /* 無視 */ } } },
  };
}
