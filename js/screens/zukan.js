/**
 * @file app/js/screens/zukan.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: ずかん（部の技術ノート）: 方眼のノート、左に目次・右に 1 項目。分類は命令・センサ・考え方・エラー・会場。習うまでは「？」、新しく開いた項目に「新」。印刷する。
 * SPEC: 3.7・9.5（エラーずかん: 見つけた回数・最初に見つけた面）
 *
 * 中身: data/zukan.json（W4）の items。命令の分類は data/api.json（W2）の summary・notes でも補う（W4 の項目が無い間）。
 *       エラーの分類は data/error_rules.json（W3）の zukan。会場は data/venues.json（W4）。
 */

import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';

const CATS = ['command', 'syntax', 'sensor', 'idea', 'error', 'venue'];

/**
 * @param {HTMLElement} root @param {object} app @param {string|null} param 開く項目の id（例 "motor"）
 */
export async function mount(root, app, param) {
  const { t, store, progress } = app;
  app.header.set({ place: t('zukan.title') });
  const [zk, api, rules, venues] = await Promise.all([app.lazy('zukan'), app.lazy('api'), app.lazy('rules'), app.lazy('venues')]);
  const items = buildItems(zk, api, rules, venues);
  const d = store.get();
  const seenSet = new Set(d.zukan.seen);
  const isSeen = (it) => {
    if (it.category === 'error') return (it.rules || [it.id]).some((r) => d.errorsSeen[r]);
    if (it.category === 'venue') return (it.chapters || []).some((c) => progress.isChapterUnlocked(c));
    if (seenSet.has(it.id)) return true;
    if (it.unlock && store.hasLevel(it.unlock) && (store.level(it.unlock).unlocked || store.level(it.unlock).cleared)) return true;
    return false;
  };
  const isNew = (it) => d.zukan.new.includes(it.id);
  let cat = 'command';
  let cur = null;
  if (param) {
    const it = items.find((x) => x.id === param);
    if (it) { cat = it.category; cur = it; }
  }
  root.innerHTML = `<div class="page zukan">
    <h1>${icon('book')}<span>${esc(t('zukan.title'))}</span></h1>
    <div class="zk-cats" role="tablist" aria-label="${esc(t('zukan.toc'))}">${CATS.map((c) => `<button type="button" role="tab" data-cat="${c}" aria-selected="false">${esc(t(`zukan.cat_${c}`))}</button>`).join('')}</div>
    <div class="zk-body">
      <nav class="zk-toc" aria-label="${esc(t('zukan.toc'))}"><ul></ul></nav>
      <article class="zk-item" aria-live="polite"></article>
    </div>
    <div class="zk-tools"><button type="button" class="btn" data-a="print">${icon('print')}<span>${esc(t('button.print'))}</span></button><span class="note small">${esc(t('zukan.print_note'))}</span></div>
    <div class="zk-print" aria-hidden="true"></div>
  </div>`;
  const q = (s) => root.querySelector(s);

  function renderToc() {
    for (const b of root.querySelectorAll('[data-cat]')) { b.setAttribute('aria-selected', String(b.dataset.cat === cat)); b.tabIndex = b.dataset.cat === cat ? 0 : -1; }
    const list = items.filter((x) => x.category === cat);
    const ul = q('.zk-toc ul');
    if (!list.length) { ul.innerHTML = `<li class="empty">${esc(t('zukan.empty'))}</li>`; return; }
    ul.innerHTML = list.map((it) => {
      const seen = isSeen(it);
      return `<li><button type="button" class="zk-link${cur && cur.id === it.id ? ' on' : ''}${seen ? '' : ' unknown'}" data-id="${esc(it.id)}"${cur && cur.id === it.id ? ' aria-current="true"' : ''}>${seen ? esc(it.name) : esc(t('zukan.unknown'))}${seen && isNew(it) ? ` <span class="new">${esc(t('zukan.new'))}</span>` : ''}</button></li>`;
    }).join('');
  }
  function renderItem() {
    const art = q('.zk-item');
    if (!cur) {
      const first = items.find((x) => x.category === cat && isSeen(x));
      if (first) { cur = first; } else { art.innerHTML = `<p class="note">${esc(t('zukan.unknown_note'))}</p>`; return; }
    }
    if (!isSeen(cur)) { art.innerHTML = `<h2>${esc(t('zukan.unknown'))}</h2><p class="note">${esc(t('zukan.unknown_note'))}</p>`; return; }
    art.innerHTML = itemHTML(cur);
    if (isNew(cur)) { store.markZukanRead(cur.id); }
  }
  function itemHTML(it) {
    const cnt = it.category === 'error' ? (it.rules || [it.id]).reduce((s, r) => s + (d.errorsSeen[r] || 0), 0) : 0;
    const firstAt = it.category === 'error' ? (it.rules || [it.id]).map((r) => d.errorsFirst[r]).find(Boolean) : null;
    return `<h2>${esc(it.name)}</h2>
      ${it.summary ? `<p class="zk-sum"><b>${esc(t('zukan.summary'))}:</b> ${esc(it.summary)}</p>` : ''}
      ${it.category === 'error' && cnt ? `<p class="zk-found">${esc(t('zukan.found', { n: cnt }))}${firstAt ? `　${esc(t('zukan.first_found', { id: firstAt }))}` : ''}</p>` : ''}
      ${it.body ? `<div class="zk-text">${String(it.body).split('\n').map((p) => `<p>${esc(p)}</p>`).join('')}</div>` : ''}
      ${it.figure && /^<svg[\s>]/.test(String(it.figure).trim()) ? `<figure class="zk-fig">${sanitizeSvg(it.figure)}</figure>` : ''}
      ${it.example ? `<h3>${esc(t('zukan.example'))}</h3><pre class="ex">${esc(it.example)}</pre><button type="button" class="btn small" data-free="${esc(it.id)}">${icon('play')}<span>${esc(t('zukan.send_free'))}</span></button>` : ''}
      ${it.bad || it.good ? `<div class="ec-ex"><span class="bad">✗ <code>${esc(it.bad || '')}</code></span><span class="good">✓ <code>${esc(it.good || '')}</code></span></div>` : ''}
      ${it.sil ? `<h3>${esc(t('zukan.sil'))}</h3><pre class="ex">${esc(it.sil)}</pre>` : ''}
      ${it.related && it.related.length ? `<h3>${esc(t('zukan.related'))}</h3><p>${it.related.map((r) => `<button type="button" class="linkish" data-id="${esc(r)}">${esc((items.find((x) => x.id === r) || { name: r }).name)}</button>`).join('・')}</p>` : ''}`;
  }

  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) { cat = c.dataset.cat; cur = null; renderToc(); renderItem(); return; }
    const l = e.target.closest('[data-id]');
    if (l) {
      const it = items.find((x) => x.id === l.dataset.id);
      if (it) { cat = it.category; cur = it; renderToc(); renderItem(); q('.zk-item').focus?.(); history.replaceState(null, '', `#/zukan/${encodeURIComponent(it.id)}`); }
      return;
    }
    const f = e.target.closest('[data-free]');
    if (f) {
      const it = items.find((x) => x.id === f.dataset.free);
      if (it) { app.pendingFreeCode = it.example; app.go('#/free'); }
      return;
    }
    if (e.target.closest('[data-a="print"]')) {
      const box = q('.zk-print');
      box.innerHTML = `<h1>${esc(t('zukan.title'))} ― ${esc(t(`zukan.cat_${cat}`))}</h1>` + items.filter((x) => x.category === cat && isSeen(x)).map((x) => `<section>${itemHTML(x)}</section>`).join('');
      window.print();
    }
  });
  q('.zk-cats').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = CATS.indexOf(cat);
    cat = CATS[(i + (e.key === 'ArrowRight' ? 1 : CATS.length - 1)) % CATS.length];
    cur = null;
    renderToc();
    renderItem();
    root.querySelector(`[data-cat="${cat}"]`).focus();
    e.preventDefault();
  });
  q('.zk-item').tabIndex = -1;
  renderToc();
  renderItem();
  return { unmount() {} };
}

/** 項目をまとめる（W4 の zukan.json を主に、無い分は api.json・error_rules.json・venues.json から）。 */
export function buildItems(zk, api, rules, venues) {
  const out = [];
  const have = new Set();
  for (const it of (zk && zk.items) || []) {
    if (!it || !it.id || !CATS.includes(it.category)) continue;
    out.push({ ...it, name: it.name || it.id });
    have.add(it.id);
  }
  const fns = (api && api.functions) || {};
  for (const [name, f] of Object.entries(fns)) {
    if (have.has(name)) continue;
    out.push({ id: name, category: 'command', name: f.sig || `${name}()`, summary: f.summary || '', body: f.notes || '', example: f.palette || '', unlock: f.unlock || null });
    have.add(name);
  }
  for (const it of (rules && Array.isArray(rules.zukan) ? rules.zukan : [])) {
    const id = it.id || it.key;
    if (!id || have.has(id)) continue;
    out.push({ id, category: 'error', name: it.name || it.title || id, summary: it.summary || '', body: it.body || it.why || '', rules: it.rules || it.rule_ids || [id], bad: it.example && it.example.bad, good: it.example && it.example.good });
    have.add(id);
  }
  const vs = (venues && venues.venues) || {};
  for (const [key, v] of Object.entries(vs)) {
    if (have.has(`venue_${key}`) || have.has(key)) continue;
    out.push({ id: `venue_${key}`, category: 'venue', name: v.name || key, summary: v.short || '', body: v.note || '', chapters: v.chapters || [] });
  }
  return out;
}

/** 図の SVG から script・イベントの属性・外へのリンクを取る（データは W4 のものだが念のため）。 */
function sanitizeSvg(svg) {
  return String(svg).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/(href|xlink:href)\s*=\s*("|')\s*(javascript:|https?:)[^"']*\2/gi, '');
}
