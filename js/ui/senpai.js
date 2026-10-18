/**
 * @file app/js/ui/senpai.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: ミナミ先輩の吹き出し（顔の丸＋名前＋2〜4 文）と、出力の欄の「先輩のひとこと」（見本の .tip の形）。顔は表情 4 種。
 * SPEC: 3.4 の左の欄 1・10.5（キャラクター）・11.1（口調）・9.4
 *
 * 顔は簡単な線画の SVG（14 章の 3: 絵の担当が決まるまでの仮。自然な肌と髪の色、光らせない）。
 */

import { t, esc } from './strings.js';

/** 顔の表情（10.5）。 */
export const FACES = Object.freeze(['normal', 'smile', 'think', 'surprise']);

const SKIN = '#f6d7b8';
const HAIR = '#3b2f2a';
const INK = '#2a2522';
const MOUTH = '#8a4b3a';

/**
 * 先輩の顔の SVG（58 × 58 の丸に入る）。
 * @param {'normal'|'smile'|'think'|'surprise'} [face]
 * @returns {string}
 */
export function faceSVG(face = 'normal') {
  const base = `<circle cx="29" cy="29" r="29" fill="${SKIN}"/>` +
    `<path d="M7 30C6 15 16 5 29 5s23 10 22 25c-2-5-5-8-9-10-4 3-11 5-19 4-6 0-11 2-16 6z" fill="${HAIR}"/>` +
    `<path d="M7 30c-1 6 0 11 2 15l3-1c-2-4-2-9-1-13zM51 30c1 6 0 11-2 15l-3-1c2-4 2-9 1-13z" fill="${HAIR}"/>` +
    `<circle cx="17" cy="38" r="3" fill="#f2b8a0" opacity=".55"/><circle cx="41" cy="38" r="3" fill="#f2b8a0" opacity=".55"/>`;
  let eyes = '';
  let mouth = '';
  let brows = '';
  switch (face) {
    case 'smile':
      eyes = `<path d="M19 32q3-3 6 0M33 32q3-3 6 0" stroke="${INK}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      mouth = `<path d="M22 39q7 7 14 0z" fill="${MOUTH}"/>`;
      break;
    case 'think':
      eyes = `<circle cx="23" cy="31" r="2.1" fill="${INK}"/><circle cx="37" cy="31" r="2.1" fill="${INK}"/>`;
      brows = `<path d="M19 26l7-1.5M32 24.5l7 1.5" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`;
      mouth = `<path d="M24 42h9" stroke="${MOUTH}" stroke-width="2" stroke-linecap="round"/>`;
      break;
    case 'surprise':
      eyes = `<circle cx="22" cy="32" r="2.8" fill="${INK}"/><circle cx="36" cy="32" r="2.8" fill="${INK}"/>`;
      brows = `<path d="M18 25.5q4-3 8-0.5M32 25q4-2.5 8 0.5" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
      mouth = `<ellipse cx="29" cy="42" rx="3" ry="3.6" fill="${MOUTH}"/>`;
      break;
    default:
      eyes = `<circle cx="22" cy="32" r="2.2" fill="${INK}"/><circle cx="36" cy="32" r="2.2" fill="${INK}"/>`;
      mouth = `<path d="M23 40c3 3 9 3 12 0" stroke="${MOUTH}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  }
  return `<svg viewBox="0 0 58 58" aria-hidden="true" focusable="false">${base}${brows}${eyes}${mouth}</svg>`;
}

/** ローバー（ぼく）の小さな顔（出力の欄・場面で使う）。 */
export function roverSVG() {
  return '<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="11" cy="27" r="8" fill="#2a3238"/><circle cx="29" cy="27" r="8" fill="#2a3238"/>' +
    '<circle cx="11" cy="27" r="3.5" fill="#d9d2c3"/><circle cx="29" cy="27" r="3.5" fill="#d9d2c3"/><rect x="9" y="12" width="22" height="12" rx="4" fill="#e9e4d8" stroke="#5d6b73"/>' +
    '<circle cx="16" cy="18" r="1.6" fill="#23313a"/><circle cx="24" cy="18" r="1.6" fill="#23313a"/><rect x="19" y="5" width="2" height="7" fill="#5d6b73"/><circle cx="20" cy="5" r="2.2" fill="#d9672b"/></svg>';
}

/**
 * @param {HTMLElement} el 吹き出しを入れる要素
 * @returns {{say: (text: string, face?: string) => void, tip: (hint: {id?: string, say: string}) => HTMLElement, clear: () => void, el: HTMLElement}}
 */
export function createSenpai(el) {
  el.classList.add('story');
  el.innerHTML = `<div class="face">${faceSVG('normal')}</div><div class="bubble"><div class="who">${esc(t('senpai.name'))}</div><div class="say"></div></div>`;
  const faceEl = el.querySelector('.face');
  const sayEl = el.querySelector('.say');
  return {
    el,
    say(text, face = 'normal') {
      faceEl.innerHTML = faceSVG(face);
      sayEl.innerHTML = richText(text);
    },
    tip(hint) { return tipEl(hint && hint.say ? hint.say : String(hint || ''), hint && hint.face); },
    clear() { sayEl.textContent = ''; },
  };
}

/**
 * 出力の欄の先輩のひとこと（見本の .tip。💡 は先輩の顔の小さな丸に）。
 * @param {string} text @param {string} [face] @returns {HTMLElement}
 */
export function tipEl(text, face = 'think') {
  const d = document.createElement('div');
  d.className = 'tip';
  d.innerHTML = `<span class="tip-face">${faceSVG(face)}</span><span class="tip-text"><span class="sr-only">${esc(t('senpai.short'))}: </span>${richText(text)}</span>`;
  return d;
}

/**
 * 文の中の `コード` をコードの字にする（それ以外は字のまま）。改行は <br>。
 * @param {string} s @returns {string}
 */
export function richText(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}
