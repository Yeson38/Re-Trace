# Re-Trace · Python Adapter (Phase 1)

Source-instrumentation adapter that turns any Python program into a
`trace.json` timeline the language-agnostic Re-Trace player can replay.

It uses **only the standard library** (`ast`, `sys`, `json`) — no interpreter
simulation, no native debugger. This honours the project's iron law: the
frontend player is untouched and consumes only JSON; this script is the only
Python-specific surface.

## Install

None. Requires Python 3.8+ (developed on 3.14).

## Usage

```bash
cd adapters/python

# instrument + record a program, write trace.json
python3 instrument.py samples/bubble_sort.py -o samples/bubble_sort.trace.json

# also dump the instrumented source to stderr for inspection
python3 instrument.py samples/bubble_sort.py -o out.json --print
```

Options:

| flag | default | meaning |
| :--- | :--- | :--- |
| `source` | — | Python file to instrument and record (positional). |
| `-o, --output` | `trace.json` | Output JSON path. |
| `--max-steps` | `200000` | Safety cap on recorded steps (guards against infinite loops). |
| `--print` | off | Print the instrumented source to stderr. |

## Output format

A single JSON object matching the player's `TraceFile`:

```jsonc
{
  "source": { "name": "bubble_sort.py", "language": "python", "lines": [...] },
  "steps": [
    {
      "line": 6,                 // 1-based source line being executed
      "depth": 2,                // call-stack depth (1 = global scope)
      "vars": [                  // currently visible variables
        { "name": "arr", "value": [5,2,8,1,4], "type": "list" }
      ],
      "loops": [                 // active loop counters
        { "id": "L3", "current": 0, "total": 5 }
      ],
      "output": "",              // stdout produced by this step's line
      "globalStep": 7            // monotonically increasing
    }
  ]
}
```

## How it works

1. **Parse + transform** (`Instrumenter`, an `ast.NodeTransformer`):
   - Inject `__trace_emit__(line, locals())` **before every statement** (the
     spec's required placement).
   - `for x in ITER:` → `for x in __trace_for__('L{line}', ITER):` so a counter
     is pushed/popped around iteration.
   - `while COND:` → `for __w in __trace_while__('L{line}', lambda: COND):`
     (same stack model; `break`/`continue`/`else` semantics are preserved).
   - Loop ids are `L{lineno}` — unique because two loops never share a line.
2. **Compile + exec** in a sandbox namespace where `__trace_emit__`,
   `__trace_for__`, `__trace_while__` are bound to runtime hooks.
3. **Record** (`Tracer`):
   - `emit` snapshots `locals()`, computes call depth by walking frames up to
     the exec frame, and attributes stdout to the step whose line printed it.
   - `sys.stdout` is redirected to a buffer that is drained at each emit and
     on finalize (so a trailing `print` is not lost).
   - Values are JSON-serialized with a depth cap and cycle guard; arbitrary
     objects fall back to `repr()`.

### Output attribution

Each step's `output` is the stdout produced by **that step's line**: an emit
runs *before* its statement, drains any pending stdout onto the *previous*
step, and `finalize()` flushes trailing stdout onto the last step. The player
accumulates `output` across `0..index` for the terminal.

## Samples

| file | exercises |
| :--- | :--- |
| `samples/bubble_sort.py` | nested `for` loops, in-place list mutation, `print` |
| `samples/factorial.py` | recursion → call-stack depth up to 5 |
| `samples/gcd_while.py` | `while` loop counter (`L2`) |

Run all and sanity-check:

```bash
for s in bubble_sort factorial gcd_while; do
  python3 instrument.py samples/$s.py -o samples/$s.trace.json
done
```

## Wiring into the player

The player loads `player/public/samples/bubble_sort.json`. To refresh it from
this adapter:

```bash
# from the player/ directory — regenerates the live demo from real Python
npm run gen:demo
```

`gen:demo` calls this adapter on `bubble_sort.py` and writes the result
straight into the player's served samples, so the web player replays a real
recorded run end-to-end.

## Limitations (by design for Phase 1)

- **No runtime mutation-then-continue** — this is a record/replay model.
- `async for` bodies still emit, but their iterables are not counter-wrapped.
- `while` totals are unknown and reported as the running count.
- Instrumented helpers are hidden from the variable view by the `__trace_`
  prefix and `__dunder__` filtering.
- Very large traces: this phase records eagerly; paged lazy-loading is a
  Phase 4 player concern.
