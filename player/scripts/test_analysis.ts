/**
 * Tiny test runner for analysis.ts — Node, zero deps, no runner needed.
 * Compile via `tsc --noEmit false --outDir player/dist-test player/src/analysis.ts player/src/types.ts player/scripts/test_analysis.ts`
 * then `node player/dist-test/scripts/test_analysis.js`.
 *
 * Or simpler: `npm run test:analysis` in the player package (see package.json).
 */
import {
  parseSearch,
  findFirstMatch,
  findAllMatches,
  resolvePath,
  estimateLoopComplexity,
  estimateProgram,
  diffVars,
  type SearchPredicate,
} from "../src/analysis";
import type { TraceFile, TraceStep, TraceVar } from "../src/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expectEq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}\n  expected: ${e}\n  actual:   ${a}`);
}
function expectTruthy(name: string, cond: unknown): void {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}: expected truthy, got ${JSON.stringify(cond)}`);
}

// ---------------------------------------------------------------------------
// Search parsing
// ---------------------------------------------------------------------------
function testParseSearch(): void {
  const cases: Array<[string, object | string]> = [
    ["n == 4", { name: "n", op: "==", value: 4 }],
    ["data[3] == 8", { name: "data[3]", op: "==", value: 8 }],
    ["arr ~= 5", { name: "arr", op: "~=", value: 5 }],
    ["score >= 60.5", { name: "score", op: ">=", value: 60.5 }],
    ["name == \"hello world\"", { name: "name", op: "==", value: "hello world" }],
    ["name != 'bye'", { name: "name", op: "!=", value: "bye" }],
    ["ok == true", { name: "ok", op: "==", value: true }],
    ["x == null", { name: "x", op: "==", value: null }],
    ["y < -3", { name: "y", op: "<", value: -3 }],
    ["foo.bar[0].baz == 1", { name: "foo.bar[0].baz", op: "==", value: 1 }],
    // Failures:
    ["x ?? 5", "error"],
    ["", "error"],
    [" ==", "error"],
    ["n == unterminated\"", "error"],
  ];
  for (const [inp, expect] of cases) {
    const r = parseSearch(inp);
    if (expect === "error") expectTruthy(`parseSearch(${JSON.stringify(inp)}) → error`, "error" in r);
    else {
      const e = expect as { name: string; op: string; value: unknown };
      expectTruthy(`parseSearch(${JSON.stringify(inp)}) → ok`, !("error" in r));
      if (!("error" in r)) {
        expectEq(`parseSearch name: ${inp}`, r.name, e.name);
        expectEq(`parseSearch op: ${inp}`, r.op, e.op);
        expectEq(`parseSearch value: ${inp}`, r.value, e.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// resolvePath + matches linear
// ---------------------------------------------------------------------------
function syntheticSteps(): TraceStep[] {
  const mk = (i: number, n: number, arr: number[], obj?: { a?: number; b?: { c?: string } }): TraceStep => ({
    line: i, depth: 1, output: "", globalStep: i,
    loops: [],
    vars: [
      { name: "n", type: "int", value: n },
      { name: "arr", type: "list", value: arr },
      ...(obj ? [{ name: "o", type: "dict", value: obj as unknown }] : []),
    ],
  });
  return [
    mk(1, 1, [1, 1, 1]),
    mk(2, 2, [1, 2, 3]),
    mk(3, 3, [1, 4, 9], { a: 10, b: { c: "hi" } }),
    mk(4, 4, [2, 4, 8, 16]),
    mk(5, 5, [2, 5, 12, 27, 58]),
  ];
}

function testResolve(): void {
  const step = syntheticSteps()[2];
  expectEq("resolve arr[2]", resolvePath(step.vars, "arr[2]"), { found: true, value: 9 });
  expectEq("resolve n", resolvePath(step.vars, "n"), { found: true, value: 3 });
  expectEq("resolve o.a", resolvePath(step.vars, "o.a"), { found: true, value: 10 });
  expectEq("resolve o.b.c", resolvePath(step.vars, "o.b.c"), { found: true, value: "hi" });
  expectEq("resolve missing", resolvePath(step.vars, "missing"), { found: false });
  expectEq("resolve out of range", resolvePath(step.vars, "arr[9]"), { found: false });
}

function testFinders(): void {
  const steps = syntheticSteps();
  const p = (raw: string) => parseSearch(raw) as SearchPredicate;
  expectEq("findFirst n==3", findFirstMatch(steps, p("n == 3")), 2);
  expectEq("findAll n==?", findAllMatches(steps, p("arr ~= 2")), [1, 3, 4]); // arr contains 2
  expectEq("findFirst arr[2]>4", findFirstMatch(steps, p("arr[2] > 4")), 2);
  expectEq("findAll name o== (not found)", findAllMatches(steps, p("missing == null")), []);
  expectEq("findFirst n!=null (absence != → every step)", findFirstMatch(steps, p("missing != 0")), 0);
}

// ---------------------------------------------------------------------------
// Complexity estimates — using the Python bubble_sort trace & factorial trace
// ---------------------------------------------------------------------------
function readTrace(rel: string): TraceFile {
  // We run with cwd = player package root. Allow adapters-common locations.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");
  const root = process.cwd();
  const candidates = [
    path.resolve(root, `public/samples/${rel}`),
    path.resolve(root, `../adapters/python/samples/${rel}`),
    path.resolve(root, `../adapters/cpp/samples/${rel}`),
    // Fallbacks from __dirname in case someone runs directly.
    path.resolve(__dirname, `../public/samples/${rel}`),
    path.resolve(__dirname, `../../adapters/python/samples/${rel}`),
    path.resolve(__dirname, `../../adapters/cpp/samples/${rel}`),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf-8"));
  throw new Error(`could not locate trace: ${rel}\ntried: ${candidates.join("\n")}`);
}

function testComplexity(): void {
  try {
    const bub = readTrace("bubble_sort.trace.json");
    const est = estimateProgram(bub);
    // bubble_sort = nested two loops over n≈5, 25 comparisons -> expect O(n²) high or low.
    expectTruthy("bubble program order includes n²", est.order.includes("n²") || est.order.includes("n^2"));
  } catch (e) {
    fail += 1; failures.push(`bubble complexity: ${e}`);
  }

  try {
    const fact = readTrace("factorial.trace.json");
    const est = estimateProgram(fact);
    // factorial: single linear recursion → loops? none visible; should be O(1) or O(n).
    expectTruthy(`factorial program order = ${est.order}`, /O\(1\)|O\(n\)|O\(\?\)/.test(est.order));
  } catch (e) {
    fail += 1; failures.push(`fact complexity: ${e}`);
  }

  try {
    const gcd = readTrace("gcd_while.trace.json");
    const gcdEst = estimateProgram(gcd);
    expectTruthy(`gcd program estimate exists: ${gcdEst.order}`, !!gcdEst.order);
    // Loop id should exist: Python=L6 or C++=L8. Check loop estimates exist.
    const ids = Array.from(new Set<string>(gcd.steps.flatMap((s) => s.loops.map((l) => l.id))));
    for (const id of ids) {
      const le = estimateLoopComplexity(gcd, id);
      expectTruthy(`loop ${id} complexity produced`, !!le.order && !!le.basis);
    }
  } catch (e) {
    fail += 1; failures.push(`gcd complexity: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
function mkVars(obj: Record<string, unknown>): TraceVar[] {
  return Object.entries(obj).map(([name, value]) => ({ name, value, type: typeof value }));
}

function testDiff(): void {
  const a = mkVars({ n: 3, arr: [1, 2, 3], s: "hi", o: { x: 1, y: 2 } });
  const b = mkVars({ n: 3, arr: [1, 2, 99], s: "bye", o: { x: 1, z: 3 }, k: true });
  const d = diffVars(a, b);
  const lookup = Object.fromEntries(d.map((x) => [x.name, x]));
  expectEq("n unchanged", lookup.n?.kind, "unchanged");
  expectEq("arr modified", lookup.arr?.kind, "modified");
  expectEq("arr[2] modified", lookup.arr?.children?.find((c) => c.name === "2")?.kind, "modified");
  expectEq("arr[2] before", lookup.arr?.children?.find((c) => c.name === "2")?.before, 3);
  expectEq("arr[2] after", lookup.arr?.children?.find((c) => c.name === "2")?.after, 99);
  expectEq("s modified", lookup.s?.kind, "modified");
  expectEq("s before", lookup.s?.before, "hi");
  expectEq("s after", lookup.s?.after, "bye");
  expectEq("o modified", lookup.o?.kind, "modified");
  expectEq("o.y removed", lookup.o?.children?.find((c) => c.name === "y")?.kind, "removed");
  expectEq("o.z added", lookup.o?.children?.find((c) => c.name === "z")?.kind, "added");
  expectEq("k added", lookup.k?.kind, "added");
}

// ---------------------------------------------------------------------------
function run(name: string, fn: () => void): void {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { fail += 1; failures.push(`${name} threw: ${e}`); console.log(`✗ ${name} threw`); }
}

testParseSearch();
run("resolve", testResolve);
run("finders", testFinders);
run("complexity", testComplexity);
run("diff", testDiff);

console.log(`\npass=${pass} fail=${fail}`);
if (failures.length) {
  console.log("\n--- FAILURES ---");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
