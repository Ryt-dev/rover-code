/**
 * @file app/js/export_sil.js
 * 持ち主: W8（SIL・C・テストの土台・配る形）
 * 役割: 遊ぶ画面の「SIL に書き出す」。ゲームで書いたコードを、CanSatSim の SIL（UDP 127.0.0.1:50100）で動く .py にして保存させる。
 * SPEC: 5.7（書き出しの形と注意）・1.4・2.5（1 章クリアで開く）・12 章「SIL」
 *
 * ◆ 決定（W8。使うのは W7 の遊ぶ画面・設定）:
 *   const file = buildSilPy({ levelId, title, code, inject, lang });   // inject は世界 1 の inject（level.worlds[0].inject）
 *   if (file.ok) { 画面に file.notes を出す（注意。1 行ずつ）→ downloadSilPy(file) }
 *   else         { file.notes[0] を出す（C の面など、書き出せない理由） }
 *   rover_sil.py と README_SIL.md は SIL_FILES のパス（app/ からの相対）に置いてあるので、同じダイアログにリンクを出す。
 *
 * 書き出しの形（5.7）: 先頭のコメント（面と日付・使い方）→ from rover_sil import * → 面が渡していた値（GOAL_LAT・GOAL_LON は
 * HELLO から、LAT0・LON0 は first_fix() から、それ以外の inject は世界 1 の値に「要確認」のコメント）→ 自分のコード（一番上の段にある
 * 会場ごとの値の代入 LAT0・LON0・GOAL_LAT・GOAL_LON・WAYPOINTS・CHECKPOINTS・VIA のうち、上で決めた名前への数だけの代入は
 * 「# SIL では上で決めた値を使う:」を付けてコメントに）→ finish()。
 */

/** 会場ごとに違う値（SPEC 5.7「書き出しの注意」）。 */
export const VENUE_NAMES = ['LAT0', 'LON0', 'GOAL_LAT', 'GOAL_LON', 'WAYPOINTS', 'CHECKPOINTS', 'VIA'];

/** 書き出した .py と一緒に置くファイル（app/ からの相対のパス）。 */
export const SIL_FILES = { roverSil: 'sil/rover_sil.py', readme: 'sil/README_SIL.md' };

const COMMENT_MARK = '# SIL では上で決めた値を使う: ';

/** JS の値 → Python の書き方（数・文字・真偽・None・リスト・辞書）。 */
export function pyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'float("nan")' : (v > 0 ? 'float("inf")' : '-float("inf")');
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ')}}`;
  return 'None';
}

/** 2026-10-17 の形。 */
function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 行の # から先（文字の中の # は数えない）を取る。 */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '\\') { i++; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDepth(text) {
  let d = 0;
  for (const ch of text) {
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
  }
  return d;
}

/**
 * 一番上の段の「会場ごとの値への、数だけの代入」をコメントにする。
 * @param {string} code @param {Set<string>} names コメントにしてよい名前（書き出しの先頭で決めたもの）
 * @returns {{code: string, commented: string[]}}
 */
export function commentVenueAssigns(code, names) {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const commented = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }
    const targets = m[1].split(',').map((s) => s.trim());
    if (!targets.every((t) => names.has(t) && VENUE_NAMES.includes(t))) { out.push(line); continue; }
    // 右辺（かっこが閉じるまで続く行も）
    let rhs = stripComment(m[2]);
    let j = i;
    while (bracketDepth(rhs) > 0 && j + 1 < lines.length) {
      j++;
      rhs += '\n' + stripComment(lines[j]);
    }
    if (!/^[\s\d.eE+\-,[\]()]*$/.test(rhs) || !/\d/.test(rhs)) {   // 数だけの代入でなければ（自分で測った値など）そのまま
      out.push(line);
      continue;
    }
    out.push(COMMENT_MARK + line);
    for (let k = i + 1; k <= j; k++) out.push('#     ' + lines[k]);
    commented.push(...targets);
    i = j;
  }
  return { code: out.join('\n'), commented };
}

/**
 * 書き出す .py の中身を作る（画面の外でも動く、ふつうの関数。テストは tests/sil.test.py が Node で呼ぶ）。
 * @param {{levelId: string, title: string, code: string, inject?: object, date?: Date, lang?: 'python'|'c'}} src
 * @returns {{ok: boolean, filename: string|null, text: string|null, notes: string[]}}
 *   filename は rover_<面>.py、notes は書き出す時に画面に出す注意（1 つ 1 文）
 */
export function buildSilPy(src) {
  const { levelId = 'free', title = '', inject = {}, lang = 'python' } = src || {};
  const code = String((src && src.code) || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const date = (src && src.date) || new Date();
  if (lang === 'c') {
    return {
      ok: false, filename: null, text: null,
      notes: ['C の面のコードは、まだ SIL に書き出せないよ。同じ動きを Python の面で書いて、そちらを書き出そう'],
    };
  }
  const safeId = String(levelId).replace(/[^\w.-]/g, '_');
  const filename = `rover_${safeId}.py`;
  const uses = (name) => new RegExp(`\\b${name}\\b`).test(code);
  const inj = inject && typeof inject === 'object' ? inject : {};
  const head = [];
  const defined = new Set();
  const notes = [];
  if ('GOAL_LAT' in inj || 'GOAL_LON' in inj || uses('GOAL_LAT') || uses('GOAL_LON')) {
    head.push('GOAL_LAT, GOAL_LON = HELLO["goal_lat"], HELLO["goal_lon"]   # シミュレータのゴール');
    defined.add('GOAL_LAT'); defined.add('GOAL_LON');
  }
  if ('LAT0' in inj || 'LON0' in inj || uses('LAT0') || uses('LON0')) {
    head.push('LAT0, LON0 = first_fix()                                    # 最初に測位できた所を原点に');
    defined.add('LAT0'); defined.add('LON0');
  }
  const unsure = [];
  for (const [k, v] of Object.entries(inj)) {
    if (defined.has(k) || !/^[A-Za-z_]\w*$/.test(k)) continue;
    const lit = pyLiteral(v);
    const left = `${k} = ${lit}`;
    head.push(`${left.length < 60 ? left.padEnd(60) : left}# 要確認: ゲームの世界 1 の値（SIL の世界では違うかもしれない）`);
    defined.add(k);
    unsure.push(k);
  }
  const { code: body, commented } = commentVenueAssigns(code, defined);
  const lines = [
    `# ROVER CODE ${levelId}${title ? ` ${title}` : ''} から書き出し（${ymd(date)}）`,
    `# 使い方: CanSatSim で「SIL を開始」してから  python ${filename}`,
    '#        （同じフォルダに rover_sil.py を置く。rover_sil.py は CanSatSim/SIL/cansat_sil.py を使う）',
    'from rover_sil import *          # motor, wait, stop, now, lidar, heading, odometer, encoder,',
    '                                 # gnss, camera, phase, altitude, accel, nichrome, print',
  ];
  if (head.length) {
    lines.push('# ---- ゲームの面が渡していた値（SIL ではここで決める）');
    lines.push(...head);
  }
  lines.push('# ---- ここから自分のコード（ゲームのまま）');
  lines.push(body.replace(/\s+$/, ''));
  lines.push('# ---- ここまで自分のコード');
  lines.push('finish()                         # 止めて、接続を閉じる');
  const text = lines.join('\n') + '\n';

  // 書き出す時に画面に出す注意（SPEC 5.7「書き出しの注意」）
  notes.push('SIL は世界がちがう（会場・ゴール・風）ので、ゲームと同じ結果になるとはかぎらないよ');
  if (unsure.length) notes.push(`面の数字（${unsure.join('・')}）は、世界 1 の値に「要確認」のコメントを付けて入れたよ`);
  if (defined.has('GOAL_LAT')) notes.push('ゴールは HELLO（シミュレータの返事）から読むよ');
  if (defined.has('LAT0')) notes.push('原点（LAT0・LON0）は、SIL で最初に測位できた所にしたよ');
  if (commented.length) notes.push(`自分のコードの ${[...new Set(commented)].join('・')} の代入は、上で決めた値を使うのでコメントにしたよ`);
  notes.push('心拍のために wait() を使ってね（time.sleep も wait と同じに動くよ）');
  if (uses('distance_to_cone')) notes.push('distance_to_cone() は本物の機体には無い命令。SIL ではシミュレータの本当の位置から計算するよ');
  if (uses('marker')) notes.push('marker() は SIL にはまだ無いので、呼んだ所で止まるよ');
  notes.push('同じフォルダに rover_sil.py を置いてから動かしてね');
  return { ok: true, filename, text, notes };
}

/**
 * ファイルとして保存させる（a[download]）。ブラウザの中だけで動く。
 * @param {{filename: string, text: string}} file
 */
export function downloadSilPy(file) {
  if (!file || !file.filename || typeof file.text !== 'string') return false;
  const blob = new Blob([file.text], { type: 'text/x-python;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return true;
}
