/**
 * @file app/js/screens/ending.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 全部の面をクリアした後のエンディング: 場面 3 枚 → スタッフロール → 名前入りの修了証（画像で保存できる）。
 *       10 章のあとの場面（story/10）の終わりから来る。地図の「エンディング」からもう一度見られる。
 *       演出は落ち着いたもの（紙吹雪・光る線は使わない）。動きを減らす設定ではスタッフロールは流さず並べるだけ。
 * 直し C10（2026-10-17、レビュー係 C）
 */

import { esc } from '../ui/strings.js';
import { faceSVG, roverSVG, richText } from '../ui/senpai.js';

const NAME_KEY = 'rovercode.certName';

// 見出し: 1 枚目「エンディング」、2・3 枚目にも場面の名前（空白だった。直し係 4）
const SCENES = [
  { art: 'takezaki_a', title: 'エンディング', lines: [
    { who: 'senpai', text: '種コン、おつかれさま。ローバー、ちゃんとコーンの前で止まったね。' },
    { who: 'rover', text: 'ぼく、最後まで自分で考えて走れたよ。' },
  ] },
  { art: 'lunar', title: 'ルナテラスの砂の上で', lines: [
    { who: 'senpai', text: 'ルナテラスの砂の上でも走れた。プログラムは、どの会場へも持っていけるんだ。' },
    { who: 'rover', text: '砂はすべるけど、もうこわくないよ。' },
  ] },
  { art: 'bushitsu', title: '部室にもどって', lines: [
    { who: 'senpai', text: '最初は motor と wait だけだったのに、今は「見て・決めて・動く」ロボットを書ける。' },
    { who: 'senpai', text: '次は本物の機体で。SIL に書き出したコードは、そのままシミュレータでも動くよ。' },
  ] },
];

const ROLL = [
  ['ROVER CODE', ''],
  ['物語', 'ミナミ先輩（CanSat チーム リーダー）・ローバー'],
  ['会場', '部室の前の芝生・滑走路の隣の芝生・建物の裏の通路・河川敷の練習場・落下試験の練習場・種子島 竹崎・ルナテラス'],
  ['Python を動かす', 'Pyodide（Python 3.12）'],
  ['エディタ', 'CodeMirror'],
  ['3D', 'three.js'],
  ['文字', 'Noto Sans JP・BIZ UDGothic'],
  ['音', 'このゲームの中で作った木琴・マリンバ・ギター・拍子木の音'],
  ['手本にした機体', 'CanSat ローバー（種子島ロケットコンテスト）'],
  ['そして', 'ここまで走りきった あなた'],
];

/**
 * @param {HTMLElement} root @param {object} app
 */
export async function mount(root, app) {
  const { progress, audio } = app;
  const reduced = document.documentElement.classList.contains('reduce-motion');
  let step = 0;          // 0〜2 場面・3 スタッフロール・4 修了証
  if (!app.store.isReadOnly()) app.store.markStorySeen('ending');
  root.innerHTML = '<div class="ending"></div>';
  const host = root.querySelector('.ending');

  function scene(i) {
    const sc = SCENES[i];
    host.innerHTML = `<div class="story-page">
      <div class="story-art" aria-hidden="true"><img src="assets/img/scenes/${esc(sc.art)}.svg" alt="" onerror="this.style.display='none'"></div>
      <div class="story-box">
        <h1 class="story-title">${esc(sc.title || 'エンディング')}</h1>
        <div class="story-lines" aria-live="polite">${sc.lines.map((ln) => `<div class="sl ${esc(ln.who)}"><span class="sl-face">${ln.who === 'rover' ? roverSVG() : faceSVG('smile')}</span><div class="sl-text"><b>${ln.who === 'rover' ? 'ローバー' : 'ミナミ先輩'}</b><p>${richText(ln.text)}</p></div></div>`).join('')}</div>
        <div class="story-nav"><span class="story-count">${i + 1} / ${SCENES.length} 枚目</span>
          <button type="button" class="btn ghost" data-a="skip">とばす</button>
          <button type="button" class="btn primary" data-a="next">次へ</button></div>
      </div></div>`;
    setTimeout(() => { const b = host.querySelector('[data-a="next"]'); if (b) b.focus(); }, 30);
  }

  function roll() {
    host.innerHTML = `<div class="end-roll${reduced ? ' still' : ''}">
      <div class="end-roll-track">${ROLL.map(([k, v]) => `<div class="end-roll-item">${v ? `<span class="er-k">${esc(k)}</span><span class="er-v">${esc(v)}</span>` : `<span class="er-title">${esc(k)}</span>`}</div>`).join('')}</div>
      <div class="end-roll-nav"><button type="button" class="btn primary" data-a="next">修了証へ</button></div></div>`;
    audio.play('chapter');
    const track = host.querySelector('.end-roll-track');
    if (!reduced && track) track.addEventListener('animationend', () => { const b = host.querySelector('[data-a="next"]'); if (b) b.focus(); });
    setTimeout(() => { const b = host.querySelector('[data-a="next"]'); if (b) b.focus(); }, 30);
  }

  function cert() {
    let name = 'あなた';
    try { name = localStorage.getItem(NAME_KEY) || name; } catch { /* なし */ }
    const tot = progress.totals();
    const title = progress.title();
    const date = new Date();
    host.innerHTML = `<div class="end-cert">
      <canvas class="cert-canvas" width="1200" height="840" role="img" aria-label="修了証"></canvas>
      <div class="cert-html" aria-hidden="true">
        <div class="ch-t">修了証</div>
        <div class="ch-sub">ROVER CODE　CanSat ローバー プログラミング講座</div>
        <div class="ch-name"></div>
        <p class="ch-body">あなたは ROVER CODE のすべての章をクリアし、センサで見て・決めて・動く 自律走行ローバーのプログラムを書けるようになったことを、ここに証します。</p>
        <div class="ch-stats">クリア ${esc(String(tot.clears))} 面　★ ${esc(String(tot.stars))}<br>肩書「${esc(title.name)}」</div>
        <div class="ch-foot"><span>${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日</span><span class="ch-sign">CanSat チーム リーダー　ミナミ</span></div>
      </div>
      <div class="cert-form">
        <label>修了証の名前 <input type="text" class="cert-name" maxlength="16" value="${esc(name)}"></label>
        <button type="button" class="btn primary" data-a="save">画像で保存</button>
        <button type="button" class="btn" data-a="map">地図へ</button>
      </div></div>`;
    const cv = host.querySelector('.cert-canvas');
    const input = host.querySelector('.cert-name');
    // せまい画面では canvas の代わりに、画面の幅に合わせて組んだ修了証を見せる（保存する画像は canvas のまま。直し係 3 の 7）
    const draw = () => {
      const nm = input.value.trim() || 'あなた';
      host.querySelector('.cert-html .ch-name').textContent = `${nm} さん`;
      drawCert(cv, { name: nm, stars: tot.stars, clears: tot.clears, title: title.name, date });
    };
    input.addEventListener('input', () => { try { localStorage.setItem(NAME_KEY, input.value); } catch { /* なし */ } draw(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
    draw();
    host.querySelector('[data-a="save"]').addEventListener('click', () => {
      cv.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'rovercode_修了証.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        app.toast('修了証を保存したよ');
      }, 'image/png');
    });
  }

  function show() {
    if (step < SCENES.length) scene(step);
    else if (step === SCENES.length) roll();
    else cert();
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'map') { app.go('#/map'); return; }
    if (b.dataset.a === 'skip') { step = SCENES.length + 1; show(); return; }
    if (b.dataset.a === 'next') { step++; audio.play('page'); show(); }
  });
  app.keyHandler = (e, ctx) => {
    if (e.key === 'Escape') { app.go('#/map'); return true; }
    if ((e.key === 'ArrowRight') && ctx.free) { const b = host.querySelector('[data-a="next"]'); if (b) { b.click(); return true; } }
    return false;
  };
  show();
  return { unmount() {} };
}

/** 修了証を描く（紙の色・細い枠・名前・★の数・日付・先輩のサイン）。 */
export function drawCert(cv, o) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const font = (w, px) => `${w} ${px}px "Noto Sans JP", "BIZ UDGothic", sans-serif`;
  g.fillStyle = '#fbf6ea'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#7a5c3a'; g.lineWidth = 6; g.strokeRect(30, 30, W - 60, H - 60);
  g.strokeStyle = '#b79a6e'; g.lineWidth = 2; g.strokeRect(46, 46, W - 92, H - 92);
  // 角の芝の飾り（落ち着いた緑）
  g.fillStyle = '#6f8e4c';
  for (const [x, y] of [[60, 60], [W - 60, 60], [60, H - 60], [W - 60, H - 60]]) { g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill(); }
  g.textAlign = 'center';
  g.fillStyle = '#23313a';
  g.font = font(700, 64); g.fillText('修 了 証', W / 2, 160);
  g.font = font(400, 22); g.fillStyle = '#5b6770'; g.fillText('ROVER CODE  CanSat ローバー プログラミング講座', W / 2, 205);
  g.fillStyle = '#23313a';
  g.font = font(700, 54); g.fillText(`${o.name} さん`, W / 2, 330);
  g.fillStyle = '#7a5c3a'; g.fillRect(W / 2 - 260, 348, 520, 2);
  g.fillStyle = '#23313a'; g.font = font(400, 26);
  const lines = [
    'あなたは ROVER CODE のすべての章をクリアし、',
    'センサで見て・決めて・動く 自律走行ローバーの',
    'プログラムを書けるようになったことを、ここに証します。',
  ];
  lines.forEach((s, i) => g.fillText(s, W / 2, 425 + i * 44));
  g.font = font(400, 22); g.fillStyle = '#5b6770';
  g.fillText(`クリア ${o.clears} 面　★ ${o.stars}　肩書「${o.title}」`, W / 2, 590);
  const d = o.date;
  g.textAlign = 'left'; g.fillText(`${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, 110, H - 110);
  g.textAlign = 'right'; g.fillStyle = '#23313a'; g.font = font(700, 24);
  g.fillText('CanSat チーム リーダー　ミナミ', W - 110, H - 110);
  // 小さな旗（印の代わり）
  g.fillStyle = '#7a5c3a'; g.fillRect(W - 170, H - 250, 4, 90);
  g.fillStyle = '#c8552e'; g.beginPath(); g.moveTo(W - 166, H - 250); g.lineTo(W - 110, H - 236); g.lineTo(W - 166, H - 222); g.closePath(); g.fill();
}
