/**
 * Phase 4 — Pure helper functions extracted from BrowserRecorderService.
 *
 * These functions have zero DOM/browser dependencies and can be unit-tested
 * in Node without a browser environment.
 */

import type { RecordDiagnostic } from "./types";
import type { TraceFile, TraceStep } from "../types";
import { makeDiagnostic } from "./factories";

/** Parse a Python traceback line to extract file/line/message. */
export function parsePyDiagnostic(stderr: string): RecordDiagnostic[] {
  const diags: RecordDiagnostic[] = [];
  const lines = stderr.split("\n");
  let msgLine = "";
  let lineNum: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/File "[^"]*", line (\d+)/);
    if (m) {
      lineNum = parseInt(m[1], 10);
      const next = lines[i + 2]?.trim() || lines[i + 1]?.trim();
      if (next) msgLine = next;
    }
  }
  const errMatch = stderr.match(/^(\w+Error):\s*(.+)$/m);
  if (errMatch) {
    msgLine = `${errMatch[1]}: ${errMatch[2]}`;
  }
  if (msgLine) {
    diags.push(
      makeDiagnostic<RecordDiagnostic>("error", msgLine, { line: lineNum })
    );
  }
  return diags;
}

/** Parse g++ stderr diagnostic lines. */
export function parseGccDiagnostics(stderr: string): RecordDiagnostic[] {
  const diags: RecordDiagnostic[] = [];
  const re = /^(.+?):(\d+):(\d+):\s*(warning|error|fatal error):\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    diags.push(
      makeDiagnostic<RecordDiagnostic>(
        match[4].startsWith("warning") ? "warning" : "error",
        match[5],
        {
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          raw: match[0],
        }
      )
    );
  }
  return diags;
}

/** Parse a JSON trace string, validating basic structure. */
export function parseTraceJson(jsonStr: string): TraceFile | null {
  try {
    const obj = JSON.parse(jsonStr);
    if (
      obj &&
      typeof obj === "object" &&
      obj.source &&
      typeof obj.source === "object" &&
      Array.isArray(obj.steps)
    ) {
      return obj as TraceFile;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a TraceFile from source + steps (for in-memory recording). */
export function buildTraceFile(
  source: string,
  language: string,
  steps: TraceStep[]
): TraceFile {
  return {
    source: {
      name: "recorded",
      language,
      lines: source.split("\n"),
    },
    steps,
  };
}
