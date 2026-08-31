"use strict";
/**
 * Phase 4 — Pure helper functions extracted from BrowserRecorderService.
 *
 * These functions have zero DOM/browser dependencies and can be unit-tested
 * in Node without a browser environment.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePyDiagnostic = parsePyDiagnostic;
exports.parseGccDiagnostics = parseGccDiagnostics;
exports.parseTraceJson = parseTraceJson;
exports.buildTraceFile = buildTraceFile;
const factories_1 = require("./factories");
/** Parse a Python traceback line to extract file/line/message. */
function parsePyDiagnostic(stderr) {
    const diags = [];
    const lines = stderr.split("\n");
    let msgLine = "";
    let lineNum;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/File "[^"]*", line (\d+)/);
        if (m) {
            lineNum = parseInt(m[1], 10);
            const next = lines[i + 2]?.trim() || lines[i + 1]?.trim();
            if (next)
                msgLine = next;
        }
    }
    const errMatch = stderr.match(/^(\w+Error):\s*(.+)$/m);
    if (errMatch) {
        msgLine = `${errMatch[1]}: ${errMatch[2]}`;
    }
    if (msgLine) {
        diags.push((0, factories_1.makeDiagnostic)("error", msgLine, { line: lineNum }));
    }
    return diags;
}
/** Parse g++ stderr diagnostic lines. */
function parseGccDiagnostics(stderr) {
    const diags = [];
    const re = /^(.+?):(\d+):(\d+):\s*(warning|error|fatal error):\s*(.+)$/gm;
    let match;
    while ((match = re.exec(stderr)) !== null) {
        diags.push((0, factories_1.makeDiagnostic)(match[4].startsWith("warning") ? "warning" : "error", match[5], {
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            raw: match[0],
        }));
    }
    return diags;
}
/** Parse a JSON trace string, validating basic structure. */
function parseTraceJson(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        if (obj &&
            typeof obj === "object" &&
            obj.source &&
            typeof obj.source === "object" &&
            Array.isArray(obj.steps)) {
            return obj;
        }
        return null;
    }
    catch {
        return null;
    }
}
/** Build a TraceFile from source + steps (for in-memory recording). */
function buildTraceFile(source, language, steps) {
    return {
        source: {
            name: "recorded",
            language,
            lines: source.split("\n"),
        },
        steps,
    };
}
