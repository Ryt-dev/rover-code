/**
 * @file app/sw.js
 * 持ち主: W8（SIL・C・テストの土台・配る形）
 * 役割: Service Worker（売る版のオフライン）。一度開けば、ネットが無くても全部遊べるように、vendor/ と app の中身を先に保存する。
 * SPEC: 7.6（売る版: 全部を app/vendor/ に置き sw.js で先に保存。版を上げたらキャッシュ名を変える）・12 章「オフライン（売る版）」・13.2 W8 ④
 *
 * 開発中と体験版（app/ をそのまま配る）は登録しない（CDN から読む）。売る版は tools/build.mjs が
 * dist/index.html に登録の 1 行を足し、下の CACHE（版の番号＋中身の指紋）と PRECACHE（全部のファイル）を書きかえる。
 *
 * 動き:
 *   install  … PRECACHE を全部取ってキャッシュに入れる（1 つでも取れなければ入れ直し。前の版は残る）
 *   activate … 名前が rovercode- で始まり今の CACHE でないキャッシュ（古い版）を消す。開いているページもすぐ受け持つ
 *   fetch    … 同じ配信元の GET はキャッシュを先に見る（?role= などの問い合わせは無視して探す）。無ければネットから取って足す。
 *              ページの移動でネットが無ければ index.html を返す。ほかの配信元（無いはず）はそのままネットへ
 */

/** キャッシュ名（版を上げたら変える。build.mjs が書く）。 */
const CACHE = "rovercode-v1.0.0-10d761f695";
/** 先に保存するファイルの一覧（build.mjs が書く。sw.js からの相対の場所）。 */
const PRECACHE = ["./","assets/audio/credits.json","assets/img/scenes/bushitsu.svg","assets/img/scenes/clubroom.svg","assets/img/scenes/drop.svg","assets/img/scenes/funabashi.svg","assets/img/scenes/kasen.svg","assets/img/scenes/lunar.svg","assets/img/scenes/ship.svg","assets/img/scenes/takezaki_a.svg","assets/img/scenes/takezaki_b.svg","assets/img/scenes/ura.svg","assets/img/title.svg","assets/img/title.webp","assets/textures/concrete.jpg","assets/textures/credits.json","assets/textures/dune.jpg","assets/textures/grass.jpg","assets/textures/leaves.jpg","assets/textures/macro.jpg","assets/textures/pavement.jpg","assets/textures/sand.jpg","assets/textures/soil.jpg","css/base.css","css/editor.css","css/replay.css","css/screens.css","css/tokens.css","data/api.json","data/chapters.json","data/error_rules.json","data/levels/ch01.json","data/levels/ch02.json","data/levels/ch03.json","data/levels/ch04.json","data/levels/ch05.json","data/levels/ch06.json","data/levels/ch07.json","data/levels/ch08.json","data/levels/ch09.json","data/levels/ch10.json","data/levels/chC.json","data/story.json","data/strings.ja.json","data/titles.json","data/venues.json","data/zukan.json","index.html","js/audio.js","js/editor/editor.js","js/editor/locked.js","js/editor/palette.js","js/editor/parsons.js","js/editor/symbolbar.js","js/editor/toolbox.js","js/editor/varhover.js","js/editor/zenkaku.js","js/export_sil.js","js/hints.js","js/main.js","js/progress.js","js/replay/camera_rig.js","js/replay/graphs.js","js/replay/overlays.js","js/replay/player.js","js/replay/rover_model.js","js/replay/scene.js","js/replay/timeline.js","js/replay/venues3d.js","js/router.js","js/runner.js","js/screens/ending.js","js/screens/free.js","js/screens/loadfail.js","js/screens/map.js","js/screens/play.js","js/screens/play_layout.js","js/screens/play_parts.js","js/screens/result.js","js/screens/settings.js","js/screens/story.js","js/screens/title.js","js/screens/zukan.js","js/store.js","js/ui/deps.js","js/ui/dialog.js","js/ui/error_card.js","js/ui/fallback_card.js","js/ui/fallback_editor.js","js/ui/fallback_view.js","js/ui/header.js","js/ui/icons.js","js/ui/run_bridge.js","js/ui/senpai.js","js/ui/strings.js","js/ui/toast.js","js/ui/wait_bar.js","sil/rover_sil.py","vendor/LICENSES/MIT-CodeMirror.txt","vendor/LICENSES/MIT-three.txt","vendor/LICENSES/OFL-BIZUDGothic.txt","vendor/LICENSES/OFL-NotoSansJP.txt","vendor/LICENSES/README.txt","vendor/codemirror/addon/edit/matchbrackets.min.js","vendor/codemirror/addon/selection/active-line.min.js","vendor/codemirror/codemirror.min.css","vendor/codemirror/codemirror.min.js","vendor/codemirror/mode/clike/clike.min.js","vendor/codemirror/mode/python/python.min.js","vendor/fonts/BIZUDGothic-400.woff2","vendor/fonts/BIZUDGothic-700.woff2","vendor/fonts/NotoSansJP-400.woff2","vendor/fonts/NotoSansJP-700.woff2","vendor/fonts/fonts.css","vendor/pyodide/pyodide-lock.json","vendor/pyodide/pyodide.asm.js","vendor/pyodide/pyodide.asm.wasm","vendor/pyodide/pyodide.js","vendor/pyodide/pyodide.mjs","vendor/pyodide/python_stdlib.zip","vendor/three/three.module.js","worker/engine.js","worker/metrics.js","worker/py/c_subset.py","worker/py/error_explain.py","worker/py/judge.py","worker/py/rover_runtime.py","worker/replay_explain.js","worker/sim/drop.js","worker/sim/geometry.js","worker/sim/ground.js","worker/sim/rng.js","worker/sim/sensors.js","worker/sim/sim.js","worker/worker.js"];

const PREFIX = 'rovercode-';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache: 'reload' で HTTP キャッシュの古い物を使わない
    await c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const idx = (await c.match('./')) || (await c.match('index.html'));
        if (idx) return idx;
      }
      throw err;
    }
  })());
});

/** 画面から版を聞けるように（postMessage {type: 'version'} → {type: 'version', cache}）。 */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'version' && e.source) e.source.postMessage({ type: 'version', cache: CACHE, files: PRECACHE.length });
});
