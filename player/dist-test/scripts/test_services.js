"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Phase 4 — Service unit tests (Node, zero deps).
 *
 * Tests pure helpers from factories.ts and browser.ts without a browser.
 * Run via: npm run test:services
 */
const factories_1 = require("../src/services/factories");
const browserHelpers_1 = require("../src/services/browserHelpers");
const native_1 = require("../src/services/native");
let pass = 0;
let fail = 0;
const failures = [];
function expectEq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        return;
    }
    fail++;
    failures.push(`${name}\n  expected: ${e}\n  actual:   ${a}`);
}
function expectTruthy(name, cond) {
    if (cond) {
        pass++;
        return;
    }
    fail++;
    failures.push(`${name}: expected truthy, got ${JSON.stringify(cond)}`);
}
function expectMatch(name, actual, re) {
    if (re.test(actual)) {
        pass++;
        return;
    }
    fail++;
    failures.push(`${name}: expected match ${re}, got ${actual}`);
}
// ---------------------------------------------------------------------------
// factories.ts tests
// ---------------------------------------------------------------------------
// makeTiming basic
{
    const t = (0, factories_1.makeTiming)({ instrumentMs: 10, runMs: 20 });
    expectEq("makeTiming.instrumentMs", t.instrumentMs, 10);
    expectEq("makeTiming.runMs", t.runMs, 20);
    expectEq("makeTiming.totalMs", t.totalMs, 30);
    expectEq("makeTiming.compileMs", t.compileMs, undefined);
}
// makeTiming with compile
{
    const t = (0, factories_1.makeTiming)({ instrumentMs: 5, compileMs: 100, runMs: 15 });
    expectEq("makeTiming.compileMs", t.compileMs, 100);
    expectEq("makeTiming.totalMs", t.totalMs, 120);
}
// makeDiagnostic
{
    const d = (0, factories_1.makeDiagnostic)("error", "test error", { line: 5, column: 3 });
    expectEq("makeDiagnostic.severity", d.severity, "error");
    expectEq("makeDiagnostic.message", d.message, "test error");
    expectEq("makeDiagnostic.line", d.line, 5);
    expectEq("makeDiagnostic.column", d.column, 3);
}
// makeSuccess
{
    const tf = {
        source: { name: "test", language: "python", lines: ["x=1"] },
        steps: [{ line: 1, depth: 0, vars: [], loops: [], output: "", globalStep: 0 }],
    };
    const r = (0, factories_1.makeSuccess)({
        lang: "python",
        trace: tf,
        instrumentMs: 3,
        runMs: 7,
    });
    expectTruthy("makeSuccess.ok", r.ok);
    expectEq("makeSuccess.totalPhases", r.totalPhases, 2);
    expectEq("makeSuccess.timing.totalMs", r.timing.totalMs, 10);
    expectEq("makeSuccess.lang", r.lang, "python");
}
// makeSuccess with compile (C++)
{
    const tf = {
        source: { name: "test", language: "cpp", lines: [] },
        steps: [],
    };
    const r = (0, factories_1.makeSuccess)({
        lang: "cpp",
        trace: tf,
        instrumentMs: 2,
        compileMs: 200,
        runMs: 5,
    });
    expectEq("makeSuccess.cpp.totalPhases", r.totalPhases, 3);
    expectEq("makeSuccess.cpp.compileMs", r.timing.compileMs, 200);
}
// makeError
{
    const r = (0, factories_1.makeError)({
        lang: "python",
        summary: "SyntaxError: invalid syntax",
        diagnostics: [(0, factories_1.makeDiagnostic)("error", "SyntaxError", { line: 7 })],
        instrumentMs: 11,
    });
    expectTruthy("makeError.ok is false", !r.ok);
    expectEq("makeError.summary", r.summary, "SyntaxError: invalid syntax");
    expectEq("makeError.diagnostics.length", r.diagnostics?.length, 1);
    expectEq("makeError.diagnostics[0].line", r.diagnostics[0].line, 7);
}
// ---------------------------------------------------------------------------
// browser.ts pure helper tests
// ---------------------------------------------------------------------------
// parsePyDiagnostic — SyntaxError
{
    const stderr = `Traceback (most recent call last):
  File "source.py", line 7, in <module>
    x = )
SyntaxError: invalid syntax`;
    const diags = (0, browserHelpers_1.parsePyDiagnostic)(stderr);
    expectTruthy("parsePyDiagnostic.hasDiag", diags.length > 0);
    if (diags[0]) {
        expectMatch("parsePyDiagnostic.message", diags[0].message, /SyntaxError/);
        expectEq("parsePyDiagnostic.line", diags[0].line, 7);
    }
}
// parseGccDiagnostics — error + warning
{
    const stderr = `source.cpp:5:10: error: expected ';' before '}' token
source.cpp:3:1: warning: unused variable 'x' [-Wunused-variable]`;
    const diags = (0, browserHelpers_1.parseGccDiagnostics)(stderr);
    expectEq("parseGccDiagnostics.length", diags.length, 2);
    expectEq("parseGccDiagnostics[0].severity", diags[0].severity, "error");
    expectEq("parseGccDiagnostics[0].line", diags[0].line, 5);
    expectEq("parseGccDiagnostics[0].column", diags[0].column, 10);
    expectEq("parseGccDiagnostics[1].severity", diags[1].severity, "warning");
    expectEq("parseGccDiagnostics[1].line", diags[1].line, 3);
}
// parseTraceJson — valid
{
    const json = JSON.stringify({
        source: { name: "t", language: "python", lines: ["x=1"] },
        steps: [{ line: 1, depth: 0, vars: [], loops: [], output: "", globalStep: 0 }],
    });
    const tf = (0, browserHelpers_1.parseTraceJson)(json);
    expectTruthy("parseTraceJson.valid", tf !== null);
    if (tf) {
        expectEq("parseTraceJson.steps", tf.steps.length, 1);
        expectEq("parseTraceJson.lines", tf.source.lines.length, 1);
    }
}
// parseTraceJson — invalid
{
    const tf = (0, browserHelpers_1.parseTraceJson)("{ not json");
    expectEq("parseTraceJson.invalid", tf, null);
}
// parseTraceJson — missing source
{
    const tf = (0, browserHelpers_1.parseTraceJson)('{"steps":[]}');
    expectEq("parseTraceJson.missingSource", tf, null);
}
// buildTraceFile
{
    const steps = [
        { line: 1, depth: 0, vars: [], loops: [], output: "hello", globalStep: 0 },
    ];
    const tf = (0, browserHelpers_1.buildTraceFile)("print(1)\nprint(2)", "python", steps);
    expectEq("buildTraceFile.lines", tf.source.lines.length, 2);
    expectEq("buildTraceFile.language", tf.source.language, "python");
    expectEq("buildTraceFile.steps", tf.steps.length, 1);
    expectEq("buildTraceFile.output", tf.steps[0].output, "hello");
}
// ---------------------------------------------------------------------------
// native.ts convertRustResult tests
// ---------------------------------------------------------------------------
// convertRustResult — success (Python)
{
    const tf = {
        source: { name: "x", language: "python", lines: ["x = 1"] },
        steps: [{ line: 1, depth: 0, vars: [], loops: [], output: "", globalStep: 0 }],
    };
    const r = (0, native_1.convertRustResult)({
        ok: true,
        id: "py-ok",
        timing: { instrument_ms: 3, compile_ms: null, run_ms: 12, total_ms: 15 },
        total_phases: 2,
        trace_file_json: JSON.stringify(tf),
        diagnostics: [],
        summary: null,
    }, "python");
    expectTruthy("convertRustResult.ok", r.ok);
    expectEq("convertRustResult.totalPhases", r.totalPhases, 2);
    expectEq("convertRustResult.timing.totalMs", r.timing.totalMs, 15);
    expectEq("convertRustResult.timing.compileMs", r.timing.compileMs, undefined);
    expectEq("convertRustResult.traceSteps", r.traceFile?.steps.length, 1);
}
// convertRustResult — success (C++ with compile_ms)
{
    const r = (0, native_1.convertRustResult)({
        ok: true,
        id: "cpp-ok",
        timing: { instrument_ms: 2, compile_ms: 210, run_ms: 5, total_ms: 217 },
        total_phases: 3,
        trace_file_json: JSON.stringify({
            source: { name: "x", language: "cpp", lines: [] },
            steps: [],
        }),
        diagnostics: [],
        summary: null,
    }, "cpp");
    expectTruthy("convertRustResult.cpp.ok", r.ok);
    expectEq("convertRustResult.cpp.compileMs", r.timing.compileMs, 210);
    expectEq("convertRustResult.cpp.totalPhases", r.totalPhases, 3);
}
// convertRustResult — error with diagnostics
{
    const r = (0, native_1.convertRustResult)({
        ok: false,
        id: "err",
        timing: { instrument_ms: 11, compile_ms: null, run_ms: 0, total_ms: 11 },
        total_phases: 2,
        trace_file_json: null,
        diagnostics: [
            { severity: "error", line: 7, column: 62, message: "invalid syntax", raw: "raw" },
        ],
        summary: "SyntaxError: invalid syntax",
    }, "python");
    expectTruthy("convertRustResult.err.notOk", !r.ok);
    expectEq("convertRustResult.err.diagLen", r.diagnostics?.length, 1);
    expectEq("convertRustResult.err.line", r.diagnostics[0].line, 7);
    expectEq("convertRustResult.err.summary", r.summary, "SyntaxError: invalid syntax");
}
// convertRustResult — invalid trace json
{
    const r = (0, native_1.convertRustResult)({
        ok: true,
        id: "bad-json",
        timing: { instrument_ms: 1, compile_ms: null, run_ms: 1, total_ms: 2 },
        total_phases: 2,
        trace_file_json: "{ not json",
        diagnostics: [],
        summary: null,
    }, "python");
    expectTruthy("convertRustResult.badJson.notOk", !r.ok);
    expectMatch("convertRustResult.badJson.summary", r.summary ?? "", /解析失败/);
}
// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nServices test: ${pass} passed, ${fail} failed`);
if (fail > 0) {
    console.error(failures.join("\n\n"));
    process.exit(1);
}
else {
    console.log("test_services.ts: all assertions passed");
}
