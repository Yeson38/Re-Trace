"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeTiming = makeTiming;
exports.makeDiagnostic = makeDiagnostic;
exports.makeSuccess = makeSuccess;
exports.makeError = makeError;
let _seq = 0;
function nextId(lang) {
    _seq += 1;
    return `${lang}-${Date.now().toString(36)}-${_seq}`;
}
function makeTiming(p) {
    return {
        instrumentMs: Math.round(p.instrumentMs),
        compileMs: p.compileMs != null ? Math.round(p.compileMs) : undefined,
        runMs: Math.round(p.runMs),
        totalMs: Math.round(p.instrumentMs + (p.compileMs ?? 0) + p.runMs),
    };
}
function makeDiagnostic(severity, message, extra) {
    return {
        severity,
        message,
        ...extra,
    };
}
function makeSuccess(p) {
    const timing = makeTiming(p);
    return {
        ok: true,
        lang: p.lang,
        traceFile: p.trace,
        timing,
        totalPhases: p.compileMs != null ? 3 : 2,
        id: nextId(p.lang),
    };
}
function makeError(p) {
    const timing = makeTiming({
        instrumentMs: p.instrumentMs ?? 0,
        compileMs: p.compileMs,
        runMs: p.runMs ?? 0,
    });
    return {
        ok: false,
        lang: p.lang,
        summary: p.summary,
        diagnostics: p.diagnostics,
        timing,
        totalPhases: p.compileMs != null ? 3 : 2,
        id: nextId(p.lang),
    };
}
