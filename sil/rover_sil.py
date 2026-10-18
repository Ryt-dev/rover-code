"""rover_sil — ROVER CODE で書いたコードを、CanSatSim の SIL で同じ名前で動かす

持ち主: W8（SIL・C・テストの土台・配る形）
役割: ゲームの命令（motor・wait・lidar など）を、CanSatSim/SIL/cansat_sil.py の CanSatSil（UDP 127.0.0.1:50100、JSON）につなぐ。
      判断の部分（生徒のコード）は 1 行も変えずに動くようにする。
SPEC: 5.7（rover_sil.py の作りの表）・1.2 の約束 1・12 章「SIL」・13.2 W8 ②⑧

使い方（ゲームの「SIL に書き出す」で作った .py の先頭）:
    from rover_sil import *      # motor, wait, stop, now, lidar, heading, odometer, encoder,
                                 # gnss, camera, phase, altitude, accel, nichrome, print
    GOAL_LAT, GOAL_LON = HELLO["goal_lat"], HELLO["goal_lon"]
    LAT0, LON0 = first_fix()
    ...（自分のコード）
    finish()

つなぐ相手（cansat_sil.py）の探し方: ① このファイルと同じフォルダ ② 環境変数 CANSAT_SIL_DIR ③ RoverCode の隣の CanSatSim/SIL
④ どれも無ければ、このファイルの中の同じ働きの小さなクラス（_MiniSil）を使う（UDP の約束は CanSatSim/SIL/README.md と同じ）。

時間はすべて sim の時刻（imu の t）で数える。PC の時計ではないので、CanSatSim を速回し（CoreRunner の --speed）してもずれない。
センサを読む命令は、ゲームと同じ時間（lidar 0.01 s・gnss 0.001 s・now 0.001 s〔1.1〕など）だけ sim の時刻が進むのを待ってから読む。
だから `while lidar() > 0.5: pass` や `while now() - t0 < 2: pass` も CPU を食いつぶさない（12 章「SIL」・13.2 W8 ⑧）。

環境変数（ふだんは要らない）:
    ROVER_SIL_HOST / ROVER_SIL_PORT  … つなぐ先（既定 127.0.0.1 / 50100）
    ROVER_SIL_TIMEOUT                … つなぐ時に返事を待つ秒（既定 10）
    ROVER_SIL_STALL                  … sim の時刻が止まったと見なすまでの PC の秒（既定 5。止まったらプログラムを終える）
    ROVER_SIL_QUIET=1                … 「本物の機体には無い命令だよ」などの注意を出さない
"""
from __future__ import annotations

import atexit
import builtins
import math
import os
import sys
import threading
import time as _time_mod

__all__ = ["motor", "stop", "wait", "now", "lidar", "heading", "odometer", "encoder", "gnss", "camera", "phase",
           "altitude", "accel", "nichrome", "distance_to_cone", "marker", "print", "HELLO", "first_fix", "finish", "Reading"]

# ゲームと同じ「読むのにかかる時間」（SPEC 5.1 の sim の時間の列）
COST = {"lidar": 0.01, "heading": 0.01, "odometer": 0.001, "encoder": 0.001, "gnss": 0.001, "now": 0.001,
        "altitude": 0.01, "accel": 0.01}
LIDAR_MIN, LIDAR_MAX = 0.05, 12.0      # ゲームの LiDAR の範囲（SPEC 6.2）。12 m より先は None
LIDAR_MIN_STRENGTH = 100               # これより弱い返りは「何も無い」（CanSatSim/SIL/sil_example.py と同じ）
BODY_R, CONE_R = 0.12, 0.19            # distance_to_cone のすき間（SPEC 5 章: 機体の円とコーンの円の外側どうし）
HEARTBEAT_S = 0.05                     # 心拍の糸が指令を送る間かく（PC の秒）。SIL は 0.5 s 来ないとモーターを止める

_real_sleep = _time_mod.sleep
_real_time = _time_mod.time
_real_print = builtins.print


# =====================================================================================================
# つなぐ相手
# =====================================================================================================

def _find_cansat_sil():
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [here, os.environ.get("CANSAT_SIL_DIR", "")]
    # RoverCode/app/sil → Claude/CanSatSim/SIL
    up = here
    for _ in range(5):
        up = os.path.dirname(up)
        cands.append(os.path.join(up, "CanSatSim", "SIL"))
    for d in cands:
        if d and os.path.exists(os.path.join(d, "cansat_sil.py")):
            if d not in sys.path:
                sys.path.insert(0, d)
            try:
                from cansat_sil import CanSatSil   # noqa: F401
                return CanSatSil, d
            except Exception:  # noqa
                continue
    return _MiniSil, None


class _MiniSil:
    """cansat_sil.CanSatSil と同じ働きの小さな代わり（cansat_sil.py が見つからない時だけ使う）"""

    def __init__(self, host="127.0.0.1", port=50100):
        import json
        import socket
        self._json = json
        self.addr = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.2)
        self._latest, self._count = {}, {}
        self._lock = threading.Lock()
        self._running = True
        self.hello = None
        self.sim_time = 0.0
        threading.Thread(target=self._rx, daemon=True).start()

    def _rx(self):
        import socket
        while self._running:
            try:
                data, _ = self.sock.recvfrom(65535)
            except (socket.timeout, OSError):
                continue
            try:
                msg = self._json.loads(data.decode("utf-8"))
            except ValueError:
                continue
            kind = msg.get("type", "")
            with self._lock:
                if kind == "hello":
                    self.hello = msg
                self._latest[kind] = msg
                self._count[kind] = self._count.get(kind, 0) + 1
                t = msg.get("t")
                if isinstance(t, (int, float)) and t > self.sim_time:
                    self.sim_time = t

    def get(self, kind):
        with self._lock:
            return self._latest.get(kind)

    def count(self, kind):
        with self._lock:
            return self._count.get(kind, 0)

    def send(self, **kw):
        self.sock.sendto(self._json.dumps(kw).encode("utf-8"), self.addr)

    def connect(self, timeout=10.0):
        t0 = _real_time()
        while self.hello is None:
            self.send(cmd="hello")
            _real_sleep(0.2)
            if _real_time() - t0 > timeout:
                raise TimeoutError("シミュレータから返事がない（SIL を開始したか、ポート 50100 を確認）")
        return self.hello

    def motor(self, left, right, brake=False):
        self.send(cmd="motor", l=max(-1.0, min(1.0, float(left))), r=max(-1.0, min(1.0, float(right))), brake=1 if brake else 0)

    def nichrome(self, on):
        self.send(cmd="nichrome", on=1 if on else 0)

    def phase(self, name):
        self.send(cmd="phase", name=name)

    def log(self, text):
        self.send(cmd="log", text=str(text))

    def heartbeat(self):
        self.send(cmd="heartbeat")

    def close(self):
        self._running = False
        try:
            self.motor(0, 0, brake=True)
        except OSError:
            pass
        self.sock.close()


class SilStopped(SystemExit):
    """sim の時刻が止まった（CanSatSim が終わった・止められた）。プログラムを静かに終える"""


class _State:
    def __init__(self):
        self.sil = None
        self.hello = None
        self.lock = threading.RLock()
        self.cmd = (0.0, 0.0, False)          # 今の指令（左, 右, ブレーキ）
        self.hb = None
        self.hb_stop = threading.Event()
        self.p0 = None                        # 起動時の気圧
        self.last_cam_t = None                # 前に返した写真の t_capture
        self.warned = set()
        self.finished = False
        self.connecting = False
        self.where = None                     # cansat_sil.py の場所（None なら _MiniSil）


_S = _State()


def _note(key, text):
    if key in _S.warned or os.environ.get("ROVER_SIL_QUIET") == "1":
        return
    _S.warned.add(key)
    _real_print(f"〔rover_sil〕{text}", file=sys.stderr)


def _ensure():
    """最初の命令でつなぐ（返事を HELLO に入れ、心拍の糸を動かす）"""
    if _S.sil is not None:
        return _S.sil
    with _S.lock:
        if _S.sil is not None:
            return _S.sil
        if _S.finished:
            raise RuntimeError("finish() のあとは、もう命令を送れないよ")
        cls, where = _find_cansat_sil()
        _S.where = where
        host = os.environ.get("ROVER_SIL_HOST", "127.0.0.1")
        port = int(os.environ.get("ROVER_SIL_PORT", "50100"))
        sil = cls(host, port)
        _S.connecting = True
        try:
            hello = sil.connect(timeout=float(os.environ.get("ROVER_SIL_TIMEOUT", "10")))
        except TimeoutError:
            try:
                sil.close()
            except Exception:  # noqa
                pass
            raise ConnectionError("CanSatSim の SIL から返事が来ないよ。CanSatSim で「SIL を開始」してから、もう一度動かしてね"
                                  "（画面なしなら CoreRunner.exe sil）") from None
        finally:
            _S.connecting = False
        _S.hello = dict(hello)
        _S.sil = sil
        # センサの最初の値が来るまで待つ（imu は 100 Hz）
        t0 = _real_time()
        while sil.get("imu") is None and _real_time() - t0 < 3.0:
            _real_sleep(0.01)
        _S.hb_stop.clear()
        _S.hb = threading.Thread(target=_heartbeat, name="rover_sil 心拍", daemon=True)
        _S.hb.start()
        _patch_time()
        return sil


def _heartbeat():
    """今の指令を 0.05 s（PC の秒）ごとに送り続ける。SIL は指令が 0.5 s 来ないとモーターを止める"""
    while not _S.hb_stop.is_set():
        sil = _S.sil
        if sil is None:
            break
        l, r, brake = _S.cmd
        try:
            sil.motor(l, r, brake=brake)
        except OSError:
            pass
        _S.hb_stop.wait(HEARTBEAT_S)


def _t():
    """今の sim の時刻（imu の t）"""
    sil = _ensure()
    imu = sil.get("imu")
    if imu and isinstance(imu.get("t"), (int, float)):
        return float(imu["t"])
    return float(getattr(sil, "sim_time", 0.0))


def _wait_until(target):
    """sim の時刻が target になるまで待つ（PC の時計ではない）"""
    stall = float(os.environ.get("ROVER_SIL_STALL", "5"))
    last_t = _t()
    last_change = _real_time()
    while True:
        t = _t()
        if t >= target - 1e-9:
            return t
        if t != last_t:
            last_t, last_change = t, _real_time()
        elif _real_time() - last_change > stall:
            _real_print(f"〔rover_sil〕シミュレータの時刻が {stall:.0f} 秒止まったので、プログラムを終えるよ（t = {t:.2f} s）", file=sys.stderr)
            raise SilStopped(0)
        _real_sleep(0.002)


def _spend(kind):
    c = COST.get(kind, 0.0)
    t = _t()
    if c > 0:
        _wait_until(t + c)


# =====================================================================================================
# 引数の確かめ（ゲームと同じに、数でないものは止める）
# =====================================================================================================

def _num(func, name_ja, v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        if v is None:
            raise TypeError(f"{func}() の{name_ja}が None だよ（数を入れてね）")
        raise TypeError(f"{func}() の{name_ja}には数を入れてね（いまは {type(v).__name__} の {v!r}）")
    if isinstance(v, float) and math.isnan(v):
        raise ValueError(f"{func}() の{name_ja}が NaN（数でない）だよ")
    return float(v)


# =====================================================================================================
# 返す入れ物（ゲームと同じ: g.lat でも g["lat"] でも読める）
# =====================================================================================================

class Reading(dict):
    """dict の子。g.lat でも g["lat"] でも読める（本物の SIL の値は dict なので両方通す）"""

    _kind = "Reading"

    def __init__(self, kind="Reading", **kw):
        super().__init__(**kw)
        object.__setattr__(self, "_kind", kind)

    def __getattr__(self, k):
        if k.startswith("__"):
            raise AttributeError(k)
        try:
            return self[k]
        except KeyError:
            import difflib
            close = difflib.get_close_matches(k, list(self.keys()), n=1, cutoff=0.5)
            hint = f"（{close[0]} のこと？）" if close else ""
            raise AttributeError(f"{self._kind} に「{k}」は無いよ{hint}。あるのは {', '.join(self.keys())}") from None

    def __repr__(self):
        def f(v):
            return f"{v:.7f}".rstrip("0") if isinstance(v, float) and abs(v) > 30 else (f"{v:.2f}" if isinstance(v, float) else repr(v))
        return f"{self._kind}(" + ", ".join(f"{k}={f(v)}" for k, v in self.items()) + ")"

    __str__ = __repr__


class _LazyHello(dict):
    """HELLO（hello の返事）。`from rover_sil import *` の時はまだつながないで、最初に読んだ時につなぐ"""

    def _real(self):
        _ensure()
        return _S.hello or {}

    def __getitem__(self, k):
        return self._real()[k]

    def get(self, k, d=None):
        return self._real().get(k, d)

    def keys(self):
        return self._real().keys()

    def items(self):
        return self._real().items()

    def values(self):
        return self._real().values()

    def __contains__(self, k):
        return k in self._real()

    def __iter__(self):
        return iter(self._real())

    def __len__(self):
        return len(self._real())

    def __repr__(self):
        return repr(self._real()) if _S.sil is not None else "HELLO（まだつないでいない）"


HELLO = _LazyHello()


# =====================================================================================================
# ゲームの命令（SPEC 5.1・5.7 の表）
# =====================================================================================================

def motor(left, right):
    """今の指令として覚える（心拍の糸が 0.05 s ごとに sil.motor(l, r) で送る）。−1〜1 に丸める。"""
    l = _num("motor", "左", left)
    r = _num("motor", "右", right)
    if not (-1 <= l <= 1 and -1 <= r <= 1):
        _note("motor_range", f"motor({left}, {right}) は −1〜1 にまるめたよ")
    l, r = max(-1.0, min(1.0, l)), max(-1.0, min(1.0, r))
    sil = _ensure()
    _S.cmd = (l, r, False)
    sil.motor(l, r, brake=False)


def stop():
    """今の指令を 0 にして sil.motor(0, 0, brake=True)。"""
    sil = _ensure()
    _S.cmd = (0.0, 0.0, True)
    sil.motor(0.0, 0.0, brake=True)


def wait(seconds):
    """imu の t（sim の時刻）が seconds 進むまで待つ。"""
    s = _num("wait", "秒", seconds)
    if s < 0:
        raise ValueError(f"wait() の秒はマイナスにできないよ（いまは {seconds}）")
    t0 = _t()
    _wait_until(t0 + s)


def now():
    """imu の t（sim の秒）。〔1.1〕ゲームと同じく 0.001 s 進むのを待ってから返す（while now() - t0 < 2: pass が CPU を食いつぶさない）。"""
    _spend("now")
    return _t()


def lidar():
    """LiDAR の dist（m）。valid が偽・strength が小さい・0.05〜12 m の外は None。"""
    _spend("lidar")
    m = _S.sil.get("lidar")
    if not m or not m.get("valid") or m.get("strength", 0) < LIDAR_MIN_STRENGTH:
        return None
    d = float(m.get("dist", 0.0))
    if d > LIDAR_MAX:
        return None
    return round(max(LIDAR_MIN, d), 2)


def _tilt_heading(acc, mag, decl_deg):
    """傾きを補正した方位（真北、度、時計回り）。CanSatSim/SIL/sil_example.py の式（さかさまでも同じ式で正しい）。"""
    ax, ay, az = acc
    mx, my, mz = mag
    n = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
    dx, dy, dz = -ax / n, -ay / n, -az / n
    ex, ey, ez = dy * mz - dz * my, dz * mx - dx * mz, dx * my - dy * mx
    en = math.sqrt(ex * ex + ey * ey + ez * ez) or 1.0
    ex, ey, ez = ex / en, ey / en, ez / en
    nx = ey * dz - ez * dy
    return (math.degrees(math.atan2(ex, nx)) + decl_deg) % 360.0


def heading():
    """imu と mag から傾きを補正した方位＋偏角（hello の declination_deg）。北 0・東 90・時計回り、0.1 度単位。"""
    _spend("heading")
    imu, mag = _S.sil.get("imu"), _S.sil.get("mag")
    if not imu or not mag:
        return None
    decl = float((_S.hello or {}).get("declination_deg", 0.0))
    h = _tilt_heading((imu["ax"], imu["ay"], imu["az"]), (mag["mx"], mag["my"], mag["mz"]), decl)
    return round(h, 1) % 360.0


def encoder():
    """enc の (l, r)（車輪 1 回転で hello の encoder_cpr）。"""
    _spend("encoder")
    e = _S.sil.get("enc") or {}
    return (int(e.get("l", 0)), int(e.get("r", 0)))


def odometer():
    """左右の車輪が回った距離の平均（m）。enc を hello の encoder_cpr・wheel_diameter で m に。"""
    _spend("odometer")
    e = _S.sil.get("enc") or {}
    h = _S.hello or {}
    cpr = float(h.get("encoder_cpr", 2000)) or 2000.0
    wd = float(h.get("wheel_diameter", 0.127))
    return (float(e.get("l", 0)) + float(e.get("r", 0))) / 2.0 / cpr * math.pi * wd


def gnss():
    """gnss の valid・lat・lon・gspeed→speed・headmot→course・t_fix→t。valid でなければ valid 以外は None。"""
    _spend("gnss")
    g = _S.sil.get("gnss")
    if not g or not g.get("valid"):
        return Reading("GNSS", valid=False, lat=None, lon=None, speed=None, course=None, t=None)
    return Reading("GNSS", valid=True, lat=float(g["lat"]), lon=float(g["lon"]), speed=float(g.get("gspeed", 0.0)),
                   course=float(g.get("headmot", 0.0)) % 360.0, t=float(g.get("t_fix", g.get("t", 0.0))))


def camera():
    """新しい写真（前に返したものより t_capture が新しい cam）が来るまで待ち（sim の最長 1 s）、
    detected→found・bearing→angle（右が正）・h / img_h→size・t_capture→t。見つけていなければ angle・size は None。"""
    sil = _ensure()
    t_start = _t()
    while True:
        c = sil.get("cam")
        tc = c.get("t_capture") if c else None
        if c and (_S.last_cam_t is None or (tc is not None and tc > _S.last_cam_t)) and (tc is None or tc >= t_start - 0.45):
            break
        if _t() - t_start >= 1.0:
            return Reading("Camera", found=False, angle=None, size=None, t=None)
        _real_sleep(0.002)
    _S.last_cam_t = tc
    found = bool(c.get("detected")) and float(c.get("conf", 1.0)) > 0.5
    if not found:
        return Reading("Camera", found=False, angle=None, size=None, t=float(tc) if tc is not None else None)
    img_h = float(c.get("img_h", 480)) or 480.0
    return Reading("Camera", found=True, angle=float(c.get("bearing", 0.0)), size=min(1.0, float(c.get("h", 0.0)) / img_h),
                   t=float(tc) if tc is not None else None)


def altitude():
    """baro の p を起動時の気圧 p0 で高さに（44330.8 ×（1 −（p/p0）^0.190263））。"""
    _spend("altitude")
    b = _S.sil.get("baro")
    if not b:
        return 0.0
    p = float(b["p"])
    if _S.p0 is None:
        _S.p0 = p
    return 44330.8 * (1.0 - (p / _S.p0) ** 0.190263)


def accel():
    """imu の (ax, ay, az)（m/s²、機体の座標 x 前・y 左・z 上。正立で止まっていれば az ≈ +9.8）。"""
    _spend("accel")
    i = _S.sil.get("imu") or {}
    return (float(i.get("ax", 0.0)), float(i.get("ay", 0.0)), float(i.get("az", 9.80665)))


def nichrome(on):
    """sil.nichrome(on)。True で電気を流す、False で止める。"""
    _ensure().nichrome(bool(on))


def phase(name):
    """sil.phase(name)（画面とイベントの記録に出る。心拍も兼ねる）。"""
    _ensure().phase(str(name))


def print(*values, sep=" ", end="\n", file=None, flush=False):  # noqa: A001（ゲームと同じ名前）
    """ふつうの print ＋ sil.log(text)（CanSatSim の記録にも残る）。"""
    _real_print(*values, sep=sep, end=end, file=file, flush=flush)
    if file is None or file is sys.stdout:
        try:
            text = (sep if sep is not None else " ").join(str(v) for v in values)
            sil = _ensure()
            sil.log(text)
        except (OSError, ConnectionError, SilStopped):
            pass


def distance_to_cone():
    """truth（シミュレータの本当の値）から、コーンまでのすき間（m）。本物の機体には無い命令。"""
    _note("distance_to_cone", "distance_to_cone() は本物の機体には無い命令だよ（SIL ではシミュレータの本当の位置から計算しているよ）")
    sil = _ensure()
    tr = sil.get("truth")
    t0 = _real_time()
    while tr is None and _real_time() - t0 < 1.0:
        _real_sleep(0.01)
        tr = sil.get("truth")
    if tr is None:
        return None
    return max(0.0, float(tr.get("goal_dist", 0.0)) - BODY_R - CONE_R)


def marker():
    """SIL にはまだ AR マーカーが無い。"""
    raise NotImplementedError("SIL にはまだ AR マーカーが無いよ（marker() は使えない）")


def first_fix(timeout=120.0):
    """最初に valid になった GNSS の (lat, lon) を待って返す（sim の秒で timeout まで）。"""
    _ensure()
    t0 = _t()
    while True:
        g = _S.sil.get("gnss")
        if g and g.get("valid"):
            return (float(g["lat"]), float(g["lon"]))
        if _t() - t0 > timeout:
            raise TimeoutError(f"GNSS が {timeout:.0f} 秒たっても測位できなかったよ")
        _wait_until(_t() + 0.05)


def finish():
    """止めて、接続を閉じる（2 回呼んでもよい）。"""
    if _S.finished:
        return
    _S.finished = True
    sil = _S.sil
    if sil is None:
        return
    _S.cmd = (0.0, 0.0, True)
    try:
        sil.motor(0.0, 0.0, brake=True)
        _real_sleep(0.1)
        sil.motor(0.0, 0.0, brake=True)
    except OSError:
        pass
    if os.environ.get("ROVER_SIL_SUMMARY") == "1":
        tr, e, h = sil.get("truth") or {}, sil.get("enc") or {}, _S.hello or {}
        cpr, wd = float(h.get("encoder_cpr", 2000)) or 2000.0, float(h.get("wheel_diameter", 0.127))
        od = (abs(float(e.get("l", 0))) + abs(float(e.get("r", 0)))) / 2.0 / cpr * math.pi * wd
        _real_print(f"〔rover_sil〕おわり: t = {tr.get('t', 0):.1f} s・位置 ({tr.get('x', 0):.2f}, {tr.get('y', 0):.2f}) m・"
                    f"ゴールまで {tr.get('goal_dist', float('nan')):.2f} m・車輪で {od:.2f} m", file=sys.stderr)
    _S.hb_stop.set()
    if _S.hb is not None:
        _S.hb.join(timeout=0.5)
    try:
        sil.close()
    except Exception:  # noqa
        pass
    _unpatch_time()


atexit.register(finish)


# =====================================================================================================
# import time の time.sleep は wait、time.time・time.monotonic は now と同じに動かす（SPEC 5.1 の import time）
# =====================================================================================================

def _sleep_like_wait(s):
    if _S.sil is not None and not _S.connecting and not _S.finished and threading.current_thread() is threading.main_thread():
        _note("sleep", "time.sleep は SIL では wait と同じに動くよ（sim の時刻で待つ）")
        return wait(s)
    return _real_sleep(s)


def _time_like_now():
    if _S.sil is not None and not _S.connecting and not _S.finished and threading.current_thread() is threading.main_thread():
        return now()
    return _real_time()


def _patch_time():
    _time_mod.sleep = _sleep_like_wait
    _time_mod.time = _time_like_now
    _time_mod.monotonic = _time_like_now


def _unpatch_time():
    _time_mod.sleep = _real_sleep
    _time_mod.time = _real_time
    _time_mod.monotonic = _MONO


_MONO = _time_mod.monotonic
