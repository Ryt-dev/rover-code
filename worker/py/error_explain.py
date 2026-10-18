"""ROVER CODE エラー説明（実行前の検査と、例外・止めた理由・注意をやさしい日本語のカードにする）

持ち主: W3（エラー説明）
役割: data/error_rules.json を読んで、① 文字の検査 ② compile ③ AST の注意（before_run、Pyodide の中で 10 ms 以内）と、
      実行中の例外・止めた理由・motor の丸めの注意をカード（Card）にする。表示の文言はすべて error_rules.json にあり、
      ここには「見分け方」だけを書く。外部の依存なし（Pyodide 0.26.4 = Python 3.12.1、CPython 3.12〜3.14 でも動く）。
SPEC: 9 章（9.1 5 段の流れ・9.2 ルールの使い方・9.3 カード）・7.3「W3 worker/py/error_explain.py」・5.5（コードの大きさ）
元にしたもの: design/error_explain.py（参照実装）。7.3 の形にそろえ、9.2 の足すルールの見分け方を足した。

rover_runtime.py（W2）からの使い方（spike の _syntax_ja・_runtime_ja の代わり）:

    from error_explain import Explainer
    EX = Explainer(rules_json)                    # Worker の準備の時に 1 回（data/error_rules.json の dict か文字）
    pre = EX.before_run(code, chapter, lang)      # {"items": [Card…（2 つまで）], "stop": Card | None, …}
    if pre["stop"]:                               # 実行できないエラー → RunResult.compileError に入れて終わり
        return …
    try:
        exec(compile(code, FILENAME, "exec"), g)
    except _LineLimit as e:                       # 行数・計算時間の上限（BaseException の子）
        card = EX.explain_guard(code, e.reason, line=e.line, hits=_hits, limit=…, chapter=chapter)
    except _TimeUp:
        card = EX.explain_guard(code, "timeup", hits=_hits, limit=time_limit, chapter=chapter)
    except SystemExit:                            # exit()・quit()・sys.exit() は正常な終わり（end = exit）
        …
    except BaseException as e:
        card = EX.explain_exception(e, code, chapter, _hits)
    warnings = [{"card": EX.explain_api_warning(w, src=code), "t": w[0], "line": w[1]} for w in _warnings]
    print があふれた時: EX.explain_guard(code, "print", line=…, limit=3000)
    番犬（画面の 3 s）のあと予備の Worker で: EX.explain_watchdog(code, chapter)（= explain_guard(code, "watchdog")）
    Worker が落ちた時: EX.explain_guard(code, "fatal")

Card は dict（JSON にできる）:
    {id, stage, severity, speaker, zukan, line, col, end_col, title, where, why, fix, term, raw, example,
     quickfix, confirm, more, notes, vars}
    severity: error（止める）・warn（先に知らせる）・info（豆知識）。where には「（4 行目で呼んだ step() の中）」
    「（世界 2 でだけ起きたよ）」「（鍵の行。…）」が足されることがあり、足したものは notes にも入れる。
"""
from __future__ import annotations

import ast
import builtins
import difflib
import json
import keyword
import math
import re
import sys
import unicodedata
import warnings

FILENAME = "main.py"
ERROR_STAGES = ("precheck", "compile", "compile_warning", "lint", "api", "runtime", "guard", "fallback")
_LAST = None   # いちばん新しく作った Explainer（apply_quickfix(src, rule_id) をモジュールの関数として呼ぶため）


def _chapter_num(ch):
    """章の番号を数に（"C" はおまけ C。5 章のあとに開くので 5 として扱う。分からなければ 99）"""
    if isinstance(ch, (int, float)) and not isinstance(ch, bool):
        return ch
    s = str(ch or "").strip()
    if s.isdigit():
        return int(s)
    if s.upper() == "C":
        return 5
    return 99

# ======================================================================= 文字列・コメントを消した行
def scan_source(src):
    """各行の「コード部分」を返す。文字列の中身とコメントは空白に置きかえる（長さは同じ、引用符は残す）。

    戻り値: (masked_lines, comment_cols)。comment_cols[i] は # の位置（無ければ None）。
    全角の “ や 「 は引用符として扱わない（= コードの外に出るので、全角の検査に引っかかる）。
    """
    lines = src.split("\n")
    masked, ccols = [], []
    state = None  # (quote, raw)
    for line in lines:
        if state is None and '"' not in line and "'" not in line and "#" not in line:
            masked.append(line)   # 文字列もコメントも無い行（いちばん多い）はそのまま
            ccols.append(None)
            continue
        out = []
        ccol = None
        i, n = 0, len(line)
        while i < n:
            ch = line[i]
            if state is None:
                if ch == "#":
                    ccol = i
                    out.append(" " * (n - i))
                    break
                if ch in "\"'":
                    j, prefix = i - 1, ""
                    while j >= 0 and line[j].isalpha() and line[j].isascii() and len(prefix) < 2:
                        prefix = line[j] + prefix
                        j -= 1
                    if prefix and j >= 0 and (line[j].isalnum() or line[j] == "_"):
                        prefix = ""
                    q = ch * 3 if line[i:i + 3] == ch * 3 else ch
                    out.append(q)
                    i += len(q)
                    state = (q, "r" in prefix.lower())
                    continue
                out.append(ch)
                i += 1
            else:
                q, raw = state
                if ch == "\\" and not raw:
                    out.append(" " * min(2, n - i))
                    i += 2
                    continue
                if line.startswith(q, i):
                    out.append(q)
                    i += len(q)
                    state = None
                    continue
                out.append(" ")
                i += 1
        if state is not None and len(state[0]) == 1 and not line.endswith("\\"):
            state = None  # 1 行の文字列は行の終わりで打ち切る（閉じ忘れは compile が見つける）
        masked.append("".join(out)[:n].ljust(n))
        ccols.append(ccol)
    return masked, ccols


def scan_source_c(src):
    """C（おまけ C の面）のための scan_source。"…" と '…' の中身、// と /* */ のコメントを空白にする。
    #include の行は行ごと空白にする（<stdio.h> の < > や . を全角の検査に入れない）。"""
    lines = src.split("\n")
    masked, ccols = [], []
    in_block = False
    for line in lines:
        out = []
        ccol = None
        i, n = 0, len(line)
        if not in_block and line.lstrip().startswith("#"):
            masked.append(" " * n)
            ccols.append(len(line) - len(line.lstrip()))
            continue
        while i < n:
            ch = line[i]
            if in_block:
                if line.startswith("*/", i):
                    out.append("  ")
                    i += 2
                    in_block = False
                else:
                    out.append(" ")
                    i += 1
                continue
            if line.startswith("//", i):
                ccol = i if ccol is None else ccol
                out.append(" " * (n - i))
                break
            if line.startswith("/*", i):
                ccol = i if ccol is None else ccol
                out.append("  ")
                i += 2
                in_block = True
                continue
            if ch in "\"'":
                out.append(ch)
                i += 1
                while i < n and line[i] != ch:
                    if line[i] == "\\":
                        out.append(" " * min(2, n - i))
                        i += 2
                        continue
                    out.append(" ")
                    i += 1
                if i < n:
                    out.append(ch)
                    i += 1
                continue
            out.append(ch)
            i += 1
        masked.append("".join(out)[:n].ljust(n))
        ccols.append(ccol)
    return masked, ccols


def _is_jp(ch):
    o = ord(ch)
    return 0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0xFF66 <= o <= 0xFF9F


def _byte_to_char(line, b):
    if b is None:
        return None
    return len(line.encode("utf-8")[:b].decode("utf-8", errors="ignore"))


# ======================================================================= AST の索引
class SourceIndex:
    """名前がどこで作られ、どこで使われているか。check 関数が使う。

    〔速さ〕木は 1 回だけ歩き（幅優先。ast.walk と同じ順）、親・行・種類・入っている関数の表を作る。
    check 関数は idx.of(ast.Call) のように種類で引く（10 章の 210 行でも before_run を Pyodide で 10 ms 以内に）。
    """

    def __init__(self, src, lang="python", tree=None):
        self.src = src
        self.lang = lang
        self.lines = src.split("\n")
        self.masked, self.ccols = scan_source_c(src) if lang == "c" else scan_source(src)
        self.tree = tree if tree is not False else None
        if lang != "c" and tree is None:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    self.tree = ast.parse(src)
            except (SyntaxError, ValueError, MemoryError, RecursionError, OverflowError):
                self.tree = None
        self.parents = {}
        self.funcdefs = {}          # 名前 -> FunctionDef（どの深さでも。最初のもの）
        self.module_binds = {}      # 名前 -> [(lineno, block)]  block: None / "if" / "for" / "while" / "try" / "with"
        self.local_binds = {}       # 名前 -> [関数名]
        self.imports = set()
        self.loads = {}             # 名前 -> [lineno]（読み出し）
        self.all_nodes = []         # 幅優先の順（ast.walk と同じ）
        self._by_line = None        # 行番号 -> その行で始まるノード（by_line。使う時に作る）
        self.by_type = {}           # 型 -> [ノード]（幅優先の順）
        self.order = {}             # ノード -> 幅優先の番号
        self.func_of = {}           # ノード -> いちばん内側の関数（FunctionDef・Lambda）か None
        self.func_nodes = {}        # 関数 -> その中のノード（入れ子もふくむ）
        self.globals_of = {}        # 関数 -> global で書いた名前
        self._returns = {}
        self._fn_binds = {}
        self._breaks = None
        self._has_walrus = False
        if self.tree is not None:
            self._index()
            self._collect(self.tree.body, func=None, block=None)
            for node in self.by_type.get(ast.Name, ()):
                if isinstance(node.ctx, ast.Load):
                    self.loads.setdefault(node.id, []).append(node.lineno)

    # 子のノードが入らない欄（名前・数・Load などの印）。種類ごとに、歩く欄だけの表を作っておく（〔速さ〕getattr を減らす）
    _NO_CHILD = frozenset(("ctx", "op", "ops", "id", "arg", "attr", "module", "level", "type_comment", "kind",
                           "conversion", "is_async", "simple", "tag"))
    _FIELDS = {}
    _BIND_TYPES = frozenset((ast.FunctionDef, ast.AsyncFunctionDef, ast.Assign, ast.AnnAssign, ast.AugAssign,
                             ast.For, ast.AsyncFor, ast.NamedExpr))

    def _index(self):
        AST = ast.AST
        FUNC = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
        NAME, CONST = ast.Name, ast.Constant
        parents, by_type, order, func_of = self.parents, self.by_type, self.order, self.func_of
        FIELDS, NO_CHILD = SourceIndex._FIELDS, SourceIndex._NO_CHILD
        nodes = self.all_nodes
        nodes.append(self.tree)
        func_of[self.tree] = None
        fn_nodes = self.func_nodes
        fn_binds = self._fn_binds = {}   # 関数 -> その中の名前を作るノード（_collect_func が使う。幅優先の順）
        BINDS = SourceIndex._BIND_TYPES
        nested = False                   # 関数の中の関数（lambda もふくむ）があるか
        i = 0
        while i < len(nodes):
            node = nodes[i]
            order[node] = i
            i += 1
            cls = node.__class__
            lst = by_type.get(cls)
            if lst is None:
                by_type[cls] = [node]
            else:
                lst.append(node)
            if cls is NAME or cls is CONST:   # 葉（いちばん多い）は中を見ない
                continue
            fields = FIELDS.get(cls)
            if fields is None:
                fields = FIELDS[cls] = tuple(f for f in cls._fields if f not in NO_CHILD)
            if cls in FUNC:
                inner = node
                if func_of[node] is not None:
                    nested = True
            else:
                inner = func_of[node]
            # 〔速さ〕関数の中のノードの表も、見つけた順（＝幅優先の順）にここで作る（入れ子の関数がある時は下で作り直す）
            fl = None
            if inner is not None:
                fl = fn_nodes.get(inner)
                if fl is None:
                    fl = fn_nodes[inner] = []
            for field in fields:
                v = getattr(node, field, None)
                if v.__class__ is list:
                    for ch in v:
                        if isinstance(ch, AST):
                            parents[ch] = node
                            func_of[ch] = inner
                            nodes.append(ch)
                            if fl is not None:
                                fl.append(ch)
                                if ch.__class__ in BINDS:
                                    fn_binds.setdefault(inner, []).append(ch)
                elif isinstance(v, AST):
                    parents[v] = node
                    func_of[v] = inner
                    nodes.append(v)
                    if fl is not None:
                        fl.append(v)
                        if v.__class__ in BINDS:
                            fn_binds.setdefault(inner, []).append(v)
        for f in [f for f, l in fn_nodes.items() if not l]:
            del fn_nodes[f]          # 中が空の関数は前と同じく表に入れない
        if nested:
            fn_nodes.clear()
            fn_binds.clear()
            for node in nodes:
                f = func_of.get(node)
                if f is None:
                    continue
                is_bind = node.__class__ in BINDS
                while f is not None:
                    lst = fn_nodes.get(f)
                    if lst is None:
                        fn_nodes[f] = [node]
                    else:
                        lst.append(node)
                    if is_bind:
                        fn_binds.setdefault(f, []).append(node)
                    f = func_of.get(f)
        for g in by_type.get(ast.Global, ()):
            f = func_of.get(g)
            while f is not None:
                self.globals_of.setdefault(f, set()).update(g.names)
                f = func_of.get(f)
        self._has_walrus = ast.NamedExpr in by_type

    @property
    def by_line(self):
        """行番号 -> その行で始まるノード（幅優先の順）。〔速さ〕実行前の検査ではほとんど使わないので、初めて使う時に作る"""
        bl = self._by_line
        if bl is None:
            bl = self._by_line = {}
            for node in self.all_nodes:
                ln = getattr(node, "lineno", None)
                if ln is not None:
                    lst = bl.get(ln)
                    if lst is None:
                        bl[ln] = [node]
                    else:
                        lst.append(node)
        return bl

    def of(self, *types):
        """その種類のノード（幅優先の順。いくつかの種類なら混ぜて幅優先の順）"""
        if len(types) == 1:
            return self.by_type.get(types[0], [])
        out = []
        for t in types:
            out += self.by_type.get(t, [])
        out.sort(key=self.order.__getitem__)
        return out

    def inside(self, fdef):
        """関数の中のノード（入れ子の関数もふくむ。幅優先の順）"""
        return self.func_nodes.get(fdef, [])

    def has_break(self, loop):
        """くり返しの中に break か return があるか（ast.walk(loop) と同じく、入れ子の中もふくむ）"""
        if self._breaks is None:
            br = set()
            for n in self.of(ast.Break, ast.Return):
                p = self.parents.get(n)
                while p is not None:
                    if isinstance(p, (ast.While, ast.For, ast.AsyncFor)):
                        br.add(p)
                    p = self.parents.get(p)
            self._breaks = br
        return loop in self._breaks

    _UNDER = (ast.While, ast.For, ast.AsyncFor, ast.FunctionDef, ast.AsyncFunctionDef, ast.If, ast.Module)

    def calls_under(self, node):
        """node の中の呼び出し（くり返し・関数・if・モジュールは表で。ほかは歩く）"""
        cu = self.__dict__.get("_calls_under")
        if cu is None:
            cu = {}
            for c in self.of(ast.Call):
                p = self.parents.get(c)
                while p is not None:
                    if isinstance(p, self._UNDER):
                        cu.setdefault(p, []).append(c)
                    p = self.parents.get(p)
            self._calls_under = cu
        if isinstance(node, self._UNDER) and node in self.order:
            return cu.get(node, [])
        return [c for c in ast.walk(node) if isinstance(c, ast.Call)]

    # ---- 収集
    def _bind(self, name, lineno, func, block):
        if func is None:
            self.module_binds.setdefault(name, []).append((lineno, block))
        else:
            self.local_binds.setdefault(name, []).append(func)

    def _targets(self, t):
        if isinstance(t, ast.Name):
            yield t.id
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                yield from self._targets(e)
        elif isinstance(t, ast.Starred):
            yield from self._targets(t.value)

    def _collect(self, body, func, block):
        for st in body:
            self._collect_stmt(st, func, block)

    def _collect_stmt(self, st, func, block):
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self.funcdefs.setdefault(st.name, st)
            self._bind(st.name, st.lineno, func, block)
            for a in st.args.args + st.args.kwonlyargs + st.args.posonlyargs:
                self.local_binds.setdefault(a.arg, []).append(st.name)
            self._collect_func(st, st.name, self.globals_of.get(st, set()))
            return
        if isinstance(st, ast.ClassDef):
            self._bind(st.name, st.lineno, func, block)
            return
        if isinstance(st, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            tgts = st.targets if isinstance(st, ast.Assign) else [st.target]
            for t in tgts:
                for nm in self._targets(t):
                    self._bind(nm, st.lineno, func, block)
        elif isinstance(st, (ast.Import, ast.ImportFrom)):
            for a in st.names:
                nm = (a.asname or a.name).split(".")[0]
                self.imports.add(a.name.split(".")[0] if isinstance(st, ast.Import) else nm)
                self._bind(nm, st.lineno, func, block)
        elif isinstance(st, (ast.For, ast.AsyncFor)):
            for nm in self._targets(st.target):
                self._bind(nm, st.lineno, func, block or "for")
            self._collect(st.body, func, block or "for")
            self._collect(st.orelse, func, block or "for")
            return
        elif isinstance(st, ast.While):
            self._collect(st.body, func, block or "while")
            self._collect(st.orelse, func, block or "while")
            return
        elif isinstance(st, ast.If):
            self._collect(st.body, func, block or "if")
            self._collect(st.orelse, func, block or "if")
            return
        elif isinstance(st, ast.Try):
            self._collect(st.body, func, block or "try")
            for h in st.handlers:
                if h.name:
                    self._bind(h.name, h.lineno, func, block or "try")
                self._collect(h.body, func, block or "try")
            self._collect(st.orelse, func, block or "try")
            self._collect(st.finalbody, func, block)
            return
        elif isinstance(st, ast.With):
            for it in st.items:
                if it.optional_vars is not None:
                    for nm in self._targets(it.optional_vars):
                        self._bind(nm, st.lineno, func, block or "with")
            self._collect(st.body, func, block or "with")
            return
        if self._has_walrus:
            for n in ast.walk(st):
                if isinstance(n, ast.NamedExpr):
                    self._bind(n.target.id, st.lineno, func, block)

    def _collect_func(self, fd, fname, globs):
        """関数の本体の中で作られる名前（global と書いたものはモジュールの名前として数える）"""
        for n in self._fn_binds.get(fd, ()):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.funcdefs.setdefault(n.name, n)
                tgt_names = [n.name]
            elif isinstance(n, ast.Assign):
                tgt_names = [nm for t in n.targets for nm in self._targets(t)]
            elif isinstance(n, (ast.AnnAssign, ast.AugAssign)):
                tgt_names = list(self._targets(n.target))
            elif isinstance(n, (ast.For, ast.AsyncFor)):
                tgt_names = list(self._targets(n.target))
            elif isinstance(n, ast.NamedExpr):
                tgt_names = [n.target.id]
            else:
                continue
            for nm in tgt_names:
                if nm in globs:
                    self.module_binds.setdefault(nm, []).append((n.lineno, "func"))
                else:
                    self.local_binds.setdefault(nm, []).append(fname)

    # ---- 問い合わせ
    def code_of(self, lineno):
        if not (1 <= lineno <= len(self.lines)):
            return ""
        raw = self.lines[lineno - 1]
        c = self.ccols[lineno - 1]
        return (raw[:c] if c is not None else raw).strip()

    def masked_of(self, lineno):
        return self.masked[lineno - 1] if 1 <= lineno <= len(self.masked) else ""

    def nodes_on_line(self, lineno):
        return list(self.by_line.get(lineno, ()))

    def calls_on_line(self, lineno):
        return [n for n in self.by_line.get(lineno, ()) if isinstance(n, ast.Call)]

    def segment(self, node):
        try:
            return ast.get_source_segment(self.src, node) or ""
        except Exception:
            return ""

    def is_bound_anywhere(self, name):
        return name in self.module_binds or name in self.local_binds

    def stmt_of_line(self, lineno):
        best = None
        for n in self.by_line.get(lineno, ()):
            if isinstance(n, ast.stmt):
                if best is None or (n.col_offset > best.col_offset):
                    best = n
        return best

    def enclosing_loop(self, lineno):
        """lineno をふくむ、いちばん内側の while / for"""
        best = None
        for n in self.of(ast.While, ast.For):
            if n.lineno <= lineno <= (n.end_lineno or n.lineno):
                if best is None or n.lineno >= best.lineno:
                    best = n
        return best

    def func_returns_value(self, fdef):
        """値を返す return があるか（入れ子の関数の return は数えない）"""
        r = self._returns.get(fdef)
        if r is None:
            r = any(isinstance(n, ast.Return) and n.value is not None and self.func_of.get(n) is fdef
                    for n in self.inside(fdef))
            self._returns[fdef] = r
        return r


# ======================================================================= 本体
class Explainer:
    """error_rules.json を持って、カード（Card）を作る。Worker の準備の時に 1 回だけ作る（ルールの並べかえをくり返さない）。"""

    def __init__(self, rules_json):
        global _LAST
        if isinstance(rules_json, (str, bytes)):
            rules_json = json.loads(rules_json)
        self.data = rules_json
        self.api = rules_json.get("api", {})
        self.funcs = self.api.get("functions", {})
        self.rules = sorted(rules_json["rules"], key=lambda r: -r.get("priority", 0))
        self.by_id = {r["id"]: r for r in self.rules}
        self.by_stage = {}
        for r in self.rules:
            self.by_stage.setdefault(r["stage"], []).append(r)
        self.terms = rules_json.get("glossary", {})
        self.type_ja = rules_json.get("type_ja", {})
        self.limits = rules_json.get("limits", {})
        disp = rules_json.get("display", {})
        self.max_items = int(disp.get("max_warnings_before_run", 2))
        # precheck の「文字」のルール: 文字 → [ルール]（全角はすべて ASCII の外なので、ASCII だけの行は見なくてよい）
        self._char_rules = []
        for r in self.by_stage.get("precheck", []):
            if "chars" in r["match"]:
                self._char_rules.append((r, set(r["match"]["chars"])))
        _LAST = self

    # ------------------------------------------------------------------ 公開の入口（SPEC 7.3）
    def before_run(self, src, chapter=99, lang="python"):
        """実行前の検査（中身は _before_run）。〔速さ〕木を作ると小さなものがたくさんでき、循環 GC が何度も走るので、
        検査の間だけ止める（10 章の 238 行で 2 割ほど速くなる）。終わったら元に戻す。"""
        import gc as _gc
        was = _gc.isenabled()
        if was:
            _gc.disable()
        try:
            return self._before_run(src, chapter, lang)
        finally:
            if was:
                _gc.enable()

    def _before_run(self, src, chapter=99, lang="python"):
        """実行前の検査（① 文字 ② compile ③ AST の注意）。

        返す: {"items": [Card…（display.max_warnings_before_run 個まで）], "stop": Card | None,
               "more": 出さなかった注意の数, "all": [止めない Card すべて], "compile_ok": bool, "ms": かかった時間}
        stop があれば実行しない（RunResult.compileError）。items は実行前の注意（RunResult.before、止めない）。
        lang="c" は ① の文字の検査だけ（書き方は c_subset.py が見る）。
        """
        import time as _t
        t0 = _t.perf_counter()
        ch = _chapter_num(chapter)
        if lang == "c":
            idx = SourceIndex(src, lang="c")
            pre = self.precheck(src, idx, lang="c", strip=False)
            stop = next((d for d in pre if d["severity"] == "error"), None)
            warns = [d for d in pre if d["severity"] != "error"]
            return self._before_result(stop, warns, False, t0)
        # 木を作るのは 1 回だけ（ast.parse → compile(木)。SyntaxWarning は両方の段で集める）
        tree, syn_err, other_err, ws = None, None, None, []
        with warnings.catch_warnings(record=True) as rec:
            warnings.simplefilter("always")
            try:
                tree = ast.parse(src, FILENAME)
            except SyntaxError as e:
                syn_err = e
            except (ValueError, MemoryError, RecursionError, OverflowError) as e:   # ヌル文字・深すぎる入れ子など
                other_err = e
            ws = list(rec)
        idx = SourceIndex(src, tree=tree) if tree is not None else SourceIndex(src, tree=False)
        pre = self.precheck(src, idx, strip=False)
        stop = next((d for d in pre if d["severity"] == "error"), None)
        warns = [d for d in pre if d["severity"] != "error"]
        code_ok = False
        if stop is not None and stop["id"] in ("EMPTY_CODE", "CODE_TOO_LONG"):
            return self._before_result(stop, [], False, t0)
        if tree is not None:
            try:
                with warnings.catch_warnings(record=True) as rec:
                    warnings.simplefilter("always")
                    # 〔速さ〕木からではなく文字から作る（Pyodide で木を C の形に戻す分 0.4 ms ほど速い。出るエラーは同じ）。
                    # 文字を読む段の SyntaxWarning（\d など）は ast.parse でも出ているので、同じものは 1 つにする
                    compile(src, FILENAME, "exec", dont_inherit=True)
                    seen_w = {(w.category, str(w.message), w.lineno) for w in ws}
                    ws += [w for w in rec if (w.category, str(w.message), w.lineno) not in seen_w]
                code_ok = True
            except SyntaxError as e:   # return が関数の外・break がくり返しの外 など（木から作る段で分かるもの）
                syn_err = e
            except (ValueError, MemoryError, RecursionError, OverflowError) as e:
                other_err = e
        if code_ok:
            for w in ws:
                if not issubclass(w.category, SyntaxWarning):
                    continue
                d = self._explain_ctx("compile_warning", self._ctx_basic(idx, w.lineno or 1, None, None,
                                                                         "SyntaxWarning", str(w.message), ch))
                if d is None:
                    continue
                if d["severity"] == "error":
                    stop = stop or d
                else:
                    warns.append(d)
        if syn_err is not None:
            if stop is None:
                stop = self.explain_syntax(src, syn_err, idx, ch)
            elif not stop.get("raw"):
                stop["raw"] = f"{type(syn_err).__name__}: {syn_err.msg}"  # 全角などのとき、Python の元の英文も見せられるように
        elif other_err is not None and stop is None:
            ctx = self._ctx_basic(idx, 1, None, None, type(other_err).__name__, str(other_err), ch)
            stop = self._fallback(ctx)
        if code_ok and stop is None:
            warns += self.lint(src, idx, ch, strip=False)
        return self._before_result(stop, warns, code_ok, t0)

    def _before_result(self, stop, warns, code_ok, t0):
        import time as _t
        order = {"warn": 0, "info": 1}
        warns.sort(key=lambda d: (order.get(d["severity"], 2), -d.get("_prio", 0)))
        for d in warns:
            d.pop("_prio", None)
        if stop is not None:
            stop.pop("_prio", None)
        items = warns[: self.max_items]
        return {"items": items, "stop": stop, "more": max(0, len(warns) - len(items)), "all": warns,
                "compile_ok": code_ok, "ms": round((_t.perf_counter() - t0) * 1000, 2)}

    def explain_syntax(self, src, e, idx=None, chapter=99):
        idx = idx or SourceIndex(src)
        line = e.lineno or 1
        col = e.offset
        end = e.end_offset if (getattr(e, "end_lineno", None) in (None, line)) else None
        if end is not None and end <= 0:
            end = None
        ctx = self._ctx_basic(idx, line, col, end, type(e).__name__, e.msg or "", chapter)
        return self._done(self._explain_ctx("compile", ctx) or self._fallback(ctx))

    def explain_exception(self, exc, src, chapter=99, hits=None, idx=None):
        """実行中の例外（API が出したものも）を説明する。SPEC 7.3: explain_exception(exc, src, chapter, hits)"""
        if isinstance(exc, str) and isinstance(src, BaseException):   # 参照実装の順番（src, exc）でも受ける
            exc, src = src, exc
        chapter = _chapter_num(chapter)
        idx = idx or SourceIndex(src)
        frames = []
        tb = exc.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == FILENAME:
                frames.append(tb)
            tb = tb.tb_next
        if isinstance(exc, SyntaxError) and not frames:
            return self.explain_syntax(src, exc, idx, chapter)
        line, col, end, frame, lasti_pos = 1, None, None, None, None
        if frames:
            last = frames[-1]
            frame, line = last.tb_frame, last.tb_lineno
            try:
                pos = list(frame.f_code.co_positions())[last.tb_lasti // 2]
                if pos[0] == line and pos[2] is not None:
                    lasti_pos = pos
                    raw = idx.lines[line - 1] if line <= len(idx.lines) else ""
                    col = _byte_to_char(raw, pos[2]) + 1
                    if pos[1] == line and pos[3] is not None:
                        end = _byte_to_char(raw, pos[3]) + 1
            except Exception:
                pass
        elif isinstance(exc, SyntaxError) and exc.lineno:
            line = exc.lineno
        msg = str(exc)
        if isinstance(exc, KeyError) and exc.args:
            msg = repr(exc.args[0])
        ctx = self._ctx_basic(idx, line, col, end, type(exc).__name__, msg, chapter)
        ctx.update(exc=exc, frame=frame, pos=lasti_pos, hits=hits)
        ctx["api_code"] = getattr(exc, "rover_code", None)
        ctx["api_info"] = getattr(exc, "rover_info", {}) or {}
        if frame is not None and frame.f_code.co_name != "<module>":
            ctx["vars"]["in_func"] = frame.f_code.co_name
            if len(frames) >= 2:
                ctx["vars"]["call_line"] = frames[-2].tb_lineno
        if isinstance(exc, RecursionError):
            names = [f.tb_frame.f_code.co_name for f in frames if f.tb_frame.f_code.co_name != "<module>"]
            if names:
                fn = max(set(names), key=names.count)
                ctx["vars"]["func"] = fn
                fd = idx.funcdefs.get(fn)
                selfcall = [c for c in ast.walk(fd) if isinstance(c, ast.Call) and _call_name(c) == fn] if fd else []
                if selfcall:
                    ln = selfcall[0].lineno
                    ctx.update(line=ln, col=None, end=None, masked_line=idx.masked_of(ln), raw_line=idx.lines[ln - 1])
                    ctx["vars"].update(line=ln, code=idx.code_of(ln))
                    ctx["vars"].pop("call_line", None)
                    ctx["vars"].pop("in_func", None)
        for stage in ("api", "runtime"):
            d = self._explain_ctx(stage, ctx)
            if d:
                return self._done(d)
        return self._done(self._fallback(ctx))

    def explain_guard(self, src, reason, line=None, hits=None, limit=None, count=None, chapter=99, idx=None, **kw):
        """実行を止めた理由のカード。reason: "lines" 行数の上限 / "wall" 計算時間 / "timeup" 時間切れ /
        "print" 出力が多すぎ / "watchdog" 番犬（画面の 3 s） / "fatal" Worker が落ちた / "test_wall" 本番テスト全体の上限"""
        chapter = _chapter_num(chapter)
        idx = idx or SourceIndex(src)
        hot = line
        if hits:
            best = max(range(len(hits)), key=lambda i: hits[i])
            if hits[best] > 0 and (hot is None or reason == "timeup"):
                hot = best
        hot = hot or 1
        if reason == "timeup" and hits and idx.tree is not None:
            # 時間切れ: 止まらなかったくり返し（頭の行がいちばん多く通った while / for）に印を付ける。
            # いちばん多く通った行が関数の中（to_xy の計算など）でも、その関数を呼んでいるくり返しを指す（直し係 2）
            best_loop, best_n = None, 0
            for lp in idx.of(ast.While, ast.For):
                n = hits[lp.lineno] if lp.lineno < len(hits) else 0
                if n > best_n or (n == best_n and n > 0 and best_loop is not None and lp.lineno > best_loop.lineno
                                  and lp.lineno <= (best_loop.end_lineno or best_loop.lineno)):
                    best_loop, best_n = lp, n
            if best_loop is not None and best_n > 0:
                inner = idx.enclosing_loop(hot)
                # いちばん多く通った行がくり返しの中なら、その一番内側のくり返し（今までどおり）。外なら、さがした while
                if inner is None or (hits[inner.lineno] if inner.lineno < len(hits) else 0) == 0:
                    hot = best_loop.lineno
        ctx = self._ctx_basic(idx, hot, None, None, "Guard", reason, chapter)
        ctx["guard"] = reason
        v = ctx["vars"]
        v["hot_line"] = hot
        if reason not in ("fatal", "test_wall", "watchdog", "busy"):
            loop = idx.enclosing_loop(hot)
            if loop is not None:
                v["loop_line"] = loop.lineno
                v["loop_code"] = idx.code_of(loop.lineno)
                v["line"] = loop.lineno
                v["code"] = idx.code_of(loop.lineno)
        if limit is not None:
            v["limit"] = _num_text(limit)
        if count is not None:
            v["count"] = f"{count:,}" if isinstance(count, int) and count >= 10000 else str(count)
        ctx["hits"] = hits
        d = self._explain_ctx("guard", ctx) or self._fallback(ctx)
        if d is not None and reason in ("fatal", "test_wall", "busy"):
            d["line"] = None
            d["col"] = None
        return self._done(d)

    def explain_watchdog(self, src, chapter=99):
        """番犬（画面の 3 s）で止めた後に、予備の Worker で呼ぶ（SPEC 7.3 の Engine.explainWatchdog）。
        AST から「とても大きな計算」「時間が進まないくり返し」を探して、WATCHDOG のカードの where を埋める。"""
        return self.explain_guard(src, "watchdog", chapter=chapter)

    def explain_fatal(self, src="", chapter=99):
        """Worker が落ちた時（FATAL）。コードはそのまま残っている、と言うカード。"""
        return self.explain_guard(src or "", "fatal", chapter=chapter)

    def explain_api_warning(self, w, src=None, chapter=99, idx=None):
        """止めずに直した注意（motor の数が 1 をこえた、など）。w は rover_runtime の _warnings の 1 つ
        （(t, line, text) か {"t", "line", "text"}）。src は生徒のコード（where の「その行」に使う）。"""
        if isinstance(w, str):   # 参照実装の順番 explain_api_warning(src, text, line) でも受ける
            w, src, chapter = (None, chapter if isinstance(chapter, int) else None, src), w, 99
        if isinstance(w, dict):
            line, text = w.get("line"), w.get("text", "")
        else:
            _, line, text = (list(w) + [None, None, ""])[:3]
        src = src or ""
        idx = idx or SourceIndex(src)
        ctx = self._ctx_basic(idx, line or 1, None, None, "Warning", text or "", _chapter_num(chapter))
        return self._done(self._explain_ctx("api_warning", ctx))

    # ---- where に足す（SPEC 9.2・3.4）
    def add_world_note(self, card, worlds_text):
        """「（世界 2 でだけ起きたよ）」を where の後ろに足す。worlds_text は「世界 2」「世界 2・3」など"""
        if not card or not worlds_text:
            return card
        note = self.data.get("where_world_only", "（{worlds} でだけ起きたよ）").replace("{worlds}", worlds_text)
        return _add_note(card, note, "world")

    def add_locked_note(self, card, locked):
        """鍵の行（[[1, 4], [7, 7]]）で起きたエラーなら「（鍵の行。原因は空欄に入れた値かもしれないよ）」を足す"""
        ln = card.get("line") if card else None
        if not ln or not locked:
            return card
        if any(a <= ln <= b for a, b in locked):
            return _add_note(card, self.data.get("where_locked", "（鍵の行。原因は空欄に入れた値かもしれないよ）"), "locked")
        return card

    # ------------------------------------------------------------------ 実行前: 文字の検査
    def precheck(self, src, idx=None, lang="python", strip=True):
        """① 文字の検査。見つけたルールごとに 1 枚（同じ所を 2 つのルールで数えない）"""
        idx = idx or SourceIndex(src, lang=lang)
        out = []
        taken = set()  # (line, col) を 1 つのルールにだけ数える
        nonascii = None
        for rule in self.by_stage.get("precheck", []):
            m = rule["match"]
            if lang == "c" and m.get("check") in ("c_comment", "jp_comment_no_hash"):
                continue
            hits = []
            if "chars" in m:
                if nonascii is None:   # ASCII の外の文字だけを 1 回で集める（全角の検査を速く）
                    nonascii = [(li, ci, ch) for li, ml in enumerate(idx.masked, start=1) if not ml.isascii()
                                for ci, ch in enumerate(ml) if ord(ch) > 127]
                chars = m["chars"]
                hits = [h for h in nonascii if h[2] in chars and (h[0], h[1]) not in taken]
            elif "check" in m:
                fn = CHECKS[m["check"]]
                hits = [h for h in fn(self, idx, **m.get("args", {})) if (h[0], h[1]) not in taken]
            if not hits:
                continue
            for h in hits:
                taken.add((h[0], h[1]))
            li, ci, ch = hits[0][:3]
            extra = hits[0][3] if len(hits[0]) > 3 else {}
            ctx = self._ctx_basic(idx, li, ci + 1, ci + 1 + len(ch), "Precheck", "")
            v = ctx["vars"]
            v["char"] = ch
            v["count"] = len(hits)
            v["to"] = _char_fix(m, ch, idx.lines[li - 1] if li <= len(idx.lines) else "", ci)
            v["char_name"] = _char_name(ch)
            v.update(extra)
            d = self._render(rule, ctx)
            d["more"] = len(hits) - 1
            d["hits"] = [{"line": h[0], "col": h[1] + 1, "char": h[2]} for h in hits[:200]]
            out.append(d)
        if strip:
            for d in out:
                d.pop("_prio", None)
        return out

    # ------------------------------------------------------------------ 実行前: AST の注意
    def lint(self, src, idx=None, chapter=99, strip=True):
        """③ AST の注意（止めない）"""
        idx = idx or SourceIndex(src)
        if idx.tree is None:
            return []
        out = []
        for rule in self.by_stage.get("lint", []):
            if rule.get("chapter_gate", False) and rule.get("chapter", 1) > chapter:
                continue
            fn = CHECKS[rule["match"]["check"]]
            for line, col, vars_ in fn(self, idx, **rule["match"].get("args", {}))[: rule.get("max_hits", 3)]:
                ctx = self._ctx_basic(idx, line, col, None, "Lint", "", chapter)
                ctx["vars"].update(vars_)
                out.append(self._render(rule, ctx))
        if strip:
            for d in out:
                d.pop("_prio", None)
        return out

    # ------------------------------------------------------------------ 直す（全角など）
    def apply_quickfix(self, src, rule_id):
        """［半角に直す］などのボタン。そのルールが指した所だけを直す（「モーター」の ー や、ほかの行はさわらない）。
        知らない ID・直し方の無いルールは src をそのまま返す。"""
        rule = self.by_id.get(rule_id)
        if rule is None:
            return src
        qf = rule.get("quickfix") or {}
        idx = SourceIndex(src)
        lines = list(idx.lines)
        if qf.get("type") == "tabs_to_spaces":
            return "\n".join(l.replace("\t", "    ") for l in lines)
        if rule["stage"] == "precheck":
            d = next((d for d in self.precheck(src, idx) if d["id"] == rule_id), None)
            if d is None:
                return src
            spots = sorted({(h["line"], h["col"]) for h in d["hits"]}, reverse=True)
        else:  # compile など: 正規表現に合う行だけ
            spots = [(i + 1, None) for i, ml in enumerate(idx.masked) if "pattern" in qf and re.search(qf["pattern"], ml)]
        if qf.get("type") == "char_map":
            mp, lead = qf.get("map", {}), qf.get("leading", {})
            for li, col in spots:
                raw = lines[li - 1]
                ci = col - 1
                ch = raw[ci]
                if ch not in mp:
                    continue
                lead_end = len(raw) - len(raw.lstrip(" \t　"))
                rep = lead.get(ch, mp[ch]) if ci < lead_end else mp[ch]
                lines[li - 1] = raw[:ci] + rep + raw[ci + 1:]
            return "\n".join(lines)
        if qf.get("type") == "regex":
            for li in sorted({li for li, _ in spots}):
                lines[li - 1] = re.sub(qf["pattern"], qf["replace"], lines[li - 1], count=1)
            return "\n".join(lines)
        return src

    # ------------------------------------------------------------------ 照合と文の組み立て
    def _ctx_basic(self, idx, line, col, end, exc_type, msg, chapter=99):
        raw_line = idx.lines[line - 1] if 1 <= line <= len(idx.lines) else ""
        code = idx.code_of(line)
        v = {"line": line, "col": col or 1, "code": code, "exc_type": exc_type, "msg": msg,
             "raw": f"{exc_type}: {msg}" if exc_type not in ("Precheck", "Lint", "Guard", "Warning") else ""}
        if col and end and end > col:
            v["span"] = raw_line[col - 1:end - 1]
        elif col:
            v["span"] = raw_line[col - 1:col] if col - 1 < len(raw_line) else ""
        return {"idx": idx, "line": line, "col": col, "end": end, "exc_type": exc_type, "msg": msg,
                "masked_line": idx.masked_of(line), "raw_line": raw_line, "vars": v, "chapter": _chapter_num(chapter)}

    def _match(self, rule, ctx):
        m = rule["match"]
        got = {}
        if "exc" in m and ctx["exc_type"] not in m["exc"]:
            return None
        if "api_code" in m:
            if ctx.get("api_code") != m["api_code"]:
                if ctx.get("api_code") or not ("msg" in m and re.search(m["msg"], ctx["msg"])):
                    return None
                # rover_code が無い runtime でも、メッセージで見分けられれば良い（別の rover_code が付いていたら合わない）
        if "guard" in m and ctx.get("guard") not in (m["guard"] if isinstance(m["guard"], list) else [m["guard"]]):
            return None
        if "msg" in m:
            mo = re.search(m["msg"], ctx["msg"])
            if not mo:
                if "api_code" in m and ctx.get("api_code") == m["api_code"]:
                    mo = None   # rover_code が合っていれば、文が変わっても受ける
                else:
                    return None
            if mo:
                for k, val in zip(m.get("msg_vars", []), mo.groups()):
                    if val is not None:
                        got[k] = val
        if "line" in m:
            mo = re.search(m["line"], ctx["masked_line"])
            if not mo:
                return None
            for k, val in zip(m.get("line_vars", []), mo.groups()):
                if val is not None:
                    got[k] = val
        if "line_raw" in m and not re.search(m["line_raw"], ctx["raw_line"]):
            return None
        if "not_line" in m and re.search(m["not_line"], ctx["masked_line"]):
            return None
        if "check" in m:
            fn = CHECKS[m["check"]]
            r = fn(self, ctx, got, **m.get("args", {}))
            if not r:
                return None
            if isinstance(r, dict):
                got.update(r)
        if "map" in m:  # 正規表現で取った値を、ことばに置きかえる
            for k, table in m["map"].items():
                if k in got and got[k] in table:
                    got[k + "_ja"] = table[got[k]]
        return got

    def _explain_ctx(self, stage, ctx):
        for rule in self.by_stage.get(stage, []):
            got = self._match(rule, ctx)
            if got is not None:
                ctx["vars"].update(got)
                return self._render(rule, ctx)
        return None

    def _fallback(self, ctx):
        for rule in self.by_stage.get("fallback", []):
            got = self._match(rule, ctx)
            if got is not None:
                ctx["vars"].update(got)
                return self._render(rule, ctx)
        return None

    @staticmethod
    def _done(card):
        if card is not None:
            card.pop("_prio", None)
        return card

    def _message(self, rule, chapter):
        """章で文を変えるルール（variants）。chapters: [から, まで]（"C" は 5 として数える）"""
        msg = rule["message"]
        for var in rule.get("variants", ()):
            lo, hi = var.get("chapters", [1, 99])
            if _chapter_num(lo) <= chapter <= _chapter_num(hi):
                msg = {**msg, **var.get("message", {})}
                break
        return msg

    def _render(self, rule, ctx):
        v = dict(ctx["vars"])
        if "line" in v and "line_override" in v:
            v["line"] = v["line_override"]

        def fill(text):
            if not text:
                return text

            def sub(mo):
                if mo.group(1) not in v:
                    return mo.group(0)
                return _spaced(_fill_value(v[mo.group(1)]), mo.string[mo.start() - 1] if mo.start() > 0 else "",
                               mo.string[mo.end()] if mo.end() < len(mo.string) else "")
            return re.sub(r"\{([a-z][a-z0-9_]*)\}", sub, text)

        msg = self._message(rule, ctx.get("chapter", 99))
        where = fill(msg.get("where", ""))
        notes = []
        if v.get("in_func") and rule["stage"] in ("runtime", "api", "fallback") and v.get("call_line"):
            note = fill(self.data.get("where_in_func", "（{call_line} 行目で呼んだ {in_func}() の中）"))
            where += note
            notes.append({"kind": "func", "text": note})
        return {
            "id": rule["id"], "stage": rule["stage"], "severity": rule["severity"], "zukan": rule.get("zukan"),
            "line": v.get("line"), "col": ctx.get("col") or v.get("col"), "end_col": ctx.get("end"),
            "title": fill(msg["title"]), "where": where, "why": fill(msg.get("why", "")),
            "fix": fill(msg.get("fix", "")), "term": fill(rule.get("term", "")), "raw": v.get("raw", ""),
            "example": rule.get("example"), "quickfix": rule.get("quickfix"), "speaker": rule.get("speaker", "rover"),
            "confirm": rule.get("confirm", False), "more": 0, "notes": notes, "_prio": rule.get("priority", 0),
            "vars": {k: x for k, x in v.items() if isinstance(x, (str, int, float)) and k not in ("msg", "raw")},
        }

    def uncalled_funcs(self, src):
        """作ったが一度も呼んでいない関数の名前（replay_explain.js の uncalledFuncs に渡す。lint の出す・出さないに関係なく全部）"""
        idx = SourceIndex(src)
        return [name for name, _ in _uncalled(idx)] if idx.tree is not None else []

    # ---- 小さな道具
    def api_names(self):
        return list(self.funcs.keys())

    def api_sig(self, name):
        f = self.funcs.get(name)
        return f.get("sig") if f else None

    def tname(self, tn):
        return self.type_ja.get(tn, tn)


def _add_note(card, note, kind):
    if any(n.get("kind") == kind for n in card.get("notes", ())):
        return card
    card["where"] = (card.get("where") or "") + note
    card.setdefault("notes", []).append({"kind": kind, "text": note})
    return card


def apply_quickfix(src, rule_id, rules_json=None):
    """［半角に直す］など（SPEC 7.3）。rules_json を渡さなければ、いちばん新しく作った Explainer を使う。"""
    ex = Explainer(rules_json) if rules_json is not None else _LAST
    if ex is None:
        raise RuntimeError("Explainer がまだ無い（先に Explainer(rules_json) を作る）")
    return ex.apply_quickfix(src, rule_id)


# ======================================================================= 道具
_KANA_KANJI = re.compile(r"[぀-ヿ㐀-鿿]")


def _spaced(value, before, after):
    """日本語と英数字が直接つながるときは半角スペースを入れる（「まだ LiDAR が」）"""
    if value and before and _KANA_KANJI.match(before) and value[0].isascii() and value[0].isalnum():
        value = " " + value
    if value and after and _KANA_KANJI.match(after) and value[-1].isascii() and (value[-1].isalnum() or value[-1] == ")"):
        value = value + " "
    return value


def _fill_value(x):
    """説明の文に入れる値（直し係 6）: 計算した小数は小数第 2 位までに丸める（丸めて 0 になる小さな数は 1 けた残す）。
    文字の値（コードの引用）・整数・整数の形の小数（1.0）はそのまま"""
    if isinstance(x, float) and math.isfinite(x) and not x.is_integer():
        r = round(x, 2)
        if r == 0:
            return f"{x:.1g}"
        return repr(r)
    return str(x)


def _num_text(x):
    if isinstance(x, float) and x.is_integer():
        x = int(x)
    return f"{x:g}" if isinstance(x, float) else str(x)


def _char_name(ch):
    if len(ch) != 1:
        return ch
    try:
        return unicodedata.name(ch)
    except ValueError:
        return f"U+{ord(ch):04X}"


def _char_fix(m, ch, raw, ci):
    mp = m.get("map", {})
    if ch in mp:
        if ch == "　" and raw[:ci].strip(" \t　") == "":
            return "半角スペース 2 つ"
        return "半角スペース" if mp[ch] == " " else mp[ch]
    n = unicodedata.normalize("NFKC", ch)
    return n if len(n) == 1 and ord(n) < 128 else ch


def _human_seconds(s):
    s = float(s)
    if s < 60:
        return f"{_num_text(round(s, 1))} 秒"
    m, r = divmod(int(round(s)), 60)
    if m < 60:
        return f"{m} 分 {r} 秒" if r else f"{m} 分"
    h, m = divmod(m, 60)
    return f"{h} 時間 {m} 分"


def _const_num(node):
    """数のリテラル（-0.5 などもふくむ）なら値、ちがえば None"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _const_num(node.operand)
        if v is not None:
            return -v if isinstance(node.op, ast.USub) else v
    return None


def _call_name(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _full_call_name(call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
        return f"{f.value.id}.{f.attr}"
    return None


def _names_in(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _close(name, candidates, cutoff=0.7):
    low = {c.lower(): c for c in candidates}
    m = difflib.get_close_matches(name.lower(), list(low.keys()), n=1, cutoff=cutoff)
    if m:
        return low[m[0]]
    if len(name) >= 4:
        for c in candidates:
            if c.lower().startswith(name.lower()) and c != name:
                return c
    # latitude → lat、longitude → lon のように、短い名前で始まっているとき
    pre = [c for c in candidates if len(c) >= 3 and name.lower().startswith(c.lower()) and c != name]
    if pre:
        return max(pre, key=len)
    return None


def _frame_value(frame, name):
    if frame is None:
        return False, None
    for d in (frame.f_locals, frame.f_globals):
        if name in d:
            return True, d[name]
    b = frame.f_globals.get("__builtins__")
    if isinstance(b, dict) and name in b:
        return True, b[name]
    return False, None


def _failing_nodes(ctx):
    """エラーの起きた式（3.11 以降の位置情報）。無ければその行の式すべて"""
    idx = ctx["idx"]
    pos = ctx.get("pos")
    nodes = idx.nodes_on_line(ctx["line"])
    if pos is not None:
        exact = [n for n in nodes if getattr(n, "col_offset", None) == pos[2] and getattr(n, "end_col_offset", None) == pos[3]]
        if exact:
            return exact
    return nodes


# ======================================================================= check 関数
# 照合用: fn(explainer, ctx, got, **args) -> dict|True|None
# precheck 用: fn(explainer, idx, **args) -> [(line, col0, char, vars?)]
# lint 用: fn(explainer, idx, **args) -> [(line, col, vars)]
CHECKS = {}


def check(name):
    def deco(fn):
        CHECKS[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------- precheck
@check("choon_minus")
def _ck_choon(ex, idx):
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        for mo in re.finditer(r"[ーｰ‐－−–—](?=\s*[0-9０-９.．(（A-Za-z_])", ml):
            ci = mo.start()
            prev = ml[ci - 1] if ci > 0 else " "
            if mo.group(0) in "ーｰ" and (_is_jp(prev) and prev not in "（"):
                continue  # 「モーター」など日本語の名前の中の長音
            if mo.group(0) in "－−‐–—" :
                continue  # 全角の記号は FW_OPERATOR が見る
            out.append((li, ci, mo.group(0)))
    return out


@check("empty_code")
def _ck_empty_code(ex, idx):
    """空白とメモ（コメント）だけ（SPEC 5.5 の EMPTY_CODE）"""
    if any(ml.strip() for ml in idx.masked):
        return []
    return [(1, 0, "")]


@check("code_too_long")
def _ck_code_too_long(ex, idx):
    """2000 行・60 KB をこえた（SPEC 5.5 の CODE_TOO_LONG）"""
    lim = ex.limits
    max_lines, max_bytes = int(lim.get("max_lines", 2000)), int(lim.get("max_bytes", 61440))
    n = len(idx.lines)
    if n and idx.lines[-1] == "":
        n -= 1
    size = len(idx.src.encode("utf-8", "surrogatepass"))
    if n <= max_lines and size <= max_bytes:
        return []
    return [(1, 0, "", {"lines": n, "kb": _num_text(round(size / 1024, 1)), "max_lines": max_lines,
                        "max_kb": _num_text(round(max_bytes / 1024))})]


_BLANK = re.compile(r"(?<![A-Za-z0-9_])_{3,}(?![A-Za-z0-9_])")


@check("blank_not_filled")
def _ck_blank(ex, idx):
    """穴埋めの空欄 ___ が残っている（文字列とコメントの中は見ない。__x__ や my___name は名前なので見ない）"""
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        if "___" not in ml:
            continue
        for mo in _BLANK.finditer(ml):
            out.append((li, mo.start(), mo.group(0)))
    if out:
        n = len(out)
        phrase = f"このプログラムには、まだ空欄が {n} か所あるよ。" if n > 1 else ""
        li, ci, ch = out[0]
        out[0] = (li, ci, ch, {"count_phrase": phrase, "blanks": n})
    return out


_JP_RUN = re.compile(r"\(\s*([぀-ヿ㐀-鿿ー！？。、]*([！？。、])[぀-ヿ㐀-鿿ー！？。、]*)\s*[,)]")


@check("jp_text_unquoted")
def _ck_jp_text_unquoted(ex, idx):
    """かっこの中に、！？。、まじりの日本語がそのまま書いてある（" の囲み忘れ。日本語の変数名は記号を含まないので見ない）"""
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        if ml.isascii():
            continue
        for mo in _JP_RUN.finditer(ml):
            text = mo.group(1)
            if not any(_is_jp(c) for c in text):
                continue
            out.append((li, mo.start(1), mo.group(2), {"text": text, "mark": mo.group(2)}))
    return out


@check("jp_comment_no_hash")
def _ck_jp_comment(ex, idx):
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        s = ml.strip()
        if not s or not _is_jp(s[0]):
            continue
        if re.search(r"[=(\[:（＝]", s):
            continue
        ci = len(ml) - len(ml.lstrip())
        snippet = idx.lines[li - 1].strip()
        out.append((li, ci, s[0], {"snippet": snippet[:30]}))
    return out


_C_COMMENT_JP = re.compile(r"//\s*[^\x00-\x7f]")


@check("c_comment")
def _ck_c_comment(ex, idx):
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        if "/" not in ml:   # 〔速さ〕/ の無い行（ほとんど）は見ない
            continue
        s = ml.lstrip()
        ci = len(ml) - len(s)
        if s.startswith("//") or s.startswith("/*") or s.rstrip().endswith("*/"):
            out.append((li, ci, s[:2]))
            continue
        mo = _C_COMMENT_JP.search(ml)
        if mo:
            out.append((li, mo.start(), "//"))
    return out


# ---------------------------------------------------------------- compile
COMPOUND = r"(if|elif|else|for|while|def|class|try|except|finally|with)"


@check("colon_kw")
def _ck_colon_kw(ex, ctx, got):
    mo = re.match(r"\s*" + COMPOUND + r"\b", ctx["masked_line"])
    return {"kw": mo.group(1) if mo else "この", "kw_phrase": f"{mo.group(1)} の行" if mo else "この行"}


@check("indent_kind")
def _ck_indent_kind(ex, ctx, got):
    kind = got.get("kind", "")
    mo = re.match(r"'(\w+)' statement", kind)
    if mo:
        kw = mo.group(1)
    elif "function definition" in kind:
        kw = "def"
    elif "class definition" in kind:
        kw = "class"
    else:
        kw = kind
    return {"kw": kw}


@check("compare_arrow")
def _ck_compare_arrow(ex, ctx, got):
    table = {"=>": ">=", "=<": "<=", "<>": "!=", "===": "==", "!==": "!=", "=!": "!="}
    mo = re.search(r"!==|===|=>|=<|<>|=!(?!=)", ctx["masked_line"])
    if not mo:
        return None
    return {"op": mo.group(0), "fix_op": table[mo.group(0)]}


@check("unit_after_number")
def _ck_unit(ex, ctx, got):
    ml = ctx["masked_line"]
    mo = re.search(r"(?<![A-Za-z_0-9.])(\d+(?:\.\d+)?)\s?(ミリ秒|秒|メートル|センチ|度|ms|sec|cm|mm|km|deg|s|m|%|％)(?![A-Za-z_0-9])", ml)
    if not mo:
        return None
    num, unit = float(mo.group(1)), mo.group(2)
    factor = {"ミリ秒": 0.001, "ms": 0.001, "%": 0.01, "％": 0.01, "cm": 0.01, "センチ": 0.01, "mm": 0.001, "km": 1000}.get(unit, 1)
    fixed = round(num * factor, 6)
    return {"num": mo.group(1), "unit": unit, "fixed": _num_text(fixed)}


@check("keyword_as_name")
def _ck_kw_name(ex, ctx, got):
    mo = re.match(r"\s*([A-Za-z_]+)\s*=(?!=)", ctx["masked_line"])
    if mo and (keyword.iskeyword(mo.group(1))):
        return {"kw": mo.group(1)}
    mo = re.search(r"cannot assign to (True|False|None)", ctx["msg"])
    if mo:
        return {"kw": mo.group(1)}
    return None


@check("quote_inside")
def _ck_quote_inside(ex, ctx, got):
    if "Is this intended to be part of the string" in ctx["msg"]:
        return True
    return bool(re.search(r"(\"|')[^\"']*\1[A-Za-z0-9_぀-ヿ一-鿿]+\1", ctx["raw_line"]))


@check("c_braces")
def _ck_c_braces(ex, ctx, got):
    ml = ctx["masked_line"]
    if re.match(r"\s*" + COMPOUND + r"\b.*\{\s*$", ml) or re.match(r"\s*\}\s*$", ml):
        return True
    if re.match(r"\s*(void|int|float|function|func)\b.*\)\s*\{\s*$", ml):
        return True
    return None


@check("c_declaration")
def _ck_c_decl(ex, ctx, got):
    ml = ctx["masked_line"]
    mo = re.match(r"\s*(unsigned|int|float|double|char|bool|long|short|void|var|let|const|auto|string|String|function|func|fn)\s+[A-Za-z_]", ml)
    if mo:
        return {"word": mo.group(1)}
    mo = re.search(r"\((int|float|double|long)\)\s*[A-Za-z_0-9(]", ml)
    if mo:
        return {"word": f"({mo.group(1)})"}
    return None


@check("assign_target")
def _ck_assign_target(ex, ctx, got):
    t = got.get("target", "")
    if t in ("True", "False", "None"):
        return None
    table = {"function call": "関数の呼び出し", "literal": "数や文字", "expression": "計算の式",
             "comparison": "比べる式", "attribute": "名前.名前", "subscript": "名前[番号]", "conditional expression": "if の式"}
    return {"target_ja": table.get(t, t)}


@check("incomplete_line")
def _ck_incomplete(ex, ctx, got):
    ml = ctx["masked_line"].rstrip()
    mo = re.search(r"(==|!=|<=|>=|\*\*|//|[=+\-*/%<>,]|\band|\bor|\bnot)$", ml)
    if not mo:
        return None
    return {"tail": mo.group(1)}


@check("colon_extra")
def _ck_colon_extra(ex, ctx, got):
    ml = ctx["masked_line"].rstrip()
    if not ml.endswith(":"):
        return None
    if re.match(r"\s*(if|elif|else|for|while|def|class|try|except|finally|with|lambda|match|case)\b", ml):
        return None
    return True


@check("invalid_number")
def _ck_invalid_number(ex, ctx, got):
    if re.search(r"invalid (decimal|hexadecimal|octal|binary|digit)", ctx["msg"]):
        return True
    return bool(re.search(r"\d*\.\d+\.\d", ctx["masked_line"]))


@check("str_numeric")
def _ck_str_numeric(ex, ctx, got):
    """計算に使った文字が、数の形（"0.5" など）をしているか"""
    num = re.compile(r"^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$")
    fr, idx = ctx.get("frame"), ctx["idx"]
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and num.match(n.value):
            return {"value": n.value.strip()}
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            ok, val = _frame_value(fr, n.id)
            if ok and isinstance(val, str) and num.match(val):
                return {"value": val.strip()}
    return None


@check("call_on_number")
def _ck_call_on_number(ex, ctx, got):
    for c in ctx["idx"].calls_on_line(ctx["line"]):
        v = _const_num(c.func)
        if v is not None:
            inner = ", ".join(ctx["idx"].segment(a) for a in c.args)
            return {"num": _num_text(v), "inner": inner}
    return None


@check("is_literal")
def _ck_is_literal(ex, ctx, got):
    return True


# ---------------------------------------------------------------- 名前（NameError）
@check("name_info")
def _ck_name_info(ex, ctx, got):
    """NameError の名前を取り出す（すべての NameError 系ルールの最初に使う）"""
    exc = ctx.get("exc")
    name = getattr(exc, "name", None) or got.get("name")
    if not name:
        mo = re.search(r"name '([^']+)' is not defined", ctx["msg"])
        name = mo.group(1) if mo else None
    return {"name": name} if name else None


def _name(ctx, got):
    r = _ck_name_info(None, ctx, got)
    return r["name"] if r else None


@check("name_other_language")
def _ck_name_other(ex, ctx, got):
    name = _name(ctx, got)
    table = ex.data.get("other_language_names", {})
    if name in table:
        e = table[name]
        return {"name": name, "py": e["py"], "note": e["note"], "fix_text": e["fix"]}
    return None


def _candidates(ex, idx):
    c = set(ex.api_names()) | set(ex.data.get("builtins_watch", [])) | {"True", "False", "None"}
    c |= set(idx.module_binds) | set(idx.local_binds) | set(idx.funcdefs)
    for mod in idx.imports:
        c.add(mod)
    return c


@check("name_case")
def _ck_name_case(ex, ctx, got):
    name = _name(ctx, got)
    if not name:
        return None
    for c in _candidates(ex, ctx["idx"]):
        if c != name and c.lower() == name.lower():
            return {"name": name, "suggest": c}
    return None


@check("name_typo")
def _ck_name_typo(ex, ctx, got):
    name = _name(ctx, got)
    if not name or not name.isascii() or len(name) < 2:
        return None
    s = _close(name, [c for c in _candidates(ex, ctx["idx"]) if c != name], cutoff=0.7)
    if s:
        return {"name": name, "suggest": s}
    return None


@check("name_japanese")
def _ck_name_jp(ex, ctx, got):
    name = _name(ctx, got)
    if name and not name.isascii():
        return {"name": name}
    return None


@check("name_in_print_unquoted")
def _ck_name_unquoted(ex, ctx, got):
    name = _name(ctx, got)
    idx = ctx["idx"]
    if not name or idx.is_bound_anywhere(name) or name in ex.funcs:
        return None
    for c in idx.calls_on_line(ctx["line"]):
        if _call_name(c) == "print":
            for a in c.args:
                if isinstance(a, ast.Name) and a.id == name:
                    return {"name": name}
    return None


@check("name_called_before_def")
def _ck_name_before_def(ex, ctx, got):
    name = _name(ctx, got)
    idx = ctx["idx"]
    f = idx.funcdefs.get(name)
    if f is not None and f.lineno > ctx["line"]:
        return {"name": name, "def_line": f.lineno}
    return None


@check("name_used_before_assign")
def _ck_name_before_assign(ex, ctx, got):
    name = _name(ctx, got)
    binds = ctx["idx"].module_binds.get(name or "", [])
    later = [ln for ln, blk in binds if ln > ctx["line"]]
    if later and not [ln for ln, blk in binds if ln <= ctx["line"]]:
        return {"name": name, "assign_line": min(later)}
    return None


@check("name_assigned_in_branch")
def _ck_name_in_branch(ex, ctx, got):
    name = _name(ctx, got)
    binds = ctx["idx"].module_binds.get(name or "", [])
    earlier = [(ln, blk) for ln, blk in binds if ln <= ctx["line"] and blk]
    if earlier:
        ln, blk = earlier[0]
        return {"name": name, "assign_line": ln, "block": blk}
    return None


@check("name_local_only")
def _ck_name_local(ex, ctx, got):
    name = _name(ctx, got)
    idx = ctx["idx"]
    if name in idx.local_binds and name not in idx.module_binds:
        fn = idx.local_binds[name][0]
        return {"name": name, "func": fn}
    return None


@check("name_in_set")
def _ck_name_in_set(ex, ctx, got, names=(), key="name"):
    name = _name(ctx, got)
    if name in names:
        return {"name": name, "has_import": "math" in ctx["idx"].imports}
    return None


@check("unbound_local")
def _ck_unbound(ex, ctx, got):
    name = got.get("name") or getattr(ctx.get("exc"), "name", None)
    fr = ctx.get("frame")
    return {"name": name, "func": fr.f_code.co_name if fr is not None else "関数"}


# ---------------------------------------------------------------- 呼び出し（引数）
def _params_ja(ex, s):
    pj = ex.api.get("param_ja", {})
    names = re.findall(r"'([^']+)'", s)
    return "と".join(f"{pj.get(n, n)}（{n}）" if n in pj else n for n in names) if names else s


def _sig_example(ex, idx, func):
    f = ex.funcs.get(func)
    if f:
        return f.get("sig", f"{func}()"), f.get("example", f"{func}()"), True
    fd = idx.funcdefs.get(func)
    if fd is not None:
        args = [a.arg for a in fd.args.args]
        sig = f"{func}({', '.join(args)})"
        return sig, sig, False
    return f"{func}(...)", f"{func}(...)", False


@check("args_info")
def _ck_args_info(ex, ctx, got):
    func = got.get("func")
    if not func:
        return None
    sig, example, is_api = _sig_example(ex, ctx["idx"], func)
    out = {"sig": sig, "example": example, "kind": "命令" if is_api else "関数"}
    if "params" in got:
        out["params_ja"] = _params_ja(ex, got["params"])
    if "takes" in got:
        t = int(got["takes"])
        out["need_phrase"] = "何も入れない" if t == 0 else f"値を {t} つ入れる"
    return out


@check("motor_three_args")
def _ck_motor3(ex, ctx, got):
    for c in ctx["idx"].calls_on_line(ctx["line"]):
        if _call_name(c) == "motor" and len(c.args) == 3:
            seg = [ctx["idx"].segment(a) for a in c.args]
            return {"a1": seg[0], "a2": seg[1], "a3": seg[2]}
    return None


@check("decimal_comma")
def _ck_decimal_comma(ex, ctx, got):
    if int(got.get("given", 0)) != 2 * int(got.get("takes", -1)):
        return None
    mo = re.search(r"(?<![0-9.])0\s*,\s*(\d+)", ctx["masked_line"])
    if mo:
        return {"bad": mo.group(0).replace(" ", ""), "good": "0." + mo.group(1)}
    return None


@check("shadowed_call")
def _ck_shadowed(ex, ctx, got):
    idx = ctx["idx"]
    watch = set(ex.api_names()) | set(ex.data.get("builtins_watch", []))
    for c in idx.calls_on_line(ctx["line"]):
        if isinstance(c.func, ast.Name) and c.func.id in watch and c.func.id in idx.module_binds:
            ln = min(l for l, _ in idx.module_binds[c.func.id])
            return {"name": c.func.id, "assign_line": ln, "type_ja": ex.tname(got.get("type", ""))}
    return None


@check("module_called")
def _ck_module_called(ex, ctx, got):
    for c in ctx["idx"].calls_on_line(ctx["line"]):
        if isinstance(c.func, ast.Name):
            ok, val = _frame_value(ctx.get("frame"), c.func.id)
            if ok and type(val).__name__ == "module":
                return {"name": c.func.id}
    mo = re.search(r"Did you mean: '(\w+)\.", ctx["msg"])
    return {"name": mo.group(1)} if mo else {"name": "モジュール"}


@check("type_name")
def _ck_type_name(ex, ctx, got):
    out = {}
    for k in ("type", "type2", "left", "right"):
        if k in got:
            out[k + "_ja"] = ex.tname(got[k])
    return out or True


@check("func_as_value")
def _ck_func_as_value(ex, ctx, got):
    fr = ctx.get("frame")
    idx = ctx["idx"]
    called = {id(c.func) for c in idx.calls_on_line(ctx["line"])}
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and id(n) not in called:
            ok, val = _frame_value(fr, n.id)
            if (ok and callable(val) and not isinstance(val, type)) or (not ok and (n.id in ex.funcs or n.id in idx.funcdefs)):
                return {"name": n.id}
    return None


@check("not_subscriptable_func")
def _ck_ns_func(ex, ctx, got):
    for n in ctx["idx"].nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name):
            ok, val = _frame_value(ctx.get("frame"), n.value.id)
            if (ok and callable(val)) or n.value.id in ex.funcs:
                return {"name": n.value.id}
    return None


@check("not_iterable")
def _ck_not_iter(ex, ctx, got):
    for n in ctx["idx"].nodes_on_line(ctx["line"]):
        if isinstance(n, ast.For):
            return {"n": ctx["idx"].segment(n.iter)}
    return {"n": "回数"}


# ---------------------------------------------------------------- None
SENSOR_ATTRS = {"lat": "gnss", "lon": "gnss", "course": "gnss", "speed": "gnss", "angle": "camera", "size": "camera",
                "dist": "marker", "id": "marker"}


def _assign_source_call(idx, name, before_line):
    """name に最後に入れた式（before_line 以前）にある呼び出し名"""
    best = None
    if idx.tree is None:
        return None
    for n in idx.all_nodes:
        if isinstance(n, ast.Assign) and n.lineno <= before_line:
            if any(isinstance(t, ast.Name) and t.id == name for t in n.targets):
                if best is None or n.lineno >= best.lineno:
                    best = n
    if best is None:
        return None
    calls = [_call_name(c) for c in ast.walk(best.value) if isinstance(c, ast.Call)]
    return calls[0] if calls else None


def _none_sources(ex, ctx):
    """None になった原因の候補: [("func", 名前) / ("sensor", "lidar") / ("name", 変数名)]"""
    idx, fr = ctx["idx"], ctx.get("frame")
    out = []
    nodes = _failing_nodes(ctx)
    line_nodes = idx.nodes_on_line(ctx["line"])
    for n in nodes + line_nodes:
        if isinstance(n, ast.Call):
            cn = _call_name(n)
            if cn in idx.funcdefs and not idx.func_returns_value(idx.funcdefs[cn]):
                out.append(("func", cn))
            if cn in ex.api.get("may_return_none", {}):
                out.append(("sensor", cn))
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            ok, val = _frame_value(fr, n.id)
            if ok and val is None:
                out.append(("name", n.id))
                src = _assign_source_call(idx, n.id, ctx["line"])
                if src in idx.funcdefs and not idx.func_returns_value(idx.funcdefs[src]):
                    out.append(("func", src))
                if src in ex.api.get("may_return_none", {}):
                    out.append(("sensor", src))
                if src in ("append", "sort", "reverse", "extend", "insert", "remove", "clear"):
                    out.append(("listmethod", (n.id, src)))
        if isinstance(n, ast.Attribute) and n.attr in SENSOR_ATTRS:
            base = n.value
            if isinstance(base, ast.Name):
                ok, val = _frame_value(fr, base.id)
                try:
                    attr_val = val[n.attr] if isinstance(val, dict) else getattr(val, n.attr, 0)
                except Exception:
                    attr_val = 0
                if ok and attr_val is None:
                    out.append(("name", f"{base.id}.{n.attr}"))
                    # g = gnss() / m = marker() のように、どの命令の答えかを代入の行から見る（angle はカメラとマーカーの両方にある）
                    src = _assign_source_call(idx, base.id, ctx["line"])
                    if src in ex.api.get("may_return_none", {}):
                        out.append(("sensor", src))
                    else:
                        out.append(("sensor", SENSOR_ATTRS[n.attr]))
            elif isinstance(base, ast.Call) and _call_name(base) in ex.api.get("may_return_none", {}):
                out.append(("sensor", _call_name(base)))
        if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant) and n.slice.value in SENSOR_ATTRS:
            out.append(("sensor", SENSOR_ATTRS[n.slice.value]))
    return out


@check("none_source")
def _ck_none_source(ex, ctx, got, kind=None, sensor=None):
    srcs = _none_sources(ex, ctx)
    for k, val in srcs:
        if k == kind == "func":
            return {"func": val, "def_line": ctx["idx"].funcdefs[val].lineno}
        if k == kind == "sensor" and val == sensor:
            return {"sensor": val}
        if k == kind == "listmethod":
            return {"name": val[0], "method": val[1]}
    if kind == "any":
        names = [v for k, v in srcs if k == "name"]
        if names:
            return {"what": f"「{names[0]}」の中身", "hint_name": names[0]}
        return {"what": "使った値", "hint_name": "値"}
    return None


# ---------------------------------------------------------------- 属性・添字
@check("attr_info")
def _ck_attr_info(ex, ctx, got, need_suggest=False, dict_only=False):
    exc = ctx.get("exc")
    name = getattr(exc, "name", None) or got.get("name")
    obj = getattr(exc, "obj", None) if exc is not None else None
    have_obj = obj is not None
    idx, fr = ctx["idx"], ctx.get("frame")
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Attribute) and (name is None or n.attr == name):
            name = n.attr
            if not have_obj and isinstance(n.value, ast.Name):
                ok, val = _frame_value(fr, n.value.id)
                if ok:
                    obj, have_obj = val, True
            break
    if name is None:
        return None
    tn = type(obj).__name__ if have_obj else got.get("type", "")
    if dict_only and not (isinstance(obj, dict) and type(obj).__name__ == "dict"):
        return None
    if isinstance(obj, dict):
        attrs = [str(k) for k in obj.keys()]
    elif have_obj:
        attrs = [a for a in dir(obj) if not a.startswith("_")]
    else:
        attrs = []
    if tn == "module" and have_obj:
        label = getattr(obj, "__name__", "モジュール")
    else:
        label = ex.tname(tn)
    out = {"name": name, "type_ja": label, "attrs": "、".join(attrs[:8]) if attrs else "（なし）"}
    s = _close(name, attrs, cutoff=0.6) if attrs else None
    if need_suggest and not s:
        return None
    if s:
        out["suggest"] = s
    return out


@check("index_info")
def _ck_index_info(ex, ctx, got, empty=None):
    fr, idx = ctx.get("frame"), ctx["idx"]
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name):
            ok, seq = _frame_value(fr, n.value.id)
            if ok and hasattr(seq, "__len__"):
                ln = len(seq)
                if empty is True and ln != 0:
                    return None
                if empty is False and ln == 0:
                    return None
                out = {"seq": n.value.id, "length": ln, "last": max(ln - 1, 0), "index": idx.segment(n.slice)}
                return out
    if empty is True:
        return None
    return {"seq": "リスト", "length": "？", "last": "？", "index": "その番号"}


@check("key_info")
def _ck_key_info(ex, ctx, got):
    fr, idx = ctx.get("frame"), ctx["idx"]
    key = ctx["exc"].args[0] if ctx.get("exc") is not None and ctx["exc"].args else "?"
    out = {"key": key, "keys": "（分からない）"}
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name):
            ok, d = _frame_value(fr, n.value.id)
            if ok and isinstance(d, dict):
                ks = [str(k) for k in d.keys()]
                out["keys"] = "、".join(ks[:10])
                s = _close(str(key), ks, cutoff=0.5)
                if s:
                    out["suggest_phrase"] = f"。「{s}」のことかな？"
                break
    out.setdefault("suggest_phrase", "")
    return out


@check("zero_div")
def _ck_zero_div(ex, ctx, got):
    idx = ctx["idx"]
    for n in _failing_nodes(ctx) + idx.nodes_on_line(ctx["line"]):
        if isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)):
            op = {ast.Div: "/", ast.FloorDiv: "//", ast.Mod: "%"}[type(n.op)]
            seg = idx.segment(n.right)
            return {"denom": seg, "op_denom": f"{op} ({seg})" if isinstance(n.right, ast.BinOp) else f"{op} {seg}"}
        if isinstance(n, ast.AugAssign) and isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)):
            return {"denom": idx.segment(n.value), "op_denom": f"/= {idx.segment(n.value)}"}
    return {"denom": "割る数", "op_denom": "/ 割る数"}


@check("math_fn")
def _ck_math_fn(ex, ctx, got):
    for c in ctx["idx"].calls_on_line(ctx["line"]):
        fn = _full_call_name(c) or ""
        if fn.split(".")[-1] in ("sqrt", "acos", "asin", "log", "log10", "log2", "atanh", "acosh"):
            return {"fn": fn.split(".")[-1]}
    return {"fn": "sqrt"}


@check("unpack_info")
def _ck_unpack(ex, ctx, got):
    exp = got.get("expected", "?")
    gt = got.get("got")
    return {"expected": exp, "got_phrase": f"{gt} つ" if gt else (f"{exp} つより多く" if "too many" in ctx["msg"] else "足りない数")}


@check("parse_reason")
def _ck_parse_reason(ex, ctx, got, reason=None):
    t = got.get("text", "")
    r = None
    if re.fullmatch(r"\s*-?\d+,\d+\s*", t):
        r = "comma"
    elif re.fullmatch(r"\s*-?\d*\.\d+\s*", t) and "int()" in ctx["msg"]:
        r = "float_to_int"
    elif any(not c.isascii() for c in t):
        r = "zenkaku"
    else:
        r = "other"
    if reason and r != reason:
        return None
    return {"text": t, "fixed": t.replace(",", ".").strip() if r == "comma" else unicodedata.normalize("NFKC", t)}


# ---------------------------------------------------------------- API（rover_runtime の例外）
@check("api_arg")
def _ck_api_arg(ex, ctx, got, want=None):
    info = dict(ctx.get("api_info") or {})
    func = info.get("func") or got.get("func")
    param_ja = info.get("param_ja") or got.get("param_ja")
    if not func:
        mo = re.match(r"(\w+)\(?\)?\s*の", ctx["msg"])
        func = mo.group(1) if mo else None
    if not func:
        for c in ctx["idx"].calls_on_line(ctx["line"]):
            if _call_name(c) in ex.funcs:
                func = _call_name(c)
                break
    value = info.get("value")
    pos = {"左": 0, "右": 1}.get(param_ja or "", None)
    for c in ctx["idx"].calls_on_line(ctx["line"]):
        if _call_name(c) == func:
            args = c.args
            cand = [args[pos]] if pos is not None and pos < len(args) else args
            for a in cand:
                if want == "str" and isinstance(a, ast.Constant) and isinstance(a.value, str):
                    value = a.value
                    break
                if want is None and value is None:
                    value = ctx["idx"].segment(a)
            break
    out = {"func": func or "命令", "param_ja": param_ja or "かっこの中", "value": value if value is not None else "?"}
    mo = re.search(r"（今は ([^）]+)）", ctx["msg"]) or re.search(r"not (\w+)$", ctx["msg"])
    if mo:
        out["type_ja"] = ex.tname(mo.group(1))
    return out


def _api_func_of(ex, ctx, names=None):
    """API の例外がどの命令から来たか（rover_info.func → 英文の xxx() → その行の呼び出し）"""
    info = ctx.get("api_info") or {}
    func = info.get("func")
    if not func:
        mo = re.search(r"([a-z_]+)\(\)", ctx["msg"])
        func = mo.group(1) if mo and mo.group(1) in ex.funcs else None
    if not func:
        for c in ctx["idx"].calls_on_line(ctx["line"]):
            if _call_name(c) in (names if names is not None else ex.funcs):
                func = _call_name(c)
                break
    return func


@check("equip_info")
def _ck_equip(ex, ctx, got, need_device=None):
    """need_device: True なら部品のある命令だけ（API_NOT_EQUIPPED）、False なら部品の無い命令だけ（now・phase。API_NOT_LEARNED）"""
    devices = ex.api.get("devices", {})
    func = _api_func_of(ex, ctx)
    if need_device is True and func is not None and func not in devices:
        return None
    if need_device is False and (func is None or func in devices):
        return None
    dev = devices.get(func or "", "その部品")
    ch = ex.funcs.get(func or "", {}).get("chapter", "？")
    return {"func": func or "その命令", "device": dev, "chapter": ch}


@check("turned_off_info")
def _ck_turned_off(ex, ctx, got):
    """返した命令（api_off。distance_to_cone は 4-1 から）"""
    table = ex.api.get("turned_off", {})
    func = _api_func_of(ex, ctx, names=table)
    t = table.get(func or "")
    if not t:
        if not table:
            return None
        func, t = next(iter(table.items()))
    return {"func": func, "thing": t.get("thing", func), "instead": t.get("instead", ""),
            "why_text": t.get("why", ""), "fix_text": t.get("fix", t.get("how", ""))}


@check("sensor_broken")
def _ck_sensor_broken(ex, ctx, got):
    """OSError が、部品を読む命令（camera など）から来たか。生徒が自分で raise した OSError は見ない"""
    devices = ex.api.get("devices", {})
    func = (ctx.get("api_info") or {}).get("func")
    if func not in devices:
        func = None
        for c in ctx["idx"].calls_on_line(ctx["line"]):
            if _call_name(c) in devices:
                func = _call_name(c)
                break
    if func is None:
        return None
    name = devices[func]
    if func == "marker":
        name = "カメラ"
    return {"func": func, "sensor_ja": name}


# ---------------------------------------------------------------- guard
def _loop_updates(idx, body_nodes):
    """くり返しの本体の中で値が変わる名前（代入・for の変数・global を書きかえる関数の呼び出し）"""
    upd = set()
    for n in body_nodes:
        if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                upd |= set(idx._targets(t))
                if isinstance(t, (ast.Attribute, ast.Subscript)):
                    upd |= _names_in(t)
        elif isinstance(n, (ast.For,)):
            upd |= set(idx._targets(n.target))
        elif isinstance(n, ast.NamedExpr):
            upd.add(n.target.id)
        elif isinstance(n, ast.Call):
            cn = _call_name(n)
            if cn in idx.funcdefs:
                upd |= idx.globals_of.get(idx.funcdefs[cn], set())
            if isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name):
                upd.add(n.func.value.id)  # pts.append(...) など
    return upd


def _has_break(idx, loop):
    return idx.has_break(loop)


def _adv_names(ex):
    a = getattr(ex, "_adv", None)
    if a is None:
        a = ex._adv = set(ex.api.get("advances_time", []))
    return a


def _calls_advance_time(ex, idx, node, seen=None):
    """node（くり返し・関数・式）の中で、sim の時間が進む命令を呼ぶか（自分の関数の中もたどる。関数ごとに覚える）"""
    adv = _adv_names(ex)
    memo = idx.__dict__.setdefault("_adv_memo", {})
    if node in memo:
        return memo[node]
    top = not seen
    seen = set(seen or ())
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        seen.add(node.name)
    calls = idx.calls_under(node) if node in idx.order else [c for c in ast.walk(node) if isinstance(c, ast.Call)]
    result = False
    for n in calls:
        cn = _call_name(n)
        if cn in adv or (_full_call_name(n) or "") in adv:
            result = True
            break
        if cn in idx.funcdefs and cn not in seen:
            seen.add(cn)
            if _calls_advance_time(ex, idx, idx.funcdefs[cn], seen):
                result = True
                break
    if node in idx.order and (result or top):
        memo[node] = result
    return result


def _stuck_names(ex, idx, loop):
    if not isinstance(loop, ast.While):
        return None
    test = loop.test
    if isinstance(test, ast.Constant):
        return None
    if any(isinstance(n, ast.Call) for n in ast.walk(test)):
        return None
    names = sorted(n for n in _names_in(test) if n not in ("True", "False", "None"))
    if not names or _has_break(idx, loop):
        return None
    body = [n for st in loop.body for n in ast.walk(st)]
    upd = _loop_updates(idx, body)
    if any(n in upd for n in names):
        return None
    return names


def _reread_example(idx, name, before_line):
    """name を最後に作った行（ループより前）を「読み直しの例」にする"""
    best = None
    for n in idx.of(ast.Assign):
        if n.lineno < before_line and any(isinstance(t, ast.Name) and t.id == name for t in n.targets):
            if best is None or n.lineno > best.lineno:
                best = n
    if best is not None and any(isinstance(c, ast.Call) for c in ast.walk(best.value)):
        return f"{name} = {idx.segment(best.value)}"
    return f"{name} = 新しい値"


@check("loop_stuck")
def _ck_loop_stuck(ex, ctx, got):
    idx = ctx["idx"]
    loop = idx.enclosing_loop(ctx["vars"].get("hot_line", ctx["line"]))
    if loop is None:
        return None
    names = _stuck_names(ex, idx, loop)
    if not names:
        return None
    return {"names": "、".join(names), "first_name": names[0], "reread": _reread_example(idx, names[0], loop.lineno)}


@check("loop_no_time")
def _ck_loop_no_time(ex, ctx, got):
    idx = ctx["idx"]
    loop = idx.enclosing_loop(ctx["vars"].get("hot_line", ctx["line"]))
    if loop is None:
        return None
    if _calls_advance_time(ex, idx, loop):   # 本体と条件のどちらかで時間が進めばよい
        return None
    return True


_BIG_CALLS = ("sum", "list", "sorted", "max", "min", "set", "tuple", "len", "any", "all")


def _const_value(node, cap=10 ** 18):
    """数の式（10 ** 11・2 * 10 ** 9 など）の値。大きすぎる累乗は計算せずに cap を返す。分からなければ None"""
    v = _const_num(node)
    if v is not None:
        return v
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Pow, ast.Mult, ast.Add, ast.Sub)):
        a, b = _const_value(node.left, cap), _const_value(node.right, cap)
        if a is None or b is None:
            return None
        try:
            if isinstance(node.op, ast.Pow):
                if abs(a) > 1 and b > 64:
                    return cap
                return min(cap, a ** b) if b >= 0 else a ** b
            return min(cap, {ast.Mult: a * b, ast.Add: a + b, ast.Sub: a - b}[type(node.op)])
        except Exception:
            return None
    return None


def _big_work(idx, big=10 ** 7):
    """番犬まで行く「とても大きな計算」を探す: range(10 ** 11)・sum(range(…))・巨大な累乗"""
    found = []
    for n in idx.all_nodes:
        if isinstance(n, ast.Call) and _call_name(n) == "range" and n.args:
            vals = [_const_value(a) for a in n.args]
            stop = vals[1] if len(vals) >= 2 else vals[0]
            if stop is not None and abs(stop) >= big:
                outer = n
                p = idx.parents.get(n)
                if isinstance(p, ast.Call) and _call_name(p) in _BIG_CALLS:
                    outer = p
                found.append((n.lineno, idx.segment(outer), "range"))
        elif isinstance(n, ast.BinOp) and isinstance(n.op, ast.Pow):
            b = _const_value(n.right)
            a = _const_value(n.left)
            if a is not None and b is not None and abs(a) > 1 and b >= 10 ** 5:
                found.append((n.lineno, idx.segment(n), "pow"))
        elif isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mult):
            # [0] * 10 ** 9 のような大きなリスト
            if isinstance(n.left, ast.List):
                v = _const_value(n.right)
                if v is not None and v >= big * 10:
                    found.append((n.lineno, idx.segment(n), "list"))
    found.sort(key=lambda f: f[0])
    return found


@check("watchdog_where")
def _ck_watchdog(ex, ctx, got):
    """WATCHDOG の where を埋める（SPEC 7.5 の 3 段目）。見つからなくてもカードは出す"""
    idx = ctx["idx"]
    if idx.tree is not None:
        work = _big_work(idx)
        if work:
            ln, seg, kind = work[0]
            seg = seg if len(seg) <= 40 else seg[:38] + "…"
            reason = {"range": f"「{seg}」のくり返しの回数が多すぎて、ぼくは終われなかったよ。",
                      "pow": f"「{seg}」の答えがとても大きな数になって、計算が終わらなかったよ。",
                      "list": f"「{seg}」で、とても大きなリストを作ろうとしたよ。"}[kind]
            ctx["vars"]["line"] = ln
            ctx["vars"]["code"] = idx.code_of(ln)
            return {"where_text": f"{ln} 行目「{seg}」", "reason_text": reason, "line": ln,
                    "fix_text": "くり返しや数を小さくしよう（range の数を 10 万くらいまでに）。本物のローバーのコンピュータも、とても大きな計算は苦手なんだ。"}
        for n in idx.of(ast.While, ast.For):
            if not _calls_advance_time(ex, idx, n):
                if isinstance(n, ast.While) and _has_break(idx, n) and not (isinstance(n.test, ast.Constant) and n.test.value):
                    continue
                ctx["vars"]["line"] = n.lineno
                return {"where_text": f"{n.lineno} 行目のくり返し「{idx.code_of(n.lineno)}」", "line": n.lineno,
                        "reason_text": "このくり返しの中では時間が進まず、終わる条件も変わらなかったみたい。",
                        "fix_text": "くり返しの中に wait(0.05) を入れるか、終わる条件（break）を見直そう。"}
    return {"where_text": "プログラム全体", "reason_text": "どこで時間がかかったのかは、ぼくにも分からなかった。",
            "fix_text": "とても大きな range や、終わらないくり返しがないか見直そう。"}


@check("hot_hint")
def _ck_hot_hint(ex, ctx, got):
    v = ctx["vars"]
    if v.get("loop_line"):
        return {"hot_hint": f"（{v['loop_line']} 行目のくり返しが続いていたよ）"}
    return {"hot_hint": ""}


# ======================================================================= lint（実行前の注意）
def _walk_calls(idx, names):
    # 〔速さ〕呼び出しの名前は 1 回だけ作って索引に置く（lint の多くがここを通る）
    cn = idx.__dict__.get("_call_names")
    if cn is None:
        cn = idx._call_names = [(n, _full_call_name(n), _call_name(n)) for n in idx.of(ast.Call)]
    for n, full, short in cn:
        if full in names or short in names:
            yield n


@check("lint_wait_ms")
def _lk_wait_ms(ex, idx, threshold=100):
    out = []
    for c in _walk_calls(idx, {"wait", "time.sleep", "sleep"}):
        if c.args:
            v = _const_num(c.args[0])
            if v is not None and v >= threshold:
                out.append((c.lineno, c.col_offset + 1, {"sec": _num_text(v), "human": _human_seconds(v),
                                                          "ms_fix": _num_text(v / 1000)}))
    return out


def _module_consts(idx):
    """モジュールの一番上で 1 回だけ数を入れた名前（SPEED = 1.5）→ 値"""
    cache = idx.__dict__.get("_consts")
    if cache is None:
        cache = {}
        # 〔速さ〕行の表（by_line）を作らずに、Assign の表から引く（結果は前と同じ）
        mb = idx.module_binds
        for st in idx.of(ast.Assign):
            if len(st.targets) != 1 or not isinstance(st.targets[0], ast.Name):
                continue
            name = st.targets[0].id
            binds = mb.get(name)
            if binds and len(binds) == 1 and binds[0][1] is None and binds[0][0] == st.lineno and name not in cache:
                v = _const_num(st.value)
                if v is not None:
                    cache[name] = v
        idx._consts = cache
    return cache


@check("lint_motor_percent")
def _lk_motor_pct(ex, idx, fix_percent="{val} % のつもりなら {fixed} と書こう。", fix_over="全速なら 1 と書こう。"):
    out = []
    consts = _module_consts(idx)
    for c in _walk_calls(idx, {"motor"}):
        for a in c.args:
            v = _const_num(a)
            if v is None and isinstance(a, ast.Name) and idx.func_of.get(a) is None:
                v = consts.get(a.id)
            if v is not None and abs(v) > 1:
                fixed = v / 100 if abs(v) <= 100 else (1 if v > 0 else -1)
                tmpl = fix_percent if abs(v) >= 10 else fix_over
                vars_ = {"val": _num_text(v), "fixed": _num_text(fixed)}
                vars_["fix_text"] = tmpl.replace("{val}", vars_["val"]).replace("{fixed}", vars_["fixed"])
                out.append((c.lineno, a.col_offset + 1, vars_))
                break
    return out


@check("lint_api_shadow")
def _lk_api_shadow(ex, idx):
    out = []
    watch_api = set(ex.api_names())
    watch_bi = set(ex.data.get("builtins_watch", []))
    for name, binds in idx.module_binds.items():
        if name in watch_api or name in watch_bi:
            ln = min(b[0] for b in binds)
            kind = "ゲームの命令" if name in watch_api else "Python の関数"
            out.append((ln, 1, {"name": name, "kind": kind, "assign_line": ln}))
    for name, funcs in idx.local_binds.items():
        if (name in watch_api or name in watch_bi) and name not in idx.module_binds:
            fd = idx.funcdefs.get(funcs[0])
            out.append((fd.lineno if fd else 1, 1, {"name": name, "kind": "ゲームの命令" if name in watch_api else "Python の関数",
                                                   "assign_line": fd.lineno if fd else 1}))
    return sorted(out, key=lambda o: (o[0], o[1], o[2]["name"]))


def _uncalled(idx):
    return [(name, fd) for name, fd in idx.funcdefs.items() if name not in idx.loads]


@check("lint_func_never_called")
def _lk_never_called(ex, idx):
    """def だけ書いて、何も呼んでいない時（関数の外で 1 つも命令を呼んでいない）。
    外で何かを呼んでいるなら、使わない道具の関数（道具箱・スターターの関数）があっても言わない（出すぎを防ぐ。2026-10-17 に 53 面で合わせた）"""
    if any(idx.func_of.get(c) is None for c in idx.of(ast.Call)):
        return []
    # 最後の文の後ろにメモ（# 1. … # 2. …）だけが続く＝書いている途中の骨組み（7-2・8-5 のスターター）
    body = idx.tree.body
    end = max((st.end_lineno or st.lineno) for st in body) if body else 0
    if any(c is not None for c in idx.ccols[end:]):
        return []
    return [(fd.lineno, fd.col_offset + 1, {"func": name}) for name, fd in _uncalled(idx)]


@check("lint_call_without_parens")
def _lk_no_parens(ex, idx):
    out = []
    sensors = {k for k, f in ex.funcs.items() if f.get("returns")}
    for n in idx.of(ast.Expr, ast.Assign, ast.Compare):
        if isinstance(n, ast.Expr) and isinstance(n.value, ast.Name):
            nm = n.value.id
            if nm in ex.funcs or nm in idx.funcdefs:
                out.append((n.lineno, n.col_offset + 1, {"name": nm}))
        elif isinstance(n, ast.Assign) and isinstance(n.value, ast.Name) and n.value.id in sensors:
            out.append((n.lineno, n.value.col_offset + 1, {"name": n.value.id}))
        elif isinstance(n, ast.Compare):
            for side in [n.left] + list(n.comparators):
                if isinstance(side, ast.Name) and side.id in sensors:
                    out.append((n.lineno, side.col_offset + 1, {"name": side.id}))
    for c in idx.of(ast.Call):
        if _call_name(c) in ("print", "round", "abs", "str", "int", "float"):
            for a in c.args:
                if isinstance(a, ast.Name) and a.id in sensors and a.id not in idx.module_binds:
                    out.append((c.lineno, a.col_offset + 1, {"name": a.id}))
    out.sort(key=lambda o: (o[0], o[1]))
    return out


@check("lint_name_case_twin")
def _lk_case_twin(ex, idx):
    out = []
    lower = {}
    for name in list(idx.module_binds) + list(idx.loads):
        lower.setdefault(name.lower(), set()).add(name)
    for name, binds in idx.module_binds.items():
        if name in idx.loads:
            continue
        twins = [o for o in lower.get(name.lower(), ()) if o != name and o in idx.loads]
        if twins:
            ln = min(b[0] for b in binds)
            out.append((ln, 1, {"name": name, "other": sorted(twins)[0]}))
    return sorted(out, key=lambda o: o[0])


@check("lint_compare_statement")
def _lk_compare_stmt(ex, idx):
    out = []
    for n in idx.of(ast.Expr):
        if isinstance(n.value, ast.Compare) and len(n.value.ops) == 1 \
                and isinstance(n.value.ops[0], ast.Eq) and isinstance(n.value.left, ast.Name):
            out.append((n.lineno, n.col_offset + 1, {"target": n.value.left.id,
                                                     "value": idx.segment(n.value.comparators[0])}))
    return out


@check("lint_xor_power")
def _lk_xor(ex, idx):
    out = []
    for n in idx.of(ast.BinOp):
        if isinstance(n.op, ast.BitXor):
            out.append((n.lineno, n.col_offset + 1, {"left": idx.segment(n.left), "right": idx.segment(n.right)}))
    return out


def _mentions_break(idx, loop):
    """くり返しの中のメモ（# のコメント）に break と書いてある＝スターターの「ここで break」の骨組み"""
    last = loop.end_lineno or loop.lineno
    # 本体の後ろに続く、本体より深く字下げしたメモの行もふくめる（「# ここで break」は最後の文の後ろに書かれやすい）
    while last < len(idx.lines) and not idx.masked[last].strip() and             (not idx.lines[last].strip() or len(idx.lines[last]) - len(idx.lines[last].lstrip()) > loop.col_offset):
        last += 1
    for ln in range(loop.lineno, last + 1):
        c = idx.ccols[ln - 1] if 0 < ln <= len(idx.ccols) else None
        if c is not None and "break" in idx.lines[ln - 1][c:]:
            return True
    return False


@check("lint_while_no_time")
def _lk_while_no_time(ex, idx):
    out = []
    for n in idx.of(ast.While):
        if _has_break(idx, n) or _mentions_break(idx, n):
            continue
        const_true = isinstance(n.test, ast.Constant) and bool(n.test.value)
        if _calls_advance_time(ex, idx, n):
            continue
        uses_api = any(_call_name(c) in ex.funcs for c in idx.calls_under(n))
        if const_true or uses_api:
            out.append((n.lineno, n.col_offset + 1, {}))
    return out


@check("lint_while_cond_stuck")
def _lk_while_stuck(ex, idx):
    out = []
    for n in idx.of(ast.While):
        names = _stuck_names(ex, idx, n)
        if names:
            out.append((n.lineno, n.col_offset + 1, {"names": "、".join(names), "first_name": names[0],
                                                     "reread": _reread_example(idx, names[0], n.lineno)}))
    return out


_HAS_BODY = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.For, ast.AsyncFor, ast.While, ast.If,
             ast.With, ast.AsyncWith, ast.Try, ast.ExceptHandler)


@check("lint_unreachable")
def _lk_unreachable(ex, idx):
    out = []
    for n in idx.of(*_HAS_BODY):
        body = getattr(n, "body", None)
        if not isinstance(body, list):
            continue
        for lst in (body, getattr(n, "orelse", []) or []):
            for i, st in enumerate(lst[:-1]):
                if isinstance(st, ast.While) and isinstance(st.test, ast.Constant) and st.test.value and not _has_break(idx, st)                         and not _mentions_break(idx, st):
                    nxt = lst[i + 1]
                    out.append((nxt.lineno, nxt.col_offset + 1, {"loop_line": st.lineno}))
    return out


@check("lint_return_missing")
def _lk_return_missing(ex, idx):
    out = []
    by_name = {}
    for n in idx.of(ast.Call):
        if isinstance(n.func, ast.Name):
            by_name.setdefault(n.func.id, []).append(n)
    for name, fd in idx.funcdefs.items():
        if idx.func_returns_value(fd):
            continue
        for n in by_name.get(name, ()):
            p = idx.parents.get(n)
            if not isinstance(p, ast.Expr):
                out.append((fd.lineno, fd.col_offset + 1, {"func": name, "use_line": n.lineno}))
                break
    return out


@check("lint_range_from_one")
def _lk_range_one(ex, idx):
    out = []
    for n in idx.of(ast.For):
        if isinstance(n.iter, ast.Call) and _call_name(n.iter) == "range" and len(n.iter.args) == 2:
            a, b = _const_num(n.iter.args[0]), _const_num(n.iter.args[1])
            if a == 1 and isinstance(b, int) and b >= 2:
                tnames = set(idx._targets(n.target))
                used = any(isinstance(x, ast.Name) and x.id in tnames for st in n.body for x in ast.walk(st))
                if not used:
                    out.append((n.lineno, n.col_offset + 1, {"start": 1, "stop": b, "count": b - 1, "last": b - 1,
                                                             "stop_minus_1": b - 1}))
    return out


@check("lint_trig_degrees")
def _lk_trig(ex, idx):
    out = []
    for c in _walk_calls(idx, {"math.sin", "math.cos", "math.tan", "sin", "cos", "tan"}):
        if not c.args:
            continue
        a = c.args[0]
        v = _const_num(a)
        uses_heading = any(isinstance(x, ast.Call) and _call_name(x) == "heading" for x in ast.walk(a))
        if (v is not None and v in (30, 45, 60, 90, 120, 135, 150, 180, 270, 360)) or uses_heading:
            import math as _m
            deg = round(_m.degrees(v)) if v is not None else "？"
            out.append((c.lineno, c.col_offset + 1, {"fn": _call_name(c), "arg": idx.segment(a), "deg_equiv": deg}))
    return out


@check("lint_sleep_not_wait")
def _lk_sleep(ex, idx):
    return [(c.lineno, c.col_offset + 1, {"arg": idx.segment(c.args[0]) if c.args else "秒"})
            for c in _walk_calls(idx, {"time.sleep"})]


@check("lint_semicolon")
def _lk_semicolon(ex, idx):
    out = []
    for li, ml in enumerate(idx.masked, start=1):
        if ml.rstrip().endswith(";"):
            out.append((li, len(ml.rstrip()), {}))
    return out[:1]


@check("lint_plus_equal_typo")
def _lk_plus_eq(ex, idx):
    out = []
    for n in idx.of(ast.Assign):
        if len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) \
                and isinstance(n.value, ast.UnaryOp) and isinstance(n.value.op, ast.UAdd):
            if re.search(r"=\+", idx.masked_of(n.lineno)):
                out.append((n.lineno, n.col_offset + 1, {"name": n.targets[0].id}))
    return out


@check("lint_none_equals")
def _lk_none_eq(ex, idx):
    out = []
    for n in idx.of(ast.Compare):
        for op, comp in zip(n.ops, n.comparators):
            if isinstance(op, (ast.Eq, ast.NotEq)) and isinstance(comp, ast.Constant) and comp.value is None:
                out.append((n.lineno, n.col_offset + 1, {}))
                return out
    return out


@check("lint_double_negation")
def _lk_double_neg(ex, idx):
    out = []
    for n in idx.of(ast.Expr):
        if isinstance(n.value, ast.UnaryOp) and isinstance(n.value.operand, ast.UnaryOp) \
                and isinstance(n.value.operand.operand, ast.Name):
            op = "--" if isinstance(n.value.op, ast.USub) else "++"
            out.append((n.lineno, n.col_offset + 1, {"name": n.value.operand.operand.id, "op": op}))
    return out


@check("lint_global_shadow")
def _lk_global_shadow(ex, idx):
    """関数の中で外と同じ名前に入れたのに、関数の中では使わず・返さず、外で読んでいる時だけ（外を変えたつもりの形）。
    関数の中だけで使う名前（中で読む）・return で返して外で受け取る形は、ふつうのローカル変数なので言わない（直し係 2）。"""
    out = []
    if not idx.funcdefs:
        return out
    # 名前 -> その名前を読んでいる関数（関数の外は None）。〔速さ〕1 回だけ作る
    readers = {}
    for x in idx.of(ast.Name):
        if isinstance(x.ctx, ast.Load):
            readers.setdefault(x.id, set()).add(idx.func_of.get(x))
    for name, fd in idx.funcdefs.items():
        globs = idx.globals_of.get(fd, set())
        params = {a.arg for a in fd.args.args}
        inner = idx.inside(fd)
        returned = None
        for n in inner:
            if isinstance(n, ast.Assign):
                for t in n.targets:
                    for nm in idx._targets(t):
                        if nm not in idx.module_binds or nm in globs or nm in params or nm not in idx.loads:
                            continue
                        rd = readers.get(nm, set())
                        if fd in rd:          # 関数の中でも使っている（ふつうのローカル変数）
                            continue
                        if returned is None:
                            returned = set()
                            for r_ in inner:
                                if isinstance(r_, ast.Return) and r_.value is not None:
                                    returned |= _names_in(r_.value)
                        if nm in returned:
                            continue
                        # 外（関数の外か、ほかの関数）で読んでいるか
                        if rd - {fd}:
                            out.append((n.lineno, n.col_offset + 1, {"name": nm, "func": name}))
                            return out
    return out


# ======================================================================= JSON で使う値の置きかえ（type_ja など）
@check("always")
def _ck_always(ex, ctx, got):
    return True


@check("chain")
def _ck_chain(ex, ctx, got, checks=()):
    """いくつかの check を順に（全部が通れば、取れた値を合わせる）"""
    out = {}
    for c in checks:
        name, args = (c, {}) if isinstance(c, str) else (c[0], c[1])
        r = CHECKS[name](ex, ctx, {**got, **out}, **args)
        if not r:
            return None
        if isinstance(r, dict):
            out.update(r)
    return out or True


if __name__ == "__main__":
    # 手で試す: python app/worker/py/error_explain.py < main.py   （app/data/error_rules.json を読む）
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "..", "data", "error_rules.json"), encoding="utf-8") as f:
        ex = Explainer(json.load(f))
    sys.stdin.reconfigure(encoding="utf-8")
    src = sys.stdin.read() if not sys.stdin.isatty() else "motor（0.5, 0.5)\n"
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(ex.before_run(src, chapter=int(sys.argv[1]) if len(sys.argv) > 1 else 99),
                     ensure_ascii=False, indent=1, default=str))
