/**
 * @file app/js/screens/result.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 結果のカード（2 s 以内・とばせる: 数え上げ・★ごとの音・葉・記録の比較・次の★のひとこと・次へ／もう一度／地図）と、
 *       本番テストの表（回ごとの ✓/✗・すき間・時間・理由、✗ を押すとその回を再生）、章のボスの肩書。小さい画面は下からのシート。
 * SPEC: 3.5・2.4 の 8・10.6（★ごとにマリンバ・★3 はカリンバ・章クリアは木琴とギター）・10.1（動きを減らす）・7.9（書き出しの声かけ）
 *
 * 画面（ルータの画面）ではなく、遊ぶ画面の上に出す部品。mount は使わない（段 0 の形の名残り）。
 */

import { isMeasured } from './play_parts.js';
import { fmtCm } from './play_parts.js';
import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';
import { faceSVG, richText } from '../ui/senpai.js';

/** 演出の時刻（s）。全体で 2 s 以内（3.5）。 */
export const TIMING = Object.freeze({ appear: 0.3, count: 0.5, starGap: 0.25, starStart: 0.55, senpai: 1.35, total: 1.6 });

const reduced = () => document.documentElement.classList.contains('reduce-motion') ||
  !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/** 段 0 の形の名残り（使わない）。 */
export function mount(root) { return { unmount() { root.innerHTML = ''; } }; }

/**
 * 見出しの文の数（{cm}・{s}・{m}）を出す。
 * @param {object} level @param {object} judgeShow RunResult.judge.show（{text, value}）
 * @returns {{text: string, value: number|null, fmt: (v: number) => string}}
 */
export function headline(level, judgeShow) {
  const show = (level && level.show) || {};
  const tmpl = (judgeShow && judgeShow.text && !/\{/.test(judgeShow.text) ? null : show.text) || '';
  const v = judgeShow && isMeasured(judgeShow.value) ? judgeShow.value : null;
  const fmt = (x) => {
    if (!tmpl) return judgeShow && judgeShow.text ? judgeShow.text : '';
    return tmpl.replace(/\{cm\}\s*cm/g, fmtCm(x)).replace(/\{cm\}/g, String(Math.round(x * 100))).replace(/\{s\}/g, x.toFixed(1)).replace(/\{m\}/g, x.toFixed(2));
  };
  if (!tmpl && judgeShow && judgeShow.text) return { text: judgeShow.text, value: null, fmt: () => judgeShow.text };
  return { text: v === null ? '' : fmt(v), value: v, fmt };
}

/**
 * クリアのカードを出す。
 * @param {HTMLElement} host 3D の区画（大きい画面）か、画面全体（小さい画面のシート）
 * @param {object} app
 * @param {{level: object, outcome: {stars: boolean[], newStars: boolean[], capped: boolean}, got: boolean[], show: object,
 *   compare: {you: object, senpai: object|null}, nextTip: {n: number, label: string, now: string|null, tip: string|null}|null,
 *   chapterClear: {no: number|string, title: string|null, badge?: string|null}|null, exportNudge: boolean, sheet: boolean,
 *   senpaiClear: string, compact?: boolean, onNext: () => void, onAgain: () => void, onMap: () => void, onExport: () => void, onCelebrate?: (k: string) => void}} o
 * @returns {{el: HTMLElement, skip: () => void, destroy: () => void, done: Promise<void>}}
 */
export function showClear(host, app, o) {
  const { t, audio } = app;
  const el = document.createElement('section');
  el.className = `clear-card${o.sheet ? ' sheet' : ''}`;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', t('result.sheet_label'));
  const H = headline(o.level, o.show);
  const got = o.got;                                   // この実行で取った★（1・2・3）
  const stars3 = (o.outcome && o.outcome.stars) || got;
  const cmp = o.compare || {};
  const fmtCmp = (who, r) => {
    if (!r) return '';
    const parts = [];
    if (Number.isFinite(r.gap)) parts.push(fmtCm(r.gap));
    if (isMeasured(r.t)) parts.push(t('result.seconds', { s: r.t.toFixed(1) }));
    if (Number.isFinite(r.lines)) parts.push(t('result.lines', { n: r.lines }));
    return parts.length ? `${who} ${parts.join('・')}` : '';
  };
  const cmpText = [fmtCmp(t('result.you'), cmp.you), fmtCmp(t('result.senpai'), cmp.senpai)].filter(Boolean).join(' ／ ');
  const nt = o.nextTip;
  const pr = o.predict || null;          // 予想の面: 当たり・はずれを札に大きく（直し A-8）
  const big = pr ? t(pr.right ? 'play.predict_result_right' : 'play.predict_result_wrong') : t('result.clear');
  el.innerHTML = `
    <div class="cc-chapter" hidden></div>
    <div class="cc-main">
      <div class="cc-text">
        <div class="cc-big${pr && !pr.right ? ' miss' : ''}">${esc(big)}</div>
        <div class="cc-head" aria-live="off">${esc(pr && !pr.right ? t('play.predict_result_sub') : H.value !== null ? H.fmt(0) : H.text)}</div>
      </div>
      <div class="cc-stars" role="img" aria-label="${esc(t('result.stars_label', { n: stars3.filter(Boolean).length }))}">
        ${[0, 1, 2].map((i) => `<span class="st s${i} ${stars3[i] ? 'on' : 'off'}${o.outcome && o.outcome.capped && i === 2 ? ' capped' : ''}">${stars3[i] ? '★' : '☆'}</span>`).join('')}
      </div>
      <button type="button" class="btn next">${esc(t('result.next'))}</button>
      <button type="button" class="cc-fold" aria-expanded="true" aria-label="${esc(t('result.fold'))}" title="${esc(t('result.fold'))}">▾</button>
    </div>
    <div class="cc-senpai"><span class="tip-face">${faceSVG('smile')}</span><span>${richText(o.senpaiClear || '')}</span></div>
    ${o.outcome && o.outcome.capped ? `<div class="cc-capped">☆ ${esc(t('play.answer_seen_star'))}</div>` : ''}
    ${cmpText ? `<div class="cc-cmp">${esc(cmpText)}</div>` : ''}
    ${nt ? `<div class="cc-tip">${icon('bulb')}<span>${esc(t('result.next_star', { n: nt.n, label: nt.label }))}${nt.now ? esc(t('result.next_star_now', { v: nt.now })) : ''}${nt.tip ? `<br>${richText(nt.tip)}` : ''}</span></div>` : ''}
    <div class="cc-actions"><button type="button" class="btn small" data-a="again">${icon('reset')}<span>${esc(t('result.again'))}</span></button>
      <button type="button" class="btn small" data-a="map">${icon('map')}<span>${esc(t('result.map'))}</span></button>
      ${o.exportNudge ? `<button type="button" class="linkish small" data-a="export">${icon('download')}<span>${esc(t('result.export_nudge'))}</span></button>` : ''}</div>`;
  host.appendChild(el);
  const q = (s) => el.querySelector(s);
  // たたむ（3D の止まった所や跡を見たい時。選んだ方を覚えておく。直し A-5）
  const FOLD_KEY = 'rovercode.clearFolded';
  const setFold = (v, remember = true) => {
    el.classList.toggle('folded', v);
    const b = q('.cc-fold');
    b.textContent = v ? '▴' : '▾';
    b.setAttribute('aria-expanded', String(!v));
    b.setAttribute('aria-label', t(v ? 'result.unfold' : 'result.fold'));
    b.title = t(v ? 'result.unfold' : 'result.fold');
    if (remember) { try { localStorage.setItem(FOLD_KEY, v ? '1' : '0'); } catch { /* なし */ } }
  };
  q('.cc-fold').addEventListener('click', (e) => { e.stopPropagation(); finish(); setFold(!el.classList.contains('folded')); });
  let folded0 = false;
  try { folded0 = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* なし */ }
  // 低い画面・せまい画面は最初からたたむ（★と［次へ］だけの細い帯。3D を札でかくさない。直し係 3 の 1）
  if (o.compact) setFold(true, false);
  else if (folded0 && !o.chapterClear) setFold(true);
  q('.next').addEventListener('click', (e) => { e.stopPropagation(); finish(); o.onNext(); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (b) {
      e.stopPropagation();
      finish();
      if (b.dataset.a === 'again') o.onAgain();
      else if (b.dataset.a === 'map') o.onMap();
      else if (b.dataset.a === 'export') o.onExport();
      return;
    }
    skip();                                   // カードを押すと演出を全部とばす（3.5）
  });

  const timers = [];
  let raf = 0;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const at = (s, fn) => timers.push(setTimeout(fn, s * 1000));

  function finalState() {
    if (H.value !== null) q('.cc-head').textContent = H.fmt(H.value);
    el.classList.add('shown');
    for (const s of el.querySelectorAll('.st')) s.classList.add('in');
    q('.cc-senpai').classList.add('in');
    if (o.chapterClear) showChapter();
  }
  function showChapter() {
    const c = q('.cc-chapter');
    if (!c.hidden) return;
    c.hidden = false;
    const cc = o.chapterClear;
    // 章クリア: 旗が上がる・★の集計・先輩のひとこと（紙吹雪や光る演出は使わない。直し A-20・C10）
    const msg = cc.badge ? t('result.chapter_clear_c', { badge: cc.badge }) : t('result.chapter_clear', { no: cc.no, title: cc.title || '' });
    const tally = Number.isFinite(cc.starsGot) && Number.isFinite(cc.starsMax) ? t('result.chapter_stars', { got: cc.starsGot, max: cc.starsMax }) : '';
    c.innerHTML = `<div class="ch-flag" aria-hidden="true"><svg viewBox="0 0 60 80" width="46" height="62"><rect x="8" y="6" width="3" height="72" rx="1.5" fill="#7a5c3a"/><rect x="2" y="74" width="16" height="5" rx="2" fill="#5e7a3a"/><g class="ch-flag-cloth"><path d="M11 8 h38 l-8 9 l8 9 h-38 z" fill="#c8552e"/><text x="27" y="21" font-size="10" text-anchor="middle" fill="#fffaf0" font-weight="700">${esc(String(cc.no))}</text></g></svg></div>
      <div class="ch-text"><b>${esc(msg)}</b>${tally ? `<span class="ch-tally">${esc(tally)}</span>` : ''}${cc.say ? `<span class="ch-say">${esc(cc.say)}</span>` : ''}</div>`;
    if (el.classList.contains('folded') && !o.compact) setFold(false);
  }
  function finish() {
    if (finished) return;
    finished = true;
    for (const h of timers) clearTimeout(h);
    if (raf) cancelAnimationFrame(raf);
    finalState();
    el.classList.add('done');                 // 出そろった（テストと支援技術のため）
    resolveDone();
  }
  function skip() { finish(); }

  if (reduced()) {
    // 動きを減らす: すぐ最後の形。音は 1 つだけ
    audio.play('clear');
    finish();
  } else {
    requestAnimationFrame(() => el.classList.add('shown'));
    audio.play('clear');
    // 数え上げ（0.5 s）
    if (H.value !== null) {
      const t0 = performance.now() + TIMING.appear * 1000;
      const step = (now) => {
        const u = Math.max(0, Math.min(1, (now - t0) / (TIMING.count * 1000)));
        q('.cc-head').textContent = H.fmt(H.value * (1 - (1 - u) ** 2));
        if (u < 1 && !finished) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    // ★を 1 つずつ（0.25 s ずつ、マリンバの音が上がる）
    let k = 0;
    for (let i = 0; i < 3; i++) {
      if (!stars3[i]) continue;
      const when = TIMING.starStart + k * TIMING.starGap;
      const idx = i;
      at(when, () => { q(`.st.s${idx}`).classList.add('in'); audio.play('star', { index: idx }); });
      k++;
    }
    for (let i = 0; i < 3; i++) if (!stars3[i]) at(TIMING.starStart, () => q(`.st.s${i}`).classList.add('in'));
    if (got[2]) at(TIMING.starStart + 3 * TIMING.starGap, () => { audio.play('leaves'); if (o.onCelebrate) o.onCelebrate('leaves'); el.classList.add('leaves'); });
    at(TIMING.senpai, () => { q('.cc-senpai').classList.add('in'); if (o.onCelebrate) o.onCelebrate('wiggle'); });
    at(TIMING.total, () => finish());
  }
  if (o.chapterClear) done.then(() => { showChapter(); audio.play('chapter'); });
  // 次へにフォーカス（キーボードの人がすぐ進める）
  setTimeout(() => { try { q('.next').focus({ preventScroll: true }); } catch { /* なし */ } }, 50);

  return { el, skip, destroy() { finish(); el.remove(); }, done };
}

/**
 * 本番テストの表（3.5）。
 * @param {HTMLElement} host 出力の欄
 * @param {object} app
 * @param {{rr: object, level: object, need: number|null, onReplay: (i: number) => void}} o
 * @returns {HTMLElement}
 */
export function testTable(host, app, o) {
  const { t } = app;
  const runs = (o.rr && o.rr.runs) || [];
  const passFor = (i) => {
    const st = (o.rr.judge && o.rr.judge.stars) || [];
    const s = st.find((x) => x && x.byTest) || st[st.length - 1];
    if (s && Array.isArray(s.pass)) return !!s.pass[i];
    const c = o.rr.judge && o.rr.judge.clear;
    return c && c.conds && c.conds[0] && Array.isArray(c.conds[0].pass) ? !!c.conds[0].pass[i] : false;
  };
  const pass = runs.filter((_, i) => passFor(i)).length;
  const box = document.createElement('div');
  box.className = 'test-box';
  const reason = (r, i) => {
    if (passFor(i)) return '';
    if (r.error) return r.error.title || r.error.id;
    if (r.guard) return r.guard.title || r.guard.id;
    if (r.end === 'timeup' || (r.final && r.final.timeUp)) return t('play.time_up');
    const s = (o.rr.senpai || []).find((h) => h.world === i || h.run === i);
    return s ? s.say : '—';
  };
  const gapOf = (r) => {
    const m = r.metrics || {};
    const g = isMeasured(m['gap:cone']) ? m['gap:cone'] : isMeasured(m.gap) ? m.gap : null;
    return g === null ? "—" : fmtCm(g);
  };
  const timeOf = (r) => {
    const m = r.metrics || {};
    const tt = isMeasured(m.t_stop) ? m.t_stop : r.final && isMeasured(r.final.t) ? r.final.t : null;
    return tt === null ? '—' : `${tt.toFixed(1)} 秒`;
  };
  box.innerHTML = `<h4>${esc(t('play.test_title'))} <span class="test-pass">${esc(t('play.test_pass', { pass, of: runs.length }))}</span></h4>
    ${o.rr.testCut ? `<p class="test-cut">${esc(t('play.test_cut', { n: o.rr.testCut.done }))}</p>` : ''}
    <div class="test-scroll"><table class="test-table"><thead><tr><th scope="col">${esc(t('play.test_col_no'))}</th><th scope="col">${esc(t('play.test_col_ok'))}</th><th scope="col">${esc(t('play.test_col_gap'))}</th><th scope="col">${esc(t('play.test_col_time'))}</th><th scope="col">${esc(t('play.test_col_reason'))}</th></tr></thead>
    <tbody>${runs.map((r, i) => {
      const ok = passFor(i);
      return `<tr class="${ok ? 'ok' : 'ng'}"><th scope="row">${i + 1}</th><td>${ok ? '<span class="okmark">✓</span>' : `<button type="button" class="btn small ngbtn" data-run="${i}" aria-label="${esc(t('play.test_row_replay'))} ${i + 1}">✗ ${esc(t('play.test_row_replay'))}</button>`}</td><td>${esc(gapOf(r))}</td><td>${esc(timeOf(r))}</td><td>${esc(reason(r, i))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-run]'); if (b) o.onReplay(Number(b.dataset.run)); });
  host.appendChild(box);
  return box;
}
