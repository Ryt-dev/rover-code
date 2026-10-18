# vendor（売る版で自前で配るライブラリ）

持ち主: W8（SIL・C・テストの土台・配る形）　／　SPEC: 7.2・7.6・12 章「オフライン（売る版）」「法と表示」

売る版では CDN を使わず、ここに置いたものを配る。中身は `node tools/build.mjs` が作る（手で置かない）。
`sw.js` が先に保存するので、一度開けばネットが無くても遊べる。

| もの | 版 | 置き場所 | ライセンス |
|---|---|---|---|
| Pyodide | 0.26.4 | `pyodide/`（wasm・標準ライブラリ。packages は使わない） | MPL 2.0（中の CPython は PSF） |
| CodeMirror | 5.65.18 | `codemirror/`（editor.js の cdnjs の名前にそろえた。中身は npm の物） | MIT |
| three | 0.160.0 | `three/three.module.js` | MIT |
| Noto Sans JP（400・700）・BIZ UDGothic（400・700） | 部分集合の woff2（画面の文言の字＋JIS 第 1 水準＋記号・かな・英数） | `fonts/`（`fonts.css`） | OFL 1.1 |

ライセンスの文: `LICENSES/`（README.txt に一覧。音の出典は `assets/audio/credits.json`）。

- 元: Pyodide・CodeMirror・three は `tests/node_modules`（`cd tests && npm install`）。
  Noto Sans JP は Windows 11 の `C:\Windows\Fonts\NotoSansJP-VF.ttf`（OFL）から 400・700 を切り出す。
  BIZ UDGothic は google/fonts の OFL 版（Windows に入っている物は Microsoft の約束で配れないので使わない）。
- 売る版の形は `dist/`（app/ の写しで、CDN の URL を vendor/ に置きかえ、sw.js を登録したもの）。
- 開発中と体験版は app/ をそのまま配り、CDN（jsdelivr・cdnjs・Google Fonts）から読む。
