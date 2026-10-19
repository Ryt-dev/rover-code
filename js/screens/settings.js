/**
 * @file app/js/screens/settings.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 設定: 音・全角の自動直し・文字の大きさ・再生の既定の速さ・3D の画質・色・英語のエラー文・地面に描くもの・動きを減らす・
 *       データ（書き出し・読み込み・全部消す・最後に書き出した日・使っている量）・クレジット。
 * SPEC: 3.9・10.1・7.9（読み込みは中身を確かめ、違いを見せてから置きかえる。元に戻せる）
 */

import { resetSavedLayout } from './play_layout.js';
import { esc } from '../ui/strings.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/dialog.js';
import { showCredits } from './title.js';

/**
 * @param {HTMLElement} root @param {object} app @param {string|null} param
 * @returns {{unmount: () => void}}
 */
export function mount(root, app, param) {
  const { t, store } = app;
  app.header.set({ place: t('settings.title') });
  const s = () => store.settings();
  const radio = (name, value, label, cur) => `<label class="opt"><input type="radio" name="${name}" value="${esc(value)}"${String(cur) === String(value) ? ' checked' : ''}> <span>${esc(label)}</span></label>`;
  const check = (name, label, on) => `<label class="opt"><input type="checkbox" name="${name}"${on ? ' checked' : ''}> <span>${esc(label)}</span></label>`;
  const range = (name, label, min, max, v, unit = '') => `<label class="rng"><span>${esc(label)}</span><input type="range" name="${name}" min="${min}" max="${max}" step="1" value="${v}" style="--pz:${((v - min) / (max - min) * 100).toFixed(1)}%"><output>${v}${unit}</output></label>`;

  function render() {
    const st = s();
    const d = store.get();
    const u = store.usage();
    const last = d.lastExportAt ? new Date(d.lastExportAt) : null;
    const lastText = last ? t('settings.last_export', { date: `${last.getFullYear()}/${last.getMonth() + 1}/${last.getDate()}` }) : t('settings.never_exported');
    root.innerHTML = `
    <div class="page settings">
      <h1>${icon('gear')}<span>${esc(t('settings.title'))}</span></h1>
      <form class="set-form" onsubmit="return false">
        <fieldset><legend>${esc(t('settings.sound'))}</legend>
          ${range('sfx', t('settings.sfx'), 0, 100, st.sfx)}
          ${range('ambience', t('settings.ambience'), 0, 100, st.ambience)}
          ${check('mute', t('settings.mute'), st.mute)}
        </fieldset>
        <fieldset><legend>${esc(t('settings.zenkaku'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.zenkaku'))}">
          ${radio('autoZenkaku', 'true', t('settings.zenkaku_on'), st.autoZenkaku)}
          ${radio('autoZenkaku', 'false', t('settings.zenkaku_off'), st.autoZenkaku)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.font'))}</legend>
          ${range('editorFont', t('settings.font_editor', { px: '' }).replace(/\s*px$/, ''), 14, 20, st.editorFont, ' px')}
          ${range('uiFont', t('settings.font_ui', { px: '' }).replace(/\s*px$/, ''), 14, 18, st.uiFont, ' px')}
        </fieldset>
        <fieldset><legend>${esc(t('settings.replay'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.replay'))}">
          ${radio('replaySpeed', 'auto', t('settings.replay_auto'), st.replaySpeed)}
          ${radio('replaySpeed', 'line', t('settings.replay_line'), st.replaySpeed)}
          ${radio('replaySpeed', '1', t('settings.replay_x1'), st.replaySpeed)}
          ${radio('replaySpeed', '2', t('settings.replay_x2'), st.replaySpeed)}
          ${radio('replaySpeed', 'result', t('settings.replay_result'), st.replaySpeed)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.quality'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.quality'))}">
          ${radio('quality', 'auto', t('settings.quality_auto'), st.quality)}
          ${radio('quality', 'light', t('settings.quality_light'), st.quality)}
          ${radio('quality', 'normal', t('settings.quality_normal'), st.quality)}
          ${radio('quality', 'fine', t('settings.quality_fine'), st.quality)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.theme'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.theme'))}">
          ${radio('theme', 'light', t('settings.theme_light'), st.theme)}
          ${radio('theme', 'dusk', t('settings.theme_dusk'), st.theme)}
          ${radio('theme', 'auto', t('settings.theme_auto'), st.theme)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.motion'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.motion'))}">
          ${radio('reduceMotion', 'true', t('settings.motion_on'), st.reduceMotion)}
          ${radio('reduceMotion', 'false', t('settings.motion_off'), st.reduceMotion)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.raw'))}</legend>
          <div class="seg" role="radiogroup" aria-label="${esc(t('settings.raw'))}">
          ${radio('rawError', 'chapter', t('settings.raw_chapter'), st.rawError)}
          ${radio('rawError', 'always', t('settings.raw_always'), st.rawError)}
          </div>
        </fieldset>
        <fieldset><legend>${esc(t('settings.overlays'))}</legend>
          ${check('ov_trail', t('settings.ov_trail'), st.overlays.trail)}
          ${check('ov_ghost', t('settings.ov_ghost'), st.overlays.ghost)}
          ${check('ov_sensors', t('settings.ov_sensors'), st.overlays.sensors)}
          ${check('ov_gnss', t('settings.ov_gnss'), st.overlays.gnss)}
        </fieldset>
        <fieldset class="layout"><legend>${esc(t('settings.layout'))}</legend>
          <p class="note">${esc(t('settings.layout_note'))}</p>
          <button type="button" class="btn" data-a="layout_reset">${icon('reset')}<span>${esc(t('settings.layout_reset'))}</span></button>
        </fieldset>
        <fieldset class="data"><legend>${esc(t('settings.data'))}</legend>
          <p class="note">${esc(lastText)}</p>
          <p class="note">${esc(t('settings.usage', { kb: Math.ceil(u.bytes / 1024), max: Math.round(u.quota / 1024) }))}</p>
          <div class="row">
            <button type="button" class="btn" data-a="export">${icon('download')}<span>${esc(t('settings.export'))}</span></button>
            <label class="btn file-btn">${icon('upload')}<span>${esc(t('settings.import'))}</span><input type="file" accept="application/json,.json" data-a="import" class="sr-only"></label>
            ${store.canUndoImport() ? `<button type="button" class="btn" data-a="undo">${icon('reset')}<span>${esc(t('button.undo'))}</span></button>` : ''}
            <button type="button" class="btn danger" data-a="delete">${esc(t('button.delete_all'))}</button>
          </div>
          <p class="note small">${esc(t('settings.persist_note'))}</p>
        </fieldset>
        <fieldset><legend>${esc(t('settings.credits'))}</legend>
          <button type="button" class="btn" data-a="credits">${icon('info')}<span>${esc(t('button.credits'))}</span></button>
        </fieldset>
      </form>
    </div>`;
  }
  render();

  const apply = (patch) => { store.setSettings(patch); app.applySettings(store.settings()); };
  root.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.type === 'range') {
      const v = Number(el.value);
      el.style.setProperty('--pz', `${((v - Number(el.min)) / (Number(el.max) - Number(el.min)) * 100).toFixed(1)}%`);   // つまみの左を塗る
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = `${v}${el.name.endsWith('Font') ? ' px' : ''}`;
      apply({ [el.name]: v });
      if (el.name === 'sfx') app.audio.play('star', { index: 0 });
    }
  });
  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.type === 'radio') {
      const v = el.value === 'true' ? true : el.value === 'false' ? false : el.value;
      apply({ [el.name]: v });
    } else if (el.type === 'checkbox') {
      if (el.name.startsWith('ov_')) apply({ overlays: { [el.name.slice(3)]: el.checked } });
      else apply({ [el.name]: el.checked });
    } else if (el.type === 'file' && el.files && el.files[0]) {
      const f = el.files[0];
      el.value = '';
      if (f.size > 8 * 1024 * 1024) { app.toast(t('settings.import_bad', { why: 'ファイルが大きすぎる' })); return; }
      const text = await f.text();
      const r = store.importJSON(text);
      if (!r.ok) { app.toast(t('settings.import_bad', { why: r.error })); return; }
      const ok = await confirmDialog(t('settings.import'), t('settings.import_confirm', r.diff));
      if (!ok) return;
      r.commit();
      app.applySettings(store.settings());
      app.refreshHeader();
      app.toast(t('settings.import_done'));
      render();
    }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'export') { app.exportRecord(); render(); }
    else if (a === 'layout_reset') { resetSavedLayout(); app.toast(t('settings.layout_done')); }
    else if (a === 'undo') { if (store.undoImport()) { app.applySettings(store.settings()); app.refreshHeader(); app.toast(t('settings.undo_done')); render(); } }
    else if (a === 'delete') {
      if (!(await confirmDialog(t('button.delete_all'), t('settings.delete_confirm1'), { ok: t('button.delete_all'), danger: true }))) return;
      if (!(await confirmDialog(t('button.delete_all'), t('settings.delete_confirm2'), { ok: t('button.delete_all'), danger: true }))) return;
      store.resetAll();
      app.applySettings(store.settings());
      app.refreshHeader();
      app.toast(t('settings.delete_done'));
      render();
    } else if (a === 'credits') showCredits(app);
  });
  return { unmount() { store.flush(); } };
}
