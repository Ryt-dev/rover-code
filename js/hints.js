/**
 * @file app/js/hints.js
 * 持ち主: W7（画面・流れ・保存・音）
 * 役割: 段階のヒント（3 段）と先輩の答え。次の段は「前の段を開いてからもう 1 回実行」か「30 s たった」で開く。
 *       同じ種類の失敗が 3 回続いたら「ヒント 1 を見てみる？」と声をかける（1 面で 1 回まで）。
 * SPEC: 3.6（ヒントと先輩の答え）・4 章の 5・8.3 #13（ボスは 3 段目をクリア後に）
 *
 * 形（W7 が決めた）:
 *   const h = createHints(level, levelState, { now: () => Date.now(), cleared: () => bool })
 *   h.total()          今見られる段の数（ボスでクリア前は 2、それ以外は hints の数で最大 3）
 *   h.opened()         開いた段の数（levelState.hintsOpened）
 *   h.canOpen(i)       i 段目（0 から）を今開けるか
 *   h.remainingMs(i)   i 段目が開くまでの残り ms（0 なら開ける。もう 1 回実行しても開く）
 *   h.open(i)          開いて文を返す（levelState.hintsOpened を増やす。保存は呼ぶ側）
 *   h.onRun()          計算まで進んだ実行の後に呼ぶ（次の段が開く）
 *   h.canSeeAnswer()   先輩の答えを見られるか（ボスはクリアしてから）
 *   h.answer()         { code, labels }（ボスでクリア前は null）
 *   h.noteResult(id)   失敗の ID（エラーの ID か先輩のひとことの ID。成功は null）。声をかける時に true
 */

/** 次の段が開くまでの時間 ms（3.6）。 */
export const HINT_WAIT_MS = 30000;
/** 同じ失敗が何回続いたら声をかけるか（3.6）。 */
export const NUDGE_REPEAT = 3;

/**
 * 1 つの面のヒントの状態を作る。
 * @param {object} level レベルの定義（hints・solution・solution_labels・checkpoint）
 * @param {object} levelState store の levels[id]（hintsOpened・answerSeen）
 * @param {{now?: () => number, cleared?: () => boolean}} [opts]
 */
export function createHints(level, levelState, { now = () => Date.now(), cleared = () => !!levelState.cleared } = {}) {
  const hints = Array.isArray(level && level.hints) ? level.hints.slice(0, 3) : [];
  const boss = !!(level && (level.checkpoint || level.type === 'boss' || level.type === 'final'));   // ボス面は説明どおり 2 つまで（直し A-17）
  let lastOpenAt = now();          // 面を開いた時から数える（読み直した時も 30 s 待つ）
  let runsSinceOpen = 0;
  let nudged = false;
  let lastFail = null;
  let failRun = 0;

  const total = () => (boss && !cleared() ? Math.min(2, hints.length) : hints.length);
  const opened = () => Math.min(levelState.hintsOpened || 0, hints.length);

  const api = {
    total,
    opened,
    /** 残りの段（ボタンの「あと n 回」）。 */
    left() { return Math.max(0, total() - opened()); },
    canOpen(i) {
      if (i !== opened() || i >= total()) return false;
      if (i === 0) return true;
      return runsSinceOpen >= 1 || now() - lastOpenAt >= HINT_WAIT_MS;
    },
    remainingMs(i) {
      if (i !== opened() || i >= total()) return Infinity;
      if (i === 0 || runsSinceOpen >= 1) return 0;
      return Math.max(0, HINT_WAIT_MS - (now() - lastOpenAt));
    },
    /** 開いた段をもう一度読む（開いていない段は null）。 */
    text(i) { return i < opened() ? hints[i] : null; },
    open(i) {
      if (i < opened()) return hints[i];
      if (!api.canOpen(i)) return null;
      levelState.hintsOpened = i + 1;
      lastOpenAt = now();
      runsSinceOpen = 0;
      return hints[i];
    },
    onRun() { runsSinceOpen += 1; },
    /** ボスの 3 段目がクリア前で閉じているか。 */
    bossLocked() { return boss && !cleared() && hints.length > 2; },
    canSeeAnswer() { return !!(level && level.solution) && (!boss || cleared()); },
    answer() {
      if (!api.canSeeAnswer()) return null;
      return { code: level.solution, labels: Array.isArray(level.solution_labels) ? level.solution_labels : [] };
    },
    noteResult(failId) {
      if (!failId) { lastFail = null; failRun = 0; return false; }
      if (failId === lastFail) failRun += 1;
      else { lastFail = failId; failRun = 1; }
      if (!nudged && failRun >= NUDGE_REPEAT && opened() === 0) { nudged = true; return true; }
      return false;
    },
  };
  return api;
}
