/**
 * @file app/js/ui/header.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: どの画面にもあるヘッダー（高さ 60 px）: ロゴ・今いる所・その面の★・全体の進み具合（クリア 3 / 53 と細いバー）・地図・ずかん・設定。
 *       600 px 未満はロゴは絵だけ・今いる所は「1-3」だけ・★・「≡」（地図・ずかん・設定のメニュー）で 1 行。
 * SPEC: 3.1・11.2（「クリア 3 / 53」の書き方）・2.2（1-2 で地図ボタンが軽く揺れる）
 */

import { icon } from './icons.js';
import { t, esc } from './strings.js';

const LOGO = '<svg class="logo-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="11" cy="26" r="9" fill="#2a3238"/><circle cx="29" cy="26" r="9" fill="#2a3238"/><circle cx="11" cy="26" r="4" fill="#f3ead8"/><circle cx="29" cy="26" r="4" fill="#f3ead8"/><rect x="11" y="15" width="18" height="10" rx="3" fill="#5f8f3e"/><rect x="18" y="8" width="2" height="7" fill="#2a3238"/><circle cx="19" cy="7" r="2.5" fill="#d9672b"/></svg>';

/**
 * ヘッダーを作る。
 * @param {HTMLElement} el <header> の要素
 * @param {{go: (hash: string) => void}} nav
 * @returns {{set: (o: {chapter?: string, levelId?: string, levelTitle?: string, stars?: boolean[]|null, place?: string}) => void,
 *            setTotals: (o: {clears: number, total: number}) => void, show: (b: boolean) => void, wiggleMap: () => void}}
 */
export function createHeader(el, nav) {
  el.className = 'app-header';
  el.innerHTML = `
    <a class="logo" href="#/title" aria-label="${esc(t('app.logo_label'))}">${LOGO}<span class="logo-text">${esc(t('app.name'))}</span></a>
    <div class="crumb"><span class="crumb-ch"></span><b><span class="lv-id"></span><span class="lv-title"></span></b></div>
    <div class="stars" role="img" hidden></div>
    <div class="prog"><span class="prog-text"></span><div class="bar" role="progressbar" aria-label="${esc(t('header.progress_label'))}" aria-valuemin="0"><i></i></div></div>
    <nav class="hnav" aria-label="${esc(t('header.nav_label'))}">
      <button class="hbtn" type="button" data-go="#/map">${icon('map')}<span>${esc(t('button.map'))}</span></button>
      <button class="hbtn" type="button" data-go="#/zukan">${icon('book')}<span>${esc(t('button.zukan'))}</span></button>
      <button class="hbtn" type="button" data-go="#/settings" aria-label="${esc(t('button.settings'))}">${icon('gear')}</button>
      <button class="hbtn menu" type="button" aria-haspopup="true" aria-expanded="false" aria-label="${esc(t('header.menu_label'))}">${icon('menu')}</button>
      <div class="hmenu" role="menu" hidden>
        <button type="button" role="menuitem" data-go="#/map">${icon('map')}<span>${esc(t('button.map'))}</span></button>
        <button type="button" role="menuitem" data-go="#/zukan">${icon('book')}<span>${esc(t('button.zukan'))}</span></button>
        <button type="button" role="menuitem" data-go="#/settings">${icon('gear')}<span>${esc(t('button.settings'))}</span></button>
      </div>
    </nav>`;
  const q = (s) => el.querySelector(s);
  const menuBtn = q('.hbtn.menu');
  const menu = q('.hmenu');
  const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) { closeMenu(); nav.go(b.dataset.go); return; }
    if (e.target.closest('.hbtn.menu')) {
      const open = menu.hidden;
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button').focus();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); menuBtn.focus(); }
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.hnav')) closeMenu(); });

  return {
    set(o = {}) {
      q('.crumb-ch').textContent = o.chapter ? `${o.chapter} ／ ` : '';
      q('.lv-id').textContent = o.levelId || o.place || '';
      q('.lv-title').textContent = o.levelTitle ? ` ${o.levelTitle}` : '';
      const st = q('.stars');
      if (Array.isArray(o.stars)) {
        const n = o.stars.filter(Boolean).length;
        st.hidden = false;
        st.innerHTML = o.stars.map((s) => `<span class="${s ? 'on' : 'off'}">${s ? '★' : '☆'}</span>`).join('');
        st.setAttribute('aria-label', t('header.level_stars', { n }));
      } else {
        st.hidden = true;
      }
    },
    setTotals({ clears, total }) {
      q('.prog-text').textContent = t('header.clears', { clears, total_levels: total });
      const bar = q('.bar');
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(clears));
      bar.setAttribute('aria-valuetext', t('header.clears', { clears, total_levels: total }));
      q('.bar i').style.width = `${total ? Math.round(clears / total * 100) : 0}%`;
    },
    show(b) { el.hidden = !b; document.body.classList.toggle('no-header', !b); },
    wiggleMap() {
      const b = el.querySelector('.hbtn[data-go="#/map"]') || menuBtn;
      b.classList.remove('wiggle');
      void b.offsetWidth;
      b.classList.add('wiggle');
    },
  };
}
