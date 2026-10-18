"""ROVER CODE 判定（クリア・★・見出し・小目標の式を評価する）と、コードを読む道具（lines・uses・defs・道具箱）

持ち主: W2（実行エンジン）
役割: レベルの clear・stars・show・steps の式（Python の式）を、世界（または本番テストの回）ごとに eval で評価し、
      need（"all"・数 n・["test", n]）で合否をまとめる。道具箱（extract_defs）もここ。
SPEC: 6.12（語彙）・7.3「W2 worker/py/judge.py」・7.7（stars[].measure・better・steps・show）・7.8（判定の書き方）・3.4（道具箱）

名前空間: 記録から出す値は metrics.js（JS）の関数を呼ぶ（gap('cone') → JS）。コードから出す値（lines・uses・defs）は ast。
画面から来る値（prediction_ok・attempt）は job の ui。式のエラーは「判定できなかった」と灰色で出し、生徒のせいにしない。
CPython でも動く（ctx に Python の dict を渡せばよい。テストと W4 の確かめ用）。
"""
import ast
import json
import math
import re

# eval に渡す __builtins__（7.3: これだけ）
SAFE_BUILTINS = ("min", "max", "abs", "round", "len", "sum", "any", "all")
_SAFE = {k: __builtins__[k] if isinstance(__builtins__, dict) else getattr(__builtins__, k) for k in SAFE_BUILTINS}

# metrics.js の語彙（6.12・7.3）。関数か値か
METRIC_FUNCS = ("gap", "min_gap", "dist", "heading_err", "aim_err", "touched", "hit_speed", "visited",
                "visited_in_order", "entered", "max_offset", "calls", "printed_not_in", "printed_number_near",
                "speed_at_print", "phase_t", "phases_in_order", "n_phase", "stalls")
METRIC_VALUES = ("bumps", "still_shots", "turn_total", "travel", "stopped", "t_stop", "t_end", "x_end", "y_end", "heading_end",
                 "printed", "max_printed", "landed_t", "separated", "tangled", "crashed", "motor_before_land",
                 "nichrome_in_air", "timeup", "ok", "error")

try:  # Pyodide の中だけ
    from pyodide.ffi import to_js as _to_js, JsProxy as _JsProxy
except Exception:  # pragma: no cover（CPython）
    _to_js = None
    _JsProxy = ()


# ------------------------------------------------------------------ コードを読む（lines・uses・defs）
def _line_is_code(s, lang):
    s = s.strip()
    if not s:
        return False
    if lang == "c":
        return not s.startswith("//")
    return not s.startswith("#")


def _c_strip(src):
    """C のコメントと文字列を空白に（行の数は変えない）。"""
    out = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("".join(c if c == "\n" else " " for c in src[i:j]))
            i = j
        elif ch in "\"'":
            j = i + 1
            while j < n and src[j] != ch and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            j = min(j + 1, n)
            out.append(ch + " " * (j - i - 2) + (ch if j - i >= 2 else ""))
            i = j
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _c_semicolons(line):
    """1 行の中の ; の数（for ( ) の中を除く）。"""
    n = 0
    depth = 0
    in_for = False
    i = 0
    while i < len(line):
        if line.startswith("for", i) and (i == 0 or not (line[i - 1].isalnum() or line[i - 1] == "_")) \
                and not (i + 3 < len(line) and (line[i + 3].isalnum() or line[i + 3] == "_")):
            in_for = True
            i += 3
            continue
        ch = line[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
            if depth == 0:
                in_for = False
        elif ch == ";" and not (in_for and depth > 0):
            n += 1
        i += 1
    return n


def count_lines(src, lang="python"):
    """lines（6.12）: 空行とコメントだけの行を数えない。〔1.1〕1 行に文が 2 つ以上なら文の数（Python は ast の文、
    C は ; の数（for ( ) の中を除く））。C は #include・{・} だけの行も数える（コメントだけの行は数えない）。"""
    if lang == "c":
        stripped = _c_strip(src).split("\n")
        total = 0
        for s in stripped:
            if not s.strip():
                continue
            k = _c_semicolons(s)
            total += k if k >= 2 else 1
        return total
    lines = src.split("\n")
    per_line = {}
    try:
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.stmt):
                per_line[node.lineno] = per_line.get(node.lineno, 0) + 1
    except SyntaxError:
        per_line = {}
    total = 0
    for i, s in enumerate(lines, start=1):
        if not _line_is_code(s, "python"):
            continue
        k = per_line.get(i, 0)
        total += k if k >= 2 else 1
    return total


_USES = {ast.For: "for", ast.While: "while", ast.If: "if", ast.FunctionDef: "def", ast.Return: "return",
         ast.List: "list", ast.JoinedStr: "fstring", ast.Try: "try", ast.Import: "import", ast.ImportFrom: "import",
         ast.Break: "break", ast.Continue: "continue", ast.Global: "global", ast.ListComp: "list",
         ast.Tuple: "tuple", ast.IfExp: "if", ast.Lambda: "lambda"}


def code_uses(src):
    """ast で使った書き方の集まり（for・while・if・def・return・list・fstring・try・import・break と call:名前）。"""
    out = set()
    ndef = 0
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return out, 0
    for node in ast.walk(tree):
        k = _USES.get(type(node))
        if k:
            out.add(k)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            ndef += 1
        if hasattr(ast, "TryStar") and isinstance(node, ast.TryStar):
            out.add("try")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                out.add("call:" + node.func.id)
            elif isinstance(node.func, ast.Attribute):
                out.add("call:" + node.func.attr)
    return out, ndef


def uses(src, word):
    """uses(word)（6.12）: for・while・if・def・return・list・fstring・try・import・break を使ったか（ast で）。"""
    return word in code_uses(src)[0]


def count_defs(src):
    """defs（6.12）: def の数。"""
    return code_uses(src)[1]


# ------------------------------------------------------------------ 判定
def _py(v):
    if _JsProxy and isinstance(v, _JsProxy):
        try:
            return v.to_py()
        except Exception:
            return v
    return v


def _wrap(fn):
    def call(*args):
        a = []
        for x in args:
            if _to_js is not None and isinstance(x, (list, tuple, dict)):
                a.append(_to_js(list(x) if isinstance(x, tuple) else x))
            else:
                a.append(x)
        return _py(fn(*a))
    return call


def _get(obj, name, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    try:
        v = getattr(obj, name)
    except AttributeError:
        return default
    return default if v is None and default is not None else v


def _namespace(run, info):
    """1 つの世界（回）の名前空間。"""
    ns = dict(_SAFE)
    ns["math"] = math
    ns["inf"] = math.inf
    m = _get(run, "metrics")
    for name in METRIC_FUNCS:
        f = _get(m, name)
        if f is not None:
            ns[name] = _wrap(f) if (_JsProxy and isinstance(f, _JsProxy)) else f
    for name in METRIC_VALUES:
        v = _get(m, name)
        ns[name] = _py(v)
    if ns.get("printed") is None:
        ns["printed"] = []
    if ns.get("landed_t") is None:
        ns["landed_t"] = math.inf
    ns["lines"] = info["lines"]
    ns["defs"] = info["defs"]
    used = info["uses"]
    ns["uses"] = lambda word: word in used
    ns["prediction_ok"] = info["prediction_ok"]
    ns["attempt"] = info["attempt"]
    ns["seed"] = _py(_get(run, "seed", 1))
    for key in ("inject", "judge"):
        d = _py(_get(run, key)) or {}
        if isinstance(d, dict):
            ns.update(d)
    return ns


def _eval(expr, ns):
    """式を評価する。式のエラー（作り手のまちがい）は (None, "NameError: …")。"""
    try:
        code = compile(expr, "<judge>", "eval")
        return eval(code, {"__builtins__": {}}, ns), None
    except Exception as e:  # noqa
        return None, f"{type(e).__name__}: {e}"


def _need_ok(need, passes, n_runs):
    vals = [p for p in passes if p is not None]
    if need in (None, "all"):
        return len(vals) == n_runs and all(vals) and n_runs > 0
    if isinstance(need, (int, float)) and not isinstance(need, bool):
        return sum(1 for p in vals if p) >= need
    if isinstance(need, (list, tuple)) and len(need) == 2 and need[0] == "test":
        return sum(1 for p in vals if p) >= need[1]
    return False


def _is_test_need(need):
    return isinstance(need, (list, tuple)) and len(need) == 2 and need[0] == "test"


def _fmt_measure(v, unit):
    if v is None:
        return None
    try:
        if isinstance(v, bool):
            return "はい" if v else "いいえ"
        if v == math.inf:
            return "—"
        if unit == "cm":
            return f"{v:.1f} m" if abs(v) >= 1 else f"{round(v * 100)} cm"
        if unit == "m":
            return f"{v:.2f} m"
        if unit in ("s", "秒"):
            return f"{v:.1f} 秒"
        if unit in ("deg", "度"):
            return f"{v:.1f}°"
        if unit in ("lines", "行"):
            return f"{int(v)} 行"
        if unit in ("回", "times"):
            return f"{int(v)} 回"
        if isinstance(v, float):
            return f"{v:.2f}"
        return str(v)
    except Exception:
        return str(v)


def _fill_text(text, v):
    if not text:
        return text
    if v is None:
        return text
    reps = {}
    try:
        fv = float(v)
        if fv != fv or abs(fv) == math.inf:
            return None
        reps ={"cm": str(round(fv * 100)), "m": f"{fv:.2f}", "s": f"{fv:.1f}", "deg": f"{fv:.1f}",
                "value": f"{fv:g}", "n": str(int(fv)) if fv == fv and abs(fv) != math.inf else str(fv),
                "mm": str(round(fv * 1000))}
    except (TypeError, ValueError):
        reps = {"value": str(v)}
    # 1 m 以上は「3952 cm」ではなく「39.5 m」（直し C12）
    if "cm" in reps:
        fv = float(v)
        if abs(fv) >= 1:
            text = re.sub(r"\{cm\}\s*cm", f"{fv:.1f} m", text)
    return re.sub(r"\{([a-z]+)\}", lambda mo: reps.get(mo.group(1), mo.group(0)), text)


def _to_list(x):
    x = _py(x)
    if x is None:
        return []
    return list(x)


def evaluate(conditions_json, ctx):
    """条件を評価して JSON の文字で返す。

    conditions_json: {"clear": [...], "stars": [...], "show": {...}, "steps": [...]}（7.7）
    ctx: {"runs": [{metrics, inject, judge, seed}], "testRuns": [...]（本番テストの回。無ければ空）,
          "code", "lang", "pyCode"（C の面の訳）, "ui": {predictionOk, attempt}, "mode"}
    返す: {"clear": {"ok", "conds": [{label, need, pass, ok, error?}], "unjudged"},
           "stars": [{label, ok, earned, pass, byTest, measure?, error?}], "show": {text, value, world}|None,
           "steps": [{label, ok, pass}], "values": {"lines", "defs"}}
    """
    cond = json.loads(conditions_json) if isinstance(conditions_json, str) else conditions_json
    if not cond:
        return json.dumps(None)
    code = _py(_get(ctx, "code")) or ""
    lang = _py(_get(ctx, "lang")) or "python"
    py_code = _py(_get(ctx, "pyCode")) or (code if lang != "c" else "")
    ui = _py(_get(ctx, "ui")) or {}
    used, ndef = code_uses(py_code)
    info = {"lines": count_lines(code, lang), "defs": ndef, "uses": used,
            "prediction_ok": bool(ui.get("predictionOk", False)), "attempt": int(ui.get("attempt", 1) or 1)}
    runs = _to_list_runs(_get(ctx, "runs"))
    tests = _to_list_runs(_get(ctx, "testRuns"))
    ns_runs = [_namespace(r, info) for r in runs]
    ns_tests = [_namespace(r, info) for r in tests]
    has_tests = bool(tests)

    def judge_cond(c, is_star):
        expr = c.get("expr", "False")
        need = c.get("need", "all")
        by_test = _is_test_need(need)
        out = {"label": c.get("label", ""), "need": need, "byTest": by_test}
        group = ns_tests if by_test else ns_runs
        if by_test and not has_tests:
            out.update(ok=None, pass_=[], notJudged=True)
            return out
        passes, errors = [], []
        for ns in group:
            v, err = _eval(expr, ns)
            if err:
                errors.append(err)
                passes.append(None)
            else:
                passes.append(bool(v))
        out["pass_"] = passes
        if errors:
            out.update(ok=None, error=errors[0], expr=expr, unjudged=True)
        else:
            out["ok"] = _need_ok(need, passes, len(group))
        if is_star and c.get("measure"):
            # 「A または B」の★（直し係 5）: measure_alt = [{when, measure|None, label?, unit?}]。when が合った世界は
            # その measure（None ならその世界は値を出さない）で測る。出す値は、満たした側の値（「いま」と ✓ が食い違わない）
            alts = c.get("measure_alt") or []
            unit = c.get("unit", "")
            vals, kinds = [], []
            for ns in group:
                m_expr, kind = c["measure"], 0
                for k, a in enumerate(alts):
                    av, aerr = _eval(a.get("when", "False"), ns)
                    if not aerr and av:
                        m_expr, kind = a.get("measure"), k + 1
                        break
                if not m_expr:
                    vals.append(None)
                    kinds.append(None)
                    continue
                v, err = _eval(m_expr, ns)
                vals.append(None if err else _num_or_none(v))
                kinds.append(kind)
            better = c.get("better", "low")
            isnum = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)  # noqa: E731
            used = [k for k, x in zip(kinds, vals) if k is not None and isnum(x)]
            show_kind = 0 if (0 in used or not used) else used[0]
            nums = [x for k, x in zip(kinds, vals) if k == show_kind and isnum(x)]
            worst = None
            if nums:
                worst = max(nums) if better == "low" else min(nums)
            m_expr, m_label, m_unit = c["measure"], None, unit
            if show_kind:
                a = alts[show_kind - 1]
                m_expr, m_label, m_unit = a.get("measure"), a.get("label"), a.get("unit", unit)
            text = _fmt_measure(worst, m_unit)
            if text and m_label:
                text = f"{m_label} {text}"
            out["measure"] = {"expr": m_expr, "value": worst, "byWorld": vals, "better": better, "unit": m_unit,
                              "text": text}
            if m_label:
                out["measure"]["label"] = m_label
            if c.get("tip"):
                out["tip"] = c["tip"]
        return out

    clear_conds = [judge_cond(c, False) for c in cond.get("clear") or []]
    unjudged = any(c.get("unjudged") for c in clear_conds)
    clear_ok = bool(clear_conds) and all(c.get("ok") is True for c in clear_conds if not c.get("notJudged")) \
        and not unjudged
    stars = []
    for c in cond.get("stars") or []:
        s = judge_cond(c, True)
        s["earned"] = bool(clear_ok and s.get("ok") is True)
        # ★はクリアした実行でだけ数える（直し係 3。C-2 のスターターで「スタートの 15 cm 以内」、6-4 の時間切れで
        # 「ずれ 25 cm 以内」に ✓ が付いた）。クリアしていない時は ok を False にし、元の値は okRaw・測った値は counted: False
        s["counted"] = bool(clear_ok)
        if not clear_ok and s.get("ok") is True:
            s["okRaw"] = True
            s["ok"] = False
        if not clear_ok and isinstance(s.get("measure"), dict):
            s["measure"]["counted"] = False
        stars.append(s)

    # 見出し（show）: 決めた世界（first_failed は最初に失敗した世界、無ければ 1 つ目）
    fail_idx = _first_failed(clear_conds, len(ns_runs))
    show = None
    sh = cond.get("show")
    if sh and ns_runs:
        w = sh.get("world", "first_failed")
        wi = fail_idx if w == "first_failed" else (int(w) if isinstance(w, int) and 0 <= w < len(ns_runs) else 0)
        v, err = _eval(sh.get("expr", "None"), ns_runs[wi])
        v = _num_or_none(v) if err is None else None
        show = {"text": _fill_text(sh.get("text", ""), v) if v is not None else None, "value": v, "world": wi}
        if err:
            show["error"] = err
        # すき間を見出しにする面は、どの世界も同じ規則で言う（ぶつかった・そっとタッチ・通りすぎた・手前で止まった。
        # 直し A-1・直し係 3）。世界ごとの文は show["byWorld"]（画面の世界の切りかえ・ふきだし用）
        if not err:
            byw = [_show_world_text(sh, cond, ns, _fill_text) for ns in ns_runs]
            show["byWorld"] = [b[0] for b in byw]
            text, kind = byw[wi]
            if kind:
                show["text"] = text
                show[kind] = True
    steps = []
    for st in cond.get("steps") or []:
        passes = []
        err = None
        for ns in ns_runs:
            v, e = _eval(st.get("expr", "False"), ns)
            err = err or e
            passes.append(None if e else bool(v))
        ok = passes[fail_idx] if passes else None
        item = {"label": st.get("label", ""), "ok": ok, "pass_": passes}
        if err:
            item["error"] = err
        steps.append(item)
    res = {"clear": {"ok": clear_ok, "conds": clear_conds, "unjudged": unjudged, "failedWorld": fail_idx},
           "stars": stars, "show": show, "steps": steps,
           "values": {"lines": info["lines"], "defs": info["defs"]}}
    return json.dumps(_rename_pass(res), ensure_ascii=False, default=_json_default)


_TOUCH_SOFT = 0.3   # これ以下の速さでふれたら「そっとタッチ」（8-4〜10 章の hit_speed('cone') <= 0.3 と同じ）


def _touch_limit(cond, target):
    """面がふれるのを許す速さ: clear に hit_speed(target) <= X があれば X、touched(target) を禁じていれば 0、
    どちらも書いていなければ（7-3・9-6・10-3 など。gap だけ）いくらでもよい（inf）。"""
    exprs = " ".join(str(c.get("expr", "")) for c in (cond.get("clear") or []))
    lim = None
    for m in re.finditer(r"hit_speed\(\s*['\"]%s['\"]\s*\)\s*<=?\s*([\d.]+)" % re.escape(target), exprs):
        lim = max(lim or 0.0, float(m.group(1)))
    if lim is not None:
        return lim
    if re.search(r"touched\(\s*['\"]%s['\"]\s*\)" % re.escape(target), exprs):
        return 0.0
    return math.inf


def _show_world_text(sh, cond, ns, fill):
    """1 つの世界の見出し（文, 種類）。種類は touched・soft・passed（決まった文）か None（面の text のまま）"""
    expr = sh.get("expr", "None")
    v, err = _eval(expr, ns)
    v = _num_or_none(v) if err is None else None
    base = fill(sh.get("text", ""), v) if v is not None else None
    m = re.search(r"gap\(\s*['\"]([A-Za-z0-9_]+)['\"]\s*\)", expr)
    if not m:
        # 距離の見出し（「スタートまで {cm} cm」など）でも、動いていなければそう言う（3-1・C-2 で「スタートまで 0 cm」と出た。直し係 6）
        tr, e5 = _eval("travel", ns)
        tt, e6 = _eval("turn_total", ns)
        if e5 is None and isinstance(tr, (int, float)) and tr < 0.01 and (e6 is not None or not isinstance(tt, (int, float)) or abs(tt) < 5):
            return "1 cm も動かなかった", "still"
        return base, None
    target = m.group(1)
    name = "コーン" if target == "cone" else ""
    hit, e2 = _eval("touched('%s')" % target, ns)
    if e2 is None and hit:
        hs, e3 = _eval("hit_speed('%s')" % target, ns)
        hs = hs if e3 is None and isinstance(hs, (int, float)) else math.inf
        lim = _touch_limit(cond, target)
        if lim <= 0:   # ふれてはいけない面（1〜6 章など）は速さによらず「ぶつかった」
            return f"{name}にぶつかった" if name else "ぶつかった", "touched"
        if hs <= min(lim, _TOUCH_SOFT) + 1e-9:
            return f"{name}にそっとタッチ" if name else "そっとタッチ", "soft"
        if hs <= lim + 1e-9:
            return f"{name}にタッチした" if name else "タッチした", "soft"
        return f"{name}にぶつかった" if name else "ぶつかった", "touched"
    # 1 cm も動いていない（スタートの向きの後ろに目標があると「通りすぎた」と言っていた。2-5・8-5・9-6 のスターター。直し係 4）
    tr, e5 = _eval("travel", ns)
    tt, e6 = _eval("turn_total", ns)
    if e5 is None and isinstance(tr, (int, float)) and tr < 0.01 and (e6 is not None or not isinstance(tt, (int, float)) or abs(tt) < 5):
        return "1 cm も動かなかった", "still"
    # 通りすぎた: 止まった時、目標が機体の後ろ（向きと目標の方向の差が 100° より大きい）にある
    aim, e4 = _eval("aim_err('%s')" % target, ns)
    if e4 is None and isinstance(aim, (int, float)) and aim > 100 and v is not None and v > 0.005:
        t = fill("{cm} cm", v)
        return (f"{name}を {t} 通りすぎた" if name else f"{t} 通りすぎた"), "passed"
    if v is not None and 0 <= v < 0.005 and "{cm}" in (sh.get("text") or ""):
        # 「0 cm 手前で止まった」は読みにくい（ふれてはいない）
        return (f"{name}のすぐ前（1 cm 未満）で止まった" if name else "すぐ前（1 cm 未満）で止まった"), "close"
    return base, None


def _rename_pass(o):
    if isinstance(o, dict):
        return {("pass" if k == "pass_" else k): _rename_pass(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_rename_pass(v) for v in o]
    if isinstance(o, float) and (o != o or o in (math.inf, -math.inf)):
        return None if o != o else (1e308 if o > 0 else -1e308)
    return o


def _json_default(o):
    try:
        return float(o)
    except Exception:
        return str(o)


def _num_or_none(v):
    v = _py(v)
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    return None


def _first_failed(clear_conds, n):
    for i in range(n):
        for c in clear_conds:
            if c.get("byTest"):
                continue
            p = c.get("pass_") or []
            if i < len(p) and p[i] is False:
                return i
    return 0


def _to_list_runs(x):
    x = _py(x) if not (_JsProxy and isinstance(x, _JsProxy)) else x
    if x is None:
        return []
    try:
        return list(x)
    except TypeError:
        return []


def eval_expr(expr, ctx_run, code="", lang="python"):
    """1 つの式を 1 つの世界で評価する（W4 の levels.test.mjs がダミーの記録で式を確かめる時など）。"""
    used, ndef = code_uses(code)
    info = {"lines": count_lines(code, lang), "defs": ndef, "uses": used, "prediction_ok": True, "attempt": 1}
    v, err = _eval(expr, _namespace(ctx_run, info))
    return json.dumps({"value": _rename_pass(v) if not callable(v) else None, "error": err}, ensure_ascii=False,
                      default=_json_default)


# ------------------------------------------------------------------ 道具箱（extract_defs、〔1.1〕3.4）
def extract_defs(src):
    """トップレベルの def と、それが使う上の段の import・代入・def を取り出す。
    返す（JSON）: [{name, kind: "def"|"value"|"import", src, needs: [名前…], lines}]
    （needs は直接使うものだけ。道具箱に入れる側が needs をたどって、足りないものもいっしょに入れる）"""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return json.dumps([])
    top = {}      # 名前 → (kind, node)
    order = []
    for node in tree.body:
        names = []
        kind = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names, kind = [node.name], "def"
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            kind = "import"
            names = [(a.asname or a.name).split(".")[0] for a in node.names if a.name != "*"]
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            kind = "value"
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        names.append(n.id)
        for nm in names:
            if nm not in top:
                order.append(nm)
            top[nm] = (kind, node)    # 後の代入が勝つ（同じ名前を 2 回書いたら最後のもの）
    out = []
    seen_nodes = set()
    for nm in order:
        kind, node = top[nm]
        if id(node) in seen_nodes and kind != "import":
            continue
        seen_nodes.add(id(node))
        seg = _segment(src, node)
        needs = sorted(_free_names(node) & set(top) - {nm}) if kind == "def" else \
            sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)} & set(top) - {nm})
        out.append({"name": nm, "kind": kind, "src": seg, "needs": needs, "lines": count_lines(seg),
                    "line": node.lineno})
    return json.dumps(out, ensure_ascii=False)


def _segment(src, node):
    lines = src.split("\n")
    start = node.lineno
    if getattr(node, "decorator_list", None):
        start = min([start] + [d.lineno for d in node.decorator_list])
    end = getattr(node, "end_lineno", node.lineno) or node.lineno
    return "\n".join(lines[start - 1:end])


def _free_names(fn):
    """関数の中で読むが、引数でも中の代入でもない名前（global 宣言したものは外の名前）。"""
    params = set()
    a = fn.args if hasattr(fn, "args") else None
    if a is not None:
        for x in a.posonlyargs + a.args + a.kwonlyargs:
            params.add(x.arg)
        if a.vararg:
            params.add(a.vararg.arg)
        if a.kwarg:
            params.add(a.kwarg.arg)
    glob = set()
    stored = set()
    loaded = set()
    for n in ast.walk(fn):
        if isinstance(n, ast.Global):
            glob.update(n.names)
        elif isinstance(n, ast.Name):
            if isinstance(n.ctx, ast.Store):
                stored.add(n.id)
            else:
                loaded.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n is not fn:
            stored.add(n.name)
    local = (stored | params) - glob
    return (loaded | (glob & stored)) - local
