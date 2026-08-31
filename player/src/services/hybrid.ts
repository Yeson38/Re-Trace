/**
 * Phase 4 — Hybrid recorder service.
 *
 * Strategy: try Native (Tauri) first; on infrastructure error, fall back
 * to Browser (Pyodide + clangWASM). User-code errors (syntax etc.)
 * do NOT trigger fallback — both backends would produce the same error.
 */
import type {
  IRecorderService,
  RecorderCapabilities,
  RecorderInitOpts,
  RecordResult,
  RecordOptions,
  RecorderLanguage,
} from "./types";
import type { NativeRecorderService } from "./native";
import type { BrowserRecorderService } from "./browser";

function isInfraError(summary?: string): boolean {
  if (!summary) return false;
  const lower = summary.toLowerCase();
  return /找不到 python3|找不到 g\+\+|apt install|spawn failed|timeout|not found|enoent/.test(
    lower
  );
}

function mergeCaps(
  a: RecorderCapabilities,
  b: RecorderCapabilities
): RecorderCapabilities {
  const s = new Set<RecorderLanguage>([...a.languages, ...b.languages]);
  return {
    languages: [...s],
    backendName: "hybrid",
    nativePythonPath: a.nativePythonPath ?? b.nativePythonPath,
    nativeGxxPath: a.nativeGxxPath ?? b.nativeGxxPath,
    pyodideReady: b.pyodideReady ?? a.pyodideReady ?? false,
    cppBrowserNotice: b.cppBrowserNotice ?? a.cppBrowserNotice,
  };
}

export class HybridRecorderService implements IRecorderService {
  private caps: RecorderCapabilities = {
    languages: [],
    backendName: "hybrid",
  };

  constructor(
    private native: NativeRecorderService,
    private browser: BrowserRecorderService
  ) {}

  async init(opts?: RecorderInitOpts): Promise<RecorderCapabilities> {
    // Init both backends in parallel
    const [nCaps, bCaps] = await Promise.all([
      this.native.init(opts),
      this.browser.init(opts),
    ]);
    this.caps = mergeCaps(nCaps, bCaps);
    return { ...this.caps };
  }

  getCapabilities(): RecorderCapabilities {
    return { ...this.caps };
  }

  async recordPython(
    source: string,
    opts?: RecordOptions
  ): Promise<RecordResult> {
    if (this.native.getCapabilities().languages.includes("python")) {
      const r = await this.native.recordPython(source, opts);
      if (r.ok) return r;
      if (isInfraError(r.summary)) return this.browser.recordPython(source, opts);
      return r;
    }
    return this.browser.recordPython(source, opts);
  }

  async recordCpp(
    source: string,
    opts?: RecordOptions
  ): Promise<RecordResult> {
    if (this.native.getCapabilities().languages.includes("cpp")) {
      const r = await this.native.recordCpp(source, opts);
      if (r.ok) return r;
      if (isInfraError(r.summary)) return this.browser.recordCpp(source, opts);
      return r;
    }
    return this.browser.recordCpp(source, opts);
  }
}
