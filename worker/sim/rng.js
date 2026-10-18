/**
 * @file app/worker/sim/rng.js
 * 持ち主: W1（シミュレータ）
 * 役割: 乱数（mulberry32）と種の作り方（hash32）。同じ種なら記録が 1 ビットも違わない（6.9）。
 * SPEC: 6.9・13.2 W1 ③⑩
 *
 * 種の決まり（6.9。種を作るのは W2 の engine.js。ここの hash32 を import して使う）:
 *   世界 = hash32(面の id + ":" + 世界の番号)、本番テスト = hash32(面の id + ":t" + 回の番号)、
 *   GNSS のずれ = hash32(… + ":gnss")（別の流れ。整数の秒ごとに決まった数だけ進める）、
 *   自由走行場 = 保存した種。
 * gauss は Box–Muller（一様乱数 2 つで 1 つ）。log・cos は geometry.js の決まった答えの関数を使う
 * （Math.log・Math.cos はブラウザで最後の桁が違うことがある。6.7〔1.1〕）。
 */

import { dlog, dcos, TWO_PI } from './geometry.js';

/**
 * 文字列から 32 ビットの種を作る（FNV-1a ＋ murmur3 の仕上げ。UTF-16 の 1 文字ずつ）。
 * @param {string} text 例 "1-3:1"
 * @returns {number} 0〜2^32−1 の整数
 */
export function hash32(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * mulberry32 の乱数の流れを作る。
 * @param {number} seed 32 ビットの種（数でないときは 0）
 * @returns {() => number} 呼ぶたびに 0 以上 1 未満の数を返す関数
 */
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 標準正規分布の数（平均 0・σ 1）。Box–Muller（一様乱数を 2 つ使う）。読んだ順に主の流れから引く（6.9）。
 * @param {() => number} rand mulberry32 の流れ
 * @returns {number}
 */
export function gauss(rand) {
  const u1 = 1 - rand();          // (0, 1]
  const u2 = rand();
  return Math.sqrt(-2 * dlog(u1)) * dcos(TWO_PI * u2);
}

/** a 以上 b 未満の一様な数。 @param {() => number} rand @param {number} a @param {number} b */
export function uniform(rand, a, b) { return a + (b - a) * rand(); }
