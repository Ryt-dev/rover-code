# ROVER CODE → CanSatSim の SIL

持ち主: W8（SIL・C・テストの土台・配る形）　／　SPEC: 5.7・12 章「SIL」

ゲームで書いたコードを、CanSatSim の SIL（UDP 127.0.0.1:50100）でそのまま走らせるための説明。
判断の部分（自分のコード）は 1 行も変えない。命令の名前（`motor`・`wait`・`lidar` …）が同じなので、そのまま動く。

## 使い方

1. ゲームの遊ぶ画面で「SIL に書き出す」を押す → `rover_<面>.py`（例 `rover_7-3.py`）が保存される（1 章クリアで使える）。
2. その `.py` と、この `rover_sil.py` を同じフォルダに置く。
3. CanSatSim で「SIL」→「SIL を開始」（画面なしなら `CoreRunner.exe sil preset=2`）。
4. `python rover_7-3.py`

`rover_sil.py` は `CanSatSim/SIL/cansat_sil.py` を使ってつなぐ。探す順は ① 同じフォルダ ② 環境変数 `CANSAT_SIL_DIR` ③ RoverCode の隣の `CanSatSim/SIL`。
どれにも無ければ、`rover_sil.py` の中の同じ働きの小さなクラスでつなぐ（つなぎ方の約束は CanSatSim の SIL の README と同じ）。

## 書き出したファイルの形

```python
# ROVER CODE 7-3 走りながら向きを直す から書き出し（2026-10-17）
# 使い方: CanSatSim で「SIL を開始」してから  python rover_7-3.py
from rover_sil import *          # motor, wait, stop, now, lidar, heading, odometer, encoder,
                                 # gnss, camera, phase, altitude, accel, nichrome, print
# ---- ゲームの面が渡していた値（SIL ではここで決める）
GOAL_LAT, GOAL_LON = HELLO["goal_lat"], HELLO["goal_lon"]   # シミュレータのゴール
LAT0, LON0 = first_fix()                                    # 最初に測位できた所を原点に
# ---- ここから自分のコード（ゲームのまま）
import math
# SIL では上で決めた値を使う: LAT0 = 35.726195     # スタート地点の緯度
...
# ---- ここまで自分のコード
finish()                         # 止めて、接続を閉じる
```

- 面が渡していた数（`GAP`・`ANGLE`・`WAYPOINTS` など）は、ゲームの世界 1 の値に「要確認」のコメントを付けて入れる。SIL の世界に合わせて直そう。
- 自分のコードの一番上にある会場ごとの値の代入（`LAT0`・`LON0`・`GOAL_LAT`・`GOAL_LON`・`WAYPOINTS`・`CHECKPOINTS`・`VIA` に数だけを入れる行）は、
  `# SIL では上で決めた値を使う:` を付けてコメントにする（上で決めた値を上書きしないように）。自分で測った値（`LAT0 = g.lat` など）はそのまま。

## 命令ごとの SIL での中身

| 命令 | SIL での中身 |
|---|---|
| （つなぐ） | 最初の命令（か `HELLO` を読んだ時）に `hello` を送ってつなぐ。返事が `HELLO` に入る |
| `motor(l, r)` | 今の指令として覚える。心拍の糸が 0.05 秒ごとに送り続ける（SIL は 0.5 秒指令が来ないとモーターを止める）。−1〜1 に丸める |
| `stop()` | 指令を 0 にしてブレーキ |
| `wait(s)` | sim の時刻（`imu` の `t`）が s 秒進むまで待つ。PC の時計ではないので、速回ししてもずれない |
| `now()` | sim の時刻（秒）。ゲームと同じく、読むたびに 0.001 秒ぶん進むのを待つ（`while now() - t0 < 2: pass` が CPU を食いつぶさない） |
| `lidar()` | `lidar` の `dist`（m）。`valid` が偽・`strength` が 100 未満・12 m より先は `None` |
| `heading()` | `imu` と `mag` から傾きを補正した方位＋偏角（`hello` の `declination_deg`）。さかさまでも同じ式で正しい |
| `odometer()`・`encoder()` | `enc` の `l`・`r`。m に直すのは `hello` の `encoder_cpr`・`wheel_diameter` |
| `gnss()` | `valid`・`lat`・`lon`・`speed`（`gspeed`）・`course`（`headmot`）・`t`（`t_fix`）。`valid` でなければほかは `None` |
| `camera()` | 前より新しい写真（`t_capture`）が来るまで待つ（最長 1 秒）。`found`・`angle`（`bearing`、右が正）・`size`（`h / img_h`）・`t` |
| `altitude()` | `baro` の気圧を、起動した時の気圧からの高さに |
| `accel()` | `imu` の `(ax, ay, az)` |
| `nichrome(on)`・`phase(name)` | そのまま SIL へ |
| `print(...)` | ふつうに表示して、CanSatSim の記録にも残す（`log`） |
| `distance_to_cone()` | シミュレータの本当の値から計算（本物の機体には無い命令。1 回だけ注意を出す） |
| `marker()` | SIL にはまだ AR マーカーが無いので止まる（`NotImplementedError`） |
| `import time` | `time.sleep` は `wait`、`time.time`・`time.monotonic` は `now` と同じに動く |
| 足したもの | `HELLO`（hello の返事）・`first_fix()`（最初に測位できた所の (緯度, 経度)）・`finish()`（止めて閉じる。最後に自動でも呼ぶ） |

CanSatSim が終わる（コーンにふれた・制限時間）と sim の時刻が止まる。5 秒止まったら、プログラムは静かに終わる。

## ゲームとの違い（知っておくと迷わない）

- **世界（会場・ゴール・風）がちがう**。ゲームと同じ数字で同じ結果になるとはかぎらない。ゴールは `HELLO` から読む。
- **CanSatSim の機体は、止まっている間は前に傾く**（2 輪と後ろのスタビライザー）。その時の LiDAR は近くの地面（0.2〜0.5 m）を返すことがある。
  走り出してしばらくすると水平に近づいて、前のコーンが見える。`motor(…)` のすぐあとに `lidar()` で止まる判定をすると、走り出す前に止まってしまう。
  本物の機体でも起きることなので、走り出してから 0.5 秒ほど `wait` してから測る・何回か続けて近い時だけ止まる、などで備えよう。
- 地上スタートの向きは、人が置くのと同じで ±20° くらいずれる。ゲームのように「真正面にコーン」とはかぎらない。
- `distance_to_cone()` は本物の機体には無い。`marker()` は SIL にはまだ無い。
- 心拍のために、長い計算の間も `wait()` を使うこと（`time.sleep` も `wait` と同じに動く）。

## 困った時

| 出たもの | わけと直し方 |
|---|---|
| 「CanSatSim の SIL から返事が来ないよ」 | SIL を開始していない・ポート 50100 がちがう。CanSatSim で「SIL を開始」してからもう一度 |
| 「シミュレータの時刻が 5 秒止まったので、プログラムを終えるよ」 | CanSatSim が終わった（ゴール・制限時間）か、止められた。CanSatSim の記録を見よう |
| `NotImplementedError: SIL にはまだ AR マーカーが無いよ` | `marker()` を使う面（10-3）のコードは、その部分を別の方法にする |

## 確かめ（W8）

`python tests/sil.test.py` が、見せかけの SIL で全部の命令を、CoreRunner の `sil` で書き出した 1-1・4-3・7-3・9-6 の 4 本を最後まで走らせて確かめる
（記録は `tests/results/sil/<面>/log.txt`）。
