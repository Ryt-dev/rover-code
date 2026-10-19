/**
 * @file app/js/screens/play.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 遊ぶ画面: 左の欄（先輩の吹き出し・今回おぼえること・予想カード・小目標・クリア条件・ヒントと答え）、右上の 3D（W5）、
 *       時間のつまみ（W5）、エディタ（W6）と出力。実行の流れ（準備中の実行・予想・本番テスト・持ってくる・履歴・道具箱）を組み合わせる。
 * SPEC: 3.4・2.4・2.2・3.5・3.6・3.11・7.4（job）・7.5（■ 止める の意味）
 *
 * ほかの単位の部品は ui/deps.js で読み、まだ使えない時は W7 の代わりの部品（ui/fallback_*.js）を使う。
 * 並べ方は CSS の grid（screens.css の .play）。小さい画面のタブは data-tab で切りかえる（3.11）。
 */

import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';
import { createSenpai, tipEl, richText, faceSVG } from '../ui/senpai.js';
import { confirmDialog } from '../ui/dialog.js';
import { createFallbackEditor } from '../ui/fallback_editor.js';
import { createFallbackScene, SimplePlayer, SimpleTimeline, poseAt, readFrames } from '../ui/fallback_view.js';
import { createFallbackCard } from '../ui/fallback_card.js';
import { createHints, HINT_WAIT_MS } from '../hints.js';
import { oneShotStarIndexes } from '../store.js';
import { showClear, testTable, headline } from './result.js';
import { createWaitBar } from '../ui/wait_bar.js';
import { failCard } from './loadfail.js';
import { setupLayout } from './play_layout.js';
import { chapterLabel, countLines, fmtMeasure, measureOf, isMeasured, learnCard, predictCard, stepsCard, goalsCard, hudValues, unitOf, fmtCm, measureText } from './play_parts.js';

const DAY = 86400000;
const DEFAULT_LIMITS = { lineLimit: 2000000, wallLimitS: 8, printCap: 3000, logCap: 20000, eventCap: 20000 };

/**
 * 画面を出す。
 * @param {HTMLElement} root @param {object} app @param {string|null} id 面の id（例 "1-3"）
 * @returns {Promise<{unmount: () => void}>}
 */
export async function mount(root, app, id) {
  const { t, store, progress, audio } = app;
  const level = id ? await app.level(id) : null;
  const ch = id ? progress.chapterOf(id) : null;
  if (!level || !progress.isUnlocked(id)) {
    app.header.set({ chapter: chapterLabel(ch), levelId: id || '' });
    root.innerHTML = `<div class="screen-msg card"><h1>${esc(level ? t('play.level_locked') : t('play.level_missing'))}</h1>
      <p><button type="button" class="btn primary" data-go="#/map">${icon('map')}<span>${esc(t('button.map'))}</span></button></p></div>`;
    root.querySelector('[data-go]').addEventListener('click', () => app.go('#/map'));
    return { unmount() {} };
  }
  // 面の前の場面（story.json の before_level。10-3 の前の「後日、鳥取へ」）: 初めて開く時だけ先に見せる
  const L0 = store.hasLevel(id) ? store.level(id) : null;
  if (!store.isReadOnly() && !store.storySeen(`L${id}`) && !(L0 && (L0.cleared || L0.attempts > 0))) {
    const story = await app.lazy('story');
    if (((story && story.scenes) || []).some((s) => s.before_level === id)) {
      setTimeout(() => app.router.replace(`#/story/L${encodeURIComponent(id)}`), 0);
      return { unmount() {} };
    }
  }
  const deps = await app.deps;
  const api = await app.lazy('api');
  const rules = await app.lazy('rules');          // W3 のカードの見出し・ずかんの名前・開く段（error_rules.json）
  const apiFns = (api && api.functions) || {};
  const L = store.level(id);
  store.markUnlocked(id);
  const chapterNo = level.chapter;
  const isC = level.lang === 'c';
  const predictQs = level.type === 'predict' && Array.isArray(level.predict) && level.predict.length ? level.predict : level.predict_card ? [level.predict_card] : null;
  const settings = store.settings();
  const newZukan = store.markZukanSeen(level.new || []);

  // ---------------------------------------------------------------- 骨組み
  root.innerHTML = `
  <div class="play" data-tab="code">
    <div class="ptabs" role="tablist" aria-label="${esc(t('play.tabs_label'))}">
      <button type="button" role="tab" data-tab="mission" id="tab-mission" aria-controls="pane-mission">${esc(t('play.tab_mission'))}</button>
      <button type="button" role="tab" data-tab="view" id="tab-view" aria-controls="pane-view">${esc(t('play.tab_view'))}<span class="tab-dot" hidden></span></button>
      <button type="button" role="tab" data-tab="code" id="tab-code" aria-controls="pane-code">${esc(t('play.tab_code'))}</button>
      <button type="button" role="tab" data-tab="output" id="tab-output" aria-controls="pane-output">${esc(t('play.tab_output'))}<span class="tab-dot out-dot" hidden></span></button>
    </div>
    <aside class="mission" id="pane-mission" role="tabpanel" aria-labelledby="tab-mission" aria-label="${esc(t('play.tab_mission'))}">
      <div class="ro-banner" hidden>${esc(t('play.readonly'))}</div>
      <div class="senpai-box"></div>
      <div class="hints-open"></div>
      <div class="review-slot"></div>
      <div class="retry-slot"></div>
      <div class="learn-slot"></div>
      <div class="predict-slot"></div>
      <div class="steps-slot"></div>
      <div class="goals-slot"></div>
      <div class="hint">
        <button type="button" class="hint-btn">${icon('bulb')}<span class="hb-text"></span><span class="ring" aria-hidden="true"></span></button>
        <button type="button" class="answer-btn">${icon('eye')}<span>${esc(t('button.answer'))}</span></button>
      </div>
    </aside>
    <div class="view" id="pane-view" role="tabpanel" aria-labelledby="tab-view">
      <div class="scene-host"></div>
      <div class="hud" aria-hidden="true"></div>
      <div class="camsw" role="group" aria-label="${esc(t('camera.label'))}">
        <button type="button" data-cam="follow" aria-pressed="true">${esc(t('camera.follow'))}</button>
        <button type="button" data-cam="top" aria-pressed="false">${esc(t('camera.top'))}</button>
        <button type="button" data-cam="onboard" aria-pressed="false">${esc(t('camera.onboard'))}</button>
      </div>
      <div class="worldsw" role="group" aria-label="${esc(t('play.worlds_label'))}" hidden></div>
      <div class="legend" aria-hidden="true"><span class="lg now">${esc(t('play.legend_now'))}</span><span class="lg prev">${esc(t('play.legend_prev'))}</span><span class="lg senpai">${esc(t('play.legend_senpai'))}</span></div>
      <button type="button" class="btn small senpai-run" hidden>${esc(t('button.show_senpai_run'))}</button>
      <div class="result-slot"></div>
    </div>
    <div class="vsplit" role="separator" aria-orientation="horizontal" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="45" aria-controls="pane-view" aria-label="${esc(t('play.vsplit'))}"></div>
    <div class="asplit" role="separator" aria-orientation="vertical" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="30" aria-controls="pane-mission" aria-label="${esc(t('play.split_aside'))}"></div>
    <div class="csplit" role="separator" aria-orientation="vertical" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25" aria-controls="pane-output" aria-label="${esc(t('play.split_console'))}"></div>
    <button type="button" class="unfold unfold-aside" aria-controls="pane-mission"><span>${esc(t('play.unfold_aside'))}</span></button>
    <button type="button" class="unfold unfold-console" aria-controls="pane-output"><span>${esc(t('play.unfold_console'))}</span></button>
    <div class="tl-host"><div class="tl-empty"><span>${esc(t('play.tl_empty'))}</span><i class="tl-rail" aria-hidden="true"></i></div></div>
    <div class="curline" aria-hidden="true"></div>
    <div class="fail-head" hidden><span class="fh-mark" aria-hidden="true">✗</span><span class="fh-text"></span><button type="button" class="fh-go">${esc(t('play.fail_head_go'))}</button></div>
    <div class="editor" id="pane-code" role="tabpanel" aria-labelledby="tab-code">
      <div class="etop">
        <span class="file">${isC ? 'main.c' : 'main.py'}</span>
        <span class="etools">
          <button class="btn-dark" type="button" data-a="palette" aria-pressed="false" title="${esc(t('play.palette_toggle'))}">${icon('plus')}<span>${esc(t('play.palette_toggle'))}</span></button>
          <button class="btn-dark" type="button" data-a="history" title="${esc(t('button.history'))}">${icon('history')}<span>${esc(t('button.history'))}</span></button>
          ${level.carry_from ? `<button class="btn-dark" type="button" data-a="carry" title="${esc(t('button.carry'))}">${icon('carry')}<span>${esc(t('button.carry'))}</span></button>` : ''}
          <button class="btn-dark" type="button" data-a="toolbox" title="${esc(t('button.toolbox'))}">${icon('toolbox')}<span>${esc(t('button.toolbox'))}</span></button>
          <button class="btn-dark" type="button" data-a="sil" title="${esc(t('button.export_sil'))}">${icon('sil')}<span>${esc(t('button.export_sil'))}</span></button>
        </span>
        <button class="btn-dark" type="button" data-a="reset" title="${esc(t('button.reset'))}">${icon('reset')}<span>${esc(t('button.reset'))}</span></button>
        <button class="btn-dark" type="button" data-a="stop" title="${esc(t('button.stop'))}" disabled>${icon('stop')}<span>${esc(t('button.stop'))}</span></button>
        ${level.test ? `<button class="btn-dark btn-test" type="button" data-a="test" title="${esc(t('button.test'))}">${icon('test')}<span>${esc(t('button.test'))}</span></button>` : ''}
        <button class="btn-run" type="button" data-a="run"><span class="run-text"></span></button>
      </div>
      <div class="run-bubble" hidden><span class="tip-face">${faceSVG('smile')}</span><span>${esc(t('senpai.press_here'))}</span></div>
      <div class="run-sub" aria-live="polite"></div>
      <div class="editor-host"></div>
    </div>
    <div class="console" id="pane-output" role="tabpanel" aria-labelledby="tab-output">
      <h2 class="console-h sr-only">${esc(t('play.output'))}</h2>
      <div class="ctabs" role="tablist" aria-label="${esc(t('play.output'))}">
        <button type="button" role="tab" class="ctab" data-ctab="log" id="ctab-log" aria-selected="true" aria-controls="clog">${esc(t('play.output'))}</button>
        <button type="button" role="tab" class="ctab" data-ctab="graph" id="ctab-graph" aria-selected="false" aria-controls="cgraph" tabindex="-1" hidden>${esc(t('play.graph_tab'))}</button>
      </div>
      <div class="log" id="clog" role="log" aria-live="off" aria-labelledby="ctab-log"></div>
      <div class="graphs-host" id="cgraph" role="tabpanel" aria-labelledby="ctab-graph" hidden></div>
      <div class="sr-only result-live" aria-live="polite"></div>
    </div>
  </div>`;
  const P = root.querySelector('.play');
  const q = (s) => root.querySelector(s);
  const qa = (s) => [...root.querySelectorAll(s)];

  app.header.set({ chapter: chapterLabel(ch), levelId: id, levelTitle: level.title, stars: L.stars });
  if (id === '1-2' && L.attempts === 0) app.header.wiggleMap();       // 2.2: 1-2 で地図の場所を小さく見せる
  // 初めての 1-1: エディタや 3D の読み込みを待たずに「ここを押してみて」を出す（2.2 の 〜10 s）
  if (L.attempts === 0 && id === '1-1') { q('.run-bubble').hidden = false; q('[data-a="run"]').classList.add('beckon'); }

  // ---------------------------------------------------------------- 左の欄
  const senpai = createSenpai(q('.senpai-box'));
  senpai.say(level.story || '', 'normal');
  q('.learn-slot').appendChild(learnCard(level, apiFns, (name) => app.go(`#/zukan/${encodeURIComponent(name)}`)));
  // 「ずかんに増えたよ」の通知: 初めての 1-1 は「▶ 実行 を押してみて」の吹き出しに重なるので、1 回目の実行の後に出す（直し係 6）
  let zukanToast = newZukan.slice(0, 1).map((nm) => t('play.zukan_new', { name: apiFns[nm] ? apiFns[nm].sig || nm : nm }));
  if (!(L.attempts === 0 && id === '1-1')) { for (const s of zukanToast) app.toast(s); zukanToast = []; }

  const oneShots = oneShotStarIndexes(level);
  let pcard = null;
  // 予想の当たり・はずれを札に大きく出すのは、予想した直後の 1 回の実行だけ（直し係 3 の 4）
  let predictFresh = !!predictQs && !!(L.prediction && L.prediction.first && L.prediction.first.length) && L.attemptsSinceReset === 0;
  let predictShowNow = false;
  const isReadOnlyPredict = () => !!predictQs && (!L.prediction || L.attemptsSinceReset === 0);
  function buildPredict() {
    if (!predictQs) return;
    const slot = q('.predict-slot');
    slot.innerHTML = '';
    pcard = predictCard(predictQs, {
      saved: L.prediction, order: L.prediction && L.prediction.order,
      onChoose(first) {
        const ok = first.every((c, i) => c === predictQs[i].answer);
        store.setPrediction(id, first, ok);
        predictFresh = true;
        app.toast(t('play.predict_saved'));
        updateRunButton();
      },
    });
    slot.appendChild(pcard.el);
    if (L.prediction && L.attemptsSinceReset > 0) pcard.reveal();
  }
  buildPredict();

  const steps = Array.isArray(level.steps) && level.steps.length ? stepsCard(level.steps) : null;
  if (steps) q('.steps-slot').appendChild(steps.el);
  const capped = () => L.answerSeen && L.answerSeenClearsAfter < 1;
  const goals = goalsCard(level, { stars: L.stars, capped: capped() });
  q('.goals-slot').appendChild(goals.el);

  // 一度きりの★の取り直し（3.6〔1.1〕）
  function showRetry() {
    const slot = q('.retry-slot');
    slot.innerHTML = '';
    if (!oneShots.length || !progress.canRetryOneShot(id)) return;
    const box = document.createElement('div');
    box.className = 'card retry-card';
    box.innerHTML = `<p>${esc(t('play.one_shot_retry'))}</p><button type="button" class="btn small primary">${esc(t('button.again'))}</button>`;
    box.querySelector('button').addEventListener('click', async () => {
      store.startOneShotRetry(id);
      if (predictQs) {
        const order = predictQs.map((qq) => shuffle(qq.choices.map((_, i) => i), id));
        store.setPredictionOrder(id, order);
        buildPredict();
        app.toast(t('play.predict_reshuffle'));
      }
      if (level.type === 'parsons') { await buildEditor(level.starter || '', true); app.toast(t('play.parsons_reset')); }
      slot.innerHTML = '';
      updateRunButton();
    });
    slot.appendChild(box);
  }
  showRetry();

  // おさらいカード（2.3: 3 日以上あいたら 1 回だけ）
  const since = store.sinceLastSeen();
  const reviewKey = `${chapterNo}`;
  if (since !== null && since >= 3 * DAY && store.get().reviewShown !== reviewKey) {
    store.setReviewShown(reviewKey);
    const done = (ch && ch.levels ? ch.levels : []).filter((x) => store.hasLevel(x) && store.level(x).cleared);
    const lvls = await app.chapterLevels(chapterNo);
    const cmds = [...new Set(lvls.filter((x) => done.includes(x.id)).flatMap((x) => x.new || []))].filter((n) => apiFns[n]);
    if (cmds.length) {
      const box = document.createElement('section');
      box.className = 'card review-card';
      box.innerHTML = `<h3>${esc(t('senpai.review_title'))}<button type="button" class="dlg-x small" aria-label="${esc(t('button.close'))}">${icon('close')}</button></h3>
        <p>${esc(t('senpai.review_intro', { no: chapterNo }))}</p><ul>${cmds.map((c) => `<li><code>${esc(apiFns[c].sig || c)}</code> … ${esc(apiFns[c].summary || '')}</li>`).join('')}</ul>`;
      box.querySelector('.dlg-x').addEventListener('click', () => box.remove());
      q('.review-slot').appendChild(box);
    }
  }

  // ---------------------------------------------------------------- ヒントと答え（3.6）
  const hints = createHints(level, L, { cleared: () => L.cleared });
  let hintTimer = 0;
  let errHint = null;            // 今出ているエラーのヒント（{title, fix}。ヒントの数は使わない。直し A-10）
  function renderHints() {
    const box = q('.hints-open');
    box.innerHTML = '';
    if (errHint && errHint.shown) {
      const c = document.createElement('div');
      c.className = 'card hint-card err-hint';
      c.innerHTML = `<h3>${icon('bulb')}<span>${esc(t('play.hint_for_error'))}</span></h3><p><b>${esc(errHint.title || '')}</b>${errHint.fix ? `<br>${richText(errHint.fix)}` : ''}</p>`;
      box.appendChild(c);
    }
    for (let i = 0; i < hints.opened(); i++) {
      const c = document.createElement('div');
      c.className = 'card hint-card';
      c.innerHTML = `<h3>${icon('bulb')}<span>${esc(t('play.hint_title', { n: i + 1 }))}</span></h3><p>${richText(hints.text(i) || '')}</p>`;
      box.appendChild(c);
    }
    if (hints.bossLocked() && hints.opened() >= 2) {
      const c = document.createElement('p');
      c.className = 'hint-note';
      c.textContent = t('play.hint_boss');
      box.appendChild(c);
    }
    const btn = q('.hint-btn');
    const left = hints.left();
    const i = hints.opened();
    const rem = hints.remainingMs(i);
    const errReady = !!(errHint && !errHint.shown && errHint.fix);
    btn.disabled = left === 0 && !errReady;
    btn.querySelector('.hb-text').textContent = errReady ? t('play.hint_error_btn') : left ? t('play.hints_left', { n: left }) : t('play.hints_none');
    const ring = btn.querySelector('.ring');
    if (left && rem > 0 && rem !== Infinity) {
      btn.classList.add('waiting');
      ring.style.setProperty('--p', String(1 - rem / HINT_WAIT_MS));
      btn.setAttribute('aria-description', t('play.hint_wait', { s: Math.ceil(rem / 1000) }));
      clearTimeout(hintTimer);
      hintTimer = setTimeout(renderHints, Math.min(1000, rem));
    } else {
      btn.classList.remove('waiting');
      btn.removeAttribute('aria-description');
    }
    const ab = q('.answer-btn');
    ab.classList.toggle('locked', !hints.canSeeAnswer());
  }
  q('.fh-go').addEventListener('click', () => setTab('output', true));
  q('.hint-btn').addEventListener('click', () => {
    // エラーで止まっている時は、まずそのエラーに合ったヒントを出す（数は減らない）
    if (errHint && !errHint.shown && errHint.fix) {
      errHint.shown = true;
      audio.play('page');
      renderHints();
      const c = q('.err-hint');
      if (c) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const i = hints.opened();
    if (!hints.canOpen(i)) {
      const rem = hints.remainingMs(i);
      if (rem > 0 && rem !== Infinity) app.toast(t('play.hint_wait', { s: Math.ceil(rem / 1000) }));
      return;
    }
    hints.open(i);
    store.setHintsOpened(id, i + 1);
    audio.play('page');
    renderHints();
    const cards = qa('.hint-card');
    if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  q('.answer-btn').addEventListener('click', async () => {
    if (!hints.canSeeAnswer()) { app.toast(t('play.answer_after_clear')); return; }
    if (!L.cleared && !L.answerSeen) {
      const ok = await confirmDialog(t('play.answer_title'), t('play.answer_confirm'));
      if (!ok) return;
    }
    if (!L.cleared) store.markAnswerSeen(id);
    const a = hints.answer();
    const box = document.createElement('div');
    box.className = 'answer-box';
    box.innerHTML = `${a.labels.length ? `<ol class="answer-toc">${a.labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>` : ''}<pre class="answer-code" aria-label="${esc(t('play.answer_title'))}">${esc(a.code)}</pre><p class="answer-note">${esc(t('play.answer_note'))}</p>`;
    await app.openDialog({ title: t('play.answer_title'), body: box, noCopy: true, wide: true, actions: [{ label: t('button.close'), value: 'c', primary: true }] });
    goals.setGot(L.stars);
    renderGoals(null);
  });
  renderHints();

  // ---------------------------------------------------------------- エディタ
  let editor = null;
  let codeChangedSinceRun = false;
  let marksShown = false;
  const savedCode = typeof L.code === 'string' ? L.code : null;
  async function buildEditor(code, fresh = false) {
    if (editor && editor.destroy) { try { editor.destroy(); } catch { /* なし */ } }
    const host = q('.editor-host');
    host.innerHTML = '';
    const mode = level.type === 'parsons' && level.parsons ? 'parsons' : level.blanks && level.blanks.length ? 'blanks' : 'free';
    const learnedNew = await learnedUpTo();
    const roMsg = isReadOnlyPredict() ? t('play.predict_locked') : '';
    const opts = {
      lang: level.lang || 'python', value: code, starter: level.starter || '', mode, locked: level.locked || [], blanks: level.blanks || [],
      parsons: level.parsons || null, palette: { level, api: api || { functions: {} }, learnedNew }, fontSize: settings.editorFont,
      autoZenkaku: settings.autoZenkaku, unlockable: !!L.cleared, label: `${t('play.tab_code')}（${isC ? 'main.c' : 'main.py'}）`,
      onHelp: (name) => app.go(`#/zukan/${encodeURIComponent(name)}`), chapter: chapterNo, fresh,
    };
    editor = null;
    if (deps.createEditor) {
      try {
        if (deps.loadCodeMirror) await withTimeout(deps.loadCodeMirror(), 10000);
        editor = deps.createEditor(host, opts);
      } catch (e) { console.warn('W6 のエディタを作れなかった（代わりを使う）', e); host.innerHTML = ''; editor = null; }
    }
    if (!editor) editor = createFallbackEditor(host, { ...opts, palette: paletteFor(level, apiFns) });
    editor.on('change', onCodeChange);
    editor.on('run', () => onRun());
    if (!editor.fallback) {
      editor.on('escape', () => onStop());
      editor.on('marksCleared', (m) => { marksShown = false; logLine((m && m.message) || t('play.lines_cleared'), 'note'); });
      editor.on('zenkaku', (m) => { if (m && m.message) app.toast(m.message); });
      editor.on('blocked', (m) => { if (m && m.message) app.toast(m.message); });
    }
    if (roMsg && editor.setReadOnly) editor.setReadOnly(true, roMsg);
  }
  function onCodeChange() {
    const c = editor.getCode();
    if (!store.isReadOnly()) store.setCode(id, c);
    codeChangedSinceRun = true;
    if (marksShown && editor.fallback) {
      marksShown = false;
      editor.clearMarks();
      logLine(t('play.lines_cleared'), 'note');
    }
  }
  /** その面までに出てきた new（パレットの材料。5.4）。 */
  async function learnedUpTo() {
    const out = [];
    const order = progress.levelOrder();
    const upto = order.indexOf(id);
    const chs = [...new Set(order.slice(0, upto + 1).map((x) => progress.chapterNo(x)))];
    const lists = await Promise.all(chs.map((n) => app.chapterLevels(n)));
    const byId = new Map(lists.flat().map((x) => [x.id, x]));
    for (const lid of order.slice(0, upto + 1)) for (const n of ((byId.get(lid) || {}).new || [])) if (!out.includes(n)) out.push(n);
    return out;
  }
  await buildEditor(savedCode !== null ? savedCode : level.starter || '');
  if (isReadOnlyPredict() && editor.fallback) {
    const n = document.createElement('p');
    n.className = 'ro-note';
    n.textContent = t('play.predict_locked');
    q('.run-sub').after(n);
  }

  // ---------------------------------------------------------------- 3D と再生
  let scene = null;
  let usingFallbackScene = false;
  const sceneHost = q('.scene-host');
  const venues = await app.lazy('venues');
  const venueOf = (w) => (venues && venues.venues && w && venues.venues[w.venue_key]) || null;
  function makeScene() {
    if (deps.createScene && settings.quality !== 'none') {
      try {
        scene = deps.createScene(sceneHost, { quality: settings.quality });
        usingFallbackScene = false;
        return;
      } catch (e) { console.warn('W5 の 3D を作れなかった（上から見た図を使う）', e); sceneHost.innerHTML = ''; }
    }
    scene = createFallbackScene(sceneHost);
    usingFallbackScene = true;
  }
  makeScene();
  const firstWorld = (level.worlds && level.worlds[0] && level.worlds[0].world) || {};
  try { scene.loadWorld(firstWorld, venueOf(firstWorld), { arrowLevel: level }); } catch (e) { console.warn(e); }   // 札の行き先（スタートに戻る面。直し係 6）
  try { scene.setOverlays(overlayFlags()); } catch { /* なし */ }
  q('.view').classList.toggle('fallback', usingFallbackScene);

  function overlayFlags() {
    const o = settings.overlays || {};
    const lv = level.overlays || [];
    return { trail: o.trail !== false, ghost: o.ghost !== false && lv.includes('ghost'), arrow: lv.includes('arrow'), lidar: o.sensors !== false, cameraFov: o.sensors !== false, gnss: o.gnss !== false, truth: o.gnss !== false };
  }

  q('.camsw').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    for (const x of qa('.camsw button')) x.setAttribute('aria-pressed', String(x === b));
    try { scene.setCamera(b.dataset.cam); } catch { /* なし */ }
  });
  if (usingFallbackScene) q('.camsw').hidden = true;

  // ---------------------------------------------------------------- 実行の状態
  let runSeq = 0;
  let phase = 'idle';           // idle | queued | computing | replaying
  let lastResult = null;        // 今見ている RunResult
  let lastWorldIdx = 0;
  let player = null;
  let timeline = null;
  let printsShown = 0;
  let curRecord = null;
  let prevRecords = [];         // 前回の記録（世界ごと。前回の跡）
  let resultCard = null;
  let testMode = false;
  let runnerState = app.bridge.state;
  let failEl = null;
  let pendingBefore = [];
  let lastRunOpts = {};
  let graphs = null;
  let graphRec = null;
  const offs = [];
  let waitPct = null;
  const waitBar = createWaitBar(q('.run-sub').parentElement, {});
  q('.run-sub').after(waitBar.el);

  offs.push(app.bridge.onState((s) => {
    runnerState = s;
    updateRunButton();
    const sub = q('.run-sub');
    if (s.state === 'loading' && s.slow) sub.textContent = t('runner.slow', { pct: s.pct || 0 });
    else if (s.state === 'respawn') sub.textContent = t('runner.respawn', { pct: s.pct || 0 });
    else if (phase !== 'queued') sub.textContent = '';
    if (s.state === 'failed') {
      if (!failEl) { failEl = failCard(app, s.reason); q('.log').prepend(failEl); }
    } else if (failEl) { failEl.remove(); failEl = null; }
  }));

  function updateRunButton() {
    const btn = q('[data-a="run"]');
    const txt = q('.run-text');
    const needPredict = predictQs && !(pcard && pcard.complete()) && !(L.prediction && L.prediction.first && L.prediction.first.length);
    let label;
    let disabled = false;
    if (phase === 'queued') label = t('runner.queued_short');
    else if (phase === 'computing') label = t('runner.busy');
    else if (needPredict) { label = t('button.run_predict'); disabled = true; }
    else if (runnerState.state === 'loading' || runnerState.state === 'respawn') label = t('runner.loading', { pct: runnerState.pct || 0 });
    else if (runnerState.state === 'failed') { label = t('button.run'); disabled = true; }
    else label = t('button.run');
    txt.innerHTML = `${phase === 'idle' && !needPredict && runnerState.state === 'ready' ? '▶&#xFE0E; ' : ''}${esc(label)}`;
    btn.disabled = disabled;
    btn.classList.toggle('waiting', phase === 'queued' || runnerState.state === 'loading');
    // 待ち時間の細いバー（0.5 秒をこえた時だけ出る。ブラッシュアップ 15）
    if (waitBar) {
      if (phase === 'computing') waitBar.start(t(testMode ? 'wait.test' : 'wait.compute'), testMode ? waitPct : null);
      else if (phase === 'queued' && (runnerState.state === 'loading' || runnerState.state === 'respawn')) waitBar.start(t('wait.python', { pct: runnerState.pct || 0 }), runnerState.pct || 0);
      else waitBar.stop();
      if (phase === 'queued' && runnerState.state === 'loading') waitBar.set(runnerState.pct || 0, t('wait.python', { pct: runnerState.pct || 0 }));
    }
    btn.setAttribute('aria-label', phase === 'queued' ? t('runner.queued') : label);
    const stop = q('[data-a="stop"]');
    stop.disabled = !(phase === 'computing' || phase === 'replaying');
    const tb = q('[data-a="test"]');
    if (tb) tb.disabled = needPredict || runnerState.state === 'failed';
    const feats = progress.features();
    const tbx = q('[data-a="toolbox"]');
    tbx.hidden = !feats.toolbox;
    q('[data-a="sil"]').hidden = !feats.sil || isC;     // C のコードは SIL（Python）にそのまま書き出せない（直し C1）
  }
  updateRunButton();

  // 初めての 1-1: 実行ボタンの横に「ここを押してみて」（1 回目の実行で消える。2.2）
  if (L.attempts === 0 && id === '1-1') {
    q('.run-bubble').hidden = false;
    q('[data-a="run"]').classList.add('beckon');
  }
  // 小さい画面の最初のタブ（その面を初めて開いた時はミッション）
  setTab(L.attempts === 0 && matchesNarrow() ? 'mission' : 'code', false);

  // ---------------------------------------------------------------- ボタン
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    audio.unlock();
    if (a === 'run') onRun();
    else if (a === 'stop') onStop();
    else if (a === 'reset') onReset();
    else if (a === 'test') {
      // まだクリアしていない時は、本番テスト（何十回も走る）の代わりにふつうの実行をして、先にクリアするよう案内する（直し C2）
      if (!L.cleared) { app.toast(t('play.test_first_clear')); onRun({ testAsked: true }); }
      else onRun({ test: true });
    }
    else if (a === 'carry') onCarry();
    else if (a === 'history') onHistory();
    else if (a === 'toolbox') onToolbox();
    else if (a === 'sil') onSil();
    else if (a === 'palette') { const on = !q('.editor').classList.contains('pal-open'); q('.editor').classList.toggle('pal-open', on); b.setAttribute('aria-pressed', String(on)); }
  });
  // 境目を引いて欄の大きさを変える（左の欄｜右側・3D／エディタ・エディタ｜出力。900 px 以上だけ。直し A-4 を広げた。直し係 7）
  const layout = setupLayout(P, { t, getCM: () => { try { return editor && editor.getCM && editor.getCM(); } catch { return null; } } });
  offs.push(() => layout.destroy());
  app.playLayout = () => layout;               // テストと調べ物のため
  q('.ptabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab, true); });
  q('.ptabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = qa('.ptabs [role="tab"]').filter((x) => x.offsetParent !== null);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const nx = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    nx.focus();
    setTab(nx.dataset.tab, true);
    e.preventDefault();
  });
  q('.worldsw').addEventListener('click', (e) => { const b = e.target.closest('[data-world]'); if (b && lastResult) replayWorld(Number(b.dataset.world), { autoPlay: true }); });
  q('.senpai-run').addEventListener('click', () => runSenpaiGhost());
  // グラフは 3D に重ねず、出力の欄のタブ（出力 / グラフ）に出す（直し係 3 の 1）
  root.addEventListener('rc-graphs', (e) => {
    if (e.target && e.target.closest && e.target.closest('.graphs-host')) { setConsoleTab('log'); return; }
    openGraphs(!!(e.detail && e.detail.open));
  });
  q('.ctabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctab]');
    if (!b) return;
    if (b.dataset.ctab === 'graph') openGraphs(true); else setConsoleTab('log');
  });
  q('.ctabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const g = q('[data-ctab="graph"]');
    if (g.hidden) return;
    e.preventDefault();
    if (P.classList.contains('gr-open')) { setConsoleTab('log'); q('[data-ctab="log"]').focus(); } else { openGraphs(true); g.focus(); }
  });

  function matchesNarrow() { return !!(globalThis.matchMedia && matchMedia('(max-width: 899px)').matches); }
  function matchesPhone() { return !!(globalThis.matchMedia && matchMedia('(max-width: 599px)').matches); }
  function matchesWideTabs() { return !!(globalThis.matchMedia && matchMedia('(min-width: 600px) and (max-width: 1279px)').matches) || (matchesPhone() && P.dataset.tab !== 'view'); }
  /** 低い画面（高さ 820 px 以下）やせまい画面: クリアの札を最初からたたんで、3D を見えるように（直し係 3 の 1） */
  function matchesLow() { return matchesNarrow() || !!(globalThis.matchMedia && matchMedia('(max-height: 820px)').matches); }
  function setTab(name, focus) {
    // 600〜899 px には 3D のタブが無い（3D は上にいつも出る）。1280 px 未満の広い画面はコード／出力だけ
    P.dataset.tab = name;
    for (const b of qa('.ptabs [role="tab"]')) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (name === 'output') q('.out-dot').hidden = true;
    if (name === 'view') { q('.tab-dot:not(.out-dot)').hidden = true; try { scene.resize && scene.resize(); } catch { /* なし */ } }
    // 見えていなかったエディタは幅を測り直す（せまい画面で行の左が切れていた。直し C7）
    if (name === 'code') requestAnimationFrame(() => { try { const cm = editor && editor.getCM && editor.getCM(); if (cm) { cm.refresh(); cm.scrollTo(0, null); } } catch { /* なし */ } });
    if (focus && name === 'code') { try { editor.focus(); } catch { /* なし */ } }
  }

  // ---------------------------------------------------------------- 実行（2.4・2.2・7.4）
  function buildJob(code, mode) {
    const lim = { ...DEFAULT_LIMITS, ...(level.limits || {}) };
    const job = {
      levelId: id, chapter: chapterNo, lang: level.lang || 'python', code, mode,
      worlds: level.worlds.map((w) => ({ name: w.name, world: w.world, inject: w.inject || {}, judge: w.judge || {} })),
      conditions: { clear: level.clear || [], stars: level.stars || [], show: level.show || {}, steps: level.steps || [] },
      ui: { predictionOk: !!(L.prediction && L.prediction.ok), attempt: L.attemptsSinceReset + 1 },
      equipped: level.equipped || [],
      limits: lim,
      tailS: Number.isFinite(level.tail_s) ? level.tail_s : 3.0,
      keepFrames: mode === 'test' ? 'first_failed' : 'all',
      explain: level.explain || { goal: 'free', goalRadius: 1.0, expectTurn: null },
      varWatch: true,
      mistakes: level.mistakes || [],
    };
    if (mode === 'test' && level.test) job.testWorlds = level.test.worlds.map((w) => ({ name: w.name, world: w.world, inject: w.inject || {}, judge: w.judge || {} }));
    return job;
  }

  async function onRun(opts = {}) {
    if (phase === 'queued') {                               // もう一度押すと取り消し（2.2）
      app.bridge.cancelQueued();
      phase = 'idle';
      q('.run-sub').textContent = t('runner.cancelled');
      updateRunButton();
      return;
    }
    if (predictQs && !(L.prediction && L.prediction.first && L.prediction.first.length)) {
      setTab('mission', false);
      const f = q('.predict-card input:not(:disabled)');
      if (f) f.focus();
      app.toast(t('play.predict_need'));
      return;
    }
    if (runnerState.state === 'failed') return;
    const code = editor.getCode();
    if (!store.isReadOnly()) store.setCode(id, code);
    if (runnerState.state === 'ready' && phase !== 'computing' && await askBeforeRun(code)) return;
    if (phase === 'computing') { app.bridge.stop(); logLine(t('play.ide_change_mark'), 'note'); }
    stopReplay(false);
    clearResult();
    const my = ++runSeq;
    testMode = !!opts.test;
    lastRunOpts = opts;
    const job = buildJob(code, testMode ? 'test' : 'worlds');
    audio.play('run');
    q('.run-bubble').hidden = true;
    q('[data-a="run"]').classList.remove('beckon');
    if (zukanToast.length) { const s = zukanToast.splice(0); setTimeout(() => { if (root.isConnected) for (const x of s) app.toast(x); }, 1200); }
    if (matchesPhone()) setTab('view', false);              // 3.11: 実行を押したら 3D のタブへ
    let promise;
    if (runnerState.state !== 'ready') {
      phase = 'queued';
      q('.run-sub').textContent = t('runner.queued');
      updateRunButton();
      promise = app.bridge.queue(job, { onProgress });
    } else {
      phase = 'computing';
      updateRunButton();
      promise = app.bridge.run(job, { onProgress });
    }
    const t0 = performance.now();
    let rr;
    try {
      rr = await promise;
      if (phase === 'queued') phase = 'computing';
    } catch (e) {
      if (my !== runSeq) return;
      phase = 'idle';
      updateRunButton();
      if (e && e.cancelled) return;
      if (e && e.stopped) { logLine(t('play.stopped'), 'note'); return; }
      if (e && e.reason) return;                             // 読み込みの失敗（カードが出る）
      console.error(e);
      showCardInOutput({ id: 'FATAL', severity: 'error', title: t('play.fatal'), where: '', why: '', fix: '' });
      return;
    }
    if (my !== runSeq) return;
    q('.run-sub').textContent = '';
    if (!rr || rr.stopped) { phase = 'idle'; updateRunButton(); logLine(t(testMode ? 'play.test_stopped' : 'play.stopped'), 'note'); return; }
    handleResult(rr, code, performance.now() - t0);
  }

  function onProgress(p) {
    if (!testMode || !p) return;
    const pct = p.of ? Math.round(p.run / p.of * 100) : 0;
    waitPct = pct;
    if (waitBar) waitBar.set(pct);
    q('.run-sub').textContent = `${t('runner.progress_test', { run: p.run, of: p.of })}（${pct}%）`;
  }

  function onStop() {
    if (phase === 'computing') {
      app.bridge.stop();
      runSeq++;                                            // 届いた結果は捨てる
      phase = 'idle';
      updateRunButton();
      q('.run-sub').textContent = '';
      logLine(t(testMode ? 'play.test_stopped' : 'play.stopped'), 'note');
      return true;
    }
    if (phase === 'replaying') { stopReplay(true); return true; }
    return false;
  }

  async function onReset() {
    const ok = await confirmDialog(t('button.reset'), t('play.reset_confirm'));
    if (!ok) return;
    store.pushHistory(id, editor.getCode());
    editor.setCode(level.starter || '');
    store.resetAttempts(id);
    store.setCode(id, level.starter || '');
    app.toast(t('play.reset_done'));
    q('[data-a="reset"]').classList.remove('beckon');
  }

  // ---------------------------------------------------------------- 結果
  function handleResult(rr, code, ms) {
    // PC が混んでいて 1 回が実時間の安全の上限に来た: 判定も記録もしない（回数・★に数えない）。「もう一度」と出す（直し係 4）
    if (rr && rr.busy) {
      phase = 'idle';
      updateRunButton();
      logLine(t('play.busy'), 'note');
      q('.result-live').textContent = t('play.busy');
      app.toast(t('play.busy'));
      return;
    }
    lastResult = rr;
    const runs = rr.runs || [];
    const computed = !!(rr.compileError || runs.length);
    // 記録する（計算まで進んだ実行だけ。3.6 の attempt）
    const attemptNo = L.attemptsSinceReset + 1;
    const lines = countLines(code, level.lang);
    let outcome = null;
    const starsBefore = L.stars.slice();
    const clearsBefore = progress.totals().clears;
    let normalClear = !!(rr.judge && rr.judge.clear && rr.judge.clear.ok);
    if (testMode && rr.worldRuns) normalClear = !rr.testSkipped;
    if (computed && !store.isReadOnly()) {
      outcome = store.recordRun(id, rr, { code, level, attempt: attemptNo, predictionOk: !!(L.prediction && L.prediction.ok), mode: testMode && !rr.testSkipped ? 'test' : 'worlds', normalClear, lines });
    } else if (computed) {
      outcome = { clear: normalClear, firstClear: false, stars: L.stars.slice(), newStars: [false, false, false], capped: false };
    }
    predictShowNow = computed && predictFresh;
    if (computed) predictFresh = false;
    hints.onRun();
    renderHints();
    // クリアの時は、札の★が点くまでヘッダーの★と「クリア n/53」を前のままにする（ブラッシュアップ 4）
    if (outcome && outcome.clear && !reducedUi()) app.headerHold = { clears: clearsBefore, stars: starsBefore };
    else app.headerHold = null;
    app.header.set({ chapter: chapterLabel(ch), levelId: id, levelTitle: level.title, stars: app.headerHold ? starsBefore : L.stars });
    app.refreshHeader();
    if (predictQs && pcard) {
      pcard.reveal();
      if (editor.setReadOnly) editor.setReadOnly(false, '');
      const rn = root.querySelector('.ro-note'); if (rn) rn.remove();
    }
    // 出力: 実行の行
    const runS = (rr.stats && rr.stats.workerMs ? rr.stats.workerMs : ms) / 1000;
    // 本番テストの回は見出しも「▶ 本番テスト」（10-2 で「▶ 実行」のままだった。直し係 5）
    // 計算の時間と、ローバーが走った時間（最初に見せる世界の記録の長さ）を分けて書く（「実行（0.01 秒）」で初心者が混乱した。直し係 6）
    const calcS = runS < 1 ? runS.toFixed(2) : runS.toFixed(1);   // 数十 ms の計算が「0.0 秒」に見えないように
    const driveRuns = rr.runs || [];
    const dConds = (rr.judge && rr.judge.clear && rr.judge.clear.conds) || [];
    let dIdx = driveRuns.findIndex((_, i) => dConds.some((c) => Array.isArray(c.pass) && c.pass[i] === false));
    if (dIdx < 0) dIdx = 0;
    const dRun = driveRuns[dIdx];
    const driveT = dRun && dRun.final && Number.isFinite(dRun.final.t) ? dRun.final.t : null;
    { const cl = q('.curline'); if (cl && !cl.textContent) { cl.textContent = t('play.cur_line_none'); cl.classList.add('none'); } }   // 3D のタブの下の帯は、行が来るまで案内（直し係 6）
    if (driveT === null) logLine(t('play.run_line_calc', { s: calcS }), 'run');
    else logLine(t(testMode && !rr.testSkipped ? 'play.test_line' : 'play.run_line', { s: calcS, drive: driveT.toFixed(1) }), 'run');
    const beforeCards = (rr.before || []).map((c) => (c.confirm && confirmedCode === code ? { ...c, confirm: false } : c));
    if (testMode && rr.testSkipped) logLine(t('play.test_need_clear', { first: t('play.first_clear') }), 'note');
    if (lastRunOpts.testAsked) logLine(t('play.test_first_clear'), 'note');
    if (rr.compileError) {
      phase = 'idle';
      updateRunButton();
      const info = markInEditor(rr.compileError);
      showCardInOutput(rr.compileError, { primary: true, lockedNote: info && info.locked ? info.note : null });
      // 計算まで進まなかった回（書き方のエラー）は 3D に見る物が無いので、せまい画面でも［出力］のタブでカードを見せる（直し係 5）
      if (matchesPhone()) setTab('output', false);
      for (const c of agreeing(beforeCards, rr.compileError)) showCardInOutput(c);
      renderGoals(rr);
      announce(rr);
      showFailHead(rr);
      noteFailure(rr.compileError.id);
      return;
    }
    // 世界の切りかえ
    const worldRecs = testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : runs;
    renderWorldSwitch(worldRecs, rr);
    // 失敗した最初の世界（なければ世界 1）を再生（2.4 の 5）
    const passArr = clearPassArr(rr);
    let wi = passArr.findIndex((p) => p === false);
    if (wi < 0) wi = 0;
    renderGoals(rr);
    if (testMode && !rr.testSkipped) {
      testTable(q('.log'), app, { rr, level, onReplay: (i) => replayTestRun(i) });
    }
    const firstErr = runs.map((r) => r.error || r.guard).find(Boolean) || null;
    if (!firstErr) for (const c of beforeCards) showCardInOutput(c);       // エラーで止まった時は、エラーのカードの下に出す（finishRun）
    pendingBefore = firstErr ? beforeCards : [];
    phase = 'replaying';
    updateRunButton();
    replayWorld(wi, { autoPlay: true, onEnd: () => finishRun(rr, outcome, code, lines, wi) });
  }

  function clearPassArr(rr) {
    const conds = (rr.judge && rr.judge.clear && rr.judge.clear.conds) || [];
    const runs = (testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : rr.runs) || [];
    return runs.map((_, i) => conds.every((c) => !Array.isArray(c.pass) || c.pass[i] !== false));
  }

  function renderWorldSwitch(recs, rr) {
    const sw = q('.worldsw');
    if (!recs || recs.length <= 1) { sw.hidden = true; sw.innerHTML = ''; return; }
    const pass = clearPassArr(rr);
    sw.hidden = false;
    sw.innerHTML = recs.map((r, i) => `<button type="button" data-world="${i}" aria-pressed="false">${esc(pass[i] ? t('play.world_ok', { n: i + 1 }) : t('play.world_ng', { n: i + 1 }))}</button>`).join('');
  }

  function renderGoals(rr) {
    const j = rr && rr.judge;
    const ok = [null, null, null];
    const pass = [null, null, null];
    const measure = [null, null, null];
    const grey = [false, false, false];
    const note = [null, null, null];
    if (j) {
      const c = j.clear || {};
      ok[0] = !!c.ok;
      const conds = c.conds || [];
      if (conds.length) {
        const n = Math.max(...conds.map((x) => (Array.isArray(x.pass) ? x.pass.length : 0)));
        pass[0] = Array.from({ length: n }, (_, i) => conds.every((x) => !Array.isArray(x.pass) || x.pass[i] !== false));
      }
      (j.stars || []).forEach((s, i) => {
        const def = (level.stars || [])[i] || {};
        if (s && s.error) { grey[i + 1] = true; ok[i + 1] = null; return; }
        const byTest = s && (s.byTest || (Array.isArray(def.need) && def.need[0] === 'test'));
        if (byTest && !testMode) { ok[i + 1] = null; return; }
        // クリアできなかった実行では★に ✓ も世界ごとの ✓ も「いま 7 cm」も付けない。印は灰色で「クリアしたら数えるよ」（直し A-9・B10・直し係 3 の 6）
        if (!c.ok) { ok[i + 1] = null; note[i + 1] = t('play.star_after_clear'); return; }
        ok[i + 1] = !!(s && s.ok);
        pass[i + 1] = c.ok && s && Array.isArray(s.pass) ? s.pass : null;
        const mv = measureOf(s);
        if (mv !== null) measure[i + 1] = measureText(s, def);
        else if (def.measure === 'lines') measure[i + 1] = fmtMeasure(countLines(editor.getCode(), level.lang), 'lines');
      });
    }
    if (capped()) grey[2] = true;
    goals.set({ ok, pass, measure, grey, note });
    goals.setGot(L.stars);
    if (steps) steps.set(j && Array.isArray(j.steps) ? j.steps.map((s) => !!(s && (s.ok === true || s === true))) : null);
  }

  // 再生
  function replayWorld(wi, { autoPlay = true, onEnd = null, record = null, world = null } = {}) {
    const rr = lastResult;
    const recs = record ? [record] : (testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : rr.runs) || [];
    const rec = record || recs[wi];
    if (!rec) { if (onEnd) onEnd(); return; }
    lastWorldIdx = wi;
    for (const b of qa('.worldsw [data-world]')) b.setAttribute('aria-pressed', String(Number(b.dataset.world) === wi));
    stopReplay(false);
    curRecord = rec;
    printsShown = 0;
    clearPrints();
    const worldDef = world || (record ? null : (level.worlds[wi] && level.worlds[wi].world) || firstWorld);
    try {
      if (worldDef) scene.loadWorld(worldDef, venueOf(worldDef), { arrowLevel: level });
      scene.setRecord(rec.frames ? rec : null, { ghost: prevRecords[wi] && prevRecords[wi].frames ? prevRecords[wi] : null, senpaiGhost: senpaiGhosts[wi] || null });
      scene.setOverlays(overlayFlags());
    } catch (e) { console.warn(e); }
    const speed = replaySpeed();
    const Pl = deps.Player || SimplePlayer;
    try { player = new Pl(rec, { speed, lineByLine: speed === 'line' }); } catch (e) { console.warn(e); player = new SimplePlayer(rec, { speed }); }
    const tlHost = q('.tl-host');
    if (timeline) { try { timeline.destroy(); } catch { /* なし */ } timeline = null; }
    tlHost.innerHTML = '';
    if (deps.Timeline && !(player instanceof SimplePlayer)) {
      try { timeline = new deps.Timeline(tlHost, rec, level, player); } catch (e) { console.warn(e); timeline = null; tlHost.innerHTML = ''; }
    }
    if (!timeline) timeline = new SimpleTimeline(tlHost, rec, level, player);
    // グラフ（つまみの「グラフ」で開く。記録が変わったら作り直す。直し B1）
    if (graphs) { try { graphs.destroy(); } catch { /* なし */ } graphs = null; }
    graphRec = { rec, world: worldDef || firstWorld };
    q('[data-ctab="graph"]').hidden = false;
    if (P.classList.contains('gr-open')) openGraphs(true, false);
    const F = readFrames(rec);
    const w = worldDef || firstWorld;
    let lastDrive = -1;
    // ぶつかった・止まった時の音（ブラッシュアップ 13）
    const bumps = (rec.events || []).filter((e) => e && (e.k === 'cone_touch' || (e.k === 'contact' && e.what === 'cone'))).map((e) => e.t);
    let soundT = -1, wasMoving = false;
    audio.ambience(true);                                   // 芝の上の風と遠くの鳥（走る音のつまみで、とても小さく）
    player.on('time', (tt) => {
      try { scene.setTime(tt); } catch { /* なし */ }
      const pose = F.n ? poseAt(F, tt) : null;
      renderHud(pose, w, rec);
      showPrintsUpTo(rec, tt);
      if (pose && player && player.playing && Math.abs((pose.v || 0) - lastDrive) > 0.03) { lastDrive = pose.v || 0; audio.drive(lastDrive); }
      if (player && player.playing && soundT >= 0 && tt > soundT) {
        if (bumps.some((bt) => bt > soundT && bt <= tt)) audio.play('bump');
        const moving = !!pose && Math.abs(pose.v || 0) > 0.04;
        if (wasMoving && pose && Math.abs(pose.v || 0) < 0.005) { audio.play('stop'); wasMoving = false; }
        else if (moving) wasMoving = true;
      }
      soundT = tt;
    });
    player.on('line', (n) => {
      if (codeChangedSinceRun) return;                      // コードが変わったら行の印は出さない（2.4〔1.1〕）
      try { editor.setActiveLine(n || null); marksShown = true; } catch { /* なし */ }
      const lines = editor.getCode().split('\n');
      // 行が無い時（最後まで再生した後など）も空の濃い帯にしない（360 幅。直し係 6）
      q('.curline').textContent = n ? `${t('play.cur_line', { n })}  ${lines[n - 1] || ''}` : t('play.cur_line_none');
      q('.curline').classList.toggle('none', !n);
    });
    player.on('state', (st) => { if (st === false || st === 'paused' || st === 'ended') { audio.drive(0); lastDrive = -1; } });
    player.on('end', () => {
      audio.drive(0);
      showPrintsUpTo(rec, Infinity);
      if (!codeChangedSinceRun) { try { editor.setHits(rec.hits || null); } catch { /* なし */ } }
      if (onEnd) { const f = onEnd; onEnd = null; f(); }
    });
    codeChangedSinceRun = false;
    { const cl = q('.curline'); if (cl && !cl.textContent) { cl.textContent = t('play.cur_line_none'); cl.classList.add('none'); } }   // 記録を出したら、行が来るまで案内（直し係 6）
    try { editor.setVarSource((name) => varValue(name)); } catch { /* なし */ }
    renderHud(F.n ? poseAt(F, 0) : null, w, rec);
    if (autoPlay) {
      if (speed === 'result') player.toEnd(); else player.play();
    }
  }
  function graphKinds(rec) {
    const base = Array.isArray(level.graphs) && level.graphs.length ? level.graphs.slice() : ['speed'];
    const N = rec.events || [];
    const has = (k) => N.some((e) => e && e.k === k);
    const add = (k) => { if (!base.includes(k)) base.push(k); };
    add('motor');
    if (has('heading') || has('gnss') || has('camera')) add('aim');
    if (has('lidar')) add('lidar');
    if (has('heading')) add('heading');
    if (has('gnss') && (rec.gnssFixes || []).length) add('gnss');
    return base;
  }
  /** 出力の欄のタブ（'log' 出力 / 'graph' グラフ）。 */
  function setConsoleTab(name) {
    const g = name === 'graph';
    q('.log').hidden = g;
    q('.graphs-host').hidden = !g;
    P.classList.toggle('gr-open', g);
    for (const b of qa('.ctabs [data-ctab]')) {
      const on = b.dataset.ctab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const gb = q('.tl-graph'); if (gb) gb.setAttribute('aria-pressed', String(g));
  }
  function openGraphs(open, showPane = true) {
    const gh = q('.graphs-host');
    if (!open || !graphRec || !player) { setConsoleTab('log'); return; }
    if (!graphs) {
      const G = deps.Graphs;
      if (!G) { app.toast(t('play.graphs_none')); setConsoleTab('log'); return; }
      setConsoleTab('graph');
      try { graphs = new G(gh, graphRec.rec, graphKinds(graphRec.rec), player, graphRec.world); } catch (e) { console.warn(e); setConsoleTab('log'); return; }
    }
    setConsoleTab('graph');
    // 出力の欄がタブの画面（1280 px 未満）は出力のタブへ。600 px 未満で 3D を見ている時は 3D の下に出す（CSS の .gr-open）
    if (showPane && matchesWideTabs()) setTab('output', false);
    try { graphs.update(player.t || 0); } catch { /* なし */ }
  }
  function stopReplay(toEnd) {
    if (!player) return;
    if (toEnd) { try { player.toEnd(); } catch { /* なし */ } return; }
    try { player.destroy(); } catch { /* なし */ }
    player = null;
    audio.drive(0);
  }
  function replaySpeed() {
    const s = settings.replaySpeed;
    if (s === 'auto') return Number(chapterNo) <= 3 || chapterNo === 'C' ? 'line' : 1;
    if (s === 'line' || s === 'result') return s;
    return Number(s) || 1;
  }
  function renderHud(pose, w, rec) {
    const vals = hudValues(level.hud || ['time', 'speed'], pose, w, rec);
    q('.hud').innerHTML = vals.map(([k, v]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`).join('');
  }
  function clearPrints() { for (const el of qa('.log .pr')) el.remove(); }
  function showPrintsUpTo(rec, tt) {
    const ps = rec.prints || [];
    const log = q('.log');
    while (printsShown < ps.length && ps[printsShown][0] <= tt + 1e-9) {
      const [pt, line, text] = ps[printsShown];
      const d = document.createElement('div');
      d.className = 'pr';
      d.innerHTML = `<button type="button" class="pt" data-t="${pt}" aria-label="${pt.toFixed(1)} 秒へ">[${pt.toFixed(1)} s]</button> <span class="ptext">${printHTML(text)}</span>`;
      d.querySelector('.pt').addEventListener('click', () => { if (player) { player.pause(); player.seek(pt); } if (line && editor.gotoLine) editor.gotoLine(line); });
      log.appendChild(d);
      printsShown++;
    }
    if (tt === Infinity && rec.printDropped) logLine(`（print が多すぎたので ${rec.printDropped} 行を捨てたよ）`, 'note');
    log.scrollTop = log.scrollHeight;
  }

  // 再生が終わった後（2.4 の 6）
  const senpaiGhosts = [];
  function finishRun(rr, outcome, code, lines, wi) {
    phase = 'idle';
    updateRunButton();
    const recs = (testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : rr.runs) || [];
    prevRecords = recs.map((r) => r);
    const clear = outcome ? outcome.clear : !!(rr.judge && rr.judge.clear && rr.judge.clear.ok);
    // エラー・止めた理由・注意（最初に失敗した世界のもの。ほかの世界は世界の切りかえで）
    const bad = recs.findIndex((r) => r.error || r.guard);
    if (bad >= 0) {
      const r = recs[bad];
      const card = r.error || r.guard;
      const only = recs.length > 1 && recs.filter((x) => (x.error || x.guard) && (x.error || x.guard).id === card.id).length < recs.length;
      const info = r.error ? markInEditor(r.error) : null;
      const where = recs.map((x, i) => ((x.error || x.guard) && (x.error || x.guard).id === card.id ? i + 1 : 0)).filter(Boolean);
      showCardInOutput(card, { primary: true, worldNote: only ? `（世界 ${where.join('・')} で起きたよ）` : null, lockedNote: info && info.locked ? info.note : null });
      if (r.error) q('.tab-dot:not(.out-dot)').hidden = !matchesPhone();
      for (const c of agreeing(pendingBefore, card)) showCardInOutput(c);
    }
    pendingBefore = [];
    // 同じ注意が世界の数だけ並ばないよう 1 枚にまとめる（「世界 1・2・3 で」。直し B17）
    const warnMap = new Map();
    recs.forEach((r, i) => { for (const w of r.warnings || []) { const c = w.card || w; const k = `${c.id}:${c.line || ''}`; if (!warnMap.has(k)) warnMap.set(k, { c, worlds: [] }); warnMap.get(k).worlds.push(i + 1); } });
    for (const { c, worlds } of warnMap.values()) showCardInOutput(c, { worldNote: recs.length > 1 && worlds.length > 1 ? `（世界 ${worlds.join('・')} で）` : recs.length > 1 ? `（世界 ${worlds[0]} で）` : null });
    renderGoals(rr);
    announce(rr);
    showFailHead(rr);
    if (clear && editor.setUnlockable) { try { editor.setUnlockable(true); } catch { /* なし */ } }   // クリア後は鍵を外せる（W6 ④）
    if (clear && !testMode) {
      showResultCard(rr, outcome, code, lines);
      q('.senpai-run').hidden = !(level.solution) || usingFallbackScene;
    } else if (!clear) {
      // 先輩のひとこと（数字入り）・通り過ぎた時の首かしげ
      const hs = bad >= 0 && recs[bad].error ? [] : (rr.senpai || []);   // エラーで止まった時はエラーのカードだけ（「1 cm も動かなかった」を重ねない）
      for (const h of hs.slice(0, 2)) { q('.log').appendChild(tipEl(h.say, 'think')); }
      if (hs.length) audio.play('note');
      if (hs.some((h) => /OVERSHOOT/.test(h.id || ''))) { try { scene.celebrate('tilt'); } catch { /* なし */ } }
      // 先輩のひとことが何も無い時だけ、決まり文句を 1 つ（旗の面は「旗に届かなかった」）。
      // 「最初から」は勧めない（直したコードまで消えてしまう。直し A-1）
      if (!hs.length && !rr.compileError && bad < 0) {
        const flags = ((firstWorld && firstWorld.objects) || []).some((o) => o && o.type === 'flag');
        q('.log').appendChild(tipEl(t(flags ? 'senpai.broke_code' : 'senpai.fail_generic'), 'think'));
      }
      noteFailure(failIdOf(rr));
    } else {
      noteFailure(null);
    }
    if (testMode && clear) {
      if (rr.testSkipped) logLine(t('play.first_clear'), 'note');
      else if (outcome && outcome.newStars.some(Boolean)) showResultCard(rr, outcome, code, lines);
    }
    if (outcome && (outcome.firstClear || outcome.newStars.some(Boolean))) showRetry();
    const lg = q('.log');
    lg.scrollTop = lg.scrollHeight;
  }

  /** 止まったエラーと食いちがう実行前の注意を外す（「speed にそろえよう」と「SPEED のことかな？」が並んだ。直し A-6） */
  function agreeing(cards, primary) {
    if (!primary) return cards;
    const nameish = (c) => /NAME|CASE/.test(String(c && c.id || ''));
    return cards.filter((c) => c && c.id !== primary.id && !(nameish(primary) && nameish(c)));
  }

  function failIdOf(rr) {
    for (const r of rr.runs || []) { if (r.error) return r.error.id; if (r.guard) return r.guard.id; }
    const h = (rr.senpai || [])[0];
    return h ? h.id : 'FAIL';
  }
  function noteFailure(fid) {
    if (hints.noteResult(fid)) {
      senpai.say(t('senpai.hint_nudge'), 'think');
      audio.play('note');
      q('.hint-btn').classList.add('beckon');
    }
  }

  /** 1 つの世界の結果の文（読み上げ・せまい画面の失敗の見出しで共通。画面の見出しと同じ judge の show.byWorld を使う。直し係 4） */
  function worldWhy(rr, r, i) {
    const H = headline(level, rr.judge && rr.judge.show);
    const showW = rr.judge && rr.judge.show ? rr.judge.show.world : 0;
    const m = (r && r.metrics) || {};
    // 世界ごとの見出しは judge.py が同じ規則（ぶつかった・そっとタッチ・通りすぎた・手前で止まった・1 cm も動かなかった）で作る。
    // 本番テストの時も、ふつうの世界（worldRuns）の判定の byWorld なので同じものを使う
    const bw = rr.judge && rr.judge.show && Array.isArray(rr.judge.show.byWorld) ? rr.judge.show.byWorld[i] : null;
    const own = bw || (i === showW && H.text ? H.text : isMeasured(m['gap:cone']) && /gap\(/.test(String((level.show && level.show.expr) || '')) ? t('play.world_gap', { v: fmtCm(m['gap:cone']) }) : isMeasured(m.t_stop) && m.t_stop > 0.05 ? t('play.world_time', { s: m.t_stop.toFixed(1) }) : '');
    if (!r) return own;
    return r.error ? r.error.title : r.guard ? r.guard.title : r.end === 'timeup' ? t('play.time_up') : own;
  }

  function announce(rr) {
    const recs = (testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : rr.runs) || [];
    const pass = clearPassArr(rr);
    let text;
    if (rr.compileError) text = `${t('play.summary_fail')}: ${rr.compileError.title}`;
    else {
      text = recs.map((r, i) => t('play.summary_line', { world: t('play.world', { n: i + 1 }), mark: pass[i] ? '✓' : '✗', text: worldWhy(rr, r, i) })).join('／');
      text = `${rr.judge && rr.judge.clear && rr.judge.clear.ok ? t('play.summary_clear') : t('play.summary_fail')}。${text}`;
    }
    q('.result-live').textContent = text;
  }

  /** せまい画面（900 px 未満）では 3D の上にクリアの札が出ないので、失敗の時は 3D の下に見出しを 1 行と［出力］のタブに印（直し係 4） */
  function showFailHead(rr) {
    const el = q('.fail-head');
    if (!el) return;
    let text = '';
    if (rr.compileError) text = rr.compileError.title;
    else if (!(rr.judge && rr.judge.clear && rr.judge.clear.ok)) {
      const recs = (testMode && rr.worldRuns && !rr.testSkipped ? rr.worldRuns : rr.runs) || [];
      const pass = clearPassArr(rr);
      let wi = recs.findIndex((r) => r.error || r.guard);
      if (wi < 0) wi = pass.findIndex((p) => p === false);
      if (wi < 0) wi = 0;
      const why = worldWhy(rr, recs[wi], wi) || t('play.summary_fail');
      text = recs.length > 1 ? `${t('play.world', { n: wi + 1 })}: ${why}` : why;
    }
    el.hidden = !text;
    el.querySelector('.fh-text').textContent = text;
    const dot = q('.out-dot');
    if (dot) dot.hidden = !text || !matchesNarrow() || P.dataset.tab === 'output';
  }

  /** エディタにカードの下線を引く（W6）。鍵の行なら { locked, note } が返る。 */
  function markInEditor(card) {
    try { const info = editor.showCard(card); marksShown = true; return info || null; } catch { return null; }
  }
  /** その行へ（W6 のエディタは CodeMirror を直接動かす）。 */
  function gotoLine(ln, col) {
    if (!ln) return;
    if (editor.gotoLine) { editor.gotoLine(ln, col); return; }
    const cm = editor.getCM && editor.getCM();
    if (!cm) return;
    setTab('code', false);
    cm.setCursor({ line: ln - 1, ch: Math.max(0, (col || 1) - 1) });
    cm.scrollIntoView({ line: ln - 1, ch: 0 }, 60);
    cm.focus();
  }
  function showCardInOutput(card, o = {}) {
    if (!card) return null;
    if (o.primary) setConsoleTab('log');             // エラーのカードはグラフのタブの裏にかくさない
    if (o.primary && (card.severity === 'error' || !card.severity || card.fix)) { errHint = { title: card.title, fix: card.fix, shown: false }; renderHints(); }
    let c = null;
    const common = { chapter: chapterNo, rawMode: settings.rawError, onQuickfix: (rid) => quickfix(rid), onLine: (ln, col) => gotoLine(ln, col), worldNote: o.worldNote || null };
    if (deps.createErrorCard) {
      try {
        c = deps.createErrorCard(card, {
          ...common, rules: rules || undefined,
          onZukan: (zid) => app.go(`#/zukan/${encodeURIComponent(zid)}`),
          locked: level.locked && level.locked.length ? level.locked : undefined,
          lockedNote: o.lockedNote || null,
          onLockedError: () => { try { editor.flashBlanks && editor.flashBlanks(); } catch { /* なし */ } },
          onConfirm: o.onConfirm || ((choice) => { if (choice === 'fix') gotoLine(card.line, card.col); }),
          reduceMotion: settings.reduceMotion || !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
          sound: o.primary || o.onConfirm ? (n) => audio.play(n) : false,      // 音は止まったエラーと「聞く」カードだけ（注意が並んでも鳴りすぎない）
        });
      } catch (e) { console.warn('W3 のカードを作れなかった（代わりを使う）', e); c = null; }
    }
    if (!c) {
      c = createFallbackCard(card, common);
      if (o.primary && (card.severity === 'error' || !card.severity)) audio.play('error');   // 本物のカードは自分で音を鳴らす
    }
    q('.log').appendChild(c.el);
    if (o.onConfirm && card.confirm && c.open) { try { c.open(3); } catch { /* なし */ } }   // 「このまま実行／直す」をすぐ見せる
    return c;
  }
  /** wait(2000) など「このまま実行／直す」を聞く注意（9.1 の ③）。聞いた時は true（実行しない）。 */
  let confirmedCode = null;
  async function askBeforeRun(code) {
    if (confirmedCode === code || !app.bridge.precheck) return false;
    let items = [];
    try { items = await withTimeout(app.bridge.precheck(code, level.lang || 'python', chapterNo), 3000); } catch { return false; }
    const card = (items || []).find((x) => x && x.confirm);
    if (!card) return false;
    clearResult();
    const info = markInEditor(card);
    showCardInOutput(card, {
      primary: true,
      lockedNote: info && info.locked ? info.note : null,
      onConfirm: (choice) => {
        if (choice === 'run') { confirmedCode = code; onRun(); }
        else gotoLine(card.line, card.col);
      },
    });
    if (matchesPhone()) setTab('output', false);
    return true;
  }
  async function quickfix(ruleId) {
    const fixed = await app.bridge.quickfix(editor.getCode(), ruleId);
    if (typeof fixed === 'string') { editor.setCode(fixed); app.toast(t('toast.saved')); }
  }

  function logLine(text, kind = '') {
    const d = document.createElement('div');
    d.className = `ll ${kind}`;
    d.textContent = text;
    q('.log').appendChild(d);
    return d;
  }
  /** 止めていたヘッダーの★と「クリア n/53」を今の記録に合わせる。 */
  function releaseHeader() {
    if (!app.headerHold) return;
    app.headerHold = null;
    app.header.set({ chapter: chapterLabel(ch), levelId: id, levelTitle: level.title, stars: L.stars });
    app.refreshHeader();
  }
  /** クリアの札の★ i が点いた時: ヘッダーの★ i も同時に点け、最初の★で「クリア n/53」も進める。 */
  function litHeaderStar(i) {
    const h = app.headerHold;
    if (!h) return;
    h.stars[i] = !!L.stars[i] || h.stars[i];
    h.clears = NaN;
    app.header.set({ chapter: chapterLabel(ch), levelId: id, levelTitle: level.title, stars: h.stars });
    app.refreshHeader();
    if (h.stars.every((v, k) => v === !!L.stars[k])) releaseHeader();
  }
  function reducedUi() { return document.documentElement.classList.contains('reduce-motion'); }
  function clearResult() {
    releaseHeader();
    if (errHint) { errHint = null; renderHints(); }
    const sr = q('.senpai-run');
    if (sr && !sr.parentElement.classList.contains('view')) q('.result-slot').before(sr);
    if (resultCard) { resultCard.destroy(); resultCard = null; }
    q('.result-slot').innerHTML = '';
    const sheet = document.querySelector('.clear-card.sheet');
    if (sheet) sheet.remove();
    q('.log').innerHTML = '';
    if (failEl) q('.log').appendChild(failEl);
    q('.result-live').textContent = '';
    { const fh = q('.fail-head'); if (fh) fh.hidden = true; const od = q('.out-dot'); if (od) od.hidden = true; }
    q('.senpai-run').hidden = true;
    try { editor.clearMarks(); } catch { /* なし */ }
    marksShown = false;
  }

  // クリアのカード（3.5）
  function showResultCard(rr, outcome, code, lines) {
    const wr = (testMode && rr.worldRuns ? rr.worldRuns : rr.runs) || [];
    const m = (wr[0] && wr[0].metrics) || {};
    const ref = level.reference && level.reference.worlds && level.reference.worlds[0];
    // 比べるのは、その面で意味のある値だけ（コーンへ寄せる面のすき間・走った時間。回るだけの面で「300 cm・0.0 秒」と出ていた。直し A-18・B14）
    const gapMatters = /gap\(/.test(String((level.show && level.show.expr) || '')) || (level.explain && level.explain.goal === 'stop_at_cone');
    const tOk = (v) => isMeasured(v) && v > 0.05;
    const you = { gap: !gapMatters ? null : isMeasured(m['gap:cone']) ? m['gap:cone'] : isMeasured(m.gap) ? m.gap : null, t: tOk(m.t_stop) ? m.t_stop : null, lines };
    const sen = ref ? { gap: gapMatters && isMeasured(ref.gap) ? ref.gap : null, t: tOk(ref.t_stop) ? ref.t_stop : null, lines: Number.isFinite(ref.lines) ? ref.lines : countLines(level.solution || '', level.lang) } : null;
    // 次の★のひとこと（取れていない★の 1 つ目。答えは書かない）
    let nextTip = null;
    for (let i = 1; i <= 2; i++) {
      if (L.stars[i]) continue;
      const def = (level.stars || [])[i - 1];
      if (!def) continue;
      // 一度きりの★（予想・1 回目でクリア）は、もう取れないので助言を出さない（直し A-8）
      if (oneShots.includes(i) && !progress.canRetryOneShot(id) && L.attemptsSinceReset > 1) continue;
      if (oneShots.includes(i) && /prediction_ok|attempt/.test(String(def.expr || ''))) continue;
      const js = rr.judge && rr.judge.stars && rr.judge.stars[i - 1];
      const mv = measureOf(js);
      nextTip = { n: i + 1, label: def.label, now: mv !== null ? measureText(js, def) : def.measure === 'lines' ? fmtMeasure(lines, 'lines') : null, tip: starTip(def, wr[0], (level.worlds[0] || {}).world) };
      break;
    }
    let chapterClear = outcome && outcome.firstClear && progress.completesChapter(id)
      ? (String(chapterNo) === 'C' ? { no: 'C', title: null, badge: progress.title().badgeName } : { no: chapterNo, title: progress.titleAfter(chapterNo) })
      : null;
    if (chapterClear) {
      const cp = progress.chapterProgress(chapterNo);
      // 最後の章（10 章）とおまけ C には「次の章」が無いので、言葉を差しかえる（直し係 3 の 3）
      // 次の章の中身に合わせた言葉（全章同じ「もう少し本物の機体に近づくよ」だった。直し係 4）
      const perCh = `result.chapter_say_${chapterNo}`;
      const sayKey = String(chapterNo) === 'C' ? 'result.chapter_say_c' : progress.chapterByNo(Number(chapterNo) + 1) ? (t(perCh) !== perCh ? perCh : 'result.chapter_say') : 'result.chapter_say_last';
      chapterClear = { ...chapterClear, starsGot: cp.stars, starsMax: cp.total * 3, say: t(sayKey) };
    }
    // 「全レベルクリア」の言葉は、本当に全部クリアした時だけ（10-3 で残りがあっても出ていた。直し C4）
    let senpaiClear = level.senpai_clear || '';
    if (/全レベル|ぜんぶクリア|全部クリア/.test(senpaiClear)) {
      const left = progress.mainLevels().filter((x) => !(store.hasLevel(x) && store.level(x).cleared));
      if (left.length) senpaiClear = t('result.not_all_yet', { n: left.length });
    }
    const sheet = matchesNarrow();
    const host = sheet ? root : q('.result-slot');
    const got = outcome && outcome.got ? outcome.got : [true, false, false];
    const predictRes = predictQs && L.prediction && predictShowNow ? { right: !!L.prediction.ok } : null;
    resultCard = showClear(host, app, {
      level, outcome, got, predict: predictRes, show: rr.judge && rr.judge.show, compare: { you, senpai: sen }, nextTip, chapterClear,
      exportNudge: !!chapterClear && store.exportNudgeDue(), sheet, senpaiClear, compact: matchesLow(),
      onCelebrate: (k) => { try { scene.celebrate(k); } catch { /* なし */ } },
      onStarLit: (i) => litHeaderStar(i),
      onDone: () => releaseHeader(),
      onNext: () => goNext(chapterClear),
      onAgain: () => { clearResult(); try { editor.focus(); } catch { /* なし */ } setTab('code', true); },
      onMap: () => app.go('#/map'),
      onExport: () => app.exportRecord(),
    });
    // 「先輩の走りを重ねる」はクリアの札の中に（札に半分かくれていた。直し C15）
    const acts = resultCard && resultCard.el && resultCard.el.querySelector('.cc-actions');
    if (acts) acts.appendChild(q('.senpai-run'));
  }
  /**
   * ★の助言を結果で出し分ける（面データの stars[].tips: {short, over, touch}。無ければ tip。直し係 2 の (1)）。
   * 目標（explain.target か最初のコーン）へ向かう向きで、止まった所が目標の手前か先かを見る。
   */
  function starTip(def, rec, world) {
    const tips = def && def.tips;
    if (!tips || !rec) return (def && def.tip) || null;
    const objs = (world && world.objects) || [];
    const tgt = objs.find((o) => o.id === (level.explain && level.explain.target)) || objs.find((o) => o.type === 'cone') || objs.find((o) => o.type === 'flag');
    const f = rec.final || {};
    const F = readFrames(rec);
    const end = F.n ? poseAt(F, Infinity) : null;
    const x = Number.isFinite(f.x) ? f.x : end && end.x, y = Number.isFinite(f.y) ? f.y : end && end.y;
    const touched = (rec.events || []).some((e) => e && (e.k === 'cone_touch' || (e.k === 'contact' && e.what === 'cone')));
    if (touched && tips.touch) return tips.touch;
    if (!tgt || !Number.isFinite(x) || !Number.isFinite(y)) return def.tip || null;
    const st = (world && world.start) || { x: 0, y: 0 };
    const dx = tgt.x - (st.x || 0), dy = tgt.y - (st.y || 0);
    const d = Math.hypot(dx, dy) || 1;
    const along = ((x - (st.x || 0)) * dx + (y - (st.y || 0)) * dy) / d;
    const front = tgt.type === 'cone' || tgt.type === 'rock' ? d - (tgt.r || 0.19) - 0.12 : d;
    const kind = along > front ? 'over' : 'short';
    return tips[kind] || (touched ? tips.over : null) || def.tip || null;
  }
  /**
   * 次へ: 章の最後の面で、その章の場面をまだ見ていなければ場面へ（本番テストでクリアした時も。初クリアの実行に限らない）。
   * 10 章の場面を見たあと、全部の面をクリアしていてエンディングをまだ見ていなければエンディングへ（直し係 3 の 2）。
   */
  function goNext(chapterClear) {
    const no = String(chapterNo);
    const lastOfChapter = no !== 'C' && progress.completesChapter(id) && progress.isChapterCleared(chapterNo);
    if (lastOfChapter && (chapterClear || !store.storySeen(no))) { app.go(`#/story/${encodeURIComponent(no)}`); return; }
    if (lastOfChapter && no === '10' && !store.storySeen('ending') && progress.mainLevels().every((x) => store.hasLevel(x) && store.level(x).cleared)) { app.go('#/ending'); return; }
    const nx = progress.nextLevel(id);
    if (nx && progress.isUnlocked(nx)) app.go(`#/play/${encodeURIComponent(nx)}`);
    else app.go('#/map');
  }

  // 本番テストの ✗ の回を再生（同じ種なので同じ結果。frames が無ければ走らせ直す）
  async function replayTestRun(i) {
    const r = lastResult && lastResult.runs && lastResult.runs[i];
    if (!r) return;
    const tw = level.test && level.test.worlds[i];
    if (r.frames) { replayWorld(i, { record: r, autoPlay: true, world: tw ? tw.world : null }); return; }
    if (!tw) return;
    const job = buildJob(editor.getCode(), 'worlds');
    job.worlds = [{ name: tw.name, world: tw.world, inject: tw.inject || {}, judge: tw.judge || {}, seed: r.seed }];
    try {
      const rr = await app.bridge.run(job, {});
      if (rr && rr.runs && rr.runs[0]) {
        replayWorld(0, { record: rr.runs[0], autoPlay: true, world: tw.world });
      }
    } catch (e) { console.warn(e); }
  }

  // 先輩の走りを重ねる（クリア後）
  async function runSenpaiGhost() {
    if (!level.solution) return;
    const job = buildJob(level.solution, 'worlds');
    job.varWatch = false;
    try {
      const rr = await app.bridge.run(job, {});
      (rr.runs || []).forEach((r, i) => { senpaiGhosts[i] = r; });
      if (curRecord) { try { scene.setRecord(curRecord, { ghost: null, senpaiGhost: senpaiGhosts[lastWorldIdx] || null }); scene.setOverlays({ ...overlayFlags(), ghost: true }); } catch { /* なし */ } }
    } catch (e) { console.warn(e); }
  }

  // 変数にマウスを乗せた時の値（「d = 1.84（3.2 s）」）
  function varValue(name) {
    const rec = curRecord;
    if (!rec || !player || codeChangedSinceRun) return null;
    const tt = player.t !== undefined ? player.t : 0;
    const vl = rec.varLog || [];
    const times = (rec.lineLog && rec.lineLog[1]) || [];
    let last = null;
    for (const [li, nm, disp] of vl) {
      if (nm !== name) continue;
      const at = times[li];
      if (at === undefined || at > tt + 1e-9) break;
      last = [disp, at];
    }
    return last ? `${name} = ${last[0]}（${Number(last[1]).toFixed(1)} s）` : null;
  }

  // ---------------------------------------------------------------- 持ってくる・履歴・道具箱・SIL
  async function onCarry() {
    const from = Array.isArray(level.carry_from) ? level.carry_from : [level.carry_from];
    const src = from.find((f) => store.clearedCode(f));
    if (!src) { app.toast(t('play.carry_none', { from: from.join('・') })); return; }
    const ok = await confirmDialog(t('button.carry'), t('play.carry_confirm', { from: src }));
    if (!ok) return;
    store.pushHistory(id, editor.getCode());
    editor.setCode(store.clearedCode(src));
    app.toast(t('play.carry_done', { from: src }));
  }

  async function onHistory() {
    const hs = (store.level(id).history || []).slice();
    const cc = store.clearedCode(id);
    const items = [];
    if (cc) items.push({ label: t('play.history_cleared'), code: cc, kind: 'cleared' });
    hs.forEach((c, i) => items.push({ label: t('play.history_item', { n: i + 1 }), code: c, kind: 'run' }));
    const restore = (code) => {
      const before = editor.getCode();
      if (editor.restoreCode) editor.restoreCode(code); else editor.setCode(code);
      store.pushHistory(id, before);                    // 戻す前の今のコードも履歴に残す（3.4）
      app.toast(t('play.history_restored'));
    };
    const box = document.createElement('div');
    if (deps.createHistoryPanel && !editor.fallback) {
      let panel = null;
      await app.openDialog({ title: t('play.history_title'), body: box, wide: true,
        onOpen: () => { panel = deps.createHistoryPanel(box, { entries: items, current: () => editor.getCode(), onRestore: (code) => { app.closeDialog('r'); restore(code); } }); },
        actions: [{ label: t('button.close'), value: 'c', primary: true }] });
      if (panel) panel.destroy();
      return;
    }
    box.className = 'hist';
    if (!items.length) { box.textContent = t('play.history_empty'); }
    else {
      box.innerHTML = `<div class="hist-list" role="listbox" aria-label="${esc(t('play.history_title'))}">${items.map((it, i) => `<button type="button" role="option" class="hist-item" data-i="${i}" aria-selected="${i === 0}">${esc(it.label)}<small>${esc(String(countLines(it.code, level.lang)))} 行</small></button>`).join('')}</div><pre class="hist-pre"></pre>`;
      const pre = box.querySelector('.hist-pre');
      const pick = (i) => { box.dataset.sel = String(i); pre.textContent = items[i].code; for (const b of box.querySelectorAll('.hist-item')) b.setAttribute('aria-selected', String(Number(b.dataset.i) === i)); };
      box.addEventListener('click', (e) => { const b = e.target.closest('.hist-item'); if (b) pick(Number(b.dataset.i)); });
      pick(0);
    }
    const v = await app.openDialog({ title: t('play.history_title'), body: box, wide: true, actions: items.length ? [{ label: t('button.close'), value: 'c' }, { label: t('button.restore'), value: 'r', primary: true }] : [{ label: t('button.close'), value: 'c', primary: true }] });
    if (v === 'r' && items.length) restore(items[Number(box.dataset.sel || 0)].code);
  }

  async function onToolbox() {
    if (!progress.features().toolbox) { app.toast(t('play.toolbox_locked')); return; }
    const box = document.createElement('div');
    box.className = 'toolbox';
    box.textContent = t('play.toolbox_loading');
    let panel = null;
    const dlg = app.openDialog({ title: t('play.toolbox_title'), body: box, wide: true, actions: [{ label: t('button.close'), value: 'c', primary: true }] });
    const extract = (c) => app.bridge.extractDefs(c).then((x) => x || []);
    const order = progress.levelOrder();
    const mine = (await store.toolbox({ extractDefs: extract, order })).filter((f) => !f.kind || f.kind === 'def')
      .map((f) => ({ name: f.name, levelId: f.levelId, src: f.code, code: store.clearedCode(f.levelId) || '', needs: f.needs || [], lines: f.lines }));
    // 先輩の版（クリアした面の答え。答えはクリアした面なので見てよい。3.4）
    const senpaiVer = [];
    for (const lid of order) {
      if (!store.hasLevel(lid) || !store.level(lid).cleared) continue;
      const lv = await app.level(lid);
      if (!lv || !lv.solution || !/\bdef\s/.test(lv.solution)) continue;
      for (const f of await extract(lv.solution)) if (!f.kind || f.kind === 'def') senpaiVer.push({ name: f.name, levelId: lid, src: f.src, code: lv.solution, needs: f.needs || [], lines: f.lines, senpai: true });
    }
    const all = [...mine, ...senpaiVer];
    box.textContent = '';
    if (!all.length) { box.textContent = t('play.toolbox_empty'); await dlg; return; }
    const intro = document.createElement('p');
    intro.textContent = t('play.toolbox_intro');
    box.appendChild(intro);
    const insert = async (item) => {
      app.closeDialog('c');
      if (editor.insertToolbox) {
        const r = await editor.insertToolbox(item, { confirm: (name) => confirmDialog(t('play.toolbox_title'), t('play.toolbox_replace', { name }), { ok: t('button.replace'), cancel: t('button.keep') }) });
        if (r && r.ok) app.toast(t('play.toolbox_added', { name: item.name }));
        return;
      }
      const code = editor.getCode();
      if (new RegExp(`^def\\s+${item.name}\\s*\\(`, 'm').test(code)) {
        const ok = await confirmDialog(t('play.toolbox_title'), t('play.toolbox_replace', { name: item.name }), { ok: t('button.replace'), cancel: t('button.keep') });
        if (!ok) return;
      }
      const ex = item.needs.length ? await extract(item.code) : [];
      const needsSrc = ex.filter((x) => item.needs.includes(x.name) && x.kind && x.kind !== 'def').map((x) => x.src);
      editor.setCode(insertToolbox(code, item.name, item.src, needsSrc));
      app.toast(t('play.toolbox_added', { name: item.name }));
    };
    if (deps.createToolboxPanel) {
      const host = document.createElement('div');
      box.appendChild(host);
      panel = deps.createToolboxPanel(host, { items: all, order: (lid) => order.indexOf(lid), onInsert: insert });
    } else {
      const seen = new Set();
      const ul = document.createElement('ul');
      ul.className = 'tb-list';
      ul.innerHTML = all.map((f, i) => {
        const key = `${f.senpai ? 's' : 'm'}:${f.name}`;
        const old = seen.has(key);
        seen.add(key);
        return `<li><button type="button" class="btn small" data-i="${i}">${icon('plus')}<span><code>${esc(f.name)}()</code> ${esc(t('play.toolbox_item', { level: f.levelId, lines: f.lines || '?' }))}${f.senpai ? ` <span class="tag">${esc(t('play.toolbox_senpai'))}</span>` : ''}${old ? ` <span class="tag old">${esc(t('play.toolbox_old'))}</span>` : ''}</span></button></li>`;
      }).join('');
      ul.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) insert(all[Number(b.dataset.i)]); });
      box.appendChild(ul);
    }
    await dlg;
    if (panel) panel.destroy();
  }

  async function onSil() {
    if (!progress.features().sil) { app.toast(t('play.export_sil_locked')); return; }
    if (isC) { app.toast(t('play.export_sil_c')); return; }
    const code = editor.getCode();
    const inject = (level.worlds[0] && level.worlds[0].inject) || {};
    let file;
    if (deps.buildSilPy) {
      try { file = deps.buildSilPy({ levelId: id, title: level.title, code, inject, date: new Date() }); } catch (e) { console.warn(e); }
    }
    if (!file) {
      const injectLines = Object.entries(inject).map(([k, v]) => `${k} = ${JSON.stringify(v)}   # 要確認: ゲームの世界 1 の値`);
      file = { filename: `rover_${id}.py`, text: `# ROVER CODE ${id} ${level.title} から書き出し\n# 使い方: CanSatSim で「SIL を開始」してから  python rover_${id}.py\nfrom rover_sil import *\n${injectLines.join('\n')}\n# ---- ここから自分のコード（ゲームのまま）\n${code}\nfinish()\n`, notes: [] };
    }
    const notes = document.createElement('div');
    notes.innerHTML = `<p><code>${esc(file.filename)}</code></p>${(file.notes || []).length ? `<ul>${file.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
    const v = await app.openDialog({ title: t('button.export_sil'), body: notes, actions: [{ label: t('button.cancel'), value: 'c' }, { label: t('button.export'), value: 'ok', primary: true }] });
    if (v !== 'ok') return;
    if (deps.downloadSilPy) { try { deps.downloadSilPy(file); } catch { app.downloadText(file.filename, file.text, 'text/x-python'); } }
    else app.downloadText(file.filename, file.text, 'text/x-python');
    app.toast(t('play.export_sil_done', { file: file.filename }));
  }

  // ---------------------------------------------------------------- キー操作（3.1）
  app.keyHandler = (e, ctx) => {
    if (e.key === 'Escape') return onStop();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { onRun(); return true; }
    if (!ctx.free || !player) return false;
    if (e.key === ' ') { player.toggle(); return true; }
    if (e.key === '[' || e.key === ']') { player.nudge(e.key === ']' ? 1 : -1); return true; }
    if (e.key === '{' || e.key === '}') { player.step(e.key === '}' ? 1 : -1); return true; }
    return false;
  };

  // 別のタブ（見るだけ）
  const roBanner = q('.ro-banner');
  roBanner.hidden = !store.isReadOnly();
  offs.push(store.on('readonly', () => { roBanner.hidden = false; }));
  offs.push(store.on('owner', () => { roBanner.hidden = true; }));
  app.playEditor = () => editor;               // テストと調べ物のため（つなぎ込みの確かめが模範解答を入れる）
  app.playScene = () => scene;                 // テストと調べ物のため（追従カメラの確かめ。直し係 5）
  P.dataset.ready = '1';                       // 組み立てが終わった（テストが待つ印）

  return {
    unmount() {
      runSeq++;
      audio.ambience(false);
      app.headerHold = null;                     // 札を見ずに画面を出たら、ヘッダーは今の記録のまま（次の画面で）
      if (phase === 'queued') app.bridge.cancelQueued();
      for (const off of offs) off();
      clearTimeout(hintTimer);
      stopReplay(false);
      audio.stopDrive();
      app.playEditor = null;
      app.playScene = null;
      app.playLayout = null;
      if (timeline) { try { timeline.destroy(); } catch { /* なし */ } }
      if (graphs) { try { graphs.destroy(); } catch { /* なし */ } }
      try { scene.dispose(); } catch { /* なし */ }
      if (editor && editor.destroy) { try { editor.destroy(); } catch { /* なし */ } }
      if (!store.isReadOnly() && editor) store.setCode(id, editor.getCode());
      store.flush();
      const sheet = document.querySelector('.clear-card.sheet');
      if (sheet) sheet.remove();
    },
  };
}

/** パレット（7 の仕組み: その面までに習った命令。equipped のうち、その面までの new に出てきたもの。import time は出さない）。 */
export function paletteFor(level, apiFns) {
  const eq = level.equipped || [];
  return eq.filter((n) => apiFns[n] && apiFns[n].palette)
    .map((n) => ({ label: apiFns[n].palette, insert: apiFns[n].palette, summary: apiFns[n].summary || '', name: n }));
}

/**
 * 道具箱の関数をコードの先頭の「# ---- 道具箱」の段に入れる（同じ名前は入れかえる）。
 * @param {string} code @param {string} name @param {string} fsrc @param {string[]} needs 上の段の行（import・値）
 * @returns {string}
 */
export function insertToolbox(code, name, fsrc, needs = []) {
  const MARK = '# ---- 道具箱';
  const END_MARK = '# ---- 道具箱ここまで';
  let lines = code.split('\n');
  // 同じ名前の def を消す（def の行から、次の字下げの無い行の前まで）
  const start = lines.findIndex((l) => new RegExp(`^def\\s+${name}\\s*\\(`).test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(start, end - start);
  }
  const add = [];
  for (const n of needs) if (!lines.some((l) => l.trim() === n.trim())) add.push(n);
  const isHead = (l) => /^#\s*-{2,}\s*道具箱(?!ここまで)/.test(l.trim());
  const isEnd = (l) => /^#\s*-{2,}\s*道具箱ここまで/.test(l.trim());
  let at = lines.findIndex(isHead);
  if (at < 0) {
    lines = [MARK, END_MARK, '', ...lines];       // W6 の editor/toolbox.js と同じ段の形
    at = 0;
  }
  // 段の終わり（「# ---- 道具箱ここまで」、無ければ次の「# ----」の見出しの前）
  let end = lines.findIndex((l, i) => i > at && isEnd(l));
  if (end < 0) { end = at + 1; while (end < lines.length && !/^#\s*-{2,}\s*\S/.test(lines[end].trim())) end++; }
  let ins = end;
  while (ins > at + 1 && lines[ins - 1].trim() === '') ins--;
  const block = [...add, ...fsrc.replace(/\s+$/, '').split('\n')];
  lines.splice(ins, 0, ...(ins === at + 1 ? block : ['', ...block]));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 決まった順の入れかえ（同じ面なら同じ順。予想の取り直し）。 */
function shuffle(arr, seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= Date.now() & 0xffff;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (a.every((v, i) => v === arr[i]) && a.length > 1) a.push(a.shift());
  return a;
}

/**
 * print の文字を出力の欄に出す HTML。文字は Python が出したとおり（書きかえない。コピーすると元の文字になる）。
 * 見やすさは見た目だけで: 数の前のマイナスは色と太さ（.neg）、小数 4 けた目からの長い続きは薄い色（.dim）。
 * （前回の A-11・B17 は「−」や丸めた数に書きかえていた。直し係 3 の 5）
 * @param {string} text @returns {string}
 */
export function printHTML(text) {
  const s = String(text);
  const re = /(-?)(\d+)(?:\.(\d+))?((?:e[+-]?\d+)?)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const prev = m.index > 0 ? s[m.index - 1] : '';
    if (/[\w.]/.test(prev) || /[\w.]/.test(s[re.lastIndex] || '')) continue;     // 名前や長い文字の中の数字はそのまま
    out += esc(s.slice(last, m.index));
    const [, sign, ip, fp, ex] = m;
    const negOk = sign && (prev === '' || /[\s(\[{,=:]/.test(prev));
    out += negOk ? '<span class="neg">-</span>' : esc(sign);
    out += ip;
    if (fp !== undefined) out += fp.length >= 5 ? `.${fp.slice(0, 3)}<span class="dim">${fp.slice(3)}</span>` : `.${fp}`;
    out += esc(ex || '');
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}

/** 時間までに終わらなければ失敗にする（CDN の CodeMirror が届かない時など）。 */
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), ms))]);
}
