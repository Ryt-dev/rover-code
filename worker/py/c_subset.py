"""ROVER CODE おまけ C: C の部分集合を Python に訳す

持ち主: W8（SIL・C・テストの土台・配る形）
役割: 生徒の C（rover.h の関数を使う）を Python に訳し、同じエンジン・同じ記録・同じ判定で動かす。行番号は元の C の行に対応させる。
SPEC: 5.6（使える C・使えない C・rover.h・C のエラー）・7.3「W8 worker/py/c_subset.py」・9.2（C の面）・6.12（lines・uses）・13.2 W8 ①

使える C: #include "rover.h"（と <stdio.h>・<math.h>）、int・double・void の関数定義と引数、int main(void)、宣言と初期化、
          = += -= *= /= ++ --、+ - * / %（両方 int なら 0 の方へ切り捨て）、比較、&& || !、if/else if/else、for（宣言つき）、
          while、break・continue・return、printf（%d %f %.Nf %s %% \\n）、// と /* */、math.h の sqrt・fabs・atan2・sin・cos。
          （おまけで通すもの: const、float（double と同じ）、(int)・(double) の型変換、? :、%=、&|^~<<>>（int）、'a' の文字の数、
           math.h の tan・pow・floor・ceil・hypot・round・fmin・fmax・exp・log と M_PI、関数の前置きの宣言（プロトタイプ）。）
rover.h: void motor(double l, double r)・void wait(double s)・void stop(void)・double distance_to_cone(void)・
         double lidar(void)（何も無いときは −1）・double heading(void)・double now(void)。
         ◆ 決定（W8）: rover.h は <stdio.h> と <math.h> も読みこむ（C-1 のスターターは rover.h だけで printf を使うため）。
使えない C（配列・ポインタ・構造体・文字列の変数・scanf・malloc・#define・switch・do-while など）は C_UNSUPPORTED で日本語で止める。
エラーの ID は C_ で始める（C_SEMICOLON・C_UNDECLARED・C_NO_TYPE・C_BRACE・C_PRINT・C_UNSUPPORTED ほか、下の _MSG の一覧）。

公開するもの:
    translate(src) -> {"ok", "py", "lineMap", "errors", "warnings", "names", "info"}
        py      … 訳した Python（1 行目は `import _c_runtime as _c`。最後の行で main() を呼ぶ）
                  _c_runtime は c_subset を読みこんだ時に sys.modules に入る小さな道具の入れ物（idiv・imod・nz・toint・math の命令）
        lineMap … [0, C の行, C の行, …]（添え字 = py の行、値 = C の行。0 は「C の行なし」）
        errors  … 止める Card（9.3 の形。error_explain.py と同じ形の dict）。ok が偽の時に 1 つ
        warnings… 止めない Card（if (d = 0.25) の「= と ==」・何もしない文 など。gcc -Wall に似せた注意）
        names   … {py の名前: C の名前}（名前を変えた変数だけ。変数のマウスの表示で C の名前に戻す）
        info    … analyze(src) と同じ（lines・uses・defs）
    analyze(src) -> {"lines", "uses", "defs"} … 6.12 の lines（C の数え方）・uses・defs を C のまま数える（judge.py 用）
    count_lines(src) -> int
    fix_card(card, py_src, c_src, line_map) -> card … 実行中のエラーのカード（Python の行）を C の行と C のコードに直す
    remap_result(result, line_map) -> result … rover_runtime.run の結果（hits・lineLog・varLog・prints・warnings）の行を C に直す

エンジン（W2）での使い方（lang == "c" の時）:
    pre = EX.before_run(c_src, chapter, "c")            # 全角などの文字の検査は C のままで（W3）
    tr = c_subset.translate(c_src)
    if not tr["ok"]: compileError = tr["errors"][0]      # runs は空
    else:  rover_runtime.run(tr["py"], {..., "lineMap": tr["lineMap"]})   # 記録の行は lineMap で C の行に（0 の行は記録しない）
           実行中のエラーのカードは c_subset.fix_card(card, tr["py"], c_src, tr["lineMap"]) で C に直す
           before に tr["warnings"] を足す（止めない注意）
"""
from __future__ import annotations

import math as _math
import re

__all__ = ["translate", "analyze", "count_lines", "fix_card", "remap_result"]

# =====================================================================================================
# 訳した Python が実行中に使う小さな道具（`import _c_runtime as _c` で `_c.idiv(a, b)` のように呼ぶ）
# ここの関数は main.py の外にあるので、行の記録（sys.monitoring は main.py だけ）には出ない。
# =====================================================================================================


def idiv(a, b):
    """int どうしの割り算（C と同じく 0 の方へ切り捨て。-7 / 2 は -3）。"""
    a, b = int(a), int(b)
    if b == 0:
        raise ZeroDivisionError("integer division by zero")
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def imod(a, b):
    """int どうしの余り（C と同じく、符号は割られる数と同じ。-7 % 2 は -1）。"""
    a, b = int(a), int(b)
    return a - idiv(a, b) * b


def nz(v):
    """lidar() の None（何も無い）を C の −1 に。"""
    return -1.0 if v is None else v


def toint(v):
    """(int) と、double を int の変数に入れる時（0 の方へ切り捨て）。"""
    return int(v)


sqrt = _math.sqrt
fabs = _math.fabs
atan2 = _math.atan2
sin = _math.sin
cos = _math.cos
tan = _math.tan
floor = _math.floor
ceil = _math.ceil
hypot = _math.hypot
exp = _math.exp
log = _math.log
pow = _math.pow  # noqa: A001（C の名前のまま）
fmin = min
fmax = max


def round(x):  # noqa: A001（C の round は 0.5 を 0 から遠い方へ）
    return _math.floor(x + 0.5) if x >= 0 else -_math.floor(-x + 0.5)


M_PI = _math.pi

_RUNTIME_NAMES = ("idiv", "imod", "nz", "toint", "sqrt", "fabs", "atan2", "sin", "cos", "tan", "floor", "ceil", "hypot",
                  "exp", "log", "pow", "fmin", "fmax", "round", "M_PI")


def _install_runtime():
    """訳した Python が `import _c_runtime as _c` で読む小さな入れ物（上の道具だけ）を sys.modules に入れる。
    c_subset そのものは生徒の import から守られている（rover_runtime の _BLOCK）ので、道具だけを別の名前で渡す。"""
    import sys as _sys
    import types as _types
    m = _types.ModuleType("_c_runtime", "ROVER CODE おまけ C の実行用の道具（c_subset.py が作る）")
    for k in _RUNTIME_NAMES:
        setattr(m, k, globals()[k])
    _sys.modules["_c_runtime"] = m
    return m


RUNTIME = _install_runtime()

# =====================================================================================================
# エラーの文（日本語のカードと、gcc に似せた英文）
# =====================================================================================================

_TERM_C = "C ＝ マイコン（M5 ATOM など）でよく使う言葉。命令の終わりに ;、まとまりを { } で書く"
_MSG = {
    "C_SEMICOLON": ("「;」が足りなくて、ぼくには命令の区切りが分からなかったよ",
                    "{line} 行目の「{code}」の終わり",
                    "C では、1 つの命令の終わりに必ず ;（セミコロン）を書く。Python のように行の終わりでは区切れないんだ。"
                    "C のエラーは、次の行で見つかることも多いよ。",
                    "{line} 行目の終わりに ; を足そう。"),
    "C_UNDECLARED": ("「{name}」という名前を、ぼくは知らないよ",
                     "{line} 行目の「{name}」",
                     "C では、変数は使う前に double {name} = 0; のように型を付けて作り、関数も使う前に作っておく。{why2}",
                     "{fix2}"),
    "C_NO_TYPE": ("「{name}」の型が書いてないよ",
                  "{line} 行目の「{name}」",
                  "C では、変数も関数も最初に型（int・double・void）を書いて作る。Python のように、入れた値で決まらないんだ。",
                  "{fix2}"),
    "C_BRACE": ("「{」と「}」の数が合っていないみたい",
                "{line} 行目{where2}",
                "C では { と } で「ここからここまで」を決める。開いた { は、同じ数の } で閉じないといけないんだ。{why2}",
                "{fix2}"),
    "C_PAREN": ("「(」と「)」の数が合っていないみたい",
                "{line} 行目の「{code}」",
                "if (…)・while (…)・関数の呼び出しの ( ) は、開いた数だけ閉じる。",
                "{fix2}"),
    "C_PRINT": ("{title2}",
                "{line} 行目の「{code}」",
                "{why2}",
                "{fix2}"),
    "C_UNSUPPORTED": ("このゲームの C では、まだ{what}は使えないよ",
                      "{line} 行目の「{span}」",
                      "おまけの C で使えるのは、int・double・void、if・for・while、関数、printf、rover.h と math.h の命令まで。{why2}",
                      "{fix2}"),
    "C_INCLUDE": ("「{span}」は、このゲームの C では使えないよ",
                  "{line} 行目",
                  "このゲームで読みこめるのは \"rover.h\"・<stdio.h>・<math.h> の 3 つだけなんだ。",
                  "#include \"rover.h\" を一番上に書けば、ローバーの命令と printf・sqrt などが使えるよ。"),
    "C_NO_MAIN": ("int main(void) { … } が見つからないよ",
                  "プログラム全体",
                  "C のプログラムは main という関数から動き始める。main が無いと、ぼくはどこから始めればいいか分からないんだ。",
                  "int main(void) { … return 0; } を作って、命令はその { } の中に書こう。"),
    "C_OUTSIDE": ("命令が関数の外に書いてあるよ",
                  "{line} 行目の「{code}」",
                  "C では、命令（motor(…); など）は関数の { } の中にしか書けない。Python のように上から順に置くだけでは動かないんだ。",
                  "命令を int main(void) { … } の中へ移そう。"),
    "C_ARGS": ("「{name}」に渡す値の数が合っていないよ",
               "{line} 行目の「{code}」",
               "{name} は {want} 個の値を受け取る関数なのに、{got} 個渡しているんだ。",
               "{example2}"),
    "C_TYPE": ("{title2}",
               "{line} 行目の「{code}」",
               "{why2}",
               "{fix2}"),
    "C_REDECL": ("「{name}」を 2 回作っているよ",
                 "{line} 行目の「{name}」",
                 "同じ { } の中で、同じ名前の変数（または同じ名前の関数）は 1 回しか作れない。{why2}",
                 "2 回目の型（{ctype}）を消して、ただの代入 {name} = …; にしよう。名前を変えてもいいよ。"),
    "C_CONST": ("const の「{name}」は、あとから書きかえられないよ",
                "{line} 行目の「{code}」",
                "const を付けて作った変数は、最初に入れた値のまま。書きかえたい値なら const を外そう。",
                "const を外すか、別の変数を作ろう。"),
    "C_LOOP_ONLY": ("「{name}」は、くり返しの中でしか使えないよ",
                    "{line} 行目の「{name}」",
                    "{name} は while・for の { } の中で使う命令なんだ。",
                    "くり返しの中へ移すか、消そう。"),
    "C_SYNTAX": ("{title2}",
                 "{line} 行目の「{code}」",
                 "{why2}",
                 "{fix2}"),
    "C_CHAR": ("全角の「{span}」が入っていて、ぼくには読めなかったよ",
               "{line} 行目の「{span}」",
               "C の命令・記号・数は、全部半角で書く。全角の字は \"…\" の中と、// のメモの中だけで使えるんだ。",
               "日本語入力をオフにして、半角で打ち直そう。"),
    # 止めない注意（gcc -Wall に似せた）
    "C_ASSIGN_IN_COND": ("( ) の中が「=」（入れる）になっているよ。くらべるなら「==」",
                         "{line} 行目の「{code}」",
                         "C では if (d = 0.25) も書けてしまう。d に 0.25 を入れて、その値（0 でない）で「本当」になるので、"
                         "いつも中に入るんだ。くらべる時は == を使う。",
                         "くらべるつもりなら = を == に直そう。"),
    "C_NO_EFFECT": ("{line} 行目は、何もしない命令になっているよ",
                    "{line} 行目の「{code}」",
                    "計算やくらべた結果を、どこにも入れていないんだ。{why2}",
                    "{fix2}"),
}

_WHY_EXTRA = {
    "C_NO_EFFECT_EQ": ("x == 3; は「くらべるだけ」。入れたい時は = を 1 つ。", "入れるつもりなら == を = に直そう。"),
}

# Python の書き方で C に書いてしまった時のひとこと（名前 → (わけ, 直し方)）
_PY_HINTS = {
    "print": ("C の表示の命令は printf だよ。", "printf(\"のこり %.2f m\\n\", d); のように書こう（%.2f は小数 2 けた、\\n は改行）。"),
    "True": ("C には True が無い。本当は 1 で表す。", "True を 1 に直そう。"),
    "False": ("C には False が無い。うそは 0 で表す。", "False を 0 に直そう。"),
    "None": ("C には None が無い。lidar() は何も無い時に −1 を返す。", "「無い」を表すには −1 などの、ありえない数を使おう。"),
    "and": ("C の「かつ」は && だよ。", "and を && に直そう。"),
    "or": ("C の「または」は || だよ。", "or を || に直そう。"),
    "not": ("C の「〜でない」は ! だよ。", "not x を !x に直そう。"),
    "elif": ("C では elif ではなく else if と書くよ。", "elif を } else if (…) { に直そう。"),
    "def": ("C の関数は def ではなく、型から書く。", "void forward(double s) { … } のように書こう。"),
    "range": ("C の for は range を使わない。", "for (int i = 0; i < 4; i++) { … } のように書こう。"),
    "in": ("C の for は in を使わない。", "for (int i = 0; i < 4; i++) { … } のように書こう。"),
    "abs": ("小数の絶対値は fabs だよ（abs は整数だけで、このゲームの C には無い）。", "abs を fabs に直そう。"),
    "pass": ("C に pass は無い。何もしない時は { } を空にするだけ。", "pass を消そう。"),
    "time": ("C のゲームでは now() で時刻を読むよ。", "time() を now() に直そう。"),
    "sleep": ("C のゲームでは wait(秒) で待つよ。", "sleep(…) を wait(…) に直そう。"),
    "delay": ("Arduino の delay はミリ秒。このゲームでは wait(秒) を使うよ。", "delay(1000) は wait(1) に直そう。"),
    "math": ("C では math. を付けずに sqrt(x) のように呼ぶよ。", "math.sqrt(x) は sqrt(x) に直そう。"),
}
_PY_KEYWORDISH = {"elif", "def", "and", "or", "not", "in", "pass", "True", "False", "None", "print"} - {"print"}
_ROVER_NOT_IN_C = {"gnss", "camera", "marker", "odometer", "encoder", "altitude", "accel", "nichrome", "phase"}

_GCC = {
    "C_SEMICOLON": "expected ';' before {tok}",
    "C_UNDECLARED_VAR": "'{name}' undeclared (first use in this function)",
    "C_UNDECLARED_FN": "implicit declaration of function '{name}'",
    "C_BRACE_EOF": "expected declaration or statement at end of input",
    "C_BRACE_EXTRA": "expected identifier or '(' before '}}' token",
    "C_PAREN": "expected ')' before {tok}",
    "C_NO_MAIN": "undefined reference to `main'",
}


class _CErr(Exception):
    def __init__(self, card):
        super().__init__(card.get("title", ""))
        self.card = card


# =====================================================================================================
# 字句（トークン）
# =====================================================================================================

class Tok:
    __slots__ = ("k", "v", "line", "col", "end")

    def __init__(self, k, v, line, col, end):
        self.k, self.v, self.line, self.col, self.end = k, v, line, col, end   # col・end は 1 から、end は含まない

    def __repr__(self):
        return f"Tok({self.k},{self.v!r},{self.line}:{self.col})"

    def show(self):
        if self.k == "eof":
            return "end of input"
        if self.k == "num":
            return "numeric constant"
        if self.k == "str":
            return "string constant"
        if self.k == "id":
            return f"'{self.v}'"
        return f"'{self.v}' token"


_OPS = sorted("""<<= >>= ... -> ++ -- += -= *= /= %= &= |= ^= && || == != <= >= << >>
+ - * / % = < > ! ~ & | ^ ? : ; , . ( ) { } [ ]""".split(), key=len, reverse=True)
_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"', "a": "\a", "b": "\b", "f": "\f", "v": "\v", "?": "?"}


_NUM_RE = re.compile(r"0[xX][0-9a-fA-F]+[uUlL]*|([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)([eE][+-]?[0-9]+)?[fFlLuU]*")


class Lexer:
    def __init__(self, src, ctx):
        self.src = src
        self.ctx = ctx
        self.lines = src.split("\n")

    def tokens(self):
        out = []
        src = self.src
        i, n = 0, len(src)
        line, lstart = 1, 0
        at_line_start = True
        while i < n:
            ch = src[i]
            if ch == "\n":
                line += 1
                i += 1
                lstart = i
                at_line_start = True
                continue
            if ch in " \t\r\f\v":
                i += 1
                continue
            col = i - lstart + 1
            if src.startswith("//", i):
                j = src.find("\n", i)
                i = n if j < 0 else j
                continue
            if src.startswith("/*", i):
                j = src.find("*/", i + 2)
                if j < 0:
                    raise self.ctx.err("C_SYNTAX", line, col, col + 2, raw="unterminated comment",
                                       title2="/* で始めたメモが */ で閉じていないよ",
                                       why2="/* から */ までがメモになる。*/ が無いと、最後までメモになってしまうんだ。",
                                       fix2="メモの終わりに */ を書こう。1 行のメモなら // でもいいよ。")
                for k in range(i, j):
                    if src[k] == "\n":
                        line += 1
                        lstart = k + 1
                i = j + 2
                continue
            if ch == "#" and at_line_start:
                j = src.find("\n", i)
                j = n if j < 0 else j
                text = src[i:j]
                # 行の終わりの // メモは取る
                text = re.sub(r"//.*$", "", text).rstrip()
                out.append(Tok("pp", text, line, col, col + len(text)))
                i = j
                continue
            at_line_start = False
            if ch.isascii() and (ch.isalpha() or ch == "_"):
                j = i + 1
                while j < n and src[j].isascii() and (src[j].isalnum() or src[j] == "_"):
                    j += 1
                word = src[i:j]
                out.append(Tok("id", word, line, col, col + (j - i)))
                i = j
                continue
            if "0" <= ch <= "9" or (ch == "." and i + 1 < n and "0" <= src[i + 1] <= "9"):
                m = _NUM_RE.match(src, i)
                text = m.group(0)
                j = m.end()
                if j < n and src[j].isascii() and (src[j].isalnum() or src[j] == "_"):
                    raise self.ctx.err("C_SYNTAX", line, col, col + (j - i) + 1, raw="invalid suffix on integer constant",
                                       title2="数の書き方が、ぼくには読めなかったよ",
                                       why2="数のすぐ後ろに文字が続いている。1.5m のように単位を付けたり、名前を数で始めたりはできないんだ。",
                                       fix2="数だけにしよう。単位は // のメモに書けるよ。名前は文字で始めよう。")
                out.append(Tok("num", text, line, col, col + (j - i)))
                i = j
                continue
            if ch == '"':
                s, j = self._string(i, line, col, '"')
                # となりあう "…" "…" はつなぐ
                if out and out[-1].k == "str" and out[-1].line == line:
                    prev = out.pop()
                    out.append(Tok("str", prev.v + s, prev.line, prev.col, col + (j - i)))
                else:
                    out.append(Tok("str", s, line, col, col + (j - i)))
                i = j
                continue
            if ch == "'":
                s, j = self._string(i, line, col, "'")
                if len(s) != 1:
                    raise self.ctx.err("C_UNSUPPORTED", line, col, col + (j - i), what="'…' の中が 1 文字でない書き方",
                                       raw="multi-character character constant",
                                       why2="'a' のような ' ' は 1 文字だけ。文字の並び（文字列）は printf の \"…\" の中で書こう。",
                                       fix2="\"…\" に直そう。")
                out.append(Tok("num", str(ord(s)), line, col, col + (j - i)))
                i = j
                continue
            for op in _OPS:
                if src.startswith(op, i):
                    out.append(Tok("op", op, line, col, col + len(op)))
                    i += len(op)
                    break
            else:
                self._bad_char(ch, line, col)
        last_line = len(self.lines)
        last_col = len(self.lines[-1]) + 1 if self.lines else 1
        out.append(Tok("eof", "", last_line, last_col, last_col))
        return out

    def _bad_char(self, ch, line, col):
        if not ch.isascii():
            raise self.ctx.err("C_CHAR", line, col, col + 1, span=ch, raw=f"stray '{ch}' in program")
        raise self.ctx.err("C_SYNTAX", line, col, col + 1, span=ch, raw=f"stray '{ch}' in program",
                           title2=f"「{ch}」は、C では使わない記号だよ",
                           why2=f"「{ch}」は C の記号ではないんだ。Python の書き方が混ざっていないかな？",
                           fix2=f"「{ch}」を消すか、C の書き方に直そう。")

    def _string(self, i, line, col, q):
        src = self.src
        j = i + 1
        buf = []
        while True:
            if j >= len(src) or src[j] == "\n":
                raise self.ctx.err("C_SYNTAX", line, col, col + 1, raw="missing terminating " + q + " character",
                                   title2=f"{q} で始めた文字が {q} で閉じていないよ",
                                   why2=f"文字は {q}…{q} のように両側を同じ記号で囲む。閉じる {q} が行の中に無いんだ。",
                                   fix2=f"文字の終わりに {q} を足そう。")
            c = src[j]
            if c == q:
                return "".join(buf), j + 1
            if c == "\\" and j + 1 < len(src):
                e = src[j + 1]
                if e in _ESC:
                    buf.append(_ESC[e])
                    j += 2
                    continue
                buf.append(e)
                j += 2
                continue
            buf.append(c)
            j += 1


# =====================================================================================================
# 型・名前・関数
# =====================================================================================================

_TYPE_WORDS = {"int", "double", "float", "void", "char", "long", "short", "unsigned", "signed", "const", "static",
               "extern", "volatile", "register", "struct", "union", "enum", "typedef", "auto", "inline", "_Bool", "bool"}
_C_KEYWORDS = _TYPE_WORDS | {"if", "else", "while", "for", "do", "switch", "case", "default", "break", "continue",
                             "return", "goto", "sizeof"}
_PY_RESERVED = {"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
                "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
                "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
                "print", "int", "float", "range", "len", "abs", "min", "max", "round", "str", "bool", "list",
                "dict", "set", "tuple", "type", "sum", "any", "all", "input", "exit", "quit"}
# rover.h（int・double は C の型の名前）
_ROVER = {
    "motor": ("void", ["double", "double"]),
    "wait": ("void", ["double"]),
    "stop": ("void", []),
    "distance_to_cone": ("double", []),
    "lidar": ("double", []),
    "heading": ("double", []),
    "now": ("double", []),
}
_MATHF = {
    "sqrt": ("double", ["double"]), "fabs": ("double", ["double"]), "atan2": ("double", ["double", "double"]),
    "sin": ("double", ["double"]), "cos": ("double", ["double"]), "tan": ("double", ["double"]),
    "pow": ("double", ["double", "double"]), "floor": ("double", ["double"]), "ceil": ("double", ["double"]),
    "hypot": ("double", ["double", "double"]), "round": ("double", ["double"]), "fmin": ("double", ["double", "double"]),
    "fmax": ("double", ["double", "double"]), "exp": ("double", ["double"]), "log": ("double", ["double"]),
}
_UNSUP_FUNCS = {
    "scanf": ("scanf", "キーボードから値を入れる命令は、このゲームでは使えないんだ。", "入れたい値は double d = 1.5; のように変数に書いておこう。"),
    "gets": ("gets", "キーボードから値を入れる命令は、このゲームでは使えないんだ。", "入れたい値は変数に書いておこう。"),
    "getchar": ("getchar", "キーボードから値を入れる命令は、このゲームでは使えないんだ。", "入れたい値は変数に書いておこう。"),
    "malloc": ("malloc（メモリを自分で取る書き方）", "マイコンでも、走らせる前に必要な変数を作っておく書き方が安全なんだ。", "ふつうの変数を使おう。"),
    "calloc": ("calloc（メモリを自分で取る書き方）", "", "ふつうの変数を使おう。"),
    "realloc": ("realloc（メモリを自分で取る書き方）", "", "ふつうの変数を使おう。"),
    "free": ("free（メモリを返す書き方）", "", "ふつうの変数を使えば、free は要らないよ。"),
    "strcpy": ("文字列の命令（strcpy）", "", "文字は printf の \"…\" の中だけで使おう。"),
    "strlen": ("文字列の命令（strlen）", "", "文字は printf の \"…\" の中だけで使おう。"),
    "strcmp": ("文字列の命令（strcmp）", "", "文字は printf の \"…\" の中だけで使おう。"),
    "puts": ("puts", "", "printf(\"…\\n\"); で表示しよう。"),
    "putchar": ("putchar", "", "printf で表示しよう。"),
    "sprintf": ("sprintf", "", "printf で表示しよう。"),
    "exit": ("exit", "", "main の中なら return 0; で終われるよ。"),
    "rand": ("rand（乱数）", "", "決まった数で書こう。"),
    "srand": ("srand（乱数）", "", "決まった数で書こう。"),
}


class Sym:
    __slots__ = ("name", "py", "t", "const", "is_global", "line")

    def __init__(self, name, py, t, const, is_global, line):
        self.name, self.py, self.t, self.const, self.is_global, self.line = name, py, t, const, is_global, line


class Func:
    __slots__ = ("name", "py", "ret", "params", "defined", "line", "builtin")

    def __init__(self, name, py, ret, params, defined, line, builtin=None):
        self.name, self.py, self.ret, self.params, self.defined, self.line, self.builtin = name, py, ret, params, defined, line, builtin


def _node(k, line, t=None, **kw):
    d = {"k": k, "line": line, "t": t}
    d.update(kw)
    return d


# =====================================================================================================
# 構文と意味（宣言してから使う・型）
# =====================================================================================================

class Ctx:
    """カードを作る（C のソースの行を持つ）"""

    def __init__(self, src):
        self.src = src
        self.lines = src.split("\n")

    def code_of(self, line):
        if 1 <= line <= len(self.lines):
            return self.lines[line - 1].strip()
        return ""

    def card(self, rid, line, col=None, end=None, severity="error", raw=None, **v):
        base = rid
        title, where, why, fix = _MSG[base]
        line = max(1, min(line, max(1, len(self.lines))))
        code = self.code_of(line)
        span = v.get("span")
        if span is None and col and end and end > col:
            span = self.lines[line - 1][col - 1:end - 1] if line <= len(self.lines) else ""
        vv = {"line": line, "col": col or 1, "code": code, "span": span or code}
        vv.update({k: x for k, x in v.items() if x is not None})
        vv.setdefault("why2", "")
        vv.setdefault("fix2", "")
        vv.setdefault("where2", "")

        def fill(text):
            return re.sub(r"\{([a-z0-9_]+)\}", lambda mo: str(vv.get(mo.group(1), mo.group(0))), text)

        raw_txt = f"main.c:{line}:{col or 1}: {'error' if severity == 'error' else 'warning'}: {raw}" if raw else ""
        return {
            "id": rid, "stage": "compile" if severity == "error" else "compile_warning", "severity": severity,
            "speaker": "rover", "zukan": "C_SUBSET", "line": line, "col": col, "end_col": end,
            "title": fill(title), "where": fill(where), "why": fill(why).strip(), "fix": fill(fix).strip(),
            "term": _TERM_C, "raw": raw_txt, "example": v.get("example"), "quickfix": None, "confirm": False,
            "more": 0, "notes": [], "lang": "c",
            "vars": {k: x for k, x in vv.items() if isinstance(x, (str, int, float)) and k not in ("why2", "fix2")},
        }

    def err(self, rid, line, col=None, end=None, raw=None, **v):
        return _CErr(self.card(rid, line, col, end, "error", raw, **v))


class Parser:
    def __init__(self, src):
        self.ctx = Ctx(src)
        self.toks = Lexer(src, self.ctx).tokens()
        self.i = 0
        self.includes = {}            # 名前 → 行
        self.include_line = 1
        self.funcs = {}               # 名前 → Func
        self.scopes = []              # [{C の名前: Sym}]（いちばん外が大域）
        self.used_py = set()          # 今の関数で使っている py の名前
        self.global_py = set()
        self.cur_func = None
        self.loop_depth = 0
        self.items = []               # 大域の宣言と関数（出てきた順）
        self.warnings = []
        self.names = {}
        self.assigned_globals = set()
        self.ever = {}                # 一度でも作った変数の名前 → 行（{ } の外で使った時の説明）

    # ---- トークンを読む
    @property
    def tok(self):
        return self.toks[self.i]

    def peek(self, k=1):
        return self.toks[min(self.i + k, len(self.toks) - 1)]

    def prev(self):
        return self.toks[self.i - 1] if self.i > 0 else self.toks[0]

    def adv(self):
        t = self.toks[self.i]
        if t.k != "eof":
            self.i += 1
        return t

    def is_op(self, v, t=None):
        t = t or self.tok
        return t.k == "op" and t.v == v

    def accept(self, v):
        if self.is_op(v):
            return self.adv()
        return None

    def expect_semi(self):
        if self.is_op(";"):
            return self.adv()
        p = self.prev()
        t = self.tok
        self._pyism(t)
        if self.is_op("}") or t.k == "eof" or t.line > p.line or t.k in ("id", "num", "str"):
            raise self.ctx.err("C_SEMICOLON", p.line, p.end, p.end + 1, raw=_GCC["C_SEMICOLON"].format(tok=t.show()),
                               example={"bad": "motor(0.6, 0.6)\nwait(4.42);", "good": "motor(0.6, 0.6);\nwait(4.42);"})
        if self.is_op(")"):
            raise self.ctx.err("C_PAREN", t.line, t.col, t.end, raw=f"expected ';' before ')' token",
                               fix2="余分な ) を消そう。( と ) の数をそろえるんだ。")
        raise self.ctx.err("C_SEMICOLON", p.line, p.end, p.end + 1, raw=_GCC["C_SEMICOLON"].format(tok=t.show()))

    def expect(self, v, what=None):
        if self.is_op(v):
            return self.adv()
        t = self.tok
        if v in (")", ";", "{"):
            self._pyism(t)
        if v == ")":
            p = self.prev()
            raise self.ctx.err("C_PAREN", p.line, t.col if t.line == p.line else p.end, None,
                               raw=_GCC["C_PAREN"].format(tok=t.show()), fix2="( に合う ) を足そう。")
        if v == "(":
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected '(' before {t.show()}",
                               title2=f"{what or ''}のあとに ( が要るよ".strip(),
                               why2="C の if・while・for は、条件を ( ) で囲んで書くんだ。Python のように : は使わない。",
                               fix2="if (d < 0.3) { … } のように書こう。")
        if v == "{":
            raise self.ctx.err("C_BRACE", t.line, t.col, t.end, raw=f"expected '{{' before {t.show()}",
                               where2="", why2="関数の中身は { } で囲んで書く。",
                               fix2="int main(void) { のように、( ) のあとに { を書こう。")
        if v == ";":
            return self.expect_semi()
        raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected '{v}' before {t.show()}",
                           title2=f"ここに「{v}」が要るみたい",
                           why2=f"C の書き方では、ここに「{v}」が来るはずなんだ。",
                           fix2=f"「{v}」を足そう。")

    def _pyism(self, t):
        """Python の書き方が混ざっている時は、そちらの説明を優先する"""
        if t.k == "id" and t.v in _PY_HINTS and t.v not in self._visible_names():
            why, fix = _PY_HINTS[t.v]
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected expression before {t.show()}",
                               title2=f"「{t.v}」は C では使わない書き方だよ", why2=why, fix2=fix)
        if t.k == "op" and t.v == ":" and self.prev().k == "op" and self.prev().v == ")":
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="expected statement before ':' token",
                               title2="( ) のあとの「:」は Python の書き方だよ",
                               why2="C では、if (…)・while (…)・for (…) のあとは : ではなく { … } でまとまりを書く。",
                               fix2=": を { に直して、まとまりの終わりに } を書こう。",
                               example={"bad": "if (d < 0.3):\n    stop();", "good": "if (d < 0.3) {\n    stop();\n}"})

    def _visible_names(self):
        s = set(self.funcs)
        for sc in self.scopes:
            s |= set(sc)
        return s

    # ---- 名前
    def lookup(self, name):
        for sc in reversed(self.scopes):
            if name in sc:
                return sc[name]
        return None

    def py_name(self, name, is_global):
        """C の名前 → Python の名前。Python の言葉・道具の名前とぶつかる時と、見えている別の変数と同じ名前の時は変える"""
        base = name
        if base in _PY_RESERVED or base.startswith("_c") or base.startswith("__") or base in _MATHF:
            base = base + "_"
        taken = set(self.global_py)
        if not is_global:
            for sc in self.scopes[1:]:
                taken |= {x.py for x in sc.values()}
        cand = base
        k = 2
        while cand in taken:
            cand = f"{base}_{k}"
            k += 1
        if cand != name:
            self.names[cand] = name
        return cand

    def declare(self, name, t, const, line, col, end):
        sc = self.scopes[-1]
        is_global = len(self.scopes) == 1
        if name in sc:
            raise self.ctx.err("C_REDECL", line, col, end, raw=f"redefinition of '{name}'", name=name, ctype=t)
        if is_global and (name in self.funcs or name in _ROVER or name in _MATHF or name == "printf"):
            raise self.ctx.err("C_REDECL", line, col, end, raw=f"'{name}' redeclared as different kind of symbol",
                               name=name, ctype=t, why2=f"{name} は関数（命令）の名前なんだ。")
        if t == "void":
            raise self.ctx.err("C_TYPE", line, col, end, raw=f"variable or field '{name}' declared void",
                               title2=f"変数「{name}」を void では作れないよ",
                               why2="void は「値を返さない関数」に付ける型。変数は int か double で作る。",
                               fix2=f"double {name} のように直そう。")
        py = self.py_name(name, is_global)
        s = Sym(name, py, t, const, is_global, line)
        sc[name] = s
        self.ever.setdefault(name, line)
        if is_global:
            self.global_py.add(py)
        else:
            self.used_py.add(py)
        return s

    # ---- 型
    def is_type_start(self, t=None):
        t = t or self.tok
        return t.k == "id" and t.v in _TYPE_WORDS

    def parse_type(self):
        """[const] int|double|float|void。それ以外は止める。返す (型, const)"""
        const = False
        base = None
        start = self.tok
        while self.is_type_start():
            t = self.adv()
            w = t.v
            if w == "const":
                const = True
                continue
            if w in ("int", "double", "void"):
                if base:
                    self._unsup_type(t, f"{base} {w}")
                base = w
                continue
            if w == "float":
                if base:
                    self._unsup_type(t, f"{base} {w}")
                base = "double"
                continue
            if w in ("struct", "union", "enum", "typedef"):
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="構造体（struct）や型を作る書き方" if w != "enum" else "enum",
                                   raw=f"'{w}' is not supported in this game", span=w,
                                   fix2="値は 1 つずつ int か double の変数にしよう。")
            if w == "char":
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="文字や文字列の変数", span=w,
                                   raw="char variables are not supported in this game",
                                   why2="文字は printf の \"…\" の中だけで使えるよ。",
                                   fix2="表示したい文字は printf(\"…\"); の中に直接書こう。")
            if w in ("_Bool", "bool"):
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="bool の型", span=w,
                                   raw=f"unknown type name '{w}'", why2="C の真偽は int の 1（本当）と 0（うそ）で表す。",
                                   fix2=f"{w} を int に直そう。")
            if w in ("static", "extern", "volatile", "register", "auto", "inline"):
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what=f"「{w}」", span=w,
                                   raw=f"'{w}' is not supported in this game", fix2=f"{w} を消そう。")
            self._unsup_type(t, w)
        if base is None:
            t = self.tok
            raise self.ctx.err("C_NO_TYPE", start.line, start.col, start.end, name=t.v if t.k == "id" else start.v,
                               raw=f"type defaults to 'int' in declaration", fix2="const の後ろに int か double を書こう。")
        return base, const

    def _unsup_type(self, t, w):
        raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what=f"「{w}」の型", span=w,
                           raw=f"type '{w}' is not supported in this game",
                           why2="このゲームの C の型は int（整数）・double（小数）・void（値なし）の 3 つ。",
                           fix2="整数なら int、小数なら double にしよう。")

    def _check_unsup_declarator(self):
        t = self.tok
        if self.is_op("*"):
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="ポインタ（* や &）", span="*",
                               raw="pointers are not supported in this game", fix2="ふつうの int・double の変数を使おう。")
        if self.is_op("["):
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="配列", span="[",
                               raw="arrays are not supported in this game",
                               why2="いくつもの値は、変数を 1 つずつ作って並べよう。",
                               fix2="double d1 = 0, d2 = 0, d3 = 0; のように、変数を分けて書こう。")

    # ---- 全体
    def parse(self):
        self.scopes = [{}]
        while self.tok.k != "eof":
            t = self.tok
            if t.k == "pp":
                self.adv()
                self.preproc(t)
                continue
            if self.is_op(";"):
                self.adv()
                continue
            if self.is_op("}"):
                raise self.ctx.err("C_BRACE", t.line, t.col, t.end, raw=_GCC["C_BRACE_EXTRA"].format(),
                                   where2="の「}」", why2="この } に合う { が無いんだ。",
                                   fix2="余分な } を消そう。関数の終わりの } は 1 つだけ。")
            self.external()
        main = self.funcs.get("main")
        if not main or not main.defined:
            raise _CErr(self.ctx.card("C_NO_MAIN", 1, None, None, raw=_GCC["C_NO_MAIN"],
                                      example={"bad": "#include \"rover.h\"\nmotor(0.6, 0.6);",
                                               "good": "#include \"rover.h\"\n\nint main(void) {\n    motor(0.6, 0.6);\n    return 0;\n}"}))
        return self.items

    def preproc(self, t):
        text = t.v.strip()
        m = re.match(r"#\s*include\s*([<\"])\s*([^>\"]*)\s*[>\"]\s*$", text)
        if m:
            name = m.group(2).strip()
            if name in ("rover.h", "stdio.h", "math.h"):
                self.includes.setdefault(name, t.line)
                if len(self.includes) == 1:
                    self.include_line = t.line
                return
            raise self.ctx.err("C_INCLUDE", t.line, t.col, t.end, span=text, raw=f"{name}: not available in this game")
        m = re.match(r"#\s*(\w+)", text)
        word = m.group(1) if m else text
        if word == "define":
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="#define", span=text,
                               raw="#define is not supported in this game",
                               why2="#define の代わりに、const を付けた変数が使えるよ。",
                               fix2="#define SPEED 0.6 は const double SPEED = 0.6; と書こう（main より上に）。")
        raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what=f"「#{word}」", span=text,
                           raw=f"#{word} is not supported in this game", fix2="#include の行だけにしよう。")

    def need_rover(self, name, t):
        if "rover.h" not in self.includes:
            raise self.ctx.err("C_UNDECLARED", t.line, t.col, t.end, name=name, raw=_GCC["C_UNDECLARED_FN"].format(name=name),
                               why2=f"{name} は rover.h の中で作ってある命令なんだ。",
                               fix2="一番上に #include \"rover.h\" を書こう。")

    def external(self):
        t = self.tok
        if t.k == "id" and t.v not in _TYPE_WORDS:
            self._no_type_toplevel(t)
        if t.k != "id":
            self._pyism(t)
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected identifier or '(' before {t.show()}",
                               title2="ここで何をしたいのか、ぼくには分からなかったよ",
                               why2="関数の外に書けるのは、#include と、型から始まる変数や関数の作り方だけなんだ。",
                               fix2="命令は int main(void) { … } の中に書こう。")
        typ, const = self.parse_type()
        self._check_unsup_declarator()
        nt = self.tok
        if nt.k != "id":
            self._pyism(nt)
            raise self.ctx.err("C_SYNTAX", nt.line, nt.col, nt.end, raw=f"expected identifier or '(' before {nt.show()}",
                               title2=f"{typ} のあとに名前が要るよ",
                               why2=f"{typ} は型。そのあとに作る変数や関数の名前を書くんだ。",
                               fix2=f"{typ} speed = 0.6; や {typ} forward(double s) {{ … }} のように書こう。")
        if nt.v in _C_KEYWORDS:
            raise self.ctx.err("C_SYNTAX", nt.line, nt.col, nt.end, raw=f"expected identifier before '{nt.v}'",
                               title2=f"「{nt.v}」は C の決まった言葉なので、名前には使えないよ",
                               why2="int・for・if などは C の言葉として決まっているんだ。", fix2="別の名前にしよう。")
        self.adv()
        if self.is_op("("):
            self.function(typ, nt)
            return
        decls = self.declarators(typ, const, nt, global_=True)
        self.items.append(("gdecl", t.line, decls))

    def _unknown_type(self, t, nxt):
        """名前 名前 … の形（知らない型の名前）"""
        if t.v in _PY_KEYWORDISH:
            self._pyism(t)
        hint = {"string": ("文字列の変数", "文字は printf の \"…\" の中だけで使おう。"),
                "String": ("文字列の変数", "文字は printf の \"…\" の中だけで使おう。"),
                "bool": ("bool の型", "真偽は int の 1 と 0 で表そう。"),
                "boolean": ("bool の型", "真偽は int の 1 と 0 で表そう。")}.get(t.v)
        if hint:
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what=hint[0], span=t.v,
                               raw=f"unknown type name '{t.v}'", fix2=hint[1])
        raise self.ctx.err("C_NO_TYPE", t.line, t.col, t.end, name=nxt.v, raw=f"unknown type name '{t.v}'",
                           fix2=f"「{t.v}」は C の型ではないよ。int か double か void にしよう。")

    def _no_type_toplevel(self, t):
        nxt = self.peek()
        if t.v in _PY_HINTS and t.v in ("def", "print"):
            if t.v == "print" or nxt.k == "id":
                self._pyism(t)
        if t.v in ("if", "for", "while", "return", "do", "switch", "else", "break", "continue"):
            raise self.ctx.err("C_OUTSIDE", t.line, t.col, t.end, raw=f"expected identifier or '(' before '{t.v}'")
        if nxt.k == "id" and t.v not in _C_KEYWORDS:
            self._unknown_type(t, nxt)
        if self.is_op("(", nxt):
            # 名前 ( … ) のあとが { なら型のない関数、; なら関数の外の命令
            depth, j = 0, self.i + 1
            while j < len(self.toks):
                tk = self.toks[j]
                if tk.k == "op" and tk.v == "(":
                    depth += 1
                elif tk.k == "op" and tk.v == ")":
                    depth -= 1
                    if depth == 0:
                        break
                elif tk.k == "eof":
                    break
                j += 1
            after = self.toks[min(j + 1, len(self.toks) - 1)]
            if after.k == "op" and after.v == "{":
                raise self.ctx.err("C_NO_TYPE", t.line, t.col, t.end, name=t.v, raw=f"return type defaults to 'int'",
                                   fix2=f"関数の名前の前に、返す値の型を書こう。値を返さないなら void {t.v}(…) {{、main なら int main(void) {{。")
            if t.v in _ROVER or t.v in _MATHF or t.v in ("printf",) or t.v in self.funcs:
                raise self.ctx.err("C_OUTSIDE", t.line, t.col, t.end, raw="expected declaration specifiers or '...' before numeric constant",
                                   example={"bad": "#include \"rover.h\"\nmotor(0.6, 0.6);",
                                            "good": "#include \"rover.h\"\n\nint main(void) {\n    motor(0.6, 0.6);\n    return 0;\n}"})
            raise self.ctx.err("C_NO_TYPE", t.line, t.col, t.end, name=t.v, raw=f"return type defaults to 'int'",
                               fix2=f"関数を作るなら void {t.v}(…) {{ … }}、命令なら main の中に書こう。")
        if self.is_op("=", nxt) or self.is_op(";", nxt):
            raise self.ctx.err("C_NO_TYPE", t.line, t.col, t.end, name=t.v, raw=f"type defaults to 'int' in declaration of '{t.v}'",
                               fix2=f"double {t.v} = …; のように、名前の前に型を書こう。",
                               example={"bad": "speed = 0.6;", "good": "double speed = 0.6;"})
        if t.v in _PY_HINTS:
            self._pyism(t)
        raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected '=', ',', ';' or '(' before {nxt.show()}",
                           title2="ここで何をしたいのか、ぼくには分からなかったよ",
                           why2="関数の外に書けるのは、#include と、型から始まる変数や関数の作り方だけなんだ。",
                           fix2="命令は int main(void) { … } の中に書こう。")

    def function(self, ret, nt):
        name = nt.v
        self.adv()  # (
        params = []
        if self.is_op(")"):
            self.adv()
        elif self.tok.k == "id" and self.tok.v == "void" and self.is_op(")", self.peek()):
            self.adv()
            self.adv()
        else:
            while True:
                pt = self.tok
                if not self.is_type_start():
                    if pt.k == "id" and self.peek().k == "op" and self.peek().v in (",", ")"):
                        raise self.ctx.err("C_NO_TYPE", pt.line, pt.col, pt.end, name=pt.v,
                                           raw=f"type of '{pt.v}' defaults to 'int'",
                                           fix2=f"受け取る値にも型を書こう。double {pt.v} のように。",
                                           example={"bad": "void forward(s) {", "good": "void forward(double s) {"})
                    self._pyism(pt)
                    raise self.ctx.err("C_SYNTAX", pt.line, pt.col, pt.end, raw=f"expected declaration specifiers before {pt.show()}",
                                       title2="( ) の中の書き方が、ぼくには分からなかったよ",
                                       why2="関数の ( ) の中には、受け取る値を「型 名前」で書く。何も受け取らないなら void。",
                                       fix2="void forward(double s) { … } や int main(void) { … } のように書こう。")
                ptyp, pconst = self.parse_type()
                self._check_unsup_declarator()
                pn = self.tok
                if pn.k != "id":
                    if ptyp == "void" and self.is_op(")"):
                        raise self.ctx.err("C_SYNTAX", pn.line, pn.col, pn.end, raw="'void' must be the only parameter",
                                           title2="void は ( ) の中に 1 つだけ書くよ", why2="何も受け取らない時だけ (void) と書くんだ。",
                                           fix2="(void) か、(double s) のように直そう。")
                    raise self.ctx.err("C_SYNTAX", pn.line, pn.col, pn.end, raw=f"expected identifier before {pn.show()}",
                                       title2=f"{ptyp} のあとに名前が要るよ", why2="受け取る値は「型 名前」で書くんだ。",
                                       fix2=f"({ptyp} s) のように名前を書こう。")
                if ptyp == "void":
                    raise self.ctx.err("C_TYPE", pn.line, pn.col, pn.end, raw=f"parameter '{pn.v}' has incomplete type",
                                       title2=f"受け取る値「{pn.v}」を void では作れないよ",
                                       why2="受け取る値の型は int か double。", fix2=f"double {pn.v} に直そう。")
                self.adv()
                self._check_unsup_declarator()
                params.append((pn.v, ptyp, pconst, pn))
                if self.accept(","):
                    continue
                self.expect(")")
                break
        ptypes = [p[1] for p in params]
        if name in _ROVER or name in _MATHF or name == "printf":
            raise self.ctx.err("C_REDECL", nt.line, nt.col, nt.end, raw=f"conflicting types for '{name}'", name=name, ctype=ret,
                               why2=f"{name} は rover.h（か math.h・stdio.h）で、もう作ってある命令なんだ。",
                               fix2="自分の関数には別の名前を付けよう（forward・turn_right など）。")
        if name in self.scopes[0]:
            raise self.ctx.err("C_REDECL", nt.line, nt.col, nt.end, raw=f"'{name}' redeclared as different kind of symbol",
                               name=name, ctype=ret, why2=f"{name} はもう変数の名前に使っているんだ。")
        f = self.funcs.get(name)
        if f:
            if f.ret != ret or f.params != ptypes:
                raise self.ctx.err("C_REDECL", nt.line, nt.col, nt.end, raw=f"conflicting types for '{name}'", name=name, ctype=ret,
                                   why2="前に書いた宣言と、型や受け取る値が違うんだ。",
                                   fix2="前に書いた宣言と同じ型・同じ受け取る値にそろえよう。")
        else:
            py = name if name == "main" else self.py_name(name, True)
            f = Func(name, py, ret, ptypes, False, nt.line)
            self.funcs[name] = f
            self.global_py.add(py)
        if self.accept(";"):
            return  # 前置きの宣言（プロトタイプ）
        if not self.is_op("{"):
            self._pyism(self.tok)
            self.expect("{")
        if f.defined:
            raise self.ctx.err("C_REDECL", nt.line, nt.col, nt.end, raw=f"redefinition of '{name}'", name=name, ctype=ret,
                               why2="同じ名前の関数を 2 つ作っているんだ。", fix2="どちらかの名前を変えるか、1 つにまとめよう。")
        f.defined = True
        f.line = nt.line
        self.cur_func = f
        self.used_py = set()
        self.assigned_globals = set()
        self.scopes.append({})
        psyms = []
        for pname, ptyp, pconst, pt in params:
            psyms.append(self.declare(pname, ptyp, pconst, pt.line, pt.col, pt.end))
        body = self.block()
        self.scopes.pop()
        self.items.append(("func", nt.line, f, psyms, body, sorted(self.assigned_globals)))
        self.cur_func = None

    def declarators(self, typ, const, first, global_=False):
        out = []
        nt = first
        while True:
            self._check_unsup_declarator()
            if typ == "void":
                self.declare(nt.v, typ, const, nt.line, nt.col, nt.end)   # void の変数は作れない（ここで止まる）
            init = None
            if self.accept("="):
                init = self.assign_expr()
                if init["t"] == "void":
                    raise self.ctx.err("C_TYPE", init["line"], None, None, raw="void value not ignored as it ought to be",
                                       title2="値を返さない命令を、変数に入れようとしているよ",
                                       why2="void の関数（motor・wait・stop など）は値を返さないので、変数に入れられないんだ。",
                                       fix2="命令だけを 1 行で呼ぼう。")
                if init["t"] == "str":
                    raise self.ctx.err("C_UNSUPPORTED", init["line"], None, None, what="文字列の変数",
                                       raw="string variables are not supported in this game",
                                       fix2="文字は printf(\"…\"); の中に直接書こう。")
                if global_ and _has_call(init):
                    raise self.ctx.err("C_TYPE", nt.line, nt.col, nt.end, raw="initializer element is not constant",
                                       title2="関数の外で作る変数には、決まった数しか入れられないよ",
                                       why2="関数の外（大域）の変数は、走り出す前に作る。命令の結果はまだ無いんだ。",
                                       fix2="数を入れておいて、main の中で読み直そう。")
            elif const:
                raise self.ctx.err("C_CONST", nt.line, nt.col, nt.end, name=nt.v, raw=f"uninitialized const '{nt.v}'",
                                   fix2=f"const double {nt.v} = 0.6; のように、作る時に値を入れよう。")
            if init is not None:
                self._nested_printf(init)
            sym = self.declare(nt.v, typ, const, nt.line, nt.col, nt.end)
            out.append((sym, init, nt.line))
            if not self.accept(","):
                break
            nt = self.tok
            if nt.k != "id":
                raise self.ctx.err("C_SYNTAX", nt.line, nt.col, nt.end, raw=f"expected identifier before {nt.show()}",
                                   title2=", のあとに名前が要るよ", why2="int a = 1, b = 2; のように、, で区切って名前を並べるんだ。",
                                   fix2="名前を書くか、, を消そう。")
            self.adv()
        self.expect_semi()
        return out

    # ---- 文
    def block(self):
        lb = self.expect("{")
        items = []
        while not self.is_op("}"):
            t = self.tok
            if t.k == "eof":
                fn = self.cur_func.name if self.cur_func else ""
                raise self.ctx.err("C_BRACE", t.line, t.col, None, raw=_GCC["C_BRACE_EOF"], where2="（プログラムの終わり）",
                                   why2=f"{lb.line} 行目の {{ を閉じる }} が足りないまま、プログラムが終わったんだ。",
                                   fix2=f"{lb.line} 行目の {{ に合う }} を、まとまりの終わりに足そう。")
            if t.k == "pp":
                raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="preprocessor directive inside function",
                                   title2="#include は関数の外（一番上）に書くよ",
                                   why2="# で始まる行は、プログラムの一番上にまとめて書くんだ。",
                                   fix2="この行をプログラムの一番上へ移そう。")
            if self.is_type_start():
                # 関数の中で関数を作ろうとしている = 前の } が足りない
                j = self.i
                while j < len(self.toks) and self.toks[j].k == "id" and self.toks[j].v in _TYPE_WORDS:
                    j += 1
                if j + 1 < len(self.toks) and self.toks[j].k == "id" and self.toks[j + 1].k == "op" and self.toks[j + 1].v == "(":
                    fn = self.cur_func.name if self.cur_func else "前の関数"
                    raise self.ctx.err("C_BRACE", t.line, t.col, t.end, raw="invalid storage class for function",
                                       where2=f"の「{self.toks[j].v}」の前",
                                       why2=f"{fn} の {{ }} が閉じないまま、次の関数 {self.toks[j].v} が始まっているんだ。",
                                       fix2=f"{t.line} 行目より上の、{fn} の終わりに }} を足そう。")
                typ, const = self.parse_type()
                self._check_unsup_declarator()
                nt = self.tok
                if nt.k != "id" or nt.v in _C_KEYWORDS:
                    raise self.ctx.err("C_SYNTAX", nt.line, nt.col, nt.end, raw=f"expected identifier before {nt.show()}",
                                       title2=f"{typ} のあとに名前が要るよ",
                                       why2=f"{typ} は型。そのあとに作る変数の名前を書くんだ。",
                                       fix2=f"{typ} d = 0; のように書こう。")
                self.adv()
                items.append(("decl", t.line, self.declarators(typ, const, nt)))
                continue
            if t.k == "id" and self.peek().k == "id" and t.v not in _C_KEYWORDS and self.lookup(t.v) is None \
                    and t.v not in self.funcs and t.v not in _ROVER and t.v not in _MATHF:
                self._unknown_type(t, self.peek())
            items.append(self.statement())
        rb = self.adv()
        return ("block", lb.line, items, rb.line)

    def statement(self):
        t = self.tok
        if t.k == "op":
            if t.v == "{":
                self.scopes.append({})
                b = self.block()
                self.scopes.pop()
                return b
            if t.v == ";":
                self.adv()
                return ("empty", t.line)
        if t.k == "id":
            w = t.v
            if w == "if":
                self.adv()
                self.expect("(", "if ")
                c = self.cond_expr_in_parens()
                then = self.sub_statement()
                els, eline = None, None
                if self.tok.k == "id" and self.tok.v == "else":
                    eline = self.adv().line
                    els = self.sub_statement()
                return ("if", t.line, c, then, els, eline)
            if w == "else":
                raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="'else' without a previous 'if'",
                                   title2="else の前に、合う if が無いよ",
                                   why2="else は if (…) { … } のすぐあとに書く。間に別の命令や、余分な ; があると合わなくなるんだ。",
                                   fix2="if (…) { … } else { … } の形になっているか確かめよう。")
            if w == "while":
                self.adv()
                self.expect("(", "while ")
                c = self.cond_expr_in_parens()
                self.loop_depth += 1
                body = self.sub_statement()
                self.loop_depth -= 1
                return ("while", t.line, c, body)
            if w == "for":
                return self.for_statement()
            if w in ("do", "switch", "goto", "case", "default"):
                what = {"do": "do { … } while", "switch": "switch", "goto": "goto", "case": "switch（case）",
                        "default": "switch（default）"}[w]
                fix = {"do": "while (…) { … } で書こう。", "goto": "while や break で書こう。"}.get(w, "if・else if・else で書こう。")
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what=what, span=w,
                                   raw=f"'{w}' is not supported in this game", fix2=fix)
            if w in ("break", "continue"):
                self.adv()
                if self.loop_depth <= 0:
                    raise self.ctx.err("C_LOOP_ONLY", t.line, t.col, t.end, name=w,
                                       raw=f"{w} statement not within loop or switch")
                self.expect_semi()
                return (w, t.line)
            if w == "return":
                self.adv()
                e = None
                f = self.cur_func
                if not self.is_op(";"):
                    e = self.expr()
                    self._nested_printf(e)
                    if f and f.ret == "void":
                        raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="'return' with a value, in function returning void",
                                           title2="void の関数から値を返そうとしているよ",
                                           why2=f"{f.name} は void（値を返さない）で作った関数なんだ。",
                                           fix2=f"値を返したいなら void を double や int に変えよう。返さないなら return; だけにしよう。")
                    if e["t"] in ("void", "str"):
                        raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="incompatible types when returning type",
                                           title2="ここで返している値の型が合わないよ",
                                           why2="返せるのは int か double の値だけなんだ。", fix2="数を返そう。")
                self.expect_semi()
                return ("return", t.line, e, f.ret if f else "int")
            if w in _TYPE_WORDS:
                # parse_block_item で拾うはず（for の中の 1 行など）
                raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="a label can only be part of a statement and a declaration is not a statement",
                                   title2="ここでは変数を作れないよ",
                                   why2="if・for・while のすぐあとの 1 行だけの所では、変数を作れないんだ。",
                                   fix2="{ } で囲んでから、その中で作ろう。")
        e = self.expr()
        self.expect_semi()
        if e["k"] == "call" and e.get("name") == "printf":
            for a in e["args"]:
                self._nested_printf(a)
            return ("printf", t.line, e)
        self._nested_printf(e)
        self._no_effect_warn(e, t)
        return ("expr", t.line, e)

    def sub_statement(self):
        """if・while・for のすぐあとの文（{ } でなくてもよい）"""
        t = self.tok
        if self.is_op(":"):
            self._pyism(t)
        if self.is_op("{"):
            self.scopes.append({})
            b = self.block()
            self.scopes.pop()
            return b
        if self.is_op(";"):
            self.adv()
            return ("empty", t.line)
        if self.is_type_start():
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="expected expression before '" + t.v + "'",
                               title2="ここでは変数を作れないよ",
                               why2="if・for・while のすぐあとの 1 行だけの所では、変数を作れないんだ。",
                               fix2="{ } で囲んでから、その中で作ろう。")
        self.scopes.append({})
        s = self.statement()
        self.scopes.pop()
        return s

    def cond_expr_in_parens(self):
        t = self.tok
        if self.is_op(")"):
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="expected expression before ')' token",
                               title2="( ) の中に条件が書いてないよ", why2="( ) の中に、くらべる式（d < 0.3 など）を書くんだ。",
                               fix2="(d < 0.3) のように条件を書こう。ずっとくり返すなら while (1)。")
        e = self.expr()
        self._nested_printf(e)
        if e["k"] == "assign" and e["op"] == "=":
            self.warnings.append(self.ctx.card("C_ASSIGN_IN_COND", t.line, t.col, None, "warn",
                                               raw="suggest parentheses around assignment used as truth value",
                                               example={"bad": "if (d = 0.25) {", "good": "if (d == 0.25) {"}))
        self.expect(")")
        if e["t"] in ("void", "str"):
            raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="void value not ignored as it ought to be",
                               title2="( ) の中に、本当かうそかの値が無いよ",
                               why2="条件には、くらべる式や数を書く。値を返さない命令は条件にできないんだ。",
                               fix2="(d < 0.3) のように、くらべる式にしよう。")
        return e

    def for_statement(self):
        t = self.adv()
        self.expect("(", "for ")
        self.scopes.append({})
        init = None
        decl_var = None
        if self.is_op(";"):
            self.adv()
        elif self.is_type_start():
            it = self.tok
            typ, const = self.parse_type()
            self._check_unsup_declarator()
            nt = self.tok
            if nt.k != "id":
                raise self.ctx.err("C_SYNTAX", nt.line, nt.col, nt.end, raw=f"expected identifier before {nt.show()}",
                                   title2=f"{typ} のあとに名前が要るよ", why2="for (int i = 0; i < 4; i++) のように書くんだ。",
                                   fix2="for (int i = 0; i < 4; i++) のように書こう。")
            self.adv()
            decls = self.declarators(typ, const, nt)   # ; まで読む
            init = ("decl", it.line, decls)
            if len(decls) == 1:
                decl_var = decls[0][0]
        else:
            if self.tok.k == "id" and self.peek().k == "id" and self.peek().v == "in":
                self._pyism(self.peek())
            init_e = self.expr()
            self._nested_printf(init_e)
            if self.is_op(":") or (self.tok.k == "id" and self.tok.v == "in"):
                self._pyism(self.tok)
            self.expect_semi()
            init = ("expr", t.line, init_e)
        cond = None
        if not self.is_op(";"):
            cond = self.expr()
            self._nested_printf(cond)
        self.expect_semi()
        step = None
        if not self.is_op(")"):
            step = self.expr()
            self._nested_printf(step)
        self.expect(")")
        self.loop_depth += 1
        body = self.sub_statement()
        self.loop_depth -= 1
        self.scopes.pop()
        simple = _simple_range(decl_var, init, cond, step, body)
        return ("for", t.line, init, cond, step, body, simple)

    def _nested_printf(self, e):
        for x in _walk(e):
            if x.get("k") == "call" and x.get("name") == "printf":
                raise self.ctx.err("C_UNSUPPORTED", x["line"], None, None, what="printf の戻り値を使う書き方",
                                   raw="using the value of printf is not supported in this game",
                                   fix2="printf(…); は 1 行で呼ぼう。")

    def _no_effect_warn(self, e, t):
        k = e["k"]
        if k in ("call", "assign", "inc"):
            return
        if k == "bin" and e["op"] == "==":
            self.warnings.append(self.ctx.card("C_NO_EFFECT", t.line, t.col, None, "warn", raw="statement with no effect",
                                               why2="x == 3; は「くらべるだけ」で、x は変わらない。",
                                               fix2="入れるつもりなら == を = に直そう。"))
            return
        self.warnings.append(self.ctx.card("C_NO_EFFECT", t.line, t.col, None, "warn", raw="statement with no effect",
                                           why2="", fix2="変数に入れるか、消そう。"))

    # ---- 式
    def expr(self):
        e = self.assign_expr()
        if self.is_op(","):
            t = self.tok
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="カンマで式を並べる書き方", span=",",
                               raw="comma operator is not supported in this game", fix2="1 つずつ ; で区切って書こう。")
        return e

    def assign_expr(self):
        lhs = self.ternary()
        t = self.tok
        if t.k == "op" and t.v in ("=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="):
            if lhs["k"] != "var":
                raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="lvalue required as left operand of assignment",
                                   title2=f"「{t.v}」の左には、変数の名前を書くよ",
                                   why2=f"「{t.v}」は右の値を左の変数に入れる記号。左が数や式だと、入れる場所が無いんだ。",
                                   fix2="くらべるつもりなら == を使おう。入れるなら d = 1.5; のように左を変数にしよう。")
            self.adv()
            rhs = self.assign_expr()
            if rhs["t"] in ("void", "str"):
                raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="void value not ignored as it ought to be",
                                   title2="値を返さない命令を、変数に入れようとしているよ",
                                   why2="void の関数（motor・wait・stop など）は値を返さないので、変数に入れられないんだ。",
                                   fix2="命令だけを 1 行で呼ぼう。")
            self._assign_target(lhs, t)
            if t.v == "%=" and (lhs["t"] != "int" or rhs["t"] != "int"):
                self._mod_err(t)
            return _node("assign", t.line, lhs["t"], op=t.v, var=lhs, rhs=rhs)
        return lhs

    def _assign_target(self, v, t):
        s = v["sym"]
        if s.const:
            raise self.ctx.err("C_CONST", t.line, t.col, t.end, name=s.name, raw=f"assignment of read-only variable '{s.name}'")
        if s.is_global and self.cur_func is not None:
            self.assigned_globals.add(s.py)

    def _mod_err(self, t):
        raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="invalid operands to binary % (have 'double')",
                           title2="% は int どうしでしか使えないよ",
                           why2="% は「割った余り」で、整数（int）どうしの計算なんだ。小数の余りは fmod という別の命令になる。",
                           fix2="int の変数で計算しよう。")

    def ternary(self):
        c = self.binary(1)
        if self.is_op("?"):
            t = self.adv()
            a = self.expr()
            self.expect(":")
            b = self.ternary()
            for x in (a, b):
                if x["t"] in ("void", "str"):
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="type mismatch in conditional expression",
                                       title2="? : の両側には数を書くよ", why2="? : は条件で 2 つの数のどちらかを選ぶ書き方なんだ。",
                                       fix2="? : の両側を数にしよう。")
            ty = "double" if "double" in (a["t"], b["t"]) else "int"
            return _node("tern", t.line, ty, c=c, a=a, b=b)
        return c

    _PREC = {"||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, "<=": 7, ">": 7, ">=": 7,
             "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10}

    def binary(self, minp):
        lhs = self.unary()
        while True:
            t = self.tok
            if t.k == "id" and t.v in ("and", "or") and t.v not in self._visible_names():
                self._pyism(t)
            if t.k != "op" or t.v not in self._PREC or self._PREC[t.v] < minp:
                return lhs
            p = self._PREC[t.v]
            self.adv()
            rhs = self.binary(p + 1)
            lhs = self._mk_bin(t, lhs, rhs)

    def _mk_bin(self, t, a, b):
        op = t.v
        for x in (a, b):
            if x["t"] == "void":
                raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="void value not ignored as it ought to be",
                                   title2="値を返さない命令を、計算に使っているよ",
                                   why2="void の関数（motor・wait・stop など）は値を返さないんだ。",
                                   fix2="命令は 1 行で呼んで、計算には値を返す命令（lidar() など）を使おう。")
            if x["t"] == "str":
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="文字列の計算",
                                   raw="string operations are not supported in this game",
                                   fix2="文字は printf の \"…\" の中だけで使おう。")
        if op in ("&&", "||"):
            return _node("logic", t.line, "int", op=op, a=a, b=b)
        if op in ("==", "!=", "<", "<=", ">", ">="):
            return _node("bin", t.line, "int", op=op, a=a, b=b)
        if op in ("%", "&", "|", "^", "<<", ">>"):
            if a["t"] != "int" or b["t"] != "int":
                if op == "%":
                    self._mod_err(t)
                raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw=f"invalid operands to binary {op}",
                                   title2=f"{op} は int どうしでしか使えないよ", why2="ビットの計算は整数（int）だけなんだ。",
                                   fix2="int の変数で計算しよう。")
            return _node("bin", t.line, "int", op=op, a=a, b=b)
        ty = "double" if "double" in (a["t"], b["t"]) else "int"
        return _node("bin", t.line, ty, op=op, a=a, b=b)

    def unary(self):
        t = self.tok
        if t.k == "op":
            if t.v in ("-", "+", "!", "~"):
                self.adv()
                e = self.unary()
                if e["t"] in ("void", "str"):
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="wrong type argument to unary operator",
                                       title2=f"「{t.v}」を付けられない値だよ", why2="値を返さない命令や文字には、- や ! は付けられないんだ。",
                                       fix2="数か、値を返す命令にしよう。")
                if t.v == "!":
                    return _node("not", t.line, "int", e=e)
                if t.v == "~" and e["t"] != "int":
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="wrong type argument to bit-complement",
                                       title2="~ は int にしか使えないよ", why2="ビットの計算は整数だけなんだ。", fix2="int の値にしよう。")
                if e["k"] == "num" and t.v == "-":
                    return _node("num", t.line, e["t"], v="-" + e["v"])
                return _node("un", t.line, e["t"], op=t.v, e=e)
            if t.v in ("++", "--"):
                self.adv()
                e = self.unary()
                if e["k"] != "var":
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw=f"lvalue required as {'increment' if t.v == '++' else 'decrement'} operand",
                                       title2=f"{t.v} は変数にしか付けられないよ", why2=f"{t.v} は変数の値を 1 増やす（減らす）書き方なんだ。",
                                       fix2="i++; のように変数に付けよう。")
                self._assign_target(e, t)
                return _node("inc", t.line, e["t"], op=t.v, prefix=True, var=e)
            if t.v == "(" and self.is_type_start(self.peek()):
                self.adv()
                typ, _ = self.parse_type()
                if self.is_op("*"):
                    self._check_unsup_declarator()
                self.expect(")")
                e = self.unary()
                if typ == "void" or e["t"] in ("void", "str"):
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="invalid cast",
                                       title2="この型の変換はできないよ", why2="(int) と (double) で、数どうしを変えられるんだ。",
                                       fix2="(int) か (double) にしよう。")
                return _node("cast", t.line, typ, e=e)
            if t.v in ("&", "*"):
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="ポインタ（* や &）", span=t.v,
                                   raw="pointers are not supported in this game", fix2="ふつうの int・double の変数を使おう。")
        if t.k == "id" and t.v == "sizeof":
            raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="sizeof", span="sizeof",
                               raw="sizeof is not supported in this game", fix2="sizeof を使わずに書こう。")
        if t.k == "id" and t.v == "not" and "not" not in self._visible_names():
            self._pyism(t)
        return self.postfix()

    def postfix(self):
        e = self.primary()
        while True:
            t = self.tok
            if self.is_op("("):
                e = self.call(e)
                continue
            if e["k"] == "rawname":
                self._undeclared(e)
            if self.is_op("["):
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="配列", span="[",
                                   raw="arrays are not supported in this game",
                                   fix2="変数を 1 つずつ作って書こう。")
            if self.is_op(".") or self.is_op("->"):
                if e["k"] == "var" and e.get("name") == "math" or (e["k"] == "rawname" and e["name"] == "math"):
                    self._pyism(Tok("id", "math", e["line"], 1, 1))
                raise self.ctx.err("C_UNSUPPORTED", t.line, t.col, t.end, what="構造体（. や ->）", span=t.v,
                                   raw="member access is not supported in this game",
                                   fix2="値は 1 つずつ int か double の変数にしよう。")
            if self.is_op("++") or self.is_op("--"):
                if e["k"] != "var":
                    raise self.ctx.err("C_TYPE", t.line, t.col, t.end, raw="lvalue required as increment operand",
                                       title2=f"{t.v} は変数にしか付けられないよ", why2=f"{t.v} は変数の値を 1 増やす（減らす）書き方なんだ。",
                                       fix2="i++; のように変数に付けよう。")
                self.adv()
                self._assign_target(e, t)
                e = _node("inc", t.line, e["t"], op=t.v, prefix=False, var=e)
                continue
            return e

    def call(self, fe):
        lp = self.adv()
        args = []
        if not self.is_op(")"):
            while True:
                a = self.assign_expr()
                args.append(a)
                if self.accept(","):
                    continue
                break
        if not self.is_op(")"):
            self._pyism(self.tok)
            t = self.tok
            p = self.prev()
            raise self.ctx.err("C_PAREN", p.line, p.end, None, raw=_GCC["C_PAREN"].format(tok=t.show()),
                               fix2=f"{lp.line} 行目の ( に合う ) を足そう。")
        rp = self.adv()
        line = fe["line"]
        if fe["k"] != "rawname":
            raise self.ctx.err("C_TYPE", line, None, None, raw="called object is not a function or function pointer",
                               title2="関数ではないものを呼ぼうとしているよ",
                               why2=f"「{fe.get('name', '')}」は変数なので、( ) を付けて呼べないんだ。",
                               fix2="( ) を外すか、関数の名前に直そう。")
        name = fe["name"]
        ft = fe["tok"]
        code = self.ctx.code_of(line)
        if name == "printf":
            return self.printf(ft, args, line)
        if name in _UNSUP_FUNCS:
            what, why, fix = _UNSUP_FUNCS[name]
            raise self.ctx.err("C_UNSUPPORTED", ft.line, ft.col, ft.end, what=what, span=name,
                               raw=f"'{name}' is not supported in this game", why2=why, fix2=fix)
        if name in _PY_KEYWORDISH and name not in self.funcs:
            self._pyism(ft)
        if name in _PY_HINTS and name not in self.funcs:
            why, fix = _PY_HINTS[name]
            rid = "C_PRINT" if name == "print" else "C_UNDECLARED"
            raise self.ctx.err(rid, ft.line, ft.col, ft.end, name=name, raw=_GCC["C_UNDECLARED_FN"].format(name=name) +
                               ("; did you mean 'printf'?" if name == "print" else ""),
                               title2="C で表示する命令は printf だよ" if name == "print" else None,
                               why2=why + ("" if name != "print" else "printf は「書式つきで表示する」という意味。"),
                               fix2=fix,
                               example={"bad": "print(\"のこり\", d);", "good": "printf(\"のこり %.2f m\\n\", d);"} if name == "print" else None)
        if name in _ROVER:
            self.need_rover(name, ft)
            ret, ptypes = _ROVER[name]
            kind = "rover"
            f = None
        elif name in _MATHF:
            if "rover.h" not in self.includes and "math.h" not in self.includes:
                raise self.ctx.err("C_UNDECLARED", ft.line, ft.col, ft.end, name=name, raw=_GCC["C_UNDECLARED_FN"].format(name=name),
                                   why2=f"{name} は math.h（rover.h の中でも読みこんでいる）の命令なんだ。",
                                   fix2="一番上に #include \"rover.h\" を書こう。")
            ret, ptypes = _MATHF[name]
            kind = "math"
            f = None
        elif name in self.funcs:
            f = self.funcs[name]
            ret, ptypes = f.ret, f.params
            kind = "user"
        else:
            if name in _ROVER_NOT_IN_C:
                raise self.ctx.err("C_UNDECLARED", ft.line, ft.col, ft.end, name=name, raw=_GCC["C_UNDECLARED_FN"].format(name=name),
                                   why2=f"{name}() は Python の面の命令で、このゲームの rover.h にはまだ入っていないんだ。",
                                   fix2="rover.h の命令（motor・wait・stop・lidar・heading・now・distance_to_cone）で書こう。")
            sym = self.lookup(name)
            if sym:
                raise self.ctx.err("C_TYPE", ft.line, ft.col, ft.end, raw="called object is not a function or function pointer",
                                   title2=f"「{name}」は変数なので、( ) を付けて呼べないよ",
                                   why2=f"{name} は変数の名前なんだ。", fix2="( ) を外すか、関数の名前に直そう。")
            close = _close(name, list(_ROVER) + list(_MATHF) + list(self.funcs) + ["printf"])
            raise self.ctx.err("C_UNDECLARED", ft.line, ft.col, ft.end, name=name, raw=_GCC["C_UNDECLARED_FN"].format(name=name) +
                               (f"; did you mean '{close}'?" if close else ""),
                               why2=(f"「{close}」のことかな？ " if close else "") +
                               "関数は、使う行より上で作るか、void name(double s); と前もって書いておくんだ。",
                               fix2=(f"{name} を {close} に直そう。" if close else
                                     f"{name} を使う行より上で、{name} の関数を作ろう。"))
        if len(args) != len(ptypes):
            sig = f"{name}({', '.join(ptypes) if ptypes else 'void'})"
            ex = {"motor": "motor(0.5, 0.5);", "wait": "wait(2);", "stop": "stop();", "atan2": "atan2(dy, dx);"}.get(name)
            raise self.ctx.err("C_ARGS", ft.line, ft.col, ft.end, name=name, want=len(ptypes), got=len(args),
                               raw=f"too {'few' if len(args) < len(ptypes) else 'many'} arguments to function '{name}'",
                               example2=f"{name} の形は {sig}。" + (f"例: {ex}" if ex else "受け取る値の数だけ、, で区切って渡そう。"))
        for a in args:
            if a["t"] == "void":
                raise self.ctx.err("C_TYPE", a["line"], None, None, raw="void value not ignored as it ought to be",
                                   title2="値を返さない命令を、ほかの命令に渡しているよ",
                                   why2="void の関数（motor・wait・stop など）は値を返さないんだ。",
                                   fix2="値を返す命令（lidar() など）か、数を渡そう。")
            if a["t"] == "str":
                raise self.ctx.err("C_UNSUPPORTED", a["line"], None, None, what="文字列を命令に渡す書き方",
                                   raw="string arguments are not supported in this game",
                                   fix2="文字は printf の \"…\" の中だけで使おう。")
        return _node("call", line, ret, name=name, kind=kind, func=f, args=args, ptypes=ptypes)

    def printf(self, ft, args, line):
        if "rover.h" not in self.includes and "stdio.h" not in self.includes:
            raise self.ctx.err("C_UNDECLARED", ft.line, ft.col, ft.end, name="printf",
                               raw="implicit declaration of function 'printf'",
                               why2="printf は <stdio.h>（rover.h の中でも読みこんでいる）の命令なんだ。",
                               fix2="一番上に #include \"rover.h\" を書こう。")
        if not args:
            raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end, raw="too few arguments to function 'printf'",
                               title2="printf の ( ) の中が空だよ", why2="printf は \"…\" の中の文字を表示する命令なんだ。",
                               fix2="printf(\"こんにちは\\n\"); のように書こう。")
        fmt = args[0]
        if fmt["k"] != "str":
            raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end, raw="format not a string literal and no format arguments",
                               title2="printf の最初には \"…\" の書式を書くよ",
                               why2="printf は最初に \"…\"（表示する文字と %d などの穴）、そのあとに穴に入れる値を並べるんだ。",
                               fix2="printf(\"%.2f\\n\", d); のように書こう。")
        specs = _parse_format(fmt["v"])
        if isinstance(specs, str):
            raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end, raw=f"unknown conversion type character in format",
                               title2=f"printf の「{specs}」が、ぼくには読めなかったよ",
                               why2="このゲームの printf で使える穴は %d（整数）・%f（小数）・%.2f（小数 2 けた）・%s・%% など。",
                               fix2="%d か %f か %.2f に直そう。% を表示したい時は %% と書くよ。")
        vals = args[1:]
        conv = [s for s in specs if s[0] != "%%"]
        if len(conv) != len(vals):
            more = len(conv) > len(vals)
            raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end,
                               raw=f"too {'few' if more else 'many'} arguments for format",
                               title2="printf の穴（% の数）と、渡した値の数が合わないよ",
                               why2=f"\"…\" の中の穴は {len(conv)} 個、そのあとの値は {len(vals)} 個。1 つの穴に 1 つの値が入るんだ。",
                               fix2=("値を足すか、穴を減らそう。" if more else "穴を足すか、値を減らそう。"))
        out_specs = []
        for (kind, spec), v in zip(conv, vals):
            want = {"d": "int", "i": "int", "f": "double", "e": "double", "g": "double", "s": "str", "c": "int", "x": "int"}[kind]
            if v["t"] == "void":
                raise self.ctx.err("C_TYPE", v["line"], None, None, raw="void value not ignored as it ought to be",
                                   title2="値を返さない命令を、printf に渡しているよ",
                                   why2="void の関数（motor・wait・stop など）は値を返さないんだ。", fix2="数を渡そう。")
            if want != v["t"]:
                if want == "int" and v["t"] == "double":
                    raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end,
                                       raw=f"format '{spec}' expects argument of type 'int', but argument has type 'double'",
                                       title2=f"{spec} に小数（double）を渡しているよ",
                                       why2=f"{spec} は整数（int）を表示する穴。小数を入れると、C ではおかしな数が出てしまうんだ。",
                                       fix2=f"小数を表示するなら {spec} を %f か %.2f に直そう。")
                if want == "double" and v["t"] == "int":
                    raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end,
                                       raw=f"format '{spec}' expects argument of type 'double', but argument has type 'int'",
                                       title2=f"{spec} に整数（int）を渡しているよ",
                                       why2=f"{spec} は小数（double）を表示する穴。整数を入れると、C ではおかしな数が出てしまうんだ。",
                                       fix2=f"整数を表示するなら {spec} を %d に直そう。(double) を付けてもいいよ。")
                raise self.ctx.err("C_PRINT", ft.line, ft.col, ft.end, raw=f"format '{spec}' expects a different type",
                                   title2=f"{spec} に合わない値を渡しているよ",
                                   why2="%s は文字（\"…\"）、%d は整数、%f は小数の穴なんだ。",
                                   fix2="穴と値の型をそろえよう。")
            out_specs.append(spec)
        return _node("call", line, "int", name="printf", kind="printf", fmt=specs, fmt_text=fmt["v"], args=vals)

    def primary(self):
        t = self.tok
        if t.k == "num":
            self.adv()
            text = t.v
            low = text.lower()
            if low.startswith("0x"):
                return _node("num", t.line, "int", v=str(int(low.rstrip("ul"), 16)))
            clean = re.sub(r"[fFlLuU]+$", "", text)
            if re.fullmatch(r"\d+", clean):
                if len(clean) > 1 and clean.startswith("0"):
                    if re.search(r"[89]", clean):
                        raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"invalid digit in octal constant",
                                           title2="0 で始まる数は、C では 8 進数になるよ",
                                           why2="C では 012 のように 0 で始めると 8 進数（0〜7 だけ）の意味になるんだ。",
                                           fix2="頭の 0 を消そう。")
                    return _node("num", t.line, "int", v=str(int(clean, 8)))
                return _node("num", t.line, "int", v=str(int(clean)))
            if clean.startswith("."):
                clean = "0" + clean
            if clean.endswith("."):
                clean += "0"
            return _node("num", t.line, "double", v=repr(float(clean)) if "e" in clean.lower() else clean)
        if t.k == "str":
            self.adv()
            return _node("str", t.line, "str", v=t.v)
        if t.k == "id":
            if t.v in _C_KEYWORDS:
                self._pyism(t)
                raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected expression before '{t.v}'",
                                   title2=f"ここに「{t.v}」は書けないよ",
                                   why2=f"「{t.v}」は C の決まった言葉。式の途中には書けないんだ。",
                                   fix2="; や { } の位置を確かめよう。")
            self.adv()
            if t.v == "M_PI":
                return _node("num", t.line, "double", v="_c.M_PI")
            sym = self.lookup(t.v)
            if sym and not self.is_op("("):
                return _node("var", t.line, sym.t, name=t.v, py=sym.py, sym=sym)
            if sym and self.is_op("("):
                return _node("var", t.line, sym.t, name=t.v, py=sym.py, sym=sym)
            return _node("rawname", t.line, None, name=t.v, tok=t)
        if t.k == "op" and t.v == "(":
            self.adv()
            if self.is_op(")"):
                raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw="expected expression before ')' token",
                                   title2="( ) の中が空だよ", why2="( ) の中に計算や値を書くんだ。", fix2="( ) の中に値を書こう。")
            e = self.expr()
            self.expect(")")
            return e
        self._pyism(t)
        if t.k == "eof":
            raise self.ctx.err("C_BRACE", t.line, t.col, None, raw=_GCC["C_BRACE_EOF"], where2="（プログラムの終わり）",
                               why2="プログラムが途中で終わっているみたい。", fix2="足りない ) や } や ; を足そう。")
        if t.k == "op" and t.v == "}":
            p = self.prev()
            raise self.ctx.err("C_SEMICOLON", p.line, p.end, p.end + 1, raw="expected expression before '}' token")
        raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"expected expression before {t.show()}",
                           title2=f"「{t.v}」の前に、値が足りないよ",
                           why2=f"ここには数や変数などの値が来るはずなのに、「{t.v}」が来ているんだ。",
                           fix2="書きかけの所が無いか確かめよう。")

    def _undeclared(self, e):
        name = e["name"]
        t = e["tok"]
        if name in _PY_HINTS:
            self._pyism(t)
        if name in _ROVER or name in _MATHF or name in self.funcs or name == "printf":
            raise self.ctx.err("C_SYNTAX", t.line, t.col, t.end, raw=f"'{name}' is a function; did you forget '()'?",
                               title2=f"{name} は命令だから、( ) を付けて呼ぶよ",
                               why2="C の命令（関数）は、名前のあとに ( ) を付けて呼ぶんだ。", fix2=f"{name}() に直そう。")
        if name in self.ever:
            raise self.ctx.err("C_UNDECLARED", t.line, t.col, t.end, name=name,
                               raw=_GCC["C_UNDECLARED_VAR"].format(name=name),
                               why2=f"「{name}」は {self.ever[name]} 行目で {{ }} の中に作った変数なので、その {{ }} の外では使えないんだ。",
                               fix2=f"{name} を使う所まで届くように、外側の {{ }} の中（たとえば main の始め）で作ろう。")
        close = _close(name, [s for sc in self.scopes for s in sc])
        assign_stmt = self.is_op("=")
        if assign_stmt and close is None:
            raise self.ctx.err("C_NO_TYPE", t.line, t.col, t.end, name=name,
                               raw=_GCC["C_UNDECLARED_VAR"].format(name=name),
                               fix2=f"最初に作る時は double {name} = …; のように、名前の前に型を書こう。",
                               example={"bad": "speed = 0.6;", "good": "double speed = 0.6;"})
        raise self.ctx.err("C_UNDECLARED", t.line, t.col, t.end, name=name,
                           raw=_GCC["C_UNDECLARED_VAR"].format(name=name) + (f"; did you mean '{close}'?" if close else ""),
                           why2=(f"「{close}」のことかな？ 大文字・小文字や、つづりを確かめよう。" if close else
                                 "それとも、{ } の外で作った変数を、外で使っていないかな？"),
                           fix2=(f"{name} を {close} に直そう。" if close else f"使う前に double {name} = 0; のように作ろう。"))


def _close(name, cands):
    import difflib
    m = difflib.get_close_matches(name, [c for c in cands if c != name], n=1, cutoff=0.7)
    if m:
        return m[0]
    low = {c.lower(): c for c in cands}
    return low.get(name.lower())


def _walk(e):
    if isinstance(e, dict):
        yield e
        for v in e.values():
            if isinstance(v, (dict, list)):
                yield from _walk(v)
    elif isinstance(e, list):
        for v in e:
            yield from _walk(v)


def _has_call(e):
    if not isinstance(e, dict):
        return False
    if e["k"] == "call":
        return True
    return any(_has_call(v) for k, v in e.items() if isinstance(v, dict)) or any(
        _has_call(a) for a in e.get("args", []) if isinstance(a, dict))


_FMT_RE = re.compile(r"%(?P<flags>[-+ 0#]*)(?P<width>\d+)?(?:\.(?P<prec>\d+))?(?P<len>hh|h|ll|l|L|z)?(?P<conv>.?)")


def _parse_format(s):
    """printf の書式を読む。返す [(種類, もとの穴の文字)…]（%% は ("%%", "%%")）か、読めない穴の文字"""
    out = []
    i = 0
    while True:
        j = s.find("%", i)
        if j < 0:
            break
        m = _FMT_RE.match(s, j)
        conv = m.group("conv")
        whole = m.group(0)
        if conv == "%" and whole == "%%":
            out.append(("%%", "%%"))
        elif conv in ("d", "i", "u"):
            out.append(("d" if conv != "i" else "i", whole))
        elif conv in ("f", "F", "e", "E", "g", "G"):
            out.append(({"F": "f", "E": "e", "G": "g"}.get(conv, conv), whole))
        elif conv == "s":
            out.append(("s", whole))
        elif conv == "c":
            out.append(("c", whole))
        elif conv in ("x", "X"):
            out.append(("x", whole))
        else:
            return whole or "%"
        i = m.end()
    return out


def _py_format(s):
    """C の書式を Python の % 書式に（%lf → %f、%u → %d、%i → %d など）"""
    def sub(m):
        whole = m.group(0)
        if whole == "%%":
            return "%%"
        conv = m.group("conv")
        conv = {"u": "d", "i": "d", "F": "f"}.get(conv, conv)
        return "%" + (m.group("flags") or "") + (m.group("width") or "") + (("." + m.group("prec")) if m.group("prec") is not None else "") + conv
    return _FMT_RE.sub(sub, s)


def _assigned_names(node, acc):
    """文や式の中で書きかえている変数（Sym）の名前を集める"""
    if isinstance(node, dict):
        if node.get("k") in ("assign", "inc"):
            acc.add(node["var"]["sym"])
        if node.get("k") == "call" and node.get("kind") == "user":
            acc.add("__call__")
        for v in node.values():
            if isinstance(v, (dict, list, tuple)):
                _assigned_names(v, acc)
    elif isinstance(node, (list, tuple)):
        for v in node:
            if isinstance(v, (dict, list, tuple)):
                _assigned_names(v, acc)
            elif isinstance(v, Sym):
                pass
    return acc


def _vars_in(e, acc):
    if isinstance(e, dict):
        if e.get("k") == "var":
            acc.append(e["sym"])
        if e.get("k") == "call":
            acc.append("__call__")
        for v in e.values():
            if isinstance(v, (dict, list)):
                _vars_in(v, acc)
    elif isinstance(e, list):
        for v in e:
            _vars_in(v, acc)
    return acc


def _simple_range(decl_var, init, cond, step, body):
    """for (int i = A; i < B; i++) を Python の for i in range(A, B) にできるか。できれば (sym, A, B, 増やす数, 比べ方)"""
    if decl_var is None or decl_var.t != "int" or init is None or cond is None or step is None:
        return None
    sym, a, _ = init[2][0]
    if a is None or a["t"] != "int" or cond["k"] != "bin" or cond["op"] not in ("<", "<=", ">", ">="):
        return None
    if cond["a"].get("k") != "var" or cond["a"]["sym"] is not sym:
        return None
    b = cond["b"]
    if b["t"] != "int":
        return None
    used = _vars_in(b, [])
    if "__call__" in used or sym in used or any(s.is_global for s in used if isinstance(s, Sym)):
        return None
    if _has_side(b):
        return None
    inc = None
    if step["k"] == "inc" and step["var"]["sym"] is sym:
        inc = 1 if step["op"] == "++" else -1
    elif step["k"] == "assign" and step["var"]["sym"] is sym and step["op"] in ("+=", "-=") and step["rhs"]["k"] == "num" \
            and step["rhs"]["t"] == "int" and int(step["rhs"]["v"]) > 0:
        inc = int(step["rhs"]["v"]) * (1 if step["op"] == "+=" else -1)
    if inc is None:
        return None
    if (inc > 0) != (cond["op"] in ("<", "<=")):
        return None
    changed = _assigned_names(body, set())
    if sym in changed or any(s in changed for s in used):
        return None
    return (sym, a, b, inc, cond["op"])


def _has_side(e):
    if isinstance(e, dict):
        if e.get("k") in ("assign", "inc", "call"):
            return True
        return any(_has_side(v) for v in e.values() if isinstance(v, (dict, list)))
    if isinstance(e, list):
        return any(_has_side(v) for v in e)
    return False


# =====================================================================================================
# Python を書く
# =====================================================================================================

class Emitter:
    def __init__(self):
        self.lines = []      # (字下げ, 文, C の行)

    def put(self, ind, text, cline):
        self.lines.append((ind, text, cline))

    # ---- 式
    def ex(self, n, cond=False):
        k = n["k"]
        if k == "num":
            return n["v"]
        if k == "str":
            return repr(n["v"])
        if k == "var":
            return n["py"]
        if k == "call":
            args = []
            for a, pt in zip(n["args"], n.get("ptypes", [])):
                args.append(self.conv(a, pt))
            if n["kind"] == "rover":
                text = f"{n['name']}({', '.join(args)})"
                return f"_c.nz({text})" if n["name"] == "lidar" else text
            if n["kind"] == "math":
                return f"_c.{n['name']}({', '.join(args)})"
            return f"{n['func'].py}({', '.join(args)})"
        if k == "un":
            return f"({n['op']}{self.ex(n['e'])})"
        if k == "not":
            return f"(not {self.ex(n['e'], True)})"
        if k == "logic":
            op = "and" if n["op"] == "&&" else "or"
            inner = f"({self.ex(n['a'], True)} {op} {self.ex(n['b'], True)})"
            return inner if cond else f"(1 if {inner} else 0)"
        if k == "bin":
            a, b = n["a"], n["b"]
            op = n["op"]
            if op == "/" and a["t"] == "int" and b["t"] == "int":
                return f"_c.idiv({self.ex(a)}, {self.ex(b)})"
            if op == "%":
                return f"_c.imod({self.ex(a)}, {self.ex(b)})"
            return f"({self.ex(a)} {op} {self.ex(b)})"
        if k == "tern":
            return f"({self.ex(n['a'])} if {self.ex(n['c'], True)} else {self.ex(n['b'])})"
        if k == "cast":
            return f"_c.toint({self.ex(n['e'])})" if n["t"] == "int" else f"float({self.ex(n['e'])})"
        if k == "assign":
            return f"({n['var']['py']} := {self.assign_value(n)})"
        if k == "inc":
            py = n["var"]["py"]
            sign = "+" if n["op"] == "++" else "-"
            back = "-" if sign == "+" else "+"
            if n["prefix"]:
                return f"({py} := {py} {sign} 1)"
            return f"(({py} := {py} {sign} 1) {back} 1)"
        raise AssertionError(k)

    def conv(self, n, target):
        if target == "int" and n["t"] == "double":
            return f"_c.toint({self.ex(n)})"
        return self.ex(n)

    def assign_value(self, n):
        var = n["var"]
        op = n["op"]
        t = var["t"]
        if op == "=":
            return self.conv(n["rhs"], t)
        bop = op[:-1]
        a, b = var, n["rhs"]
        rt = "double" if "double" in (a["t"], b["t"]) else "int"
        if bop == "/" and rt == "int":
            val = f"_c.idiv({self.ex(a)}, {self.ex(b)})"
        elif bop == "%":
            val = f"_c.imod({self.ex(a)}, {self.ex(b)})"
        else:
            val = f"({self.ex(a)} {bop} {self.ex(b)})"
        if t == "int" and rt == "double":
            return f"_c.toint({val})"
        return val

    # ---- 文
    def stmt(self, s, ind, loop_step=None):
        k = s[0]
        if k == "block":
            n0 = len(self.lines)
            for it in s[2]:
                self.stmt(it, ind, loop_step)
            return len(self.lines) > n0
        if k == "empty":
            return False
        if k == "decl":
            for sym, init, line in s[2]:
                if init is None:
                    self.put(ind, f"{sym.py} = {'0' if sym.t == 'int' else '0.0'}", line)
                else:
                    self.put(ind, f"{sym.py} = {self.conv(init, sym.t)}", line)
            return True
        if k == "expr":
            self.put(ind, self.expr_stmt(s[2]), s[1])
            return True
        if k == "printf":
            self.put(ind, self.printf_stmt(s[2]), s[1])
            return True
        if k == "if":
            _, line, c, then, els, eline = s
            self.put(ind, f"if {self.ex(c, True)}:", line)
            self.body(then, ind + 1, line, loop_step)
            while els is not None:
                if els[0] == "if":
                    _, line2, c2, then2, els2, eline2 = els
                    self.put(ind, f"elif {self.ex(c2, True)}:", line2)
                    self.body(then2, ind + 1, line2, loop_step)
                    els, eline = els2, eline2
                    continue
                self.put(ind, "else:", eline)
                self.body(els, ind + 1, eline, loop_step)
                break
            return True
        if k == "while":
            _, line, c, body = s
            self.put(ind, f"while {self.ex(c, True)}:", line)
            self.body(body, ind + 1, line, None)
            return True
        if k == "for":
            _, line, init, cond, step, body, simple = s
            if simple:
                sym, a, b, inc, op = simple
                bx = self.ex(b)
                if op == "<=":
                    bx = f"{bx} + 1"
                elif op == ">=":
                    bx = f"{bx} - 1"
                a_x = self.ex(a)
                rng = f"range({a_x}, {bx})" if inc == 1 else f"range({a_x}, {bx}, {inc})"
                self.put(ind, f"for {sym.py} in {rng}:", line)
                self.body(body, ind + 1, line, None)
                return True
            if init is not None:
                self.stmt(init, ind)
            stp = (self.expr_stmt(step), line) if step is not None else None
            self.put(ind, f"while {self.ex(cond, True) if cond is not None else 'True'}:", line)
            n0 = len(self.lines)
            self.stmt(body, ind + 1, stp)
            if stp:
                self.put(ind + 1, stp[0], stp[1])
            elif len(self.lines) == n0:
                self.put(ind + 1, "pass", line)
            return True
        if k == "break":
            self.put(ind, "break", s[1])
            return True
        if k == "continue":
            if loop_step:
                self.put(ind, loop_step[0], s[1])
            self.put(ind, "continue", s[1])
            return True
        if k == "return":
            _, line, e, ret = s
            self.put(ind, "return" if e is None else f"return {self.conv(e, ret)}", line)
            return True
        raise AssertionError(k)

    def body(self, s, ind, line, loop_step):
        n0 = len(self.lines)
        self.stmt(s, ind, loop_step)
        if len(self.lines) == n0:
            self.put(ind, "pass", line)

    def expr_stmt(self, e):
        k = e["k"]
        if k == "assign":
            py = e["var"]["py"]
            if e["rhs"]["k"] == "assign":
                return f"{py} = {self.assign_value(e)}"
            return f"{py} = {self.assign_value(e)}"
        if k == "inc":
            return f"{e['var']['py']} {'+' if e['op'] == '++' else '-'}= 1"
        return self.ex(e)

    def printf_stmt(self, n):
        fmt_text = n["fmt_text"]
        args = [self.ex(a) for a in n["args"]]
        nl = fmt_text.endswith("\n") and "\n" not in fmt_text[:-1]
        body = fmt_text[:-1] if nl else fmt_text
        conv = [s for s in n["fmt"] if s[0] != "%%"]
        if conv:
            pyfmt = _py_format(body)
            val = f"{pyfmt!r} % ({', '.join(args)}{',' if len(args) == 1 else ''})"
        else:
            val = repr(body.replace("%%", "%"))
        return f"print({val})" if nl else f"print({val}, end='')"


# =====================================================================================================
# 公開する関数
# =====================================================================================================

def translate(src: str) -> dict:
    """C を Python に訳す。
    返す: {"ok": bool, "py": str, "lineMap": [py の行 → C の行], "errors": [Card, …], "warnings": [Card, …],
           "names": {py の名前: C の名前}, "info": analyze(src)}（Card は error_explain.py と同じ形）"""
    src = (src or "").replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
    info = analyze(src)
    p = None
    try:
        if len(src) > 60000 or src.count("\n") >= 2000:
            raise _CErr(Ctx(src).card("C_UNSUPPORTED", 1, None, None, raw="program too long for this game",
                                      what="2000 行・60 KB より長いプログラム", span="",
                                      fix2="短くまとめよう。同じ動きは関数にしてくり返し使えるよ。"))
        p = Parser(src)
        items = p.parse()
        return _emit(p, items, info)
    except _CErr as e:
        return {"ok": False, "py": "", "lineMap": [0], "errors": [e.card], "warnings": p.warnings if p else [],
                "names": {}, "info": info}
    except RecursionError:
        card = Ctx(src).card("C_SYNTAX", 1, None, None, raw="expression nesting too deep",
                             title2="( ) や { } の重なりが深すぎて、ぼくには読みきれなかったよ",
                             why2="かっこを何重にも重ねると、ぼくの読む力をこえてしまうんだ。",
                             fix2="式を分けて、途中の値を変数に入れながら書こう。")
        return {"ok": False, "py": "", "lineMap": [0], "errors": [card], "warnings": [], "names": {}, "info": info}
    except Exception as e:  # 訳し器そのものの不具合。止めるが、内部のエラーとして知らせる
        card = Ctx(src).card("C_SYNTAX", 1, None, None, raw=f"internal translator error: {type(e).__name__}: {e}",
                             title2="ぼくの C の読み取りが、うまくいかなかったよ",
                             why2="ぼく（ゲーム）の中のまちがいかもしれない。書き方を少し変えると読めることがあるよ。",
                             fix2="Python の面で同じ動きを試すか、書き方を変えてもう一度実行してね。")
        card["internal"] = True
        return {"ok": False, "py": "", "lineMap": [0], "errors": [card], "warnings": [], "names": {}, "info": info}


def _emit(p, items, info):
    em = Emitter()
    first_line = p.include_line if p.includes else 1
    em.put(0, "import _c_runtime as _c", first_line)
    main = p.funcs["main"]
    for it in items:
        if it[0] == "gdecl":
            for sym, init, line in it[2]:
                if sym is None:
                    continue
                em.put(0, f"{sym.py} = {em.conv(init, sym.t) if init is not None else ('0' if sym.t == 'int' else '0.0')}", line)
        elif it[0] == "func":
            _, line, f, psyms, body, globs = it
            em.put(0, f"def {f.py}({', '.join(s.py for s in psyms)}):", line)
            if globs:
                em.put(1, f"global {', '.join(globs)}", line)
            n0 = len(em.lines)
            em.stmt(body, 1)
            if len(em.lines) == n0:
                em.put(1, "pass", body[3])
    em.put(0, f"{main.py}()", main.line)
    py_lines = ["    " * ind + text for ind, text, _ in em.lines]
    line_map = [0] + [cl for _, _, cl in em.lines]
    return {"ok": True, "py": "\n".join(py_lines) + "\n", "lineMap": line_map, "errors": [],
            "warnings": p.warnings[:2], "names": dict(p.names), "info": info}


# ---- 6.12 の lines・uses・defs（C のまま数える）

def _strip_comments(src):
    """// と /* */ のメモと "…" の中身を空白にした行の並び（行の数は同じ）"""
    out = []
    in_block = False
    for line in src.split("\n"):
        buf = []
        i, n = 0, len(line)
        while i < n:
            if in_block:
                j = line.find("*/", i)
                if j < 0:
                    i = n
                    break
                i = j + 2
                in_block = False
                continue
            if line.startswith("//", i):
                break
            if line.startswith("/*", i):
                in_block = True
                i += 2
                continue
            ch = line[i]
            if ch in "\"'":
                q = ch
                buf.append(q)
                i += 1
                while i < n and line[i] != q:
                    i += 2 if line[i] == "\\" else 1
                buf.append(q)
                i += 1
                continue
            buf.append(ch)
            i += 1
        out.append("".join(buf))
    return out


def count_lines(src: str) -> int:
    """6.12 の lines（C）: 空行とメモだけの行は数えない。#include・{・} だけの行は数える。
    1 行に ;（for ( ) の中を除く）が 2 つ以上あれば、その数だけ数える。"""
    n = 0
    for line in _strip_comments((src or "").replace("\r\n", "\n")):
        s = line.strip()
        if not s:
            continue
        n += max(1, _semis_outside_for(s))
    return n


def _semis_outside_for(s):
    count = 0
    depth = 0
    in_for = False
    for_depth = 0
    i = 0
    while i < len(s):
        ch = s[i]
        if s.startswith("for", i) and (i == 0 or not (s[i - 1].isalnum() or s[i - 1] == "_")) and \
                (i + 3 >= len(s) or not (s[i + 3].isalnum() or s[i + 3] == "_")):
            j = i + 3
            while j < len(s) and s[j] == " ":
                j += 1
            if j < len(s) and s[j] == "(":
                in_for = True
                for_depth = depth
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if in_for and depth == for_depth:
                in_for = False
        elif ch == ";" and not in_for:
            count += 1
        i += 1
    return count


def analyze(src: str) -> dict:
    """judge.py 用: {"lines": int, "uses": [for・while・if・def・return・break…], "defs": main 以外の関数の数}"""
    src = (src or "").replace("\r\n", "\n")
    text = "\n".join(_strip_comments(src))
    uses = set()
    for w in ("for", "while", "if", "return", "break", "continue", "else"):
        if re.search(rf"\b{w}\b", text):
            uses.add(w)
    defs = 0
    for m in re.finditer(r"\b(?:int|double|float|void)\s+([A-Za-z_]\w*)\s*\([^;{)]*\)\s*\{", text):
        if m.group(1) != "main":
            defs += 1
    if defs:
        uses.add("def")
    if "printf" in text:
        uses.add("printf")
    return {"lines": count_lines(src), "uses": sorted(uses), "defs": defs}


# ---- 実行中のエラーを C に直す

def fix_card(card: dict, py_src: str, c_src: str, line_map: list) -> dict:
    """Python の行と Python のコードで作ったカード（W3 の explain_exception など）を、C の行と C のコードに直す。"""
    if not card:
        return card
    card = dict(card)
    py_lines = py_src.split("\n")
    c_lines = c_src.replace("\r\n", "\n").split("\n")

    def cmap(n):
        try:
            n = int(n)
        except (TypeError, ValueError):
            return None
        return line_map[n] if 0 < n < len(line_map) and line_map[n] else None

    pl = card.get("line")
    cl = cmap(pl)
    repl = []
    if pl and cl:
        pcode = py_lines[pl - 1].strip() if 0 < pl <= len(py_lines) else ""
        ccode = c_lines[cl - 1].strip() if 0 < cl <= len(c_lines) else ""
        if pcode:
            repl.append((pcode, ccode))
    for key in ("title", "where", "why", "fix"):
        v = card.get(key)
        if not isinstance(v, str):
            continue
        for a, b in repl:
            v = v.replace(a, b)
        v = re.sub(r"(\d+)(\s*)行目", lambda m: f"{cmap(m.group(1)) or m.group(1)}{m.group(2)}行目", v)
        v = v.replace("_c.nz(", "(").replace("_c.idiv(", "(").replace("_c.imod(", "(").replace("_c.toint(", "(int)(").replace("_c.", "")
        card[key] = v
    if cl:
        card["line"] = cl
        card["col"] = None
        card["end_col"] = None
    card["lang"] = "c"
    vars_ = dict(card.get("vars") or {})
    if cl:
        vars_["line"] = cl
        vars_["code"] = c_lines[cl - 1].strip() if 0 < cl <= len(c_lines) else ""
    card["vars"] = vars_
    return card


def remap_result(result: dict, line_map: list) -> dict:
    """rover_runtime.run の結果（hits・lineLog・varLog・prints・warnings・error.line）の行を C の行に直す（0 の行は捨てる）。"""
    def cm(n):
        return line_map[n] if isinstance(n, int) and 0 < n < len(line_map) else 0

    r = dict(result)
    if isinstance(r.get("hits"), list):
        size = max(line_map) + 1 if line_map else 1
        hits = [0] * size
        for py_line, h in enumerate(r["hits"]):
            c = cm(py_line)
            if c:
                hits[c] = max(hits[c], h)
        r["hits"] = hits
    if isinstance(r.get("lineLog"), list) and len(r["lineLog"]) == 2:
        ls, ts = r["lineLog"]
        keep = [(cm(a), b) for a, b in zip(ls, ts) if cm(a)]
        out_l, out_t = [], []
        for a, b in keep:
            if out_l and out_l[-1] == a and out_t[-1] == b:
                continue
            out_l.append(a)
            out_t.append(b)
        r["lineLog"] = [out_l, out_t]
    if isinstance(r.get("prints"), list):
        r["prints"] = [[p[0], cm(p[1]) or p[1], *p[2:]] for p in r["prints"]]
    if isinstance(r.get("warnings"), list):
        ws = []
        for w in r["warnings"]:
            w = dict(w)
            if isinstance(w.get("line"), int):
                w["line"] = cm(w["line"]) or w["line"]
            ws.append(w)
        r["warnings"] = ws
    return r
