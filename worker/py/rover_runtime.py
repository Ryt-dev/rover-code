"""ROVER CODE 生徒のコードを動かす Python の側（rover_runtime）

持ち主: W2（実行エンジン）
役割: 生徒のコードを compile して実行し、命令（motor など）を JS の sim（_rover_js）へ同期でつなぐ。
      行の記録（sys.monitoring の LINE と JUMP）・3 段の上限の 1・2 段目・5.5 節の環境を受け持つ。
SPEC: 5 章（API と環境）・7.3「W2 worker/py/rover_runtime.py」・7.5（上限）・6.11（記録の Python の部分）
元にしたもの: spike/rover_runtime.py（〔1.1〕LINE だけだったので JUMP も数えるよう直した）

error_explain.py（W3）は、ここの _LineLimit・_TimeUp・_hits・_warnings・FILENAME の名前を前提にしている。
API の関数はモジュールの一番上で def する（エラー文に修飾なしの名前 motor() が出るように。5.3）。

JS 側（engine.js が registerJsModule("_rover_js", api) で渡す）の約束:
    motor(l, r, line) -> bool（丸めたら True）     wait(s, line) -> t（時間切れは -1）    now(line) -> t（-1 は時間切れ）
    lidar・heading・odometer・altitude(line) -> 数か None     encoder・accel(line) -> 配列
    gnss・camera・marker(line) -> オブジェクト（camera の故障は {broken: true}）    distanceToCone() -> 数
    nichrome(on, line)・phase(name, line)     t（読むだけ。時間切れなら -1）     progress(t, lines)（0.1 s ごと。番犬をなでる）
"""
import ast
import builtins
import difflib
import gc
import importlib.util
import json
import math
import sys
import types
from time import perf_counter as _wall

try:  # Pyodide の中では engine.js が先に登録する。CPython のテストでは set_js() で差しこむ
    import _rover_js as _js
except ImportError:  # pragma: no cover
    _js = None

FILENAME = "main.py"

# ------------------------------------------------------------------ 止める仕組み（どちらも BaseException の子）
class _LineLimit(BaseException):
    """行数（LINE＋JUMP）か計算時間の上限で止めた。reason は "lines"・"wall"（sim の時間が進まないまま実時間が過ぎた）・
    "busy"（sim の時間は進んでいたが、実時間の大きな安全の上限に来た＝PC が混んでいた。失敗に数えない。直し係 4）、line は止めた行。"""

    def __init__(self, reason="lines", line=None):
        super().__init__(reason)
        self.reason = reason
        self.line = line


class _TimeUp(BaseException):
    """sim の時間切れ（世界の time_limit を超えた）。"""


# ------------------------------------------------------------------ 実行中の状態（速さのため global）
_hits = []            # 行ごとの実行回数（添え字＝行番号）。error_explain.py が読む
_warnings = []        # 止めずに直した注意 [t, line, text, kind, 回数]。error_explain.py が読む（w[0]=t, w[1]=line）
_warn_seen = {}
_now = 0.0            # sim の時刻（JS から返るたびに更新）
_count = 0            # 数えた LINE と JUMP の合計
_limit = 2_000_000
_log_cap = 20000
_log_line = []
_log_t = []
_prints = []
_print_cap = 3000
_print_dropped = 0
_print_drop_line = 0
_wall_deadline = 0.0   # 実時間の大きな安全の上限（固まり防止。超えたら "busy"）
_stall_deadline = 0.0  # sim の時刻が最後に進んでから stall_limit 秒（超えたら "wall"）
_stall_now = -1.0
_stall_limit = 8.0
_last_prog = 0.0
_equipped = None      # None は全部使える（自由走行場）
_turned_off = frozenset()
_var_watch = True
_var_log = []
_var_text = {}
_var_names = ()
_assign_lines = {}
_frame_last = {}
_lmap = None          # C の面: Python の行 → C の行
_calls = {}
_jcache = {}
_EX = None            # error_explain.Explainer（setup で作る）
_EX_ERR = None
_API_INFO = {}        # data/api.json の functions

_VAR_CAP = 20000
_SIMPLE = (int, float, str, bool, type(None), list, tuple)
_SCALAR = (int, float, str, bool, type(None))
_MISSING = object()

_PARAM_JA = {"left": "左", "right": "右", "seconds": "秒数", "on": "オン・オフ", "name": "名前"}
_DEVICE_JA = {"distance_to_cone": "巻尺", "lidar": "LiDAR", "heading": "IMU（向きのセンサ）", "odometer": "エンコーダ",
              "encoder": "エンコーダ", "gnss": "GNSS", "camera": "カメラ", "altitude": "気圧センサ",
              "accel": "IMU（加速度センサ）", "nichrome": "ニクロム線", "marker": "AR マーカーを読むカメラ"}
_TYPE_JA = {"str": "文字列", "NoneType": "None（なにもない）", "bool": "True/False", "list": "リスト",
            "tuple": "タプル", "dict": "辞書", "function": "関数", "Reading": "センサの記録"}


def set_js(obj):
    """テスト用: _rover_js の代わりを差しこむ。"""
    global _js
    _js = obj


# ------------------------------------------------------------------ 小さな道具
def _tb_line(exc):
    """例外の起きた main.py の行（無ければ 0。C の面は C の行）。"""
    try:
        tb = exc.__traceback__
        ln = 0
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == FILENAME:
                ln = tb.tb_lineno
            tb = tb.tb_next
        if _lmap is not None and 0 <= ln < len(_lmap):
            return _lmap[ln]
        return ln
    except Exception:
        return 0


def _line():
    """API を呼んだ main.py の行（C の面は C の行）。"""
    f = sys._getframe(2)
    while f is not None and f.f_code.co_filename != FILENAME:
        f = f.f_back
    if f is None:
        return 0
    ln = f.f_lineno
    if _lmap is not None and 0 <= ln < len(_lmap):
        return _lmap[ln] or ln
    return ln


def _tick(ln):
    """0.1 s ごとに進み具合を送り（番犬をなでる）、計算時間の上限を確かめる。
    上限の主は sim の時間（time_limit）と行数。実時間は 2 つだけ（直し係 4。遅い PC で正しいコードを落とさない）:
      ・sim の時刻が進まないまま stall_limit 秒（wallLimitS）→ "wall"（wait の無い重い計算。プログラムのせい）
      ・sim の時刻は進んでいるのに 1 回が wallSafetyS 秒 → "busy"（PC が混んでいた。失敗に数えない）"""
    global _last_prog, _stall_now, _stall_deadline
    w = _wall()
    if w - _last_prog >= 0.1:
        _last_prog = w
        try:
            _js.progress(_now, _count)
        except Exception:
            pass
    if _now != _stall_now:
        _stall_now = _now
        _stall_deadline = w + _stall_limit
    elif w >= _stall_deadline:
        raise _LineLimit("wall", ln)
    if w >= _wall_deadline:
        raise _LineLimit("busy", ln)


_next_tick = 4096
_tick_step = 4096
_tick_last_w = 0.0


def _tick_adapt(ln):
    """行の記録の中で計算時間を確かめる（ふだんは 4096 回に 1 回。1 行が重い時は間を詰めて 0.05 s ごとくらいに）。"""
    global _next_tick, _tick_step, _tick_last_w
    w = _wall()
    dt = w - _tick_last_w
    _tick_last_w = w
    if dt > 0.05 and _tick_step > 8:
        _tick_step = max(8, _tick_step // 4)
    elif dt < 0.01 and _tick_step < 4096:
        _tick_step = min(4096, _tick_step * 2)
    _next_tick = min(_count + _tick_step, _limit + 1)
    _tick(ln)


def _sync(ln):
    """時間を進める命令のあと: 今の時刻を読み、時間切れなら止め、計算時間を確かめる。"""
    global _now
    t = _js.t
    if t < 0:
        raise _TimeUp()
    _now = t
    _tick(ln)


def _count_call(name):
    _calls[name] = _calls.get(name, 0) + 1


def _api_exc(cls, code, msg, **info):
    e = cls(msg)
    e.rover_code = code
    e.rover_info = info
    return e


def _tname(x):
    tn = type(x).__name__
    return _TYPE_JA.get(tn, tn)


def _num(x, func, param):
    """命令の引数を数として受ける（int と float だけ。bool・文字・None・NaN は止める。5.3）。"""
    t = type(x)
    if t is float or t is int:
        if t is float and (x != x or x in (math.inf, -math.inf)):
            raise _api_exc(ValueError, "ARG_NAN", f"{func}() の{_PARAM_JA.get(param, param)}が数になっていません（{x}）",
                           func=func, param=param, param_ja=_PARAM_JA.get(param, param), value=repr(x))
        return float(x)
    pj = _PARAM_JA.get(param, param)
    if isinstance(x, bool):
        code = "ARG_TYPE"
    elif isinstance(x, str):
        code = "ARG_STR"
    elif x is None:
        code = "ARG_NONE"
    elif isinstance(x, (int, float)):  # int・float の子（numpy などは無いが念のため）
        return _num(float(x), func, param)
    else:
        code = "ARG_TYPE"
    raise _api_exc(TypeError, code, f"{func}() の{pj}には数を入れてください（今は {_tname(x)}）",
                   func=func, param=param, param_ja=pj, value=(x if isinstance(x, str) else repr(x))[:40])


def _need(name):
    """使える命令か（5.4）。使えなければ API_NOT_EQUIPPED か API_TURNED_OFF で止める。"""
    if name in _turned_off:
        raise _api_exc(RuntimeError, "TURNED_OFF", f"{name}() は返したので使えません（もう使えません）",
                       func=name, device=_DEVICE_JA.get(name, name))
    unlock = (_API_INFO.get(name) or {}).get("unlock", "")
    raise _api_exc(RuntimeError, "NOT_EQUIPPED", f"{name}() は、このレベルのローバーにはまだ付いていません",
                   func=name, device=_DEVICE_JA.get(name, name), unlock=unlock,
                   chapter=str(unlock).split("-")[0] if unlock else "")


def _warn(line, text, kind):
    """止めずに直した注意。同じ行・同じ種類は 1 つにまとめて数える（[t, line, text, kind, 回数]）。"""
    key = (line, kind)
    w = _warn_seen.get(key)
    if w is not None:
        w[4] += 1
        return
    if len(_warnings) < 20:
        w = [round(_now, 4), line, text, kind, 1]
        _warn_seen[key] = w
        _warnings.append(w)


# ------------------------------------------------------------------ 返す入れ物 Reading（5.2）
_ATTR_ALIAS = {"latitude": "lat", "longitude": "lon", "lng": "lon", "long": "lon", "direction": "course",
               "heading": "course", "speed_mps": "speed", "is_valid": "valid", "ok": "valid", "detected": "found",
               "bearing": "angle", "distance": "dist", "time": "t"}


class Reading(dict):
    """センサの答えの入れ物。dict の子で、g.lat でも g["lat"] でも読める（本物の SIL は dict）。
    表示は GNSS(valid=True, lat=…, …) のように名前つき。無い名前を読むと日本語の AttributeError（近い名前を出す）。"""

    __slots__ = ("_kind",)

    def __init__(self, kind, items):
        super().__init__(items)
        self._kind = kind

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            pass
        if name.startswith("__"):
            raise AttributeError(name)
        keys = [str(k) for k in self.keys()]
        sug = _ATTR_ALIAS.get(name)
        if sug not in keys:
            m = difflib.get_close_matches(name, keys, n=1, cutoff=0.5)
            sug = m[0] if m else None
        msg = f"{self._kind} の記録に「{name}」はありません（あるのは {'・'.join(keys)}）"
        if sug:
            msg += f"。{sug} のこと？"
        raise AttributeError(msg, name=name, obj=self)

    def __setattr__(self, name, value):
        if name == "_kind":
            object.__setattr__(self, name, value)
        else:
            self[name] = value

    def __repr__(self):
        return f"{self._kind}(" + ", ".join(f"{k}={_fmt_field(k, v)}" for k, v in self.items()) + ")"

    __str__ = __repr__

    def __reduce__(self):
        return (dict, (dict(self),))


def _fmt_field(k, v):
    if isinstance(v, float):
        if k in ("lat", "lon"):
            return f"{v:.7f}"
        return f"{round(v, 3)!r}"
    return repr(v)


# ------------------------------------------------------------------ 命令（5.1 の表）
# 速さのため、よく呼ぶ命令は小さな関数を呼ばずに書き下ろしている（1 回の呼び出しが Pyodide で約 3 µs）。
# 共通の形: 使えるか → 呼んだ数 → 呼んだ行 → JS → 時刻を読む（-1 は時間切れ）→ 16 回に 1 回 計算時間を確かめる。
_getframe = sys._getframe
_api_n = 0
_last_cmd = None      # (l, r, t): 同じ時刻に同じ指令を何度も送らない（1 行のくり返し motor(1, 1) を速く止めるため）
_ZERO_TIME_WEIGHT = 4  # 時間の進まない命令は 1 行＋4 として行数の上限に数える（1 行のくり返しが約 1 s で止まるように）


def _caller_line(f):
    """f（API を呼んだ frame）から main.py の行（C の面は C の行）。"""
    while f is not None and f.f_code.co_filename != FILENAME:
        f = f.f_back
    if f is None:
        return 0
    ln = f.f_lineno
    if _lmap is not None and 0 <= ln < len(_lmap):
        return _lmap[ln] or ln
    return ln


def _after(ln):
    """時間を進める命令のあと（書き下ろさない命令用）。"""
    global _now, _api_n
    t = _js.t
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15):
        _tick(ln)


def _zero_time(ln):
    """時間の進まない命令: 行数の上限に重みを足す。"""
    global _count
    _count += _ZERO_TIME_WEIGHT
    if _count > _limit:
        raise _LineLimit("lines", ln)


def _ok_num(x):
    return type(x) is float and x == x and x != math.inf and x != -math.inf


def motor(left, right):
    """左右の車輪の速さ（デューティ −1〜1）。0.08 未満は回らない。1 で約 1.1 m/s。"""
    global _last_cmd
    if _equipped is not None and "motor" not in _equipped:
        _need("motor")
    _calls["motor"] = _calls.get("motor", 0) + 1
    l = left if _ok_num(left) else _num(left, "motor", "left")
    r = right if _ok_num(right) else _num(right, "motor", "right")
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    _zero_time(ln)
    if l > 1 or l < -1 or r > 1 or r < -1:
        _warn(ln, f"motor の数は -1〜1 です。はみ出した分は 1（-1）にしました（{_short(left)}, {_short(right)}）", "API_MOTOR_RANGE")
        l = max(-1.0, min(1.0, l))
        r = max(-1.0, min(1.0, r))
    cmd = (l, r, _now)
    if cmd == _last_cmd:
        return
    _last_cmd = cmd
    _js.motor(l, r, ln)


def stop():
    """両方の車輪を止める（motor(0, 0) と同じ）。"""
    global _last_cmd
    if _equipped is not None and "stop" not in _equipped:
        _need("stop")
    _calls["stop"] = _calls.get("stop", 0) + 1
    ln = _caller_line(_getframe(1))
    _zero_time(ln)
    cmd = (0.0, 0.0, _now)
    if cmd == _last_cmd:
        return
    _last_cmd = cmd
    _js.motor(0.0, 0.0, ln)


def wait(seconds):
    """その秒数のあいだ、今の指令のまま走る（そのあいだ sim の時間が進む）。"""
    global _now, _api_n
    if _equipped is not None and "wait" not in _equipped:
        _need("wait")
    _calls["wait"] = _calls.get("wait", 0) + 1
    s = _num(seconds, "wait", "seconds")
    if s < 0:
        raise _api_exc(ValueError, "WAIT_NEGATIVE", f"wait の秒数はマイナスにできません（{_short(seconds)}）",
                       func="wait", param="seconds", param_ja="秒数", value=repr(seconds))
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    t = _js.wait(s, ln)
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15) or s >= 0.05:
        _tick(ln)


def _sleep(seconds):
    """import time の time.sleep（＝ wait）。"""
    _count_call("time.sleep")
    s = _num(seconds, "sleep", "seconds")
    if s < 0:
        raise _api_exc(ValueError, "WAIT_NEGATIVE", f"wait の秒数はマイナスにできません（{_short(seconds)}）",
                       func="sleep", param="seconds", param_ja="秒数", value=repr(seconds))
    ln = _caller_line(_getframe(1))
    t = _js.wait(s, ln)
    global _now
    if t < 0:
        raise _TimeUp()
    _now = t
    _tick(ln)


def now():
    """スタートからの sim の秒。〔1.1〕読むと 0.001 s 進む（本物の Pi の time.time() と同じ書き方が通る）。"""
    global _now, _api_n
    if _equipped is not None and "now" not in _equipped:
        _need("now")
    _calls["now"] = _calls.get("now", 0) + 1
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    t = _js.now(ln)
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15):
        _tick(ln)
    return t


def _time_now():
    """import time の time.time・time.monotonic（＝ now。いつでも使える）。"""
    _count_call("time.time")
    ln = _caller_line(_getframe(1))
    t = _js.now(ln)
    global _now
    if t < 0:
        raise _TimeUp()
    _now = t
    _tick(ln)
    return t


def distance_to_cone():
    """最初のコーンまでのすき間 m（ふれて 0、誤差なし。練習用の巻尺）。"""
    if _equipped is not None and "distance_to_cone" not in _equipped:
        _need("distance_to_cone")
    _calls["distance_to_cone"] = _calls.get("distance_to_cone", 0) + 1
    _zero_time(0)
    v = _js.distanceToCone()
    # ものさしなので 1 mm 単位（print で「0.00030183…」のような長い小数が出ないように。直し A-11）
    return None if v is None else round(float(v), 3)


def lidar():
    """前の物までの m（1 cm 単位、0.05〜12 m）。12 m より先・何もない・故障・空中は None。0.01 s。"""
    global _now, _api_n
    if _equipped is not None and "lidar" not in _equipped:
        _need("lidar")
    _calls["lidar"] = _calls.get("lidar", 0) + 1
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    v = _js.lidar(ln)
    t = _js.t
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15):
        _tick(ln)
    return v


def heading():
    """向き（度）。北 0・東 90・時計回り、0 以上 360 未満、0.1 度単位。方位の故障の世界は None。0.01 s。"""
    global _now, _api_n
    if _equipped is not None and "heading" not in _equipped:
        _need("heading")
    _calls["heading"] = _calls.get("heading", 0) + 1
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    v = _js.heading(ln)
    t = _js.t
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15):
        _tick(ln)
    return v


def odometer():
    """左右の車輪が回った距離の平均 m。すべっても増える。さかさまでは前へ走っても減る。0.001 s。"""
    global _now, _api_n
    if _equipped is not None and "odometer" not in _equipped:
        _need("odometer")
    _calls["odometer"] = _calls.get("odometer", 0) + 1
    f = _getframe(1)
    ln = f.f_lineno if (f.f_code.co_filename == FILENAME and _lmap is None) else _caller_line(f)
    v = _js.odometer(ln)
    t = _js.t
    if t < 0:
        raise _TimeUp()
    _now = t
    _api_n += 1
    if not (_api_n & 15):
        _tick(ln)
    return v


def encoder():
    """(左, 右) のカウント（車輪 1 回転で 2000）。ふつうのタプル。0.001 s。"""
    if _equipped is not None and "encoder" not in _equipped:
        _need("encoder")
    _calls["encoder"] = _calls.get("encoder", 0) + 1
    ln = _caller_line(_getframe(1))
    v = _js.encoder(ln)
    _after(ln)
    return (int(v[0]), int(v[1]))


def _f(x):
    return None if x is None else float(x)


def gnss():
    """GNSS の最新の測位。valid・lat・lon（度）・speed（m/s）・course（度）・t（測位した sim 秒）。
    valid が偽なら他は全部 None。0.001 s。"""
    if _equipped is not None and "gnss" not in _equipped:
        _need("gnss")
    _calls["gnss"] = _calls.get("gnss", 0) + 1
    ln = _caller_line(_getframe(1))
    o = _js.gnss(ln)
    _after(ln)
    o = o.to_py()
    if not o[0]:
        return Reading("GNSS", (("valid", False), ("lat", None), ("lon", None), ("speed", None), ("course", None), ("t", None)))
    return Reading("GNSS", (("valid", True), ("lat", _f(o[1])), ("lon", _f(o[2])), ("speed", _f(o[3])),
                            ("course", _f(o[4])), ("t", _f(o[5]))))


def camera():
    """カメラでコーンを探す。found・angle（度、右が正）・size（0〜1）・t（撮った sim 秒）。
    found が偽なら angle・size は None。0.4 s（その間も走る）。カメラ故障の世界は 0.4 s 後に OSError。"""
    if _equipped is not None and "camera" not in _equipped:
        _need("camera")
    _calls["camera"] = _calls.get("camera", 0) + 1
    ln = _caller_line(_getframe(1))
    o = _js.camera(ln)
    _after(ln)
    _tick(ln)
    o = o.to_py()
    if o[4]:
        e = OSError(5, "カメラが返事をしません（camera() が使えない）")
        e.rover_info = {"func": "camera", "device": "カメラ", "sensor_ja": "カメラ"}
        raise e
    if not o[0]:
        return Reading("Camera", (("found", False), ("angle", None), ("size", None), ("t", _f(o[3]))))
    return Reading("Camera", (("found", True), ("angle", _f(o[1])), ("size", _f(o[2])), ("t", _f(o[3]))))


def marker():
    """AR マーカーを探す。found・id・angle（度、右が正）・dist（m、±3%）・t。4 m 以内・画角の中で一番近いもの。0.4 s。"""
    if _equipped is not None and "marker" not in _equipped:
        _need("marker")
    _calls["marker"] = _calls.get("marker", 0) + 1
    ln = _caller_line(_getframe(1))
    o = _js.marker(ln)
    _after(ln)
    _tick(ln)
    o = o.to_py()
    if o[5]:
        e = OSError(5, "カメラが返事をしません（marker() が使えない）")
        e.rover_info = {"func": "marker", "device": "カメラ", "sensor_ja": "カメラ"}
        raise e
    if not o[0]:
        return Reading("Marker", (("found", False), ("id", None), ("angle", None), ("dist", None), ("t", _f(o[4]))))
    mid = o[1]
    if isinstance(mid, float) and mid.is_integer():
        mid = int(mid)
    return Reading("Marker", (("found", True), ("id", mid), ("angle", _f(o[2])), ("dist", _f(o[3])), ("t", _f(o[4]))))


def phase(name):
    """今のフェーズの名前を画面と記録に出す（文字に直して記録）。"""
    if _equipped is not None and "phase" not in _equipped:
        _need("phase")
    _calls["phase"] = _calls.get("phase", 0) + 1
    ln = _caller_line(_getframe(1))
    _zero_time(ln)
    _js.phase(str(name)[:40], ln)


def altitude():
    """気圧の高さ m（電源を入れた地面を 0、±0.1 m）。0.01 s。"""
    if _equipped is not None and "altitude" not in _equipped:
        _need("altitude")
    _calls["altitude"] = _calls.get("altitude", 0) + 1
    ln = _caller_line(_getframe(1))
    v = _js.altitude(ln)
    _after(ln)
    return v


def accel():
    """(ax, ay, az) m/s²。機体の座標（x 前・y 左・z 上）。正立で止まっていれば az ≈ +9.8。±156.9 で頭打ち。0.01 s。"""
    if _equipped is not None and "accel" not in _equipped:
        _need("accel")
    _calls["accel"] = _calls.get("accel", 0) + 1
    ln = _caller_line(_getframe(1))
    v = _js.accel(ln)
    _after(ln)
    return (float(v[0]), float(v[1]), float(v[2]))


def nichrome(on):
    """True で電気を流す、False で止める。地上でパラがつながっていれば、流し始めて 2 s で切れる。"""
    if _equipped is not None and "nichrome" not in _equipped:
        _need("nichrome")
    _calls["nichrome"] = _calls.get("nichrome", 0) + 1
    ln = _caller_line(_getframe(1))
    _zero_time(ln)
    _js.nichrome(bool(on), ln)


API = dict(motor=motor, stop=stop, wait=wait, now=now, distance_to_cone=distance_to_cone, lidar=lidar,
           heading=heading, odometer=odometer, encoder=encoder, gnss=gnss, camera=camera, phase=phase,
           altitude=altitude, accel=accel, nichrome=nichrome, marker=marker)


# ------------------------------------------------------------------ print・input・exit
def _short(x):
    try:
        s = repr(x)
    except Exception:
        s = "?"
    return s if len(s) <= 20 else s[:19] + "…"


def _print(*args, sep=" ", end="\n", file=None, flush=False):
    global _print_dropped, _print_drop_line, _count
    _count_call("print")
    _count += _ZERO_TIME_WEIGHT
    if _count > _limit:
        raise _LineLimit("lines", _line())
    if len(_prints) >= _print_cap:
        _print_dropped += 1
        if not _print_drop_line:
            _print_drop_line = _line()
        return
    if sep is None:
        sep = " "
    if end is None:
        end = "\n"
    text = str(sep).join(str(a) for a in args)
    if end != "\n":
        text += str(end).rstrip("\n")
    if len(text) > 2000:
        text = text[:2000] + "…"
    _prints.append([round(_now, 4), _line(), text])


def _input(*a, **k):
    raise _api_exc(RuntimeError, "NO_INPUT", "input() は使えません（ローバーにはキーボードが付いていません）", func="input")


def _exit(*a, **k):
    raise SystemExit(a[0] if a else None)


# ------------------------------------------------------------------ 5.5 の環境（import の差し替え）
_FRESH = frozenset({"math", "random", "statistics", "cmath"})
_BLOCK = frozenset({"js", "pyodide", "pyodide_js", "micropip", "_rover_js", "rover_runtime", "judge",
                    "error_explain", "c_subset", "socket", "urllib", "http", "ssl", "subprocess", "threading",
                    "multiprocessing", "asyncio", "_pyodide", "pyodide_http", "requests", "ctypes"})
_real_import = builtins.__import__
_BUILTINS0 = dict(vars(builtins))      # 生徒が import builtins で書きかえても、実行のあとで元に戻す
_REC_LIMIT0 = sys.getrecursionlimit()  # 生徒が sys.setrecursionlimit を変えても、次の実行に残さない


def _restore_globals():
    d = vars(builtins)
    for k, v in _BUILTINS0.items():
        if d.get(k, _MISSING) is not v:
            d[k] = v
    for k in [k for k in d if k not in _BUILTINS0]:
        del d[k]
    if sys.getrecursionlimit() != _REC_LIMIT0:
        sys.setrecursionlimit(_REC_LIMIT0)


def _fresh_module(name):
    spec = importlib.util.find_spec(name)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _make_time_module():
    m = types.ModuleType("time")
    m.sleep = _sleep
    m.time = _time_now
    m.monotonic = _time_now
    m.perf_counter = _time_now
    return m


def _make_import(seed):
    fresh = {}

    def _user_import(name, globals=None, locals=None, fromlist=(), level=0):
        top = name.partition(".")[0]
        if level == 0:
            if top == "time":
                m = fresh.get("time")
                if m is None:
                    m = fresh["time"] = _make_time_module()
                return m
            if top in _BLOCK:
                raise ImportError(f"このゲームでは {top} は使えないよ（import {top}）", name=top)
            if top in _FRESH and "." not in name:
                m = fresh.get(top)
                if m is None:
                    m = fresh[top] = _fresh_module(top)
                    if top == "random":
                        m.seed(seed)
                return m
        return _real_import(name, globals, locals, fromlist, level)
    return _user_import


def _make_globals(opts):
    bi = dict(vars(builtins))
    bi["print"] = _print
    bi["input"] = _input
    bi["exit"] = _exit
    bi["quit"] = _exit
    bi["__import__"] = _make_import(opts.get("seed", 1))
    g = {"__name__": "__main__", "__builtins__": bi}
    g.update(API)
    inj = opts.get("inject") or {}
    if isinstance(inj, dict):
        g.update(inj)
    return g


# ------------------------------------------------------------------ 行の記録（sys.monitoring の LINE と JUMP）
_MON = getattr(sys, "monitoring", None)
_TOOL = None
_DISABLE = _MON.DISABLE if _MON else None


def _on_line(code, ln):
    global _count
    if code.co_filename != FILENAME:
        return _DISABLE
    _count += 1
    raw = ln
    if _lmap is not None and ln < len(_lmap):
        ln = _lmap[ln] or ln
    _hits[ln] += 1
    if _count <= _log_cap:
        if _var_watch:
            f = sys._getframe(1)
            fid = id(f)
            prev = _frame_last.get(fid)
            if prev is not None:
                names = _assign_lines.get(prev[0])
                if names:
                    _scan_names(f, names, prev[1])
            elif len(_frame_last) > 20000:
                _frame_last.clear()
            _frame_last[fid] = (raw, len(_log_line))
        _log_line.append(ln)
        _log_t.append(_now)
    if _count > _limit:
        raise _LineLimit("lines", ln)
    if _count >= _next_tick:
        _tick_adapt(ln)


def _on_jump(code, src, dst):
    global _count
    if code.co_filename != FILENAME:
        return _DISABLE
    _count += 1
    if dst < src:
        key = (id(code), src, dst)
        ln = _jcache.get(key)
        if ln is None:
            ln = _jcache[key] = _one_line_loop(code, src, dst)
        if ln:
            if _lmap is not None and ln < len(_lmap):
                ln = _lmap[ln] or ln
            _hits[ln] += 1
            if _count <= _log_cap:
                _log_line.append(ln)
                _log_t.append(_now)
    if _count > _limit:
        raise _LineLimit("lines", _offset_line(code, src))
    if _count >= _next_tick:
        _tick_adapt(_offset_line(code, src))


def _one_line_loop(code, src, dst):
    """後ろへの JUMP が 1 行の中のくり返しなら、その行。違えば 0（その時は LINE のイベントで数える）。"""
    lines = set()
    for start, end, ln in code.co_lines():
        if end > dst and start <= src:
            if ln is not None:
                lines.add(ln)
    return lines.pop() if len(lines) == 1 else 0


def _offset_line(code, off):
    for start, end, ln in code.co_lines():
        if start <= off < end and ln is not None:
            if _lmap is not None and ln < len(_lmap):
                return _lmap[ln] or ln
            return ln
    return 0


def _on_line_fast(code, ln):
    """行の記録を取らない時（本番テストの回）の LINE: 数えて上限を見るだけ。"""
    global _count
    if code.co_filename != FILENAME:
        return _DISABLE
    _count += 1
    if _count >= _next_tick:
        if _count > _limit:
            raise _LineLimit("lines", _lmap[ln] if (_lmap is not None and ln < len(_lmap)) else ln)
        _tick_adapt(ln)


def _on_jump_fast(code, src, dst):
    global _count
    if code.co_filename != FILENAME:
        return _DISABLE
    _count += 1
    if _count >= _next_tick:
        if _count > _limit:
            raise _LineLimit("lines", _offset_line(code, src))
        _tick_adapt(_offset_line(code, src))


_installed_fast = None


def _install(fast=False):
    global _TOOL, _installed_fast
    E = _MON.events
    if _TOOL is None:
        for tid in (4, 3, 5, 1, 2, 0):
            try:
                _MON.use_tool_id(tid, "rover_code")
                _TOOL = tid
                break
            except ValueError:
                continue
    if _installed_fast is not fast:
        _MON.register_callback(_TOOL, E.LINE, _on_line_fast if fast else _on_line)
        _MON.register_callback(_TOOL, E.JUMP, _on_jump_fast if fast else _on_jump)
        _installed_fast = fast
    _MON.set_events(_TOOL, E.LINE | E.JUMP)


def _uninstall():
    if _TOOL is not None:
        _MON.set_events(_TOOL, 0)


# ------------------------------------------------------------------ 変数の値の記録（varLog）
def _fmt_val(v):
    t = type(v)
    if t is bool or v is None:
        return repr(v)
    if t is int:
        if v.bit_length() > 60:
            return "（とても大きな数）"
        return repr(v)
    if t is float:
        r = repr(v)
        return r if len(r) <= 10 else format(v, ".6g")
    if t is str:
        return repr(v) if len(v) <= 30 else repr(v[:29]) + "…"
    if t is list or t is tuple:
        if len(v) > 8:
            return None
        parts = []
        for x in v:
            if type(x) not in _SCALAR:
                return None
            s = _fmt_val(x)
            if s is None:
                return None
            parts.append(s)
        if t is tuple:
            return "(" + ", ".join(parts) + ("," if len(parts) == 1 else "") + ")"
        return "[" + ", ".join(parts) + "]"
    return None


def _scan_names(f, names, i):
    """その frame で 1 つ前に実行した行（lineLog の番号 i）が代入した名前だけを読み、変わった単純な値を
    [i, 名前, 表示] で残す（i の行を実行した後の値。先頭 2 万行まで）。"""
    if len(_var_log) >= _VAR_CAP:
        return
    try:
        loc = f.f_locals
    except Exception:
        return
    for k in names:
        v = loc.get(k, _MISSING)
        if v is _MISSING:
            v = f.f_globals.get(k, _MISSING)
            if v is _MISSING:
                continue
        if type(v) not in _SIMPLE:
            continue
        s = _fmt_val(v)
        if s is None or _var_text.get(k) == s:
            continue
        _var_text[k] = s
        _var_log.append([i, k, s])


def _assigned_names(tree):
    """行ごとに、その行で代入する名前（ast の Store・for の変数・引数・with/except の as）。モジュールの段の名前の一覧も。"""
    by_line = {}
    names = []
    seen = set()
    if tree is None:
        return {}, ()
    for node in ast.walk(tree):
        n = None
        ln = getattr(node, "lineno", None)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            n = node.id
        elif isinstance(node, ast.arg):
            n = node.arg
        elif isinstance(node, ast.ExceptHandler) and node.name:
            n = node.name
        if not n or n.startswith("_") or ln is None:
            continue
        if isinstance(node, ast.arg):
            continue          # 引数は関数の最初の行の前に入る（下で def の中の最初の行に足す）
        lst = by_line.setdefault(ln, [])
        if n not in lst:
            lst.append(n)
        if n not in seen:
            seen.add(n)
            names.append(n)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)) and isinstance(node.body, list) and node.body:
            a = node.args
            params = [x.arg for x in a.posonlyargs + a.args + a.kwonlyargs] +                      ([a.vararg.arg] if a.vararg else []) + ([a.kwarg.arg] if a.kwarg else [])
            first = node.body[0].lineno
            # 最初の行を実行した後に引数も読む（その行の代入と合わせる）
            lst = by_line.setdefault(first, [])
            for p in params:
                if not p.startswith("_") and p not in lst:
                    lst.append(p)
    return {k: tuple(v) for k, v in by_line.items()}, tuple(names)


# ------------------------------------------------------------------ エラー説明（W3 の Explainer。無い・壊れている時は自分のカード）
def setup(rules_json="", api_json=""):
    """Worker の準備の時に 1 回: error_rules.json と api.json を読む（Explainer を作る）。"""
    global _EX, _EX_ERR, _API_INFO
    try:
        api = json.loads(api_json) if api_json else {}
        _API_INFO = api.get("functions", {}) if isinstance(api, dict) else {}
    except Exception:
        _API_INFO = {}
    _EX = None
    _EX_ERR = None
    if rules_json:
        try:
            from error_explain import Explainer
            rules = json.loads(rules_json) if isinstance(rules_json, str) else rules_json
            _EX = Explainer(rules)
        except Exception as e:  # W3 のファイルが途中でも、エンジンは自分のカードで動く
            _EX = None
            _EX_ERR = f"{type(e).__name__}: {e}"
    return json.dumps({"explainer": _EX is not None, "error": _EX_ERR}, ensure_ascii=False)


def _card(cid, stage, title, line=None, where="", why="", fix="", raw="", severity="error", speaker="rover", **extra):
    c = {"id": cid, "stage": stage, "severity": severity, "zukan": None, "line": line, "col": None, "end_col": None,
         "title": title, "where": where or (f"{line} 行目" if line else ""), "why": why, "fix": fix, "term": "",
         "raw": raw, "example": None, "quickfix": None, "speaker": speaker, "confirm": False, "more": 0, "vars": {}}
    c.update(extra)
    return c


def _clean(card):
    if not isinstance(card, dict):
        return None
    out = {k: v for k, v in card.items() if not k.startswith("_")}
    try:
        json.dumps(out, ensure_ascii=False)
        return out
    except Exception:
        return {k: (v if isinstance(v, (str, int, float, bool, type(None))) else str(v)) for k, v in out.items()}


def _exc_line(exc):
    line = 0
    tb = exc.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == FILENAME:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def _explain_exception(src, exc):
    if _EX is not None:
        try:
            return _clean(_EX.explain_exception(src, exc))
        except Exception:
            pass
    line = _exc_line(exc)
    tn = type(exc).__name__
    return _card("EXC_GENERIC", "fallback", f"プログラムが止まっちゃったよ（{tn}）", line=line,
                 raw=f"{tn}: {exc}", why=str(exc)[:200])


def _explain_syntax(src, exc):
    if _EX is not None:
        try:
            return _clean(_EX.explain_syntax(src, exc))
        except Exception:
            pass
    return _card("SYNTAX_GENERIC", "compile", "書き方が Python のきまりに合っていないみたい", line=exc.lineno,
                 raw=f"{type(exc).__name__}: {exc.msg}")


_GUARD_FALLBACK = {
    "lines": ("LOOP_TOO_MANY", "くり返しが多すぎて、ぼくは数えきれなくなっちゃったよ"),
    "wall": ("WALL_LIMIT", "計算に時間がかかりすぎて、ぼくは止まっちゃったよ"),
    "busy": ("WALL_BUSY", "PC が混んでいたので止めたよ。もう一度［実行］してね"),
    "timeup": ("TIME_UP", "時間切れ。ぼくはまだ走っていたよ"),
    "print": ("OUTPUT_FLOOD", "print が多すぎたので、最初の 3000 行だけ見せるね"),
    "watchdog": ("WATCHDOG", "計算が終わらなくて、ぼくは止められちゃったよ"),
    "fatal": ("FATAL", "ぼくの中の Python が倒れちゃった"),
}


def explain_guard(src, reason, line=None, limit=None, count=None, use_hits=True):
    """止めた理由のカード（lines・wall・timeup・print・watchdog・fatal）。"""
    if _EX is not None:
        try:
            c = _EX.explain_guard(src, reason, line=line, hits=(_hits or None) if use_hits else None, limit=limit, count=count)
            if c:
                return _clean(c)
        except Exception:
            pass
    cid, title = _GUARD_FALLBACK.get(reason, ("GUARD", "ぼくは止まったよ"))
    if reason == "print" and limit:
        title = f"print が多すぎたので、最初の {limit} 行だけ見せるね"
    if reason == "timeup" and limit:
        title = f"時間切れ（{limit} 秒）。ぼくはまだ走っていたよ"
    return _card(cid, "guard", title, line=line, severity="warn" if reason == "print" else ("info" if reason == "busy" else "error"))


def _explain_warning(src, w):
    t, line, text, kind, count = w
    card = None
    if _EX is not None:
        try:
            card = _clean(_EX.explain_api_warning(src, text, line))
        except Exception:
            card = None
    if not card:
        card = _card(kind or "API_WARNING", "api_warning", "motor の速さが −1〜1 をはみ出したので、1（−1）にしたよ"
                     if kind == "API_MOTOR_RANGE" else text, line=line, severity="warn")
    return {"card": card, "t": t, "line": line, "count": count}


# ------------------------------------------------------------------ 実行前の検査・直す
def _size_card(src):
    n_lines = src.count("\n") + 1
    n_bytes = len(src.encode("utf-8"))
    if n_lines > 2000 or n_bytes > 61440:
        return _card("CODE_TOO_LONG", "precheck", "プログラムが長すぎて、ぼくには読みきれないよ", line=1,
                     where=f"プログラム全体（{n_lines} 行・{n_bytes // 1024} KB）",
                     fix="2000 行・60 KB までにしよう。使っていない関数や、同じことのくり返しを減らそう。")
    return None


def before_run(src, lang="python", chapter=1):
    """実行前の検査（① 文字 ② compile ③ AST の注意）。{"stop": Card|None, "items": [Card…]} の JSON。"""
    stop = _size_card(src)
    items = []
    if stop is None and _EX is not None:
        try:
            r = _EX.before_run(src, chapter)
            stop = _clean(r.get("stop", r.get("blocking")))
            items = [_clean(c) for c in (r.get("items", r.get("warnings")) or [])]
            items = [c for c in items if c]
        except Exception:
            stop = None
            items = []
    if stop is None:
        try:
            compile(src, FILENAME, "exec", dont_inherit=True)
        except SyntaxError as e:
            stop = _explain_syntax(src, e)
        except (ValueError, MemoryError, RecursionError) as e:  # ヌル文字・深すぎる式
            stop = _card("SYNTAX_GENERIC", "compile", "ぼくにはこのプログラムが読めなかったよ", line=1,
                         raw=f"{type(e).__name__}: {e}")
    return json.dumps({"stop": stop, "items": items}, ensure_ascii=False)


def precheck(src, lang="python", chapter=1):
    """打っている途中の確かめにも使う: カードの一覧（止めるものが先）。"""
    r = json.loads(before_run(src, lang, chapter))
    return json.dumps(([r["stop"]] if r["stop"] else []) + r["items"], ensure_ascii=False)


def quickfix(src, rule_id):
    """［半角に直す］などのボタン。直したコード（直せなければ元のまま）。"""
    if _EX is not None:
        try:
            out = _EX.apply_quickfix(src, rule_id)
            if isinstance(out, str):
                return out
        except Exception:
            pass
    return src


# ------------------------------------------------------------------ 番犬のあと（予備の Worker で）
_BIG = 10 ** 7
_HEAVY_CALLS = {"sum", "range", "list", "sorted", "max", "min", "set", "tuple", "pow", "factorial", "comb", "perm",
                "prod", "isqrt", "str", "len", "any", "all", "reversed", "enumerate"}


def _big_const(node):
    """とても大きな数か（10**7 以上。2**100 などの式も計算せずに見積もる）。"""
    try:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return abs(node.value) >= _BIG
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            b, e = node.left, node.right
            if isinstance(b, ast.Constant) and isinstance(e, ast.Constant) and isinstance(b.value, (int, float)) \
                    and isinstance(e.value, (int, float)):
                bv, ev = abs(b.value), e.value
                return bv > 1 and ev * math.log10(bv) >= 7
            return _big_const(e) or (isinstance(e, ast.BinOp) and isinstance(e.op, ast.Pow))
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Mult, ast.LShift)):
            return _big_const(node.left) or _big_const(node.right)
        if isinstance(node, ast.UnaryOp):
            return _big_const(node.operand)
    except Exception:
        return False
    return False


def watchdog_where(src):
    """番犬で止めた後: AST から「とても大きな数の計算」「時間が進まないくり返し」を探す。(line, text) か None。"""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    lines = src.splitlines()

    def seg(n):
        try:
            s = ast.get_source_segment(src, n) or ""
        except Exception:
            s = ""
        s = " ".join(s.split())
        return s if len(s) <= 40 else s[:39] + "…"

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else (
                node.func.attr if isinstance(node.func, ast.Attribute) else None)
            if name in _HEAVY_CALLS and any(_big_const(a) for a in ast.walk(node) if a is not node and isinstance(a, ast.expr)):
                return node.lineno, f"{node.lineno} 行目の {seg(node)} の計算が大きすぎて、ぼくは終われなかったよ"
        if isinstance(node, ast.BinOp) and _big_const(node) and isinstance(node.op, (ast.Pow, ast.Mult, ast.LShift)):
            return node.lineno, f"{node.lineno} 行目の {seg(node)} の計算が大きすぎて、ぼくは終われなかったよ"
    advancing = {"wait", "sleep", "lidar", "heading", "odometer", "encoder", "gnss", "camera", "marker", "altitude",
                 "accel", "now", "time", "monotonic"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.While, ast.For)):
            calls = {(c.func.id if isinstance(c.func, ast.Name) else getattr(c.func, "attr", None))
                     for c in ast.walk(node) if isinstance(c, ast.Call)}
            if not (calls & advancing):
                code = lines[node.lineno - 1].strip() if node.lineno <= len(lines) else ""
                return node.lineno, f"{node.lineno} 行目のくり返し「{code[:40]}」で時間が進まなくて、ぼくは終われなかったよ"
    return None


def explain_watchdog(src, chapter=1):
    """WATCHDOG のカード（where を AST で埋める）。W3 の explain_guard(src, "watchdog") が埋めればそれを使う。"""
    found = watchdog_where(src)
    line, text = found if found else (None, "計算が終わらなかったので止めたよ")
    card = None
    if _EX is not None:
        try:
            card = _clean(_EX.explain_guard(src, "watchdog", line=line))
        except Exception:
            card = None
    if not card or card.get("id") != "WATCHDOG":
        card = _card("WATCHDOG", "guard", "計算が終わらなくて、ぼくは止められちゃったよ", line=line, where=text,
                     why="ぼくの中の計算が 3 秒たっても終わらなかったので、画面が止めたよ。",
                     fix="とても大きな数の計算や、時間が進まないくり返しが無いか見直そう。")
    elif found:
        card["where"] = text          # 場所を指すのは W2 の AST（7.3〔1.1〕）
        card["line"] = line
    elif not card.get("where") or "{where_text}" in card["where"] or card["where"] == "プログラム全体":
        card["where"] = text
    return json.dumps(card, ensure_ascii=False)


# ------------------------------------------------------------------ 実行
_code_cache = {"src": None, "code": None, "tree": None, "lmap": None}


def _compile_cached(src):
    if _code_cache["src"] != src:
        code = compile(src, FILENAME, "exec", dont_inherit=True)
        try:
            tree = ast.parse(src)
        except SyntaxError:
            tree = None
        _code_cache.update(src=src, code=code, tree=tree)
    return _code_cache["code"], _code_cache["tree"]


def _uncalled_defs(tree):
    out = []
    if tree is None:
        return out
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0].lineno
            if _lmap is not None and first < len(_lmap):
                first = _lmap[first] or first
            if 0 <= first < len(_hits) and _hits[first] == 0:
                out.append(node.name)
    return out


def run(code_str, opts_json="{}"):
    """生徒のコードを 1 回（1 つの世界）実行し、Python 側の記録を JSON の文字で返す（sim の記録は JS 側）。

    opts: lang・inject・equipped・turnedOff・chapter・limits{lineLimit, wallLimitS, printCap, logCap}・seed・varWatch・
          timeLimit（TIME_UP のカードの数）・lineMap（C の面。Python の行 → C の行）・srcForCards（C の面の元の C）
    返す: end・error・errorType・guard・warnings・prints・printDropped・hits・lineLog・lineCount・varLog・calls・uncalled・stats
    """
    global _hits, _warnings, _now, _count, _limit, _log_cap, _log_line, _log_t, _prints, _print_cap, _print_dropped
    global _print_drop_line, _wall_deadline, _last_prog, _equipped, _turned_off, _var_watch, _var_log, _var_text
    global _var_names, _lmap, _calls, _jcache, _assign_lines, _frame_last, _warn_seen, _last_cmd, _api_n
    global _next_tick, _tick_step, _tick_last_w, _stall_now, _stall_deadline, _stall_limit
    opts = json.loads(opts_json) if opts_json else {}
    lim = opts.get("limits") or {}
    _now = 0.0
    _count = 0
    _limit = int(lim.get("lineLimit", 2_000_000))
    _log_cap = int(lim.get("logCap", 20000))
    _print_cap = int(lim.get("printCap", 3000))
    wall_limit = float(lim.get("wallLimitS", 8.0))
    safety = lim.get("wallSafetyS")
    safety_limit = float(safety) if safety is not None else max(45.0, wall_limit)
    _log_line, _log_t, _prints, _warnings, _var_log = [], [], [], [], []
    _var_text = {}
    _warn_seen = {}
    _last_cmd = None
    _api_n = 0
    _print_dropped = 0
    _print_drop_line = 0
    _calls = {}
    _jcache = {}
    eq = opts.get("equipped")
    _equipped = frozenset(eq) | {"print"} if isinstance(eq, list) else None
    _turned_off = frozenset(opts.get("turnedOff") or ())
    _var_watch = bool(opts.get("varWatch", True))
    lm = opts.get("lineMap")
    _lmap = lm if isinstance(lm, list) and lm else None
    n_lines = code_str.count("\n") + 2
    if _lmap is not None:
        n_lines = max(n_lines, max((x or 0) for x in _lmap) + 2)
    _hits = [0] * (n_lines + 1)
    card_src = opts.get("srcForCards") or code_str
    result = {"end": "end", "error": None, "errorType": None, "guard": None}

    t_c0 = _wall()
    try:
        code, tree = _compile_cached(code_str)
    except SyntaxError as e:
        result.update(end="error", error=_explain_syntax(card_src, e), errorType=type(e).__name__)
        result.update(warnings=[], prints=[], printDropped=0, hits=_hits, lineLog=[[], []], lineCount=0, varLog=[],
                      calls={}, uncalled=[], stats={"compileMs": (_wall() - t_c0) * 1000, "execMs": 0, "lines": 0})
        return json.dumps(result, ensure_ascii=False)
    if _var_watch:
        _assign_lines, _var_names = _assigned_names(tree)
    else:
        _assign_lines, _var_names = {}, ()
    _frame_last = {}
    g = _make_globals(opts)
    t_e0 = _wall()
    _stall_limit = wall_limit
    _stall_now = 0.0
    _stall_deadline = t_e0 + wall_limit
    _wall_deadline = t_e0 + safety_limit
    _last_prog = t_e0
    _next_tick, _tick_step, _tick_last_w = min(4096, _limit + 1), 4096, t_e0
    exc = None
    monitor = opts.get("monitor", True)   # 速さを測る時だけ False（行の記録と行数の上限が無くなる）
    if monitor:
        _install(fast=(_log_cap == 0 and not _var_watch))
    try:
        exec(code, g)
    except _TimeUp as e:
        result["end"] = "timeup"
        exc = e
    except _LineLimit as e:
        result["end"] = {"lines": "loop", "busy": "busy"}.get(e.reason, "wall")
        exc = e
    except SystemExit:
        result["end"] = "exit"
    except BaseException as e:  # noqa: B902（KeyboardInterrupt なども生徒のコードの終わりとして扱う）
        result["end"] = "error"
        exc = e
    finally:
        _uninstall()
        _restore_globals()
    t_e1 = _wall()
    if _var_watch and _log_line:
        try:
            _scan_vars_final(g)
        except Exception:
            pass

    end = result["end"]
    if end == "error":
        result["errorType"] = type(exc).__name__
        result["errorCode"] = getattr(exc, "rover_code", None)
        result["error"] = _explain_exception(card_src, exc)
        result["errorLine"] = _exc_line(exc)
    elif end == "loop":
        result["guard"] = explain_guard(card_src, "lines", line=exc.line, limit=_limit, count=_count)
        result["guardLine"] = exc.line
    elif end == "wall":
        result["guard"] = explain_guard(card_src, "wall", line=exc.line, limit=wall_limit)
        result["guardLine"] = exc.line
    elif end == "busy":
        result["guard"] = explain_guard(card_src, "busy", line=None, limit=safety_limit, use_hits=False)
    elif end == "timeup":
        # くり返しの無いプログラム（どの行も 1 回）は、時間切れの時に動いていた行（長すぎる wait など）を指す。
        # 実行回数だけで選ぶと最初の行を指してしまう（2-4 で「2 行目のあたり」になっていた。直し A-7）
        tl = _tb_line(exc)
        loops = bool(_hits) and max(_hits) > 1
        result["guard"] = explain_guard(card_src, "timeup", line=None if loops else (tl or None),
                                        limit=opts.get("timeLimit"), use_hits=loops or not tl)
    if _print_dropped:
        flood = explain_guard(card_src, "print", line=_print_drop_line or None, limit=_print_cap)
        if result["guard"] is None:
            result["guard"] = flood
        else:
            result["flood"] = flood
    warns = [_explain_warning(card_src, w) for w in _warnings]
    result.update(
        warnings=warns, prints=_prints, printDropped=_print_dropped, hits=_hits,
        lineLog=[_log_line, [round(t, 4) for t in _log_t]], lineCount=_count, varLog=_var_log,
        calls=_calls, uncalled=_uncalled_defs(tree),
        stats={"compileMs": round((t_e0 - t_c0) * 1000, 3), "execMs": round((t_e1 - t_e0) * 1000, 3), "lines": _count},
    )
    out = json.dumps(result, ensure_ascii=False)
    # 生徒のグローバルを捨てる（5.5〔1.1〕。gc.collect() は 1 回の実行の終わりに cleanup() で）
    exc = None
    g.clear()
    return out


def _scan_vars_final(g):
    """最後の行を実行した後の値（モジュールの段の変数だけ）。"""
    i = len(_log_line) - 1
    for k in _var_names:
        v = g.get(k, _MISSING)
        if v is _MISSING or type(v) not in _SIMPLE:
            continue
        s = _fmt_val(v)
        if s is None or _var_text.get(k) == s:
            continue
        _var_text[k] = s
        if len(_var_log) < _VAR_CAP:
            _var_log.append([i, k, s])


def explain_guard_json(src, reason):
    """画面側で止めた時（fatal など）のカードを JSON で。"""
    return json.dumps(explain_guard(src, reason), ensure_ascii=False)


def translate_c(src):
    """C の面: c_subset（W8）で Python に訳す。{"ok", "py", "lineMap", "errors"} の JSON。"""
    try:
        from c_subset import translate
        r = translate(src)
        if isinstance(r, str):
            r = json.loads(r)
        r = dict(r)
        r["errors"] = [_clean(c) for c in (r.get("errors") or [])]
        r.setdefault("lineMap", None)
        return json.dumps(r, ensure_ascii=False)
    except Exception as e:  # まだ無い・壊れている
        card = _card("C_UNAVAILABLE", "compile", "ぼくはまだ C を読めないみたい", line=1,
                     why="C を Python に訳す部分がまだ準備できていないよ。", raw=f"{type(e).__name__}: {e}")
        return json.dumps({"ok": False, "py": "", "lineMap": None, "errors": [card]}, ensure_ascii=False)


def cleanup():
    """1 回の実行（ボタン 1 回ぶん）の終わり: 記録を捨てて gc.collect()（12 章の長時間テスト）。"""
    global _prints, _log_line, _log_t, _var_log, _warnings, _jcache
    _prints, _log_line, _log_t, _var_log, _warnings, _jcache = [], [], [], [], [], {}
    _code_cache.update(src=None, code=None, tree=None)
    gc.collect()
    return 0


def python_version():
    return sys.version.split()[0]
