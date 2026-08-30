#!/usr/bin/env python3
"""Re-Trace Phase 1 — Python source instrumentation adapter.

Parses a Python source file with the stdlib ``ast`` module, injects an
``__trace_emit__(line, locals())`` call before every statement, and wraps
for/while loop iterables so iteration counters can be reported. The
instrumented program is executed in a sandbox namespace; each emit records one
``TraceStep`` conforming to the unified protocol, and the resulting timeline is
written as ``trace.json`` (with the source listing) for the language-agnostic
player to replay.

This honours the project's iron law: the frontend player is untouched and only
consumes JSON; this adapter is the only Python-specific surface.

Usage::

    python instrument.py <source.py> [-o trace.json] [--max-steps N]

Limitations (documented, by design for Phase 1):
  * No runtime mutation-then-continue (recording/replay model).
  * ``async`` loops are not counter-wrapped (their bodies still emit).
  * While-loop totals are unknown and reported as the running count.
"""
from __future__ import annotations

import argparse
import ast
import builtins
import io
import json
import os
import sys
import traceback
from typing import Any

# Names injected into the sandbox namespace. All share the ``__trace_`` prefix
# so the runtime can hide them from the visible-variables view.
TRACE_EMIT = "__trace_emit__"
TRACE_FOR = "__trace_for__"
TRACE_WHILE = "__trace_while__"
HIDDEN_PREFIX = "__trace_"
DEFAULT_MAX_STEPS = 200_000


# ---------------------------------------------------------------------------
# Runtime — lives in this adapter; injected into the sandbox as callables.
# ---------------------------------------------------------------------------

class LoopCounter:
    """Mutable iteration counter reported in the side panel."""

    __slots__ = ("id", "current", "total")

    def __init__(self, loop_id: str, current: int = 0, total: int | None = None) -> None:
        self.id = loop_id
        self.current = current
        self.total = total


class _TraceAborted(Exception):
    """Raised internally to stop recording once the step budget is exhausted."""


class Tracer:
    """Per-execution recording state, driven by injected ``__trace_*`` hooks."""

    def __init__(self, source_lines: list[str], run_frame: Any, max_steps: int) -> None:
        self.source_lines = source_lines
        self.run_frame = run_frame              # frame that called exec()
        self.max_steps = max_steps
        self.steps: list[dict] = []
        self._out = io.StringIO()              # captured stdout
        self._real_stdout = None
        self._loop_stack: list[LoopCounter] = []
        self._last_step: dict | None = None

    # ---- stdout capture -------------------------------------------------
    def install_stdout(self) -> None:
        self._real_stdout = sys.stdout
        sys.stdout = self._out

    def restore_stdout(self) -> None:
        if self._real_stdout is not None:
            sys.stdout = self._real_stdout

    def _drain(self) -> str:
        v = self._out.getvalue()
        if v:
            self._out.seek(0)
            self._out.truncate(0)
        return v

    # ---- call-stack depth ----------------------------------------------
    def _depth(self, caller: Any) -> int:
        """Distance from ``caller`` up to the exec frame (global scope = 1)."""
        d = 0
        f = caller
        while f is not None:
            d += 1
            if f.f_back is self.run_frame:
                return d
            f = f.f_back
        return d

    # ---- value serialization -------------------------------------------
    def _ser(self, v: Any, seen: set[int], depth: int = 0) -> Any:
        if v is None:
            return None
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float, str)):
            return v
        if depth > 4:
            return self._safe_repr(v)
        vid = id(v)
        if vid in seen:
            return "<circular>"
        if isinstance(v, (list, tuple)):
            seen.add(vid)
            try:
                return [self._ser(x, seen, depth + 1) for x in v]
            finally:
                seen.discard(vid)
        if isinstance(v, dict):
            seen.add(vid)
            try:
                return {str(k): self._ser(x, seen, depth + 1) for k, x in v.items()}
            finally:
                seen.discard(vid)
        return self._safe_repr(v)

    @staticmethod
    def _safe_repr(v: Any) -> str:
        try:
            return repr(v)
        except Exception:  # pragma: no cover - defensive
            return "<unreprable>"

    @staticmethod
    def _type_name(v: Any) -> str:
        if v is None:
            return "NoneType"
        if isinstance(v, bool):
            return "bool"
        if isinstance(v, list):
            return "list"
        if isinstance(v, tuple):
            return "tuple"
        if isinstance(v, dict):
            return "dict"
        return type(v).__name__

    def _visible_vars(self, locs: dict) -> list[dict]:
        out = []
        for name, val in locs.items():
            if name.startswith(HIDDEN_PREFIX):
                continue
            if name.startswith("__") and name.endswith("__"):
                continue
            out.append({
                "name": name,
                "value": self._ser(val, set()),
                "type": self._type_name(val),
            })
        out.sort(key=lambda x: x["name"])
        return out

    def _visible_loops(self) -> list[dict]:
        loops = []
        for c in self._loop_stack:
            total = c.total if c.total is not None else c.current + 1
            loops.append({"id": c.id, "current": c.current, "total": total})
        return loops

    # ---- emit hook (called by instrumented code) -----------------------
    def emit(self, lineno: int, locs: dict) -> None:
        if len(self.steps) >= self.max_steps:
            raise _TraceAborted("step budget exhausted")
        caller = sys._getframe(1)
        # Attribute stdout produced by the previous statement onto that step,
        # so each step's `output` is what its own line printed.
        pending = self._drain()
        if pending and self._last_step is not None:
            self._last_step["output"] += pending
        step = {
            "line": lineno,
            "depth": self._depth(caller),
            "vars": self._visible_vars(locs),
            "loops": self._visible_loops(),
            "output": "",
            "globalStep": len(self.steps),
        }
        self.steps.append(step)
        self._last_step = step

    def finalize(self) -> None:
        """Flush any trailing stdout (e.g. a final print) onto the last step."""
        pending = self._drain()
        if pending and self._last_step is not None:
            self._last_step["output"] += pending

    # ---- loop wrappers --------------------------------------------------
    def trace_for(self, loop_id: str, iterable: Any):
        """Wrap a for-iterable; pushes/pops a counter around iteration."""
        it = iter(iterable)
        try:
            total = len(iterable)
        except TypeError:
            total = None
        counter = LoopCounter(loop_id, 0, total)
        self._loop_stack.append(counter)
        try:
            i = 0
            while True:
                try:
                    item = next(it)
                except StopIteration:
                    break
                counter.current = i
                if total is None:
                    counter.total = i + 1
                yield item
                i += 1
        finally:
            try:
                self._loop_stack.remove(counter)
            except ValueError:
                pass

    def trace_while(self, loop_id: str, cond):
        """Drive a while-loop via a generator so the same stack model applies."""
        counter = LoopCounter(loop_id, 0, None)
        self._loop_stack.append(counter)
        try:
            i = 0
            while cond():
                counter.current = i
                counter.total = i + 1
                yield None
                i += 1
        finally:
            try:
                self._loop_stack.remove(counter)
            except ValueError:
                pass


# ---------------------------------------------------------------------------
# AST instrumentation
# ---------------------------------------------------------------------------

def _name(id_: str, ctx: ast.expr_context | None = None) -> ast.Name:
    return ast.Name(id=id_, ctx=ctx or ast.Load())


class Instrumenter(ast.NodeTransformer):
    """Injects emit calls and wraps loop iterables."""

    def _inject(self, stmts: list[ast.stmt]) -> list[ast.stmt]:
        out: list[ast.stmt] = []
        for s in stmts:
            out.append(self._emit_before(s))
            out.append(self.visit(s))
        return out

    @staticmethod
    def _emit_before(template: ast.stmt) -> ast.Expr:
        node = ast.Expr(value=ast.Call(
            func=_name(TRACE_EMIT),
            args=[
                ast.Constant(value=template.lineno),
                ast.Call(func=_name("locals"), args=[], keywords=[]),
            ],
            keywords=[],
        ))
        # Mirror the statement's full position so compile() sees a valid range.
        ast.copy_location(node, template)
        return node

    def _inject_body(self, node: ast.stmt) -> ast.stmt:
        node.body = self._inject(node.body) or [ast.Pass()]
        if hasattr(node, "orelse") and getattr(node, "orelse", None):
            node.orelse = self._inject(node.orelse)
        ast.fix_missing_locations(node)
        return node

    def visit_Module(self, node: ast.Module) -> ast.AST:
        node.body = self._inject(node.body) or [ast.Pass()]
        ast.fix_missing_locations(node)
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        node.body = self._inject(node.body) or [ast.Pass()]
        ast.fix_missing_locations(node)
        return node

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.AST:
        node.body = self._inject(node.body) or [ast.Pass()]
        ast.fix_missing_locations(node)
        return node

    def visit_If(self, node: ast.If) -> ast.AST:
        return self._inject_body(node)

    def visit_For(self, node: ast.For) -> ast.AST:
        node.iter = ast.Call(
            func=_name(TRACE_FOR),
            args=[ast.Constant(value=f"L{node.lineno}"), node.iter],
            keywords=[],
        )
        ast.copy_location(node.iter, node)
        return self._inject_body(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AST:
        # async iterables are not counter-wrapped; bodies still emit.
        return self._inject_body(node)

    def visit_While(self, node: ast.While) -> ast.AST:
        # while COND: BODY  ->  for __w in __trace_while__('L', lambda: COND): BODY
        cond_lambda = ast.Lambda(
            args=ast.arguments(
                posonlyargs=[], args=[], vararg=None, kwonlyargs=[],
                kw_defaults=[], kwarg=None, defaults=[],
            ),
            body=node.test,
        )
        ast.copy_location(cond_lambda, node)
        new_for = ast.For(
            target=_name(f"__trace_w_L{node.lineno}", ast.Store()),
            iter=ast.Call(
                func=_name(TRACE_WHILE),
                args=[ast.Constant(value=f"L{node.lineno}"), cond_lambda],
                keywords=[],
            ),
            body=node.body,
            orelse=node.orelse,
        )
        ast.copy_location(new_for, node)
        ast.fix_missing_locations(new_for)
        return self._inject_body(new_for)

    def visit_With(self, node: ast.With) -> ast.AST:
        return self._inject_body(node)

    visit_AsyncWith = visit_With

    def visit_Try(self, node: ast.Try) -> ast.AST:
        node.body = self._inject(node.body) or [ast.Pass()]
        for h in node.handlers:
            h.body = self._inject(h.body) or [ast.Pass()]
        node.orelse = self._inject(node.orelse)
        node.finalbody = self._inject(node.finalbody)
        ast.fix_missing_locations(node)
        return node

    def visit_Match(self, node: ast.Match) -> ast.AST:
        for c in node.cases:
            c.body = self._inject(c.body) or [ast.Pass()]
        ast.fix_missing_locations(node)
        return node


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def _fix_end_positions(node: ast.AST) -> None:
    """Ensure every node has end_lineno/end_col_offset (Python 3.14 requires this)."""
    ln = getattr(node, "lineno", None)
    if ln is not None:
        if getattr(node, "end_lineno", None) is None:
            node.end_lineno = ln
        if getattr(node, "end_col_offset", None) is None:
            node.end_col_offset = getattr(node, "col_offset", 0) or 0
    for child in ast.iter_child_nodes(node):
        _fix_end_positions(child)


def instrument_source(source: str, filename: str = "<instrumented>") -> ast.AST:
    tree = ast.parse(source, filename=filename)
    tree = Instrumenter().visit(tree)
    ast.fix_missing_locations(tree)
    _fix_end_positions(tree)
    return tree


def record(source: str, source_path: str, max_steps: int = DEFAULT_MAX_STEPS) -> dict:
    source_lines = source.splitlines()
    tree = instrument_source(source, source_path)
    code = compile(tree, source_path, "exec")

    tracer = Tracer(source_lines, run_frame=sys._getframe(), max_steps=max_steps)
    ns: dict = {
        "__name__": "__main__",
        "__file__": source_path,
        "__builtins__": builtins,
        TRACE_EMIT: tracer.emit,
        TRACE_FOR: tracer.trace_for,
        TRACE_WHILE: tracer.trace_while,
    }

    tracer.install_stdout()
    aborted_msg = None
    try:
        exec(code, ns)
    except _TraceAborted as e:
        aborted_msg = str(e)
    except Exception:
        # Capture runtime errors onto the timeline so the user can still scrub
        # to the failure point; the traceback also goes to real stderr.
        tracer.finalize()
        tb = traceback.format_exc()
        if tracer._last_step is not None:
            tracer._last_step["output"] += ("\n" if tracer._last_step["output"] else "") + tb
        tracer.restore_stdout()
        print(tb, file=sys.stderr)
        return _to_trace_file(source_path, source_lines, tracer.steps)
    else:
        tracer.finalize()
    tracer.restore_stdout()

    if aborted_msg and tracer._last_step is not None:
        tracer._last_step["output"] += f"\n[trace aborted: {aborted_msg}]"

    return _to_trace_file(source_path, source_lines, tracer.steps)


def _to_trace_file(source_path: str, source_lines: list[str], steps: list[dict]) -> dict:
    return {
        "source": {
            "name": os.path.basename(source_path),
            "language": "python",
            "lines": source_lines,
        },
        "steps": steps,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Re-Trace Python instrumentation adapter.")
    ap.add_argument("source", help="Python source file to instrument and record.")
    ap.add_argument("-o", "--output", default="trace.json", help="Output trace JSON path.")
    ap.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS,
                    help="Safety cap on recorded steps (default %(default)d).")
    ap.add_argument("--print", action="store_true",
                    help="Also print the instrumented source to stderr for inspection.")
    args = ap.parse_args(argv)

    with open(args.source, "r", encoding="utf-8") as f:
        source = f.read()

    if args.print:
        print("----- instrumented source -----", file=sys.stderr)
        print(ast.unparse(instrument_source(source, args.source)), file=sys.stderr)

    trace = record(source, args.source, max_steps=args.max_steps)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(trace, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(trace['steps'])} steps -> {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
