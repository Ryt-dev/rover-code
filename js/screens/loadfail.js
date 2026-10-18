/**
 * @file app/js/screens/loadfail.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 「Python を準備できなかったよ」のカード（タイトルと遊ぶ画面で同じもの）。理由と［もう一度］［動く環境の確かめ方］。
 * SPEC: 2.2「うまくいかない時の台本」・7.6（失敗の見分け: network | blocked | no_wasm | memory | unknown）
 */

import { esc } from '../ui/strings.js';
import { faceSVG } from '../ui/senpai.js';

/**
 * @param {object} app @param {string} reason
 * @returns {HTMLElement}
 */
export function failCard(app, reason) {
  const { t } = app;
  const r = ['network', 'blocked', 'no_wasm', 'memory', 'unknown'].includes(reason) ? reason : 'unknown';
  const el = document.createElement('div');
  el.className = 'card fail-card';
  el.setAttribute('role', 'alert');
  el.innerHTML = `<div class="fail-head"><span class="tip-face">${faceSVG('surprise')}</span><b>${esc(t('runner.failed'))}</b></div>
    <p>${esc(t(`runner.reason_${r}`))}</p>
    <div class="row"><button type="button" class="btn primary" data-a="retry">${esc(t('button.retry_load'))}</button>
    <button type="button" class="btn" data-a="env">${esc(t('button.check_env'))}</button></div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'retry') app.bridge.retry();
    else app.openDialog({ title: t('button.check_env'), body: t('runner.env_help'), actions: [{ label: t('button.close'), value: 'c', primary: true }] });
  });
  return el;
}
