/**
 * Phase 4 — Native (Tauri) recorder service.
 *
 * Wraps Tauri Rust commands via @tauri-apps/api/core invoke.
 * The invoke bridge is injectable for unit testing (stub tests use a mock).
 */
import type {
  IRecorderService,
  RecorderCapabilities,
  RecorderInitOpts,
  RecordResult,
  RecordOptions,
  RecordDiagnostic,
  RecorderLanguage,
} from "./types";
import { makeSuccess, makeError, makeDiagnostic } from "./factories";
import type { TraceFile } from "../types";

// Rust → TS boundary type (snake_case from serde)
interface RecordResultRust {
  ok: boolean;
  id: string;
  timing: {
    instrument_ms: number;
    compile_ms: number | null;
    run_ms: number;
    total_ms: number;
  };
  total_phases: number;
  trace_file_json: string | null;
  diagnostics: Array<{
    severity: string;
    line: number | null;
    column: number | null;
    message: string;
    raw: string | null;
  }>;
  summary: string | null;
}

interface ToolchainInfo {
  python3_path: string | null;
  gxx_path: string | null;
  python3_version: string | null;
  gxx_version: string | null;
}

export type InvokeFn<T = unknown> = (
  cmd: string,
  args?: Record<string, unknown>
) => Promise<T>;

/** Default invoke bridge — uses Tauri's @tauri-apps/api/core.invoke */
function defaultInvoke(
  cmd: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  // Dynamic import so non-Tauri builds don't crash at module load
  return import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke(cmd, args)
  );
}

/** Cross the Rust → TS type boundary. Exported for unit testing. */
export function convertRustResult(
  rust: RecordResultRust,
  lang: RecorderLanguage
): RecordResult {
  if (!rust || typeof rust !== "object") {
    return makeError({
      lang,
      summary: `Tauri 返回值非法：${JSON.stringify(rust).slice(0, 120)}`,
    });
  }

  const timing = {
    instrumentMs: Number(rust.timing?.instrument_ms ?? 0),
    compileMs:
      typeof rust.timing?.compile_ms === "number"
        ? Number(rust.timing.compile_ms)
        : undefined,
    runMs: Number(rust.timing?.run_ms ?? 0),
  };

  const diagnostics: RecordDiagnostic[] = Array.isArray(rust.diagnostics)
    ? rust.diagnostics.map((d) =>
        makeDiagnostic<RecordDiagnostic>(
          d.severity === "warning" ? "warning" : "error",
          String(d.message ?? ""),
          {
            line: typeof d.line === "number" ? d.line : undefined,
            column: typeof d.column === "number" ? d.column : undefined,
            raw: typeof d.raw === "string" ? d.raw : undefined,
          }
        )
      )
    : [];

  if (rust.ok && typeof rust.trace_file_json === "string") {
    let trace: TraceFile;
    try {
      trace = JSON.parse(rust.trace_file_json);
    } catch (e) {
      return makeError({
        lang,
        summary:
          "trace.json 解析失败：" +
          (e instanceof Error ? e.message : String(e)),
        diagnostics,
        ...timing,
      });
    }
    return makeSuccess({
      lang,
      trace,
      ...timing,
    });
  }

  return makeError({
    lang,
    summary:
      typeof rust.summary === "string"
        ? rust.summary
        : lang === "python"
          ? "Python 录制失败"
          : "C++ 录制失败",
    diagnostics,
    ...timing,
  });
}

const PY_ADAPTER = "adapters/python/instrument.py";
const CPP_ADAPTER = "adapters/cpp/instrument.py";
const CPP_RETRACE_H = "adapters/cpp/retrace.h";

export class NativeRecorderService implements IRecorderService {
  private invokeFn: InvokeFn;
  private caps: RecorderCapabilities = {
    languages: [],
    backendName: "native",
  };
  private pyAdapter = "";
  private cppAdapter = "";
  private retraceH = "";

  constructor(invoke?: InvokeFn) {
    this.invokeFn = invoke ?? defaultInvoke;
  }

  async init(opts?: RecorderInitOpts): Promise<RecorderCapabilities> {
    opts?.onProgress?.("init.backend", 0);
    try {
      const info = (await this.invokeFn(
        "native_check_toolchains"
      )) as ToolchainInfo;
      const langs: RecorderLanguage[] = [];
      if (info.python3_path) {
        langs.push("python");
        this.caps.nativePythonPath = info.python3_path;
        this.pyAdapter = PY_ADAPTER;
      }
      if (info.gxx_path) {
        langs.push("cpp");
        this.caps.nativeGxxPath = info.gxx_path;
        this.cppAdapter = CPP_ADAPTER;
        this.retraceH = CPP_RETRACE_H;
      }
      this.caps.languages = langs;
    } catch {
      // Non-Tauri environment or toolchain check failed
      this.caps.languages = [];
    }
    opts?.onProgress?.("init.backend", 100);
    return { ...this.caps };
  }

  getCapabilities(): RecorderCapabilities {
    return { ...this.caps };
  }

  async recordPython(
    source: string,
    opts: RecordOptions = {}
  ): Promise<RecordResult> {
    if (!this.caps.languages.includes("python")) {
      return makeError({
        lang: "python",
        summary:
          "本机未检测到 python3（请安装或等待 HybridRecorderService 回退到 Pyodide）",
      });
    }
    try {
      const rust = (await this.invokeFn("python_record", {
        source,
        adapterScript: this.pyAdapter,
        maxSteps: opts.maxSteps ?? 10000,
        timeoutMs: opts.timeoutMs ?? 5000,
        tempFileName: opts.tempFileName ?? "untitled.py",
      })) as RecordResultRust;
      return convertRustResult(rust, "python");
    } catch (e) {
      return makeError({
        lang: "python",
        summary: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async recordCpp(
    source: string,
    opts: RecordOptions = {}
  ): Promise<RecordResult> {
    if (!this.caps.languages.includes("cpp")) {
      return makeError({
        lang: "cpp",
        summary:
          "本机未检测到 g++（请安装或等待 HybridRecorderService 回退到 clangWASM）",
      });
    }
    try {
      const rust = (await this.invokeFn("cpp_record", {
        source,
        adapterScript: this.cppAdapter,
        retraceHeader: this.retraceH,
        maxSteps: opts.maxSteps ?? 10000,
        timeoutMs: opts.timeoutMs ?? 10000,
        tempFileName: opts.tempFileName ?? "untitled.cpp",
      })) as RecordResultRust;
      return convertRustResult(rust, "cpp");
    } catch (e) {
      return makeError({
        lang: "cpp",
        summary: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
