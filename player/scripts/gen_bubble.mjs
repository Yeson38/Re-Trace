/**
 * Bubble-sort demo trace generator (Phase 0).
 *
 * Hand-models the execution of bubble_sort.py and emits a TraceFile conforming
 * to the TraceStep protocol. This is NOT the Phase 1 Python adapter — it only
 * produces a realistic static trace to validate player interaction.
 *
 * Run: npm run gen:demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const source = `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

data = [5, 2, 8, 1, 4]
result = bubble_sort(data)
print(result)`;
const sourceLines = source.split("\n");

// Python passes lists by reference; bubble_sort mutates `data` in place.
const data = [5, 2, 8, 1, 4];
const arr = data;
const n = arr.length;

/** steps accumulator */
const steps = [];
let globalStep = 0;

function pyRepr(v) {
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v === null) return "None";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
function pyType(v) {
  if (v === null) return "NoneType";
  if (Array.isArray(v)) return "list";
  return typeof v;
}

function snap(list) {
  // Snapshot current array contents (shallow copy is fine for primitives).
  return list.slice();
}

function emit(line, depth, vars, loops, output = "") {
  steps.push({
    line,
    depth,
    vars: vars.map(([name, value]) => ({ name, value, type: pyType(value) })),
    loops: loops.map(([id, current, total]) => ({ id, current, total })),
    output,
    globalStep: globalStep++,
  });
}

const outerTotal = n; // for i in range(n)
// --- global scope (depth 1) ---
emit(9, 1, [["data", snap(data)], ["result", null]], []);
emit(10, 1, [["data", snap(data)], ["result", null]], []);

// --- enter bubble_sort (depth 2) ---
emit(1, 2, [["arr", snap(arr)], ["n", n]], []);
emit(2, 2, [["arr", snap(arr)], ["n", n]], []);

const innerTotal = (i) => Math.max(0, n - i - 1);

for (let i = 0; i < outerTotal; i++) {
  emit(
    3,
    2,
    [["arr", snap(arr)], ["n", n], ["i", i]],
    [["L3:outer", i, outerTotal], ["L4:inner", 0, innerTotal(i)]],
  );
  const itTot = innerTotal(i);
  for (let j = 0; j < itTot; j++) {
    emit(
      4,
      2,
      [["arr", snap(arr)], ["n", n], ["i", i], ["j", j]],
      [["L3:outer", i, outerTotal], ["L4:inner", j, itTot]],
    );
    emit(
      5,
      2,
      [["arr", snap(arr)], ["n", n], ["i", i], ["j", j]],
      [["L3:outer", i, outerTotal], ["L4:inner", j, itTot]],
    );
    if (arr[j] > arr[j + 1]) {
      // Capture state at line 6 entry (pre-swap); the post-swap state shows
      // up at the next iteration's line-4 frame, mirroring real step-over.
      emit(
        6,
        2,
        [["arr", snap(arr)], ["n", n], ["i", i], ["j", j]],
        [["L3:outer", i, outerTotal], ["L4:inner", j, itTot]],
      );
      const tmp = arr[j];
      arr[j] = arr[j + 1];
      arr[j + 1] = tmp;
    }
  }
}

emit(7, 2, [["arr", snap(arr)], ["n", n], ["i", outerTotal]], []);

// --- return to global (depth 1) ---
const finalArr = snap(arr);
emit(10, 1, [["data", snap(data)], ["result", snap(finalArr)]], []);
const printLine = `${pyRepr(finalArr)}\n`;
emit(11, 1, [["data", snap(data)], ["result", snap(finalArr)]], [], printLine);

const file = {
  source: { name: "bubble_sort.py", language: "python", lines: sourceLines },
  steps,
};

const outDir = join(__dirname, "..", "public", "samples");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "bubble_sort.json");
writeFileSync(outPath, JSON.stringify(file, null, 2));
console.log(`Wrote ${steps.length} steps -> ${outPath}`);
