/**
 * Phase 4 — Recording service protocol.
 *
 * Defines the unified IRecorderService interface that decouples the Player UI
 * from recording backends (Browser Pyodide / Tauri native / Hybrid fallback).
 * Both Web and Tauri front-ends consume the same RecordResult shape.
 */
import type { TraceFile } from "../types";

// ---------------------------------------------------------------------------
// Capabilities & options
// ---------------------------------------------------------------------------

export type RecorderLanguage = "python" | "cpp";

export interface RecorderCapabilities {
  /** Languages this backend can record (subset of ["python","cpp"]). */
  languages: RecorderLanguage[];
  /** Human-readable backend identifier: "browser" | "native" | "hybrid". */
  backendName: string;
  /** Native python3 path (Tauri only). */
  nativePythonPath?: string;
  /** Native g++ path (Tauri only). */
  nativeGxxPath?: string;
  /** Whether Pyodide has finished loading (Browser/Hybrid). */
  pyodideReady?: boolean;
  /** Notice shown to user when C++ browser recording needs first-run download. */
  cppBrowserNotice?: string;
}

export interface RecordOptions {
  maxSteps?: number;
  timeoutMs?: number;
  tempFileName?: string;
}

export interface RecorderInitOpts {
  onProgress?: (stage: string, pct?: number) => void;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RecordDiagnostic {
  severity: "error" | "warning";
  line?: number;
  column?: number;
  message: string;
  raw?: string;
}

export interface RecordTiming {
  instrumentMs: number;
  compileMs?: number;
  runMs: number;
  totalMs: number;
}

export interface RecordResult {
  ok: boolean;
  lang: RecorderLanguage;
  summary?: string;
  traceFile?: TraceFile;
  diagnostics?: RecordDiagnostic[];
  timing: RecordTiming;
  totalPhases: 2 | 3;
  id: string;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface IRecorderService {
  init(opts?: RecorderInitOpts): Promise<RecorderCapabilities>;
  getCapabilities(): RecorderCapabilities;
  recordPython(source: string, opts?: RecordOptions): Promise<RecordResult>;
  recordCpp(source: string, opts?: RecordOptions): Promise<RecordResult>;
}
