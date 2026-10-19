/**
 * @file app/js/screens/map.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 地図: 絵地図に章のカードとマス（クリア＝芝色・今の面＝橙・まだ＝薄茶、ボスは旗、★の点）、開いていない章は鍵、10 章は本番の札、おまけ C、
 *       自由走行場の入口、右上の肩書・★ x / 159・クリア y / 53・今週の走行。900 px 未満は縦の一覧（マス 44 px）。
 * SPEC: 3.3・2.5・2.3・3.10（地図からもう一度場面を見る）
 *
 * 並べ方: 900 px 以上は章のカードを蛇行（1 段目は左→右、2 段目は右→左…）に並べ、カードの中心を通る点線の道を SVG で描く
 * （見本 map.html の道の形）。章の位置（chapters.json の map）は使わず、画面の幅から決める（幅が変わっても重ならない）。
 */

import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';

/**
 * @param {HTMLElement} root @param {object} app @param {string|null} param
 * @returns {{unmount: () => void}}
 */
export function mount(root, app, param) {
  const { t, store, progress } = app;
  app.header.set({ place: t('map.title') });
  const chapters = progress.chapterList();
  const cur = progress.currentLevel();
  const tt = progress.totals();
  const ti = progress.title();
  const feats = progress.features();
  const total = progress.levelOrder().length || progress.TOTAL_LEVELS;
  // 本編を全部クリアしたら、地図の下にエンディングの入口（もう一度見られる。直し係 3 の 2）
  const allDone = progress.mainLevels().length > 0 && progress.mainLevels().every((x) => store.hasLevel(x) && store.level(x).cleared);

  root.innerHTML = `
    <div class="map-wrap">
      <div class="map-top">
        <h1 class="map-h1">${esc(t('map.title'))}</h1>
        <dl class="map-stats" aria-label="${esc(t('map.rank'))}">
          <div><dt>${esc(t('map.rank'))}</dt><dd class="rank">${esc(ti.name)}${ti.cBadge ? ` <span class="badge-c">${esc(ti.badgeName)}</span>` : ''}</dd></div>
          <div><dt class="sr-only">★</dt><dd class="stars-n">${esc(t('header.stars', { stars: tt.stars }))}</dd></div>
          <div><dt class="sr-only">クリア</dt><dd>${esc(t('header.clears', { clears: tt.clears, total_levels: total }))}</dd></div>
          <div><dt class="sr-only">今週</dt><dd>${esc(t('header.weekly', { runs: store.weeklyRuns() }))}</dd></div>
        </dl>
      </div>
      <div class="map-board">
        <svg class="map-road" aria-hidden="true"><path class="road-edge"/><path class="road-base"/><path class="road-dash"/></svg>
        <ol class="map-cards" aria-label="${esc(t('map.list_label'))}"></ol>
      </div>
      <div class="map-foot">
        <button type="button" class="free-sign${feats.free ? '' : ' locked'}" data-act="free">
          <span class="sign-board">${icon(feats.free ? 'flag' : 'lock')}<b>${esc(t('map.free'))}</b></span>
          ${feats.free ? '' : `<small>${esc(t('map.free_locked'))}</small>`}
        </button>
        ${allDone ? `<button type="button" class="btn ending-btn" data-act="ending">${icon('book')}<span>${esc(t(store.storySeen('ending') ? 'map.ending_again' : 'map.ending_first'))}</span></button>` : ''}
        <div class="map-legend card"><b>${esc(t('map.legend_title'))}</b><ul>
          <li>${esc(t('map.legend_1'))}</li><li>${esc(t('map.legend_2'))}</li><li>${esc(t('map.legend_3'))}</li><li>${esc(t('map.legend_4'))}</li></ul></div>
      </div>
      <div class="map-pop" role="dialog" aria-modal="false" hidden></div>
    </div>`;

  // 芝のイラストの地（ブラッシュアップ 6。画面ごとに 1 回だけ描いて使い回す）
  root.style.setProperty('--map-grass', `url(${grassTile(document.documentElement.dataset.theme)})`);
  const list = root.querySelector('.map-cards');
  const levelInfo = new Map();     // id → Level（開いた章だけ読む）
  for (const c of chapters) list.appendChild(chapterCard(c));

  // 開いている章のレベルを読む（マスの名前と★の条件）
  const loads = chapters.filter((c) => progress.isChapterUnlocked(c.no)).map((c) => app.chapterLevels(c.no).then((ls) => {
    for (const L of ls) levelInfo.set(L.id, L);
    for (const L of ls) {
      const sq = list.querySelector(`[data-id="${CSS.escape(L.id)}"]`);
      if (sq) sq.setAttribute('aria-label', squareLabel(L.id));
    }
  }));
  Promise.all(loads).then(() => {});

  function squareState(id) {
    const L = store.hasLevel(id) ? store.level(id) : null;
    if (L && L.cleared) return 'done';
    if (id === cur) return 'now';
    if (progress.isUnlocked(id)) return 'open';
    return 'locked';
  }
  function squareLabel(id) {
    const L = levelInfo.get(id);
    const st = squareState(id);
    const stars = store.hasLevel(id) ? store.level(id).stars.filter(Boolean).length : 0;
    const state = st === 'done' ? t('map.cleared') : st === 'now' ? t('map.now') : st === 'locked' ? t('map.locked') : t('map.not_yet');
    return t('map.square_label', { id, title: L ? L.title : '', state, stars });
  }

  function chapterCard(c) {
    const li = document.createElement('li');
    const unlocked = progress.isChapterUnlocked(c.no);
    const pr = progress.chapterProgress(c.no);
    const isC = String(c.no) === 'C';
    const is10 = String(c.no) === '10';
    li.className = `ch-card${unlocked ? '' : ' lock'}${is10 ? ' final' : ''}${isC ? ' bonus' : ''}`;
    li.dataset.no = String(c.no);
    const head = isC ? t('map.bonus') : t('header.chapter', { no: c.no, title: '' }).trim();
    const desc = c.goal || c.venue || '';
    const story = progress.isChapterCleared(c.no) && !isC;
    li.innerHTML = `
      ${is10 ? `<span class="badge">${esc(t('map.final'))}</span>` : ''}
      ${!unlocked ? `<span class="lock-tag">${icon('lock')}<span>${esc(t('map.locked'))}</span></span>` : ''}
      <div class="ch">${esc(head)}</div>
      <h2 class="t">${esc(c.title || '')}</h2>
      <p class="d">${esc(desc)}</p>
      <div class="lv"></div>
      <div class="ch-prog"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${pr.total}" aria-valuenow="${pr.cleared}" aria-label="${esc(t('map.chapter_prog', pr))}"><i style="width:${pr.total ? Math.round(pr.cleared / pr.total * 100) : 0}%"></i></div><span>${esc(t('map.chapter_prog', pr))}</span></div>
      ${!unlocked ? `<p class="lock-note">${esc(isC ? t('map.locked_c') : t('map.locked_note'))}</p>` : ''}
      ${story ? `<button type="button" class="btn small ghost story-btn" data-story="${esc(c.no)}">${icon('book')}<span>${esc(t('map.story_again'))}</span></button>` : ''}
      ${c.levels.filter((x) => store.storySeen(`L${x}`)).map((x) => `<button type="button" class="btn small ghost story-btn" data-story="L${esc(x)}">${icon('book')}<span>${esc(t('map.story_before_again', { id: x }))}</span></button>`).join('')}`;
    const lv = li.querySelector('.lv');
    c.levels.forEach((id, i) => {
      const st = squareState(id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `sq ${st}${!isC && !is10 && i === c.levels.length - 1 ? ' boss' : ''}`;
      b.dataset.id = id;
      const stars = store.hasLevel(id) ? store.level(id).stars : [false, false, false];
      b.innerHTML = `<span class="n">${i + 1}</span><span class="dots" aria-hidden="true">${stars.map((s) => `<i class="${s ? 'on' : ''}"></i>`).join('')}</span>${b.classList.contains('boss') ? `<span class="flag" aria-hidden="true">${icon('flag')}</span>` : ''}`;
      b.setAttribute('aria-label', squareLabel(id));
      if (st === 'locked') b.setAttribute('aria-disabled', 'true');
      if (st === 'now') b.setAttribute('aria-current', 'step');
      lv.appendChild(b);
    });
    // 今の章: 橙のふちと「いまここ」の札（ブラッシュアップ 6）
    if (c.levels.includes(cur) && unlocked) {
      li.classList.add('now');
      const tag = document.createElement('span');
      tag.className = 'here-tag';
      tag.textContent = t('map.here');
      li.appendChild(tag);
    }
    return li;
  }

  // マスの説明（マウスを乗せる・フォーカス）と、小さい画面の「押した時の小さなカード」
  const pop = root.querySelector('.map-pop');
  let popFor = null;
  const narrow = () => globalThis.matchMedia && matchMedia('(max-width: 899px), (hover: none)').matches;
  function showPop(btn, withPlay) {
    const id = btn.dataset.id;
    const L = levelInfo.get(id);
    const st = squareState(id);
    const s2 = L && L.stars && L.stars[0] ? L.stars[0].label : '';
    const s3 = L && L.stars && L.stars[1] ? L.stars[1].label : '';
    pop.innerHTML = `<div class="pop-t">${esc(st === 'locked' && !L ? t('map.level_tip_locked', { id }) : t('map.level_tip', { id, title: L ? L.title : '' }))}</div>
      ${L && st !== 'locked' ? `<div class="pop-s">★2 ${esc(s2)}<br>★3 ${esc(s3)}</div>` : ''}
      ${st === 'locked' ? `<div class="pop-s">${icon('lock')} ${esc(t('play.level_locked'))}</div>` : ''}
      ${withPlay && st !== 'locked' ? `<button type="button" class="btn primary small" data-play="${esc(id)}">${icon('play')}<span>${esc(id)}</span></button>` : ''}`;
    pop.hidden = false;
    const br = btn.getBoundingClientRect();
    const wr = root.querySelector('.map-wrap').getBoundingClientRect();
    const w = Math.min(280, wr.width - 32);
    pop.style.width = `${w}px`;
    let left = br.left - wr.left + br.width / 2 - w / 2;
    left = Math.max(16, Math.min(wr.width - w - 16, left));
    pop.style.left = `${left}px`;
    pop.style.top = `${br.bottom - wr.top + 8}px`;
    popFor = btn;
  }
  const hidePop = () => { pop.hidden = true; popFor = null; };

  const onClick = (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { app.audio.unlock(); app.go(`#/play/${encodeURIComponent(play.dataset.play)}`); return; }
    const sq = e.target.closest('.sq');
    if (sq) {
      const id = sq.dataset.id;
      if (narrow()) { if (popFor === sq) hidePop(); else showPop(sq, true); return; }
      if (squareState(id) === 'locked') { app.toast(t('play.level_locked')); return; }
      app.audio.unlock();
      app.go(`#/play/${encodeURIComponent(id)}`);
      return;
    }
    const sb = e.target.closest('[data-story]');
    if (sb) { app.go(`#/story/${encodeURIComponent(sb.dataset.story)}`); return; }
    if (e.target.closest('[data-act="ending"]')) { app.go('#/ending'); return; }
    const act = e.target.closest('[data-act="free"]');
    if (act) { if (feats.free) app.go('#/free'); else app.toast(t('map.free_locked')); return; }
    if (!e.target.closest('.map-pop')) hidePop();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('mouseover', (e) => { const sq = e.target.closest('.sq'); if (sq && !narrow()) showPop(sq, false); });
  root.addEventListener('mouseout', (e) => { const sq = e.target.closest('.sq'); if (sq && !narrow() && !sq.contains(e.relatedTarget)) hidePop(); });
  root.addEventListener('focusin', (e) => { const sq = e.target.closest('.sq'); if (sq && !narrow()) showPop(sq, false); });
  root.addEventListener('focusout', (e) => { if (e.target.closest('.sq') && !narrow()) hidePop(); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { hidePop(); e.stopPropagation(); } });

  // 蛇行の並べ方と道
  const board = root.querySelector('.map-board');
  function layout() {
    const wide = board.clientWidth;
    const cards = [...list.children];
    if (narrow() || wide < 860) {
      list.classList.add('vertical');
      for (const el of cards) { el.style.gridRow = ''; el.style.gridColumn = ''; }
      board.querySelector('.map-road').style.display = 'none';
      return;
    }
    list.classList.remove('vertical');
    const cols = wide >= 1240 ? 4 : 3;
    list.style.setProperty('--cols', String(cols));
    cards.forEach((el, i) => {
      const r = Math.floor(i / cols);
      const k = i % cols;
      el.style.gridRow = String(r + 1);
      el.style.gridColumn = String(r % 2 === 0 ? k + 1 : cols - k);
    });
    // 道（カードの中心を順に通る）
    const svg = board.querySelector('.map-road');
    svg.style.display = '';
    const br = board.getBoundingClientRect();
    svg.setAttribute('width', String(br.width));
    svg.setAttribute('height', String(br.height));
    const pts = cards.map((el) => { const r = el.getBoundingClientRect(); return [r.left - br.left + r.width / 2, r.top - br.top + r.height / 2]; });
    let d = '';
    pts.forEach(([x, y], i) => {
      if (i === 0) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; return; }
      const [px, py] = pts[i - 1];
      const mx = (px + x) / 2;
      d += px === x ? ` L${x.toFixed(1)} ${y.toFixed(1)}` : ` C${mx.toFixed(1)} ${py.toFixed(1)}, ${mx.toFixed(1)} ${y.toFixed(1)}, ${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    svg.querySelector('.road-edge').setAttribute('d', d);
    svg.querySelector('.road-base').setAttribute('d', d);
    svg.querySelector('.road-dash').setAttribute('d', d);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  if (ro) ro.observe(board);
  requestAnimationFrame(layout);
  // 今の面へフォーカスしやすく（キーボードの人）
  const nowSq = list.querySelector('.sq.now');
  if (nowSq && param === 'focus') nowSq.focus();

  return { unmount() { if (ro) ro.disconnect(); } };
}

// ---- 芝のイラスト（520 px 四方のくり返し。色むら・草の房・小さな花）。テーマごとに 1 回だけ作る
const grassCache = new Map();
function grassTile(theme) {
  const dark = theme === 'dusk' || (theme === 'auto' && globalThis.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const key = dark ? 'dark' : 'light';
  if (grassCache.has(key)) return grassCache.get(key);
  let url = '';
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 520;
    const g = cv.getContext('2d');
    g.fillStyle = dark ? '#3d5233' : '#bcd08f'; g.fillRect(0, 0, 520, 520);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * 520, y = rnd() * 520, r = 40 + rnd() * 90;
      const c = dark ? (rnd() < 0.5 ? '52,70,44' : '72,88,56') : (rnd() < 0.5 ? '170,196,120' : '205,214,150');
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${c},.55)`); gr.addColorStop(1, `rgba(${c},0)`);
      for (const dx of [-520, 0, 520]) for (const dy of [-520, 0, 520]) { g.save(); g.translate(dx, dy); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.restore(); }
    }
    g.lineCap = 'round';
    for (let i = 0; i < 230; i++) {
      const x = rnd() * 520, y = rnd() * 520, sz = 4 + rnd() * 5;
      g.strokeStyle = dark ? 'rgba(110,140,80,.5)' : rnd() < 0.7 ? 'rgba(120,150,78,.55)' : 'rgba(150,172,96,.6)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x - 5, y - sz * 0.8); g.moveTo(x, y); g.lineTo(x, y - sz); g.moveTo(x + 3, y); g.lineTo(x + 5, y - sz * 0.75); g.stroke();
    }
    for (let i = 0; i < 18; i++) { const x = rnd() * 520, y = rnd() * 520; g.fillStyle = rnd() < 0.5 ? 'rgba(255,252,240,.9)' : 'rgba(240,214,110,.9)'; if (dark) g.globalAlpha = 0.5; g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill(); g.globalAlpha = 1; }
    url = cv.toDataURL('image/png');
  } catch { url = ''; }
  grassCache.set(key, url);
  return url;
}
