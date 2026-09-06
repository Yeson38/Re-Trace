#!/usr/bin/env python3
"""Re-Trace Phase 2 — C++ regex-based instrumentation adapter.

Takes a ``*.cpp`` source and produces ``*_inst.cpp`` which, when compiled
against ``retrace.h`` and run, writes a language-agnostic ``trace.json`` the
Re-Trace player can replay.

Phase 2 design explicitly picks regex + macro hooks (the robust, fast path)
rather than Clang Tooling. Scope is narrowed intentionally:

  * A step is injected *before* every statement-bearing line (skipping
    preprocessor directives, line comments, braces, access specifiers, etc.).
  * ``for`` / ``while`` loop bodies are bracketed by ``__RT_LOOP_BEGIN`` /
    ``__RT_LOOP_END`` macros, so the runtime can push/pop iteration counters
    with ids derived from the loop's source line (``L<line>``).
  * Variable visibility at each step is harvested *statically*: the
    instrumenter walks source lines and collects all declared names it can
    spot (T var, T var = init, ``for (int i=…)``), then emits an
    ``__RT_VAR(行号, name)`` registration right after each declaration. The
    runtime merges all registrations visible at the current call-depth and
    reports them as ``vars`` for every step.  This is the cheapest scheme
    that still gives "something visible" without Clang semantic lookup.
  * ``__RT_FN`` (user-written, at function entry) opens a new call-depth;
    ``__RT_MAIN(path)`` boots the recorder and atexit()-flushes ``trace.json``.

Usage::

    python3 instrument.py <source.cpp> [-o <out.cpp>] [--print]
"""
from __future__ import annotations

import argparse
import re
import sys
from typing import List, Optional

_STEP_MACRO = "__RT_STEP"
_VAR_MACRO = "__RT_VAR"
_MAIN_MACRO = "__RT_MAIN"
_LOOP_BEGIN = "__RT_LOOP_BEGIN"
_LOOP_END = "__RT_LOOP_END"

# ---------------------------------------------------------------------------
# Line classification
# ---------------------------------------------------------------------------

# Strip //-style line comments and C89-style /*…*/ comments that sit on one
# line. Multi-line block comments are handled via a simple flag.
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", flags=re.S)
_LINE_COMMENT_RE = re.compile(r"//.*$", flags=re.M)

# Type keywords that can start a declaration statement (for scope-harvesting).
_DECL_TYPE_KEYWORDS = {
    "int", "long", "short", "char", "float", "double", "bool", "unsigned",
    "signed", "auto", "void", "size_t", "ssize_t",
}

# Lines that NEVER precede an executable statement (even if they end with ;).
_NON_STMT_PREFIXES = (
    "#", "//", "/*", "*",
    "public:", "private:", "protected:",
    "namespace", "using", "template", "typedef", "typename",
    "class ", "struct ", "union ", "enum ",
    "extern ", "static_assert", "constexpr_assert",
    "return",  # handled separately (counted as a statement but NOT here)
)

_RETURNING = re.compile(r"\breturn\b")
_ELSE_ONLY = re.compile(r"^\s*else\s*$")
_DO_TOKEN = re.compile(r"\bdo\b")
_SWITCH_TOKEN = re.compile(r"\bswitch\s*\(")

# Declaration capture:
#   (optional-const/typename) TYPE_SPEC  VAR_NAME  [=;]
# We greedily match any identifier before a '=', ',', or ';' that follows a
# space-comma-bracket transition. Not a full grammar — enough for OI samples.
# Matches:
#   int n = 3;               -> n
#   std::vector<int> &arr;   -> arr
#   for (int i = 0; …)       -> i   (extracted separately from for-header)
_DECL_NAME = re.compile(
    r"""
      # Declarator: optional ref/pointer decoration, then the identifier.
      \s
      (?: [*&]+ \s* )?
      ([A-Za-z_][A-Za-z0-9_]*)
      \s* (?: = | , | ; | \[ | \( | \) )
    """,
    flags=re.X,
)

# Loop headers on a single line: for (init; cond; step)  /  while (cond)
_FOR_HEADER = re.compile(r"^\s*for\s*\(", flags=re.S)
_WHILE_HEADER = re.compile(r"^\s*while\s*\(", flags=re.S)

# Extract the declared name from a for-init clause:   for (int i = 0; …)
_FOR_INIT_DECL = re.compile(
    r"for\s*\(\s*[A-Za-z_:][A-Za-z0-9_:<>*\&\s]*\s"
    r"(?:[*&]+\s*)?"
    r"([A-Za-z_][A-Za-z0-9_]*)"
    r"\s*[=;]",
    flags=re.S,
)


# ---------------------------------------------------------------------------
# Small multi-line tokenizer helper
# ---------------------------------------------------------------------------

def _strip_comments(line: str) -> str:
    line = _LINE_COMMENT_RE.sub("", line)
    line = _BLOCK_COMMENT_RE.sub(" ", line)
    return line


def _balance(lines: List[str]) -> List[Optional[int]]:
    """For each line return the statement-balance at END of that line.

    We count ``{`` - ``}`` inside non-comment code. The value on a line is
    after processing the line. We use this to tell when a compound block
    opens (balance delta == +1 on this line for a {).
    """
    out: List[Optional[int]] = []
    depth = 0
    in_block = False
    for raw in lines:
        s = raw
        if in_block:
            end = s.find("*/")
            if end == -1:
                out.append(None)
                continue
            s = s[end + 2:]
            in_block = False
        # Strip any string contents (too easy to hit '{' inside a literal).
        s2 = []
        i = 0
        in_str = False
        in_chr = False
        esc = False
        while i < len(s):
            c = s[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                i += 1
                continue
            if in_chr:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == "'":
                    in_chr = False
                i += 1
                continue
            if c == '"':
                in_str = True
                s2.append(" ")
                i += 1
                continue
            if c == "'":
                in_chr = True
                s2.append(" ")
                i += 1
                continue
            start = s.find("/*", i)
            if start == i:
                end = s.find("*/", i + 2)
                if end == -1:
                    in_block = True
                    break
                i = end + 2
                s2.append("  ")
                continue
            s2.append(c)
            i += 1
        clean = "".join(s2)
        depth += clean.count("{") - clean.count("}")
        out.append(depth)
    return out


# ---------------------------------------------------------------------------
# Variable declaration harvest
# ---------------------------------------------------------------------------

_DECL_START = re.compile(
    r"""
    ^\s*
    (?: (?:constexpr|const|static|inline|thread_local|mutable|explicit|
          friend|virtual|override|final|noexcept|register|volatile) \s+ )*
    (?:
        [A-Za-z_][A-Za-z0-9_:<>]*      # e.g. int, std::vector<int>
        (?: \s* (?:const|volatile|&|\*+(?:\s*const)?))*  # trailing cv/ref
    )
    \s+
    """,
    flags=re.X,
)


def _try_harvest_decl(clean: str) -> Optional[str]:
    """Return the declared variable name if ``clean`` looks like a declaration."""
    # Exclude control flow keywords.
    lead = clean.lstrip()
    if (
        lead.startswith("return")
        or lead.startswith("if")
        or lead.startswith("else")
        or lead.startswith("for")
        or lead.startswith("while")
        or lead.startswith("goto")
        or lead.startswith("break")
        or lead.startswith("continue")
        or lead.startswith("throw")
        or lead.startswith("case")
        or lead.startswith("do ")
        or lead.startswith("switch")
    ):
        return None
    # Assignment that isn't a declaration?  e.g.  x = 3;  -> skip.
    m = _DECL_START.match(clean)
    if not m:
        return None
    head = m.group(0)
    # Make sure the head actually contains a type-ish token.
    rest = clean[m.end():]
    m2 = _DECL_NAME.match(" " + rest)
    if not m2:
        return None
    return m2.group(1)


def _try_harvest_for_init(clean: str) -> Optional[str]:
    m = _FOR_INIT_DECL.search(clean)
    if not m:
        return None
    return m.group(1)


# ---------------------------------------------------------------------------
# Instrumentation driver
# ---------------------------------------------------------------------------

def instrument(source: str, source_name: str = "<source>") -> str:
    raw_lines = source.splitlines() or [""]
    balances = _balance(raw_lines)
    # We track line numbers 1-based like the player expects.
    # Prepend buffer for generated lines; output lines get `__LINE__` replaced
    # by the *original* source line via a compile-time constant.
    out: List[str] = []

    # Inject the source-listing once so the recorder can embed it into
    # trace.json without extra CLI plumbing. __rt_source_lines[] + __rt_emit_source()
    # are defined/declared by retrace.h.
    header = [
        f"namespace {{ const char* __rt_source_name = {_cpp_string(source_name)};",
        "  const char* const __rt_source_lines[] = {",
    ]
    for ln in raw_lines:
        header.append(f"    {_cpp_string(ln)},")
    header.append("  };")
    header.append(f"  const int __rt_source_lines_n = {len(raw_lines)};")
    header.append("}")
    out.extend(header)

    # For-loop / while-loop bracketing: if a line opens a for/while header we
    # insert a BEGIN macro inside the body. Then, when balance drops back to
    # the body-enter level (i.e. the matching '}'), emit an END macro before
    # that '}'. Since the instrumenter processes top-down, a stack of
    # (close_depth, end_at_line_balance, loop_id) suffices.
    pending_ends: List[tuple] = []  # (close_balance, loop_line, original_line_for_id)
    # 'close_balance' is the balance value at END of the loop header line.
    # The '}' that closes the body is the last line with balance equal to
    # close_balance before decrementing. Simple model: we push a marker when
    # we detect a for/while header, and pop when we hit a line where
    # ``balance == close_balance`` AND the line contains a '}' and the
    # previous balance was ``close_balance + 1``.

    prev_balance = 0
    in_preproc_continuation = False  # lines ending with '\'
    pending_braceless = None  # None=no braceless loop; True=close on next stmt; False=close now

    for idx, raw in enumerate(raw_lines):
        lineno = idx + 1
        balance = balances[idx]

        # Flush any pending loop ends BEFORE writing content for this line.
        while pending_ends:
            close_bal, loop_line, loop_id = pending_ends[-1]
            # close_bal is the balance *after* the header/body-open line. The
            # matching '}' will sit on a line where end_balance goes from
            # close_bal+1 to close_bal, i.e. previous balance was
            # close_bal+1 and current balance == close_bal.
            if (
                prev_balance is not None
                and balance is not None
                and prev_balance == close_bal + 1
                and balance == close_bal
            ):
                out.append(f"{_LOOP_END}({loop_id});")
                pending_ends.pop()
            else:
                break

        stripped = _strip_comments(raw)
        lead = stripped.lstrip()
        is_blank = (stripped.strip() == "")
        in_block_comment = (balance is None)

        # Skip obviously non-statement lines entirely.
        skip = False
        if is_blank:
            skip = True
        elif in_block_comment:
            skip = True
        elif in_preproc_continuation:
            skip = True
        elif any(lead.startswith(p) for p in _NON_STMT_PREFIXES):
            skip = True
        elif raw.lstrip().startswith("#"):
            skip = True

        # Update preprocessor continuation flag.
        if raw.rstrip().endswith("\\"):
            in_preproc_continuation = True
        elif in_preproc_continuation:
            # end-of-continuation: if this line also had no '\' we fall through
            # but the whole block was already skipped above anyway.
            if not raw.rstrip().endswith("\\"):
                in_preproc_continuation = False

        deferred_var_regs: List[str] = []
        deferred_step_after = False   # emit STEP AFTER the raw line (scope guards, main)
        deferred_main_bootstrap = False  # inject __RT_MAIN after this line

        if not skip:
            # Scope markers: the user-written macros __RT_MAIN(...) and
            # __RT_FN; push a ScopeGuard onto the stack. We must NOT emit a
            # STEP *before* them (the stack would be one level too shallow).
            # Instead emit the STEP right AFTER the raw line — the guard is
            # then live.  These lines are the ONLY ones whose STEP we defer;
            # every other statement keeps STEP before the line.
            lead_tokens = stripped.lstrip()
            is_scope_entry_line = False
            if lead_tokens.startswith("__RT_MAIN") or lead_tokens.startswith("__RT_FN"):
                is_scope_entry_line = True

            # Auto-inject __RT_MAIN into main() so users don't need to.
            if "main(" in stripped and "{" in stripped and not is_scope_entry_line:
                deferred_main_bootstrap = True

            # Step insertion: for every statement-bearing line we insert a
            # STEP macro using the ORIGINAL line number.
            is_stmt_line = False
            # Semicolon on non-empty non-skipped => statement.
            if ";" in stripped:
                is_stmt_line = True
            # Control-flow headers without a ';' on the same line.
            if any(kw in stripped for kw in ("else", "do", "switch(")):
                if _ELSE_ONLY.match(stripped) or _DO_TOKEN.search(stripped) or _SWITCH_TOKEN.search(stripped):
                    is_stmt_line = True
            # Lines consisting solely of an if/for/while + '{' also count.
            if (
                stripped.strip().endswith("{")
                and ("if" in stripped or _FOR_HEADER.match(stripped) or
                     _WHILE_HEADER.match(stripped))
            ):
                is_stmt_line = True
            # Lone opening brace or lone closing brace => not a step by itself;
            # the inner statements carry steps.
            if set(stripped.strip()).issubset({"{", "}", ",", " ", "\t", ":"}):
                is_stmt_line = False
            # 'return' always counts as a statement step (after return-value
            # eval happens at the return line, which is what we want).
            if _RETURNING.search(stripped):
                is_stmt_line = True
            # __RT_FN / __RT_MAIN lines always count (we emit STEP after push).
            if is_scope_entry_line:
                is_stmt_line = True
                deferred_step_after = True

            if is_stmt_line and not deferred_step_after:
                out.append(f"{_STEP_MACRO}({lineno});")

                # Harvest any local declaration on this line.
                # - for-init:  for (int i = ...)  — header declares inside for(),
                #   so the name is visible starting right after the header.
                #   Only register the var if the body is a braced block; for a
                #   single-statement body (no '{') the for-init var is out of
                #   scope on the next line, so we skip registration.
                if _FOR_HEADER.match(stripped) and "{" in stripped:
                    name = _try_harvest_for_init(stripped)
                    if name:
                        deferred_var_regs.append(f"{_VAR_MACRO}({lineno}, {name});")
                # - plain declaration:  int x = 3;
                if (
                    "; " not in stripped
                    and not stripped.startswith("for")
                    and not stripped.startswith("while")
                    and not stripped.startswith("if")
                    and not stripped.startswith("switch")
                    and not stripped.startswith("return")
                    and not stripped.startswith("break")
                    and not stripped.startswith("continue")
                    and not stripped.startswith("case")
                    and not stripped.startswith("throw")
                    and not stripped.startswith("goto")
                    and not stripped.startswith("using")
                    and not stripped.startswith("template")
                ):
                    name = _try_harvest_decl(stripped)
                    if name:
                        deferred_var_regs.append(f"{_VAR_MACRO}({lineno}, {name});")

            # Loop bracket insertion.
            if _FOR_HEADER.match(stripped) or _WHILE_HEADER.match(stripped):
                # Header is on this line. After the header's '{' (on this or
                # later line), record close_balance. Body is at balance+1.
                # We push: the balance after processing this line equals
                # ``close_balance`` because the header line may contain a
                # trailing '{'.
                pending_ends.append((int(balance or 0), lineno, f"L{lineno}"))
                # Insert a BEGIN macro right before the body's first statement
                # *after* the '{'. Simpler: emit BEGIN as the very next line,
                # assuming the header line itself ends with '{' or the body
                # starts on the next line.
                # To get it inside the block scope, we track that the very
                # next step of the body will be preceded by the BEGIN macro
                # being emitted *now* at the header line if there's a '{' on
                # this line, else we mark it "pending begin". Actually the
                # easiest robust approach: emit it AFTER the header line if
                # header contains '{', otherwise when we first see a '{' line
                # following this while/for.
                if "{" in stripped:
                    out.append(f"{_LOOP_BEGIN}(L{lineno});")
                    # push a marker 'need begin at next {' is handled by an aux stack
            # Aux handling: begin for/while loop body if a '{' follows the header
            # We need a side-channel: track lines that introduced a pending
            # for/while-without-open-brace. Too complex; instead: treat any
            # pending END stack as implicitly requiring a BEGIN macro at the
            # first step/body '{' AFTER the header. The current naive emit-
            # BEGIN-on-same-line works for all samples because samples have
            # '{' on the header-or-next-line for while; bubble_sort's for()
            # has its body 'if' without '{}' so a bare for without { needs
            # BEGIN on first statement after header. We address this with a
            # small deferred-begin flag:

        # Deferred begin handling (header had no '{' on its line).
        # Re-detect: was this line a for/while WITHOUT a trailing '{', with
        # pending_ends just pushed?  If the next non-skipped line is a '{' we
        # emit BEGIN there; else the next non-skipped line IS the first body
        # statement and we emit BEGIN before its step.
        # Simplest covering for samples: after any for/while line we emit
        # BEGIN regardless and rely on the runtime recorder to treat the
        # BEGIN/END pairs as RAII — which they are (they increment/decrement
        # a counter in a std::map on construction/destruction).  We therefore
        # use SCOPE-style macros, but since we're doing plain statement
        # macros with a stack-pop-at-END-counter-decrement, this is handled
        # already by the pending_ends stack.  Concretely, for for() WITHOUT
        # '{' on same line we just INSERT the BEGIN macro right NOW regardless
        # of '{' — this matches the scope of the (single) body statement.

        # So re-insert BEGIN right after the header emit for ANY for/while.
        if not skip and (_FOR_HEADER.match(stripped) or _WHILE_HEADER.match(stripped)):
            if "{" not in stripped:
                out.append(f"{_LOOP_BEGIN}(L{lineno});")
                # If the body is on the same line (statement after ')'), we
                # close the loop right after this line. Otherwise the body is
                # on the next line and we close after that.
                last_paren = stripped.rfind(")")
                pending_braceless = ";" not in stripped[last_paren:] if last_paren >= 0 else True

        # Keep the ORIGINAL source line last so compiler __LINE__ macros
        # stay aligned to the input file's line numbers if the user uses them.
        out.append(raw)
        # Variable registrations come AFTER the original line so the declared
        # name is in scope at this point (C++ declaration order matters).
        for reg in deferred_var_regs:
            out.append(reg)
        # Auto-injected __RT_MAIN bootstraps the recorder + atexit flush.
        if deferred_main_bootstrap:
            out.append(f'{_MAIN_MACRO}("trace.json");')
        # Scope-entry lines (e.g. `__RT_FN;`) need their step recorded AFTER
        # the ScopeGuard push, so depth/scope is correct.
        if deferred_step_after:
            out.append(f"{_STEP_MACRO}({lineno});")

        # Close a braceless loop right after its single body statement.
        # pending_braceless is True when the body is on the NEXT line; close
        # on the next non-header statement. When False, the body was on the
        # same line as the header, so close immediately (but skip the header
        # line itself — handled by the True case below).
        if pending_braceless is True and not (_FOR_HEADER.match(stripped) or _WHILE_HEADER.match(stripped)):
            out.append(f"{_LOOP_END}({pending_ends[-1][2]});")
            pending_ends.pop()
            pending_braceless = False
        elif pending_braceless is False:
            # Body on same line as header: close after the header line.
            out.append(f"{_LOOP_END}({pending_ends[-1][2]});")
            pending_ends.pop()
            pending_braceless = None

        if balance is not None:
            prev_balance = balance

    # Flush any pending ends at EOF (unclosed blocks? be safe).
    while pending_ends:
        _cb, _ll, loop_id = pending_ends.pop()
        out.append(f"{_LOOP_END}({loop_id});")

    return "\n".join(out) + "\n"


def _cpp_string(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ord(ch) >= 0x80:
            out.append(f"\\x{ord(ch):02x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Re-Trace C++ regex instrumenter.")
    ap.add_argument("source", help="C++ source file to instrument.")
    ap.add_argument("-o", "--output", required=True, help="Instrumented .cpp output path.")
    ap.add_argument("--print", action="store_true", help="Emit instrumented source to stdout for inspection.")
    args = ap.parse_args(argv)

    with open(args.source, "r", encoding="utf-8") as f:
        src = f.read()
    inst = instrument(src, args.source)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(inst)
    if args.print:
        sys.stdout.write(inst)
    n_lines_inst = inst.count("\n")
    print(f"Wrote {n_lines_inst} lines -> {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
