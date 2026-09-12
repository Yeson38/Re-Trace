/**
 * Phase 4 — RecordResult factory helpers.
 *
 * Pure functions that construct valid RecordResult objects.
 * Shared by all three backends (Browser / Native / Hybrid) and unit-tested.
 */
import type {
  RecordDiagnostic,
  RecordResult,
  RecordTiming,
  RecorderLanguage,
} from "./types";
import type { TraceFile } from "../types";

let _seq = 0;
function nextId(lang: RecorderLanguage): string {
  _seq += 1;
  return `${lang}-${Date.now().toString(36)}-${_seq}`;
}

export function makeTiming(p: {
  instrumentMs: number;
  compileMs?: number;
  runMs: number;
}): RecordTiming {
  return {
    instrumentMs: Math.round(p.instrumentMs),
    compileMs: p.compileMs != null ? Math.round(p.compileMs) : undefined,
    runMs: Math.round(p.runMs),
    totalMs: Math.round(p.instrumentMs + (p.compileMs ?? 0) + p.runMs),
  };
}

export function makeDiagnostic<T extends RecordDiagnostic>(
  severity: "error" | "warning",
  message: string,
  extra?: Partial<Omit<T, "severity" | "message">>
): T {
  return {
    severity,
    message,
    ...extra,
  } as T;
}

export function makeSuccess(p: {
  lang: RecorderLanguage;
  trace: TraceFile;
  instrumentMs: number;
  compileMs?: number;
  runMs: number;
}): RecordResult {
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

export function makeError(p: {
  lang: RecorderLanguage;
  summary: string;
  diagnostics?: RecordDiagnostic[];
  instrumentMs?: number;
  compileMs?: number;
  runMs?: number;
}): RecordResult {
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
