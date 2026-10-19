/**
 * @file app/js/screens/play_parts.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 遊ぶ画面の左の欄の部品（今回おぼえること・予想カード・小目標・クリア条件）と、小さな計算（行数・測った値の書き方・HUD の値）。
 * SPEC: 3.4（左の欄）・2.4（予想・小目標）・7.7（stars[].measure・unit・tip）・6.12（lines の数え方）
 */

import { esc, t } from '../ui/strings.js';
import { icon } from '../ui/icons.js';

/** 章の見出し（「第 1 章 はじめの一歩」・C は「おまけ C で書いてみる」）。 */
export function chapterLabel(ch) {
  if (!ch) return '';
  return String(ch.no) === 'C' ? t('header.chapter_c', { title: ch.title || '' }) : t('header.chapter', { no: ch.no, title: ch.title || '' });
}

/**
 * コードの行数（6.12: 空行とコメントだけの行は数えない。1 行に文が 2 つ以上ならその数。画面の目安。判定は judge.py）。
 * @param {string} code @param {'python'|'c'} [lang]
 */
export function countLines(code, lang = 'python') {
  let n = 0;
  for (const raw of String(code || '').split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    if (lang === 'c') {
      if (s.startsWith('//')) continue;
      const semis = (s.replace(/for\s*\([^)]*\)/g, 'for()').match(/;/g) || []).length;
      n += Math.max(1, semis);
    } else {
      if (s.startsWith('#')) continue;
      const body = s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
      const parts = body.split(';').filter((p) => p.trim()).length;
      const colonStmt = /^(if|elif|else|for|while|def|try|except|finally|with)\b.*:\s*\S/.test(body) ? 1 : 0;
      n += Math.max(1, parts) + colonStmt;
    }
  }
  return n;
}

/**
 * 測った値の書き方（「36 cm」「4.8 秒」「6 行」）。
 * @param {number} v @param {string} [unit]
 */
/** 測った値として見せられる数か（エンジンは inf を JSON に入れられないので 1e308 にして返す。それは「測れなかった」）。 */
export const isMeasured = (v) => Number.isFinite(v) && Math.abs(v) < 1e300;

export function fmtMeasure(v, unit) {
  if (!isMeasured(v)) return null;
  if (unit === 'cm') return fmtCm(v);
  if (unit === 'm') return `${v.toFixed(2)} m`;
  if (unit === 's' || unit === '秒') return `${v.toFixed(1)} 秒`;
  if (unit === 'deg' || unit === '°') return `${v.toFixed(1)}°`;
  if (unit === 'lines' || unit === '行') return `${Math.round(v)} 行`;
  if (unit === 'times' || unit === '回') return `${Math.round(v)} 回`;
  return String(Math.round(v * 100) / 100);
}

/** m の値を cm で（1 m 以上は「39.5 m」。直し C12）。 */
export function fmtCm(v) {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1 ? `${(Math.round(v * 10) / 10).toFixed(1)} m` : `${Math.round(v * 100)} cm`;
}

/** ★の単位（unit が無い時は measure の式から決める。直し B14） */
export function unitOf(def) {
  if (!def) return undefined;
  if (def.unit) return def.unit;
  const m = String(def.measure || '');
  if (/^(gap|min_gap|dist|max_offset)\(/.test(m)) return 'cm';
  if (/^t_(stop|end)\b/.test(m)) return '秒';
  if (m === 'lines') return '行';
  if (/^(heading_err|aim_err)\(|^turn_total/.test(m)) return '°';
  return undefined;
}

/**
 * ★の「いま」の文字。「A または B」の★で B の側を満たした時は、judge が B の値と名前（「スタートまで」）を返すので、
 * その単位と名前で出す（直し係 5。8-1・5-3・9-5 で「いま」と ✓ が食い違った）。値が無ければ null。
 */
export function measureText(js, def) {
  const mv = measureOf(js);
  if (mv === null) return null;
  const m = js && typeof js.measure === 'object' && js.measure ? js.measure : {};
  const s = fmtMeasure(mv, m.unit || unitOf(def) || (def && def.measure === 'lines' ? 'lines' : undefined));
  return m.label ? `${m.label} ${s}` : s;
}

/** judge の★の結果から測った値（W2 の judge の形の違いを吸収: measure・value・now）。 */
export function measureOf(js) {
  if (!js) return null;
  for (const k of ['measure', 'value', 'now', 'worst']) if (isMeasured(js[k])) return js[k];
  if (js.measure && isMeasured(js.measure.value)) return js.measure.value;
  return null;
}

/**
 * 今回おぼえることのカード。
 * @param {object} level @param {(name: string) => void} onZukan 命令の名前を押した時
 */
export function learnCard(level, apiFns, onZukan) {
  const el = document.createElement('section');
  el.className = 'card learn-card';
  const news = Array.isArray(level.new) ? level.new : [];
  const cmds = news.filter((n) => apiFns && apiFns[n]);
  const tag = cmds.length ? `<span class="tag">${esc(t('play.learn_new', { n: cmds.length }))}</span>` : '';
  const lines = [];
  for (const c of cmds) {
    const f = apiFns[c];
    lines.push(`<li><button type="button" class="linkish code-link" data-zukan="${esc(c)}"><code>${esc(f.sig || c)}</code></button> … ${esc(f.summary || '')}</li>`);
  }
  const learn = level.learn || {};
  const rob = (learn.robot || []).map((s) => `<li>${esc(s)}</li>`).join('');
  const py = (learn.python || []).map((s) => `<li>${esc(s)}</li>`).join('');
  const ex = exampleOf(level, cmds, apiFns);
  el.innerHTML = `<h3>${esc(t('play.learn'))} ${tag}</h3>
    ${lines.length ? `<ul class="learn-cmds">${lines.join('')}</ul>` : ''}
    ${rob ? `<div class="learn-sub"><b>${esc(t('play.learn_robot'))}</b><ul>${rob}</ul></div>` : ''}
    ${py ? `<div class="learn-sub"><b>${esc(t('play.learn_python'))}</b><ul>${py}</ul></div>` : ''}
    ${ex ? `<pre class="ex" aria-label="例">${esc(ex)}</pre>` : ''}`;
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-zukan]'); if (b) onZukan(b.dataset.zukan); });
  return el;
}

function exampleOf(level, cmds, apiFns) {
  // 新しい命令のパレットの文を並べた小さな例（見本の黒いコード例）
  const xs = cmds.map((c) => apiFns[c] && apiFns[c].palette).filter(Boolean);
  return xs.length ? xs.join('\n') : '';
}

/**
 * 予想カード（予想の面・予想カードのある面）。
 * @param {object[]} qs predict の問い（{q, choices, answer, why}）
 * @param {{saved: object|null, order: number[][]|null, locked: boolean, onChoose: (first: number[]) => void}} o
 * @returns {{el: HTMLElement, chosen: () => number[]|null, reveal: () => void, complete: () => boolean}}
 */
export function predictCard(qs, o) {
  const el = document.createElement('section');
  el.className = 'card predict-card';
  const order = o.order || qs.map((q) => q.choices.map((_, i) => i));
  let picks = o.saved && Array.isArray(o.saved.first) && o.saved.first.length === qs.length ? o.saved.first.slice() : qs.map(() => null);
  const name = `pr-${Math.random().toString(36).slice(2, 7)}`;
  el.innerHTML = `<h3>${icon('eye')}<span>${esc(t('play.predict'))}</span></h3>` + qs.map((q, qi) => `
    <fieldset class="pq" data-q="${qi}"><legend>${esc(q.q)}</legend>
      ${order[qi].map((ci) => `<label class="pc"><input type="radio" name="${name}-${qi}" value="${ci}"${picks[qi] === ci ? ' checked' : ''}${picks[qi] !== null ? ' disabled' : ''}> <span>${esc(q.choices[ci])}</span></label>`).join('')}
      <div class="pr-answer" hidden></div>
    </fieldset>`).join('') + `<p class="pr-note">${esc(t('play.predict_need'))}</p>
    <button type="button" class="btn small primary pr-lock" hidden>${esc(t('play.predict_lock'))}</button>`;
  const note = el.querySelector('.pr-note');
  const lockBtn = el.querySelector('.pr-lock');
  let locked = picks.every((p) => p !== null);
  const draft = picks.slice();
  const complete = () => locked;
  const sync = () => {
    const all = draft.every((p) => p !== null);
    note.hidden = locked || all;
    lockBtn.hidden = locked || !all;
  };
  // 選ぶだけではまだ決まらない。「この予想で決める」で決める（選びまちがいを直せる。直し A-8）
  el.addEventListener('change', (e) => {
    const r = e.target;
    if (locked || !(r instanceof HTMLInputElement) || r.type !== 'radio') return;
    draft[Number(r.closest('.pq').dataset.q)] = Number(r.value);
    sync();
  });
  lockBtn.addEventListener('click', () => {
    if (locked || !draft.every((p) => p !== null)) return;
    locked = true;
    picks = draft.slice();
    for (const inp of el.querySelectorAll('input')) inp.disabled = true;
    sync();
    o.onChoose(picks.slice());
  });
  sync();
  return {
    el,
    chosen: () => (complete() ? picks.slice() : null),
    complete,
    reveal() {
      qs.forEach((q, qi) => {
        const box = el.querySelector(`.pq[data-q="${qi}"] .pr-answer`);
        const right = picks[qi] === q.answer;
        box.hidden = false;
        box.className = `pr-answer ${right ? 'right' : 'wrong'}`;
        box.innerHTML = `<b>${right ? `✓ ${esc(t('play.predict_right'))}` : `✗ ${esc(t('play.predict_wrong', { answer: q.choices[q.answer] }))}`}</b>${q.why ? `<br>${esc(t('play.predict_why', { why: q.why }))}` : ''}`;
      });
    },
  };
}

/**
 * 小目標（steps）のカード。
 * @param {object[]} steps
 */
export function stepsCard(steps) {
  const el = document.createElement('section');
  el.className = 'card steps-card';
  el.innerHTML = `<h3>${esc(t('play.steps'))}</h3><ol class="steps">${steps.map((s, i) => `<li data-i="${i}"><span class="chk" aria-hidden="true"></span><span>${esc(s.label)}</span><span class="sr-only st-state"></span></li>`).join('')}</ol>`;
  return {
    el,
    /** @param {boolean[]|null} oks */
    set(oks) {
      el.querySelectorAll('li').forEach((li, i) => {
        const ok = !!(oks && oks[i]);
        li.querySelector('.chk').classList.toggle('on', ok);
        li.querySelector('.chk').textContent = ok ? '✓' : '';
        li.querySelector('.st-state').textContent = ok ? '（できた）' : '';
      });
    },
  };
}

/**
 * クリア条件のカード（クリアと★2・★3。世界ごとの丸・本番テストで・いまの値）。
 * @param {object} level @param {{stars: boolean[], capped: boolean}} saved
 */
export function goalsCard(level, saved) {
  const el = document.createElement('section');
  el.className = 'card goals-card';
  const multi = (level.worlds || []).length > 1;
  const rows = [];
  const clearLabel = (level.clear || []).map((c) => c.label).join('・');
  rows.push({ kind: 'clear', label: clearLabel, byTest: false, idx: 0 });
  (level.stars || []).forEach((s, i) => rows.push({ kind: 'star', label: s.label, byTest: Array.isArray(s.need) && s.need[0] === 'test', idx: i + 1, unit: s.unit }));
  el.innerHTML = `<h3>${esc(t('play.goals'))}</h3><ul class="goals">${rows.map((r) => `
    <li data-k="${r.idx}"><span class="chk${saved.stars[r.idx] ? ' got' : ''}" aria-hidden="true"></span>
      <span class="g-label">${r.kind === 'star' ? `<span class="st" aria-label="★${r.idx + 1}">★</span> ` : ''}${esc(r.label)}${r.byTest ? ` <span class="tag tag-test">${esc(t('play.by_test'))}</span>` : ''}
        <span class="g-measure"></span>${r.idx === 2 && saved.capped ? ` <span class="g-capped">${esc(t('play.answer_seen_star'))}</span>` : ''}</span>
      ${multi ? '<span class="wdots" aria-hidden="true"></span>' : ''}<span class="sr-only g-state"></span></li>`).join('')}</ul>`;
  return {
    el,
    /**
     * @param {{ok: (boolean|null)[], pass: (boolean[]|null)[], measure: (string|null)[], grey?: boolean[], note?: (string|null)[]}} r 添え字 0 = クリア、1 = ★2、2 = ★3。
     *   note があるとその行は灰色の印と、値の代わりにその文（クリアしていない実行の★）
     */
    set(r) {
      el.querySelectorAll('li').forEach((li) => {
        const k = Number(li.dataset.k);
        const ok = r.ok[k];
        const chk = li.querySelector('.chk');
        chk.classList.toggle('on', ok === true);
        chk.classList.toggle('grey', !!(r.grey && r.grey[k]));
        chk.classList.toggle('pending', !!(r.note && r.note[k]));        // クリアしていない実行の★は灰色（直し係 3 の 6）
        chk.textContent = ok === true ? '✓' : '';
        li.querySelector('.g-state').textContent = ok === true ? '（できた）' : ok === false ? '（まだ）' : '';
        const m = li.querySelector('.g-measure');
        m.textContent = r.note && r.note[k] ? ` ― ${r.note[k]}` : r.measure[k] ? ` ― ${t('play.measure_now', { v: r.measure[k] })}` : '';
        m.classList.toggle('now-wait', !!(r.note && r.note[k]));
        const wd = li.querySelector('.wdots');
        if (wd) wd.innerHTML = (r.pass[k] || []).map((p) => `<i class="${p ? 'ok' : 'ng'}">${p ? '✓' : '✗'}</i>`).join('');
      });
    },
    /** 取った★の印（保存の★）。 @param {boolean[]} stars */
    setGot(stars) { el.querySelectorAll('li').forEach((li) => li.querySelector('.chk').classList.toggle('got', !!stars[Number(li.dataset.k)])); },
  };
}

/**
 * HUD の値（3.4: 面に合わせて項目を変える）。
 * @param {string[]} kinds level.hud @param {object} pose 今の位置 {t, x, y, h, v, z} @param {object} world @param {object} rec 記録
 */
export function hudValues(kinds, pose, world, rec) {
  const out = [];
  const tt = pose ? pose.t : 0;
  for (const k of kinds || []) {
    // 時間の帯（timeline.js の fmtT）と同じ書き方: 60 秒からは「1:25.7」（HUD だけ「85.7 s」だった。直し係 5）
    if (k === 'time') out.push([t('hud.time'), tt < 60 ? `${tt.toFixed(1)} s` : `${Math.floor(tt / 60)}:${(tt % 60).toFixed(1).padStart(4, '0')}`]);
    else if (k === 'speed') out.push([t('hud.speed'), `${Math.abs(pose && Number.isFinite(pose.v) ? pose.v : 0).toFixed(2)} m/s`]);
    else if (k === 'gap') {
      const cone = ((world && world.objects) || []).find((o) => o.type === 'cone');
      if (cone && pose && Number.isFinite(pose.x)) {
        const d = Math.max(0, Math.hypot(cone.x - pose.x, cone.y - pose.y) - (cone.r || 0.19) - 0.12);
        out.push([t('hud.gap'), `${d.toFixed(2)} m`]);
      }
    } else if (k === 'heading') {
      // 方位が使えない世界（7-4 など）は「—」（直し B13）
      const broken = !!(world && world.sensor && (world.sensor.heading_broken || world.sensor.heading === null));
      out.push([t('hud.heading'), broken ? '—' : `${(((pose && pose.h) || 0) % 360 + 360) % 360 | 0}°`]);
    }
    else if (k === 'alt') out.push([t('hud.alt'), `${Math.max(0, (pose && pose.z) || 0).toFixed(1)} m`]);
    else if (k === 'left') out.push([t('hud.left'), `${Math.max(0, ((world && world.time_limit) || 0) - tt).toFixed(0)} s`]);
    else if (k === 'lidar') {
      // 一度も LiDAR を読まない走り（と実行の前）は札を出さない（ブラッシュアップ 11: 使わないセンサの「読んでいない」を出さない）
      if (!((rec && rec.events) || []).some((e) => e.k === 'lidar')) continue;
      const e = lastEvent(rec, 'lidar', tt);
      // 値が無い時は「—」ではなく字で（薄くて見えなかった。直し係 5）: None（光が返ってこない）は「届かない」、まだ一度も読んでいなければ「読んでいない」
      out.push([t('hud.lidar'), e ? (e.v === null || e.v === undefined ? '届かない' : `${Number(e.v).toFixed(2)} m`) : '読んでいない']);
    } else if (k === 'phase') {
      const ph = (rec && rec.phases) || [];
      let name = '—';
      for (const [pt, nm] of ph) if (pt <= tt) name = nm;
      out.push([t('hud.phase'), name]);
    } else if (k === 'gnss') {
      const fx = (rec && rec.gnssFixes) || [];
      if (!fx.length) continue;                 // GNSS を使わない走りは札を出さない（ブラッシュアップ 11）
      let err = null;
      for (const f of fx) if (f[0] <= tt && f[5]) err = Math.hypot(f[3] - f[1], f[4] - f[2]);
      out.push([t('hud.gnss'), err === null ? '—' : `${err.toFixed(1)} m`]);
    }
  }
  return out;
}

function lastEvent(rec, kind, tt) {
  const ev = (rec && rec.events) || [];
  // センサの読みは 1 コマ（0.01 s）あとの時刻で記録される（0.0 s に読んだ lidar() は t = 0.01）。記録の終わりでは全部を数える（直し係 6）
  const end = recEndT(rec);
  const lim = Number.isFinite(end) && tt >= end - 1e-6 ? Infinity : tt + 0.011;
  let last = null;
  for (const e of ev) { if (e.k === kind && e.t <= lim) last = e; else if (e.t > lim) break; }
  return last;
}

/** 記録の最後の時刻（コマの t）。 */
function recEndT(rec) {
  if (!rec || !rec.fields || !rec.frames) return NaN;
  const F = rec.fields.length, i = rec.fields.indexOf('t');
  const fr = rec.frames;
  if (i < 0 || !F) return NaN;
  if (Array.isArray(fr) && Array.isArray(fr[0])) return fr.length ? fr[fr.length - 1][i] : NaN;
  const n = Math.floor(fr.length / F);
  return n ? fr[(n - 1) * F + i] : NaN;
}
