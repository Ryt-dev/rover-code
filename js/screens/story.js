/**
 * @file app/js/screens/story.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 章の間の場面: 2〜3 枚の絵と短い会話（1 枚 1〜3 行）。いつでも「とばす」。地図からもう一度見られる。
 * SPEC: 3.10・data/story.json（W4。形 scenes: [{after_chapter, title, slides: [{img, lines: [{who, text}]}]}]）
 *
 * 絵: slide.img（assets/img/ のファイル名）が無ければ、章の会場の絵（assets/img/scenes/<会場>.svg）を使う。
 * story.json にその章の場面がまだ無い時は、次の章を知らせる 1 枚だけ出す（W4 の文ができたら差しかわる）。
 */

import { esc, fill } from '../ui/strings.js';
import { faceSVG, roverSVG, richText } from '../ui/senpai.js';

const SCENE_ART = ['clubroom', 'bushitsu', 'funabashi', 'ura', 'kasen', 'drop', 'takezaki_b', 'takezaki_a', 'lunar', 'ship'];

/**
 * @param {HTMLElement} root @param {object} app @param {string|null} param 章の番号（その章のあとの場面）
 */
export async function mount(root, app, param) {
  const { t, progress } = app;
  // 「L10-3」は面の前の場面（before_level）。見終わったらその面へ
  const beforeLevel = typeof param === 'string' && /^L/.test(param) ? decodeURIComponent(param.slice(1)) : null;
  const no = beforeLevel ? (progress.chapterOf(beforeLevel) || {}).no ?? 10 : param === null ? 1 : param === 'C' ? 'C' : Number(param);
  const story = await app.lazy('story');
  let scene = ((story && story.scenes) || []).find((s) => (beforeLevel ? s.before_level === beforeLevel : s.after_chapter != null && String(s.after_chapter) === String(no)));
  const ch = progress.chapterByNo(no);
  const after = beforeLevel ? `#/play/${beforeLevel}` : '#/map';
  const next = typeof no === 'number' ? progress.chapterByNo(no + 1) : null;
  if (!scene || !Array.isArray(scene.slides) || !scene.slides.length) {
    scene = {
      title: ch ? ch.title : '',
      slides: [{ img: null, lines: [
        { who: 'senpai', text: next ? t('story.fallback_next', { no, next: next.no, title: next.title }) : t('story.fallback_end') },
        { who: 'rover', text: t('story.fallback_rover') },
      ] }],
    };
  }
  if (!app.store.isReadOnly()) app.store.markStorySeen(beforeLevel ? `L${beforeLevel}` : no);     // 見た場面（章の最後の面の［次へ］が、まだ見ていない時だけ場面へ来る）
  const venueKey = (ch && ch.venue_keys && ch.venue_keys[0]) || 'bushitsu';     // 1 枚ごとの art（10 章の帰りの船 ship など）があればそちら
  const slides = scene.slides;
  let i = 0;
  // 10 章のあとで、全部の面をクリアしていればエンディングへ（直し C10）
  const allDone = !beforeLevel && String(no) === '10' && progress.mainLevels().every((x) => app.store.hasLevel(x) && app.store.level(x).cleared);
  root.innerHTML = `<div class="story-page">
    <div class="story-art" aria-hidden="true"></div>
    <div class="story-box">
      <h1 class="story-title">${esc(scene.title || t('story.title'))}</h1>
      <div class="story-lines" aria-live="polite"></div>
      <div class="story-nav">
        <span class="story-count"></span>
        <button type="button" class="btn ghost" data-a="skip">${esc(t('story.skip'))}</button>
        <button type="button" class="btn primary" data-a="next"></button>
      </div>
    </div>
  </div>`;
  const q = (s) => root.querySelector(s);
  function artFor(sl) {
    const name = sl.img && /^[\w.-]+$/.test(sl.img) ? `assets/img/${sl.img}` : `assets/img/scenes/${SCENE_ART.includes(sl.art || venueKey) ? sl.art || venueKey : 'bushitsu'}.svg`;
    return `<img src="${esc(name)}" alt="" onerror="this.style.display='none'">${driftLayer()}`;
  }
  function render() {
    const sl = slides[i];
    q('.story-art').innerHTML = artFor(sl);
    q('.story-art').dataset.art = sl.art || venueKey;     // 絵を上げた下の色（芝・海・砂）
    q('.story-lines').innerHTML = (sl.lines || []).slice(0, 3).map((ln) => {
      const face = ln.who === 'rover' ? roverSVG() : ln.who === 'you' ? '' : faceSVG(ln.face || 'smile');
      const who = ln.who === 'rover' ? fill('{rover}') : ln.who === 'you' ? t('story.you') : t('senpai.short');
      return `<div class="sl ${esc(ln.who || 'senpai')}"><span class="sl-face">${face}</span><div class="sl-text"><b>${esc(who)}</b><p>${richText(fill(ln.text || ''))}</p></div></div>`;
    }).join('');
    q('.story-count').textContent = t('story.slide', { n: i + 1, of: slides.length });
    q('[data-a="next"]').textContent = i + 1 < slides.length ? t('story.next') : allDone ? t('story.to_ending') : t('story.done');
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'skip' || i + 1 >= slides.length) { app.go(allDone ? '#/ending' : after); return; }
    i++;
    app.audio.play('page');
    render();
    q('[data-a="next"]').focus();
  });
  render();
  // 章クリアの帯: 旗が上がる・その章の★・上がった肩書（直し A-20・C10。光や紙吹雪は使わない）
  if (!beforeLevel && typeof no === 'number' && progress.isChapterCleared(no)) {
    const cp = progress.chapterProgress(no);
    const ttl = progress.titleAfter(no);
    const band = document.createElement('div');
    band.className = 'story-band';
    band.innerHTML = `<svg class="sb-flag" viewBox="0 0 40 56" width="30" height="42" aria-hidden="true"><rect x="5" y="4" width="3" height="50" rx="1.5" fill="#7a5c3a"/><path class="ch-flag-cloth" d="M8 6 h26 l-6 7 l6 7 h-26 z" fill="#c8552e"/></svg>
      <div><b>${esc(t('story.band_clear', { no }))}</b><span>${esc(t('story.band_stars', { got: cp.stars, max: cp.total * 3 }))}</span>${ttl ? `<span>${esc(t('story.band_title', { title: ttl }))}</span>` : ''}</div>`;
    q('.story-page').appendChild(band);
  }
  if (allDone) q('[data-a="next"]').dataset.end = '1';
  setTimeout(() => q('[data-a="next"]').focus(), 30);
  app.keyHandler = (e, ctx) => {
    if (e.key === 'Escape') { app.go(after); return true; }
    if ((e.key === 'ArrowRight' || e.key === ' ') && ctx.free) { q('[data-a="next"]').click(); return true; }
    return false;
  };
  return { unmount() {} };
}

/**
 * 絵の上をゆっくり流れる雲（2〜4 px/秒。ブラッシュアップ 7）。動きを減らす設定では CSS で止める。
 * @returns {string}
 */
export function driftLayer() {
  const cloud = (cls) => `<svg class="drift-cloud ${cls}" viewBox="0 0 160 60" aria-hidden="true"><g fill="#fffdf8" opacity=".85"><ellipse cx="50" cy="38" rx="40" ry="18"/><ellipse cx="85" cy="28" rx="34" ry="22"/><ellipse cx="118" cy="40" rx="30" ry="15"/></g><ellipse cx="84" cy="50" rx="66" ry="7" fill="#c9d3dc" opacity=".35"/></svg>`;
  return `<div class="story-drift" aria-hidden="true">${cloud('c1')}${cloud('c2')}</div>`;
}
