# Re-Trace · C++ Adapter (Phase 2)

Turn any C++ source into a language-agnostic `trace.json` the Re-Trace player
can replay. Uses **source-agnostic regex instrumentation + a header-only
runtime** (no Clang/LLVM dependency — the Phase 2 plan's robust-first path).

- Pipeline: `source.cpp → instrument.py → *_inst.cpp → g++ -I. → run → trace.json`
- Output conforms to the unified `TraceFile` / `TraceStep` protocol so the
  existing player plays the trace without any frontend changes (the iron law).

## Requires

- `python3` (any 3.x) for the regex instrumenter.
- `g++` / `clang++` with `-std=c++17` or newer (uses SFINAE helpers,
  `std::filesystem`, structured bindings).
- GNU `make` (optional; the `Makefile` just wraps the three-step pipeline).

## Quick start

```bash
cd adapters/cpp
make                      # instrument + compile + run all 3 sample programs
make check                # shape + output correctness validation
python3 scripts/verify.py # full: depth/loops/vars assertions (see below)
```

Per-sample:

```bash
make bubble_sort          # → samples/bubble_sort.trace.json
make factorial            # → samples/factorial.trace.json
make gcd_while            # → samples/gcd_while.trace.json
```

Manual pipeline (any user source):

```bash
# 1) instrument (regex inserts __RT_* macros before statements)
python3 instrument.cpp foo.cpp -o foo_inst.cpp --print    # --print dumps the result

# 2) compile against retrace.h (header-only runtime)
g++ -std=c++17 -I. foo_inst.cpp -o foo

# 3) run — the binary writes the json itself via atexit()
./foo            # produces foo.trace.json in the same directory
```

## User-side annotations

Because the regex instrumenter cannot resolve semantic information from the
AST, the user drops **three kinds of macro** in their source. See
`samples/*.cpp` for working examples.

### Required

```cpp
#include "retrace.h"

int main() {
    __RT_MAIN("my_program.trace.json");  // boots recorder, opens main scope (depth=1)
    ...
}
```

### Every user-defined function you want visible in the call stack

```cpp
int gcd(int a, int b) {
    __RT_FN;                     // push call-depth on entry, pop at exit (RAII)
    __RT_PARAM(a);               // register formal parameter(s) in this scope
    __RT_PARAM(b);
    ...
}
```

`__RT_PARAM` is a one-liner per formal parameter; it's the only manual
annotation that will be replaced by Clang Tooling in a future iteration (Phase
2 plan explicitly says *"if a high-precision version is needed, migrate to
Clang Tooling"*). The instrumenter auto-registers **local declarations**
(`int n = 3;`, `for (int i = 0; …)`, etc.), so only parameters need manual
`__RT_PARAM`.

### Nothing else

For-loops, while-loops, declarations, control-flow headers and bodies are all
instrumented automatically. Compiled with `-Wall -Wextra` the samples emit
**zero warnings**.

## Instrumentation overview (`instrument.py`)

Per source line (in order):

1. Skip blanks, comments, `#include`, `public:`, `namespace`, `template`, etc.
2. For every remaining "statement-bearing" line prepend `__RT_STEP(lineno);`
   — each step maps to one TraceStep frame in the JSON.
3. Harvest local declarations:
   - Declarations like `int n = 3;` → append `__RT_VAR(lineno, n);` on the
     next line so `n` is already in scope.
   - `for (int i = 0; …)` headers → also register `i` immediately after the
     for-header closes.
4. `for(…) / while(…)` headers push `__RT_LOOP_BEGIN(L<line>)` and the
   matching `}` is paired with `__RT_LOOP_END(L<line>)`. The runtime treats
   these as an RAII counter stack reported as `loops[]` per step.
5. Special handling for `__RT_MAIN(...)` / `__RT_FN;` lines — their STEP is
   deferred until **after** the original line runs, so that scope and depth
   are correct when the frame is recorded.

The instrumenter also embeds the original source listing as a static
`const char* const __rt_source_lines[]` array inside the generated `*_inst.cpp`,
so the runtime can build a complete `TraceFile` (source + steps) without any
extra CLI argument passing.

## Runtime overview (`retrace.h`, single header, ~600 lines)

- `Recorder` singleton (mutex-locked but step execution is single-threaded in
  the typical OI/developer case).
- `__RT_STEP(line)` calls `Recorder::step_record(line)` which:
  - drains the captured `std::cout` buffer onto the **previous** step (so
    step N's `output` is what step N printed; this matches the Python adapter's
    attribution semantics);
  - builds `vars[]` by merging **all active scopes' registered names + value
    factories** (inner scopes shadow outer by name);
  - attaches `loops[]` from the loop-counter stack;
  - computes `depth` = size of the live ScopeGuard stack (=1 from main, +1 per
    function).
- `__RT_VAR(line, name)` / `__RT_PARAM(name)` register a `(type-erased pointer
  + serialization factory)` pair in the current scope so STEP can read the
  live value at any later frame. Value serialization covers:
  - primitives, `bool`, pointers, `std::string`, `nullptr` natively;
  - iterable containers (`std::vector`, `std::list`, `std::array`, `std::set` …)
    → JSON arrays;
  - key-value containers (`std::map`, `std::unordered_map`) → JSON objects;
  - any type with `operator<<` → quoted string fallback (so custom types
    usually "just work").
- Loop counters are approximate (Phase 2 trade-off for regex vs Clang): the
  `current` counts **body steps, not iterations**, and `total` grows
  monotonically. This is enough for the side-panel progress bar to make
  progress visible; Clang Tooling upgrade can exact-iterate later.
- On `atexit()` (via `BootstrapGuard`'s lifetime in `main`) the recorder
  restores the real `std::cout` and writes the complete `TraceFile` JSON to
  the path from `__RT_MAIN(...)`. Filesystem parents are auto-created.

## Sample verification results

Expected output (as validated by `scripts/verify.py`):

| sample        | steps | depth     | loops visible | vars visible                        | Σ stdout       |
| :------------ | :---- | :-------- | :------------ | :---------------------------------- | :------------- |
| bubble_sort   | 52    | 1 → 2 → 1 | L9, L10, L24  | data, arr, n, i, j, tmp             | `1 2 4 5 8`    |
| factorial(4)  | 14    | 1→2→3→4→5 | —             | n                                   | `24`           |
| gcd(48, 18)   | 15    | 1 → 2 → 1 | L8            | a, b, t                             | `6`            |

Protocol shape (`line`, `depth`, `vars`, `loops`, `output`, `globalStep`) is
checked by both `make check` and `verify.py`.

## Wiring into the player

The frontend knows only `TraceFile` JSON. Drop any C++ trace into the player's
`public/samples/` (or upload via file picker once Phase 4 lands) to replay it:

```bash
cp adapters/cpp/samples/bubble_sort.trace.json \
   player/public/samples/cpp_bubble_sort.json
# Adjust player/src/main.ts load URL or copy on top of bubble_sort.json:
cp adapters/cpp/samples/bubble_sort.trace.json \
   player/public/samples/bubble_sort.json
cd player && npm run dev     # http://localhost:5173/ — plays C++ record now
```

## Known limits (Phase 2 design, by spec)

- No runtime mutation-then-continue: record/replay only.
- Loop `current` counts body steps, not iteration count (regex can't tell
  when one iteration ends vs the next). Upgrade path: Clang Tooling.
- `__RT_PARAM` is manual for formal parameters.
- References / pointers' **target values** are not deep-snapped; the raw
  pointer address is shown (or container contents if the *stored* type is a
  standard container and accessed by value).
- If code writes to stdout via `printf`/`write(1, …)` instead of `std::cout`,
  capture may miss output. Phase 4 can LD_PRELOAD `write(2)` if needed.
- Multi-line block comments and raw-strings containing `{` / `}` may throw off
  brace-based loop closure detection in corner cases. The three canonical
  sample shapes are covered; for production-grade accuracy upgrade to Clang
  Tooling (the explicitly documented migration path in the spec).
