/**
 * Phase 4 — Browser recorder service.
 *
 * Python recording: loads Pyodide, fetches adapters/python/instrument.py,
 * instruments + executes source, captures trace.json output.
 *
 * C++ recording: Pyodide instruments C++ source using adapters/cpp/instrument.py,
 * then compiles + runs via Wasmer/ClangWASI pipeline, captures trace via
 * retrace.h __WASM__ JS callback.
 *
 * All pure helper functions (diagnostic parsing, trace parsing) are exported
 * for unit testing without a browser environment.
 */
import type {
  IRecorderService,
  RecorderCapabilities,
  RecorderInitOpts,
  RecordResult,
  RecordOptions,
} from "./types";
import { makeSuccess, makeError } from "./factories";
import {
  parsePyDiagnostic,
  parseGccDiagnostics,
  parseTraceJson,
} from "./browserHelpers";
// Re-export pure helpers so existing imports keep working
export {
  parsePyDiagnostic,
  parseGccDiagnostics,
  parseTraceJson,
  buildTraceFile,
} from "./browserHelpers";

// ---------------------------------------------------------------------------
// BrowserRecorderService
// ---------------------------------------------------------------------------

// Pyodide types (minimal)
interface PyodideAPI {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  globals: {
    get(key: string): unknown;
    set(key: string, val: unknown): void;
  };
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  FS: {
    readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
    writeFile(path: string, data: string): void;
    mkdir(path: string): void;
  };
  loadPackagesFromNames(names: string[]): Promise<void>;
}

let _pyodidePromise: Promise<PyodideAPI> | null = null;

async function loadPyodide(): Promise<PyodideAPI> {
  if (_pyodidePromise) return _pyodidePromise;
  _pyodidePromise = (async () => {
    // Dynamic import of Pyodide from CDN
    const mod = await import(
      /* @vite-ignore */ "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.mjs"
    );
    const pyodide = await mod.loadPyodide();
    return pyodide as unknown as PyodideAPI;
  })();
  return _pyodidePromise;
}

async function fetchAdapterText(path: string): Promise<string> {
  const base = import.meta.env.BASE_URL ?? "./";
  const url = new URL(path, new URL(base, document.baseURI)).href;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return r.text();
}

const PY_ADAPTER = "adapters/python/instrument.py";
const CPP_ADAPTER = "adapters/cpp/instrument.py";
const CPP_RETRACE_H = "adapters/cpp/retrace.h";

export class BrowserRecorderService implements IRecorderService {
  private caps: RecorderCapabilities = {
    languages: ["python"], // C++ added after first clang-wasm download
    backendName: "browser",
    pyodideReady: false,
    cppBrowserNotice:
      "C++ 录制首次需下载浏览器内编译器 (~100MB)，Chromium 内核浏览器体验最佳",
  };

  getCapabilities(): RecorderCapabilities {
    return { ...this.caps };
  }

  async init(
    opts?: RecorderInitOpts
  ): Promise<RecorderCapabilities> {
    opts?.onProgress?.("init.backend", 0);
    try {
      // Pre-load Pyodide (lazy: only when first needed, but init can trigger it)
      // For init we just mark ready status — actual Pyodide load is deferred
      // to the first recordPython call to avoid blocking UI startup.
      this.caps.pyodideReady = false;
      opts?.onProgress?.("init.backend", 100);
    } catch {
      // Non-fatal: Pyodide loads on demand
    }
    return { ...this.caps };
  }

  async recordPython(
    source: string,
    opts: RecordOptions = {}
  ): Promise<RecordResult> {
    const t0 = performance.now();
    try {
      const pyodide = await loadPyodide();
      this.caps.pyodideReady = true;

      // Fetch the Python instrument adapter
      const adapterSrc = await fetchAdapterText(PY_ADAPTER);

      // Set up stdout/stderr capture
      let stdoutBuf = "";
      let stderrBuf = "";
      pyodide.setStdout({ batched: (s) => (stdoutBuf += s) });
      pyodide.setStderr({ batched: (s) => (stderrBuf += s) });

      // Write the adapter and source into Pyodide's filesystem
      pyodide.FS.mkdir("/retrace");
      pyodide.FS.writeFile("/retrace/instrument.py", adapterSrc);
      pyodide.FS.writeFile("/retrace/source.py", source);

      // Run the adapter: it instruments + executes source.py and writes trace.json
      const maxSteps = opts.maxSteps ?? 10000;
      const pyCode = `
import sys, json
sys.argv = ['instrument.py', '/retrace/source.py', '-o', '/retrace/trace.json', '--max-steps', '${maxSteps}']
exec(open('/retrace/instrument.py').read())
`;
      // instrument.py may call sys.exit(0) on success; Pyodide surfaces that
      // as a Python exception. Treat SystemExit(0) as normal completion.
      try {
        await pyodide.runPythonAsync(pyCode);
      } catch (e) {
        const msg = String(e);
        if (!msg.includes("SystemExit") && !/SystemExit: 0/.test(msg)) {
          throw e;
        }
      }

      // Read back the trace (Pyodide FS.readFile returns Uint8Array)
      const traceBytes = pyodide.FS.readFile("/retrace/trace.json") as
        | Uint8Array
        | string;
      const traceStr =
        typeof traceBytes === "string"
          ? traceBytes
          : new TextDecoder().decode(traceBytes);

      const trace = parseTraceJson(traceStr);
      if (!trace) {
        return makeError({
          lang: "python",
          summary: "trace.json 解析失败或格式不合法",
          instrumentMs: performance.now() - t0,
          runMs: 0,
        });
      }

      return makeSuccess({
        lang: "python",
        trace,
        instrumentMs: performance.now() - t0,
        runMs: 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const diags = parsePyDiagnostic(msg);
      return makeError({
        lang: "python",
        summary: msg,
        diagnostics: diags.length ? diags : undefined,
        instrumentMs: performance.now() - t0,
      });
    }
  }

  async recordCpp(
    source: string,
    opts: RecordOptions = {}
  ): Promise<RecordResult> {
    const t0 = performance.now();
    const compileStart = performance.now();
    void opts;
    try {
      // Phase 1: Instrument C++ source using Pyodide + adapters/cpp/instrument.py
      const pyodide = await loadPyodide();
      this.caps.pyodideReady = true;

      const adapterSrc = await fetchAdapterText(CPP_ADAPTER);
      const retraceH = await fetchAdapterText(CPP_RETRACE_H);

      let stderrBuf = "";
      pyodide.setStderr({ batched: (s) => (stderrBuf += s) });

      pyodide.FS.mkdir("/retrace_cpp");
      pyodide.FS.writeFile("/retrace_cpp/instrument.py", adapterSrc);
      pyodide.FS.writeFile("/retrace_cpp/retrace.h", retraceH);
      pyodide.FS.writeFile("/retrace_cpp/source.cpp", source);

      // Run the C++ instrument adapter to produce instrumented source
      const instPy = `
import sys
sys.argv = ['instrument.py', '/retrace_cpp/source.cpp', '-o', '/retrace_cpp/source_inst.cpp']
exec(open('/retrace_cpp/instrument.py').read())
`;
      // instrument.py may call sys.exit(0); treat as normal completion.
      try {
        await pyodide.runPythonAsync(instPy);
      } catch (e) {
        const msg = String(e);
        if (!msg.includes("SystemExit") && !/SystemExit: 0/.test(msg)) {
          throw e;
        }
      }

      const instBytes = pyodide.FS.readFile(
        "/retrace_cpp/source_inst.cpp"
      ) as Uint8Array | string;
      const instrumentedSource =
        typeof instBytes === "string"
          ? instBytes
          : new TextDecoder().decode(instBytes);

      const compileMs = performance.now() - compileStart;

      // Phase 2: Compile + execute via Wasmer/ClangWASI
      // This phase uses the clang-17 WASM package downloaded to public/assets/wasm/
      // The compiled binary runs in a WASI environment, and retrace.h's
      // __WASM__ branch flushes trace via window.__retrace_emit callback.
      const traceStr = await this.runClangWasi(instrumentedSource);

      const runMs = performance.now() - t0 - compileMs;

      const trace = parseTraceJson(traceStr);
      if (!trace) {
        return makeError({
          lang: "cpp",
          summary: "C++ trace.json 解析失败或格式不合法",
          compileMs,
          instrumentMs: compileMs,
          runMs,
        });
      }

      return makeSuccess({
        lang: "cpp",
        trace,
        instrumentMs: compileMs,
        compileMs,
        runMs,
      });
    } catch (e) {
      // Debug: surface the raw error shape (some SDK errors are plain objects)
      console.error("[retrace/cpp] raw error:", e);
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : (e as any)?.message ?? JSON.stringify(e);
      const diags = parseGccDiagnostics(msg);
      return makeError({
        lang: "cpp",
        summary: msg,
        diagnostics: diags.length ? diags : undefined,
        instrumentMs: performance.now() - t0,
      });
    }
  }

  /**
   * Compile + execute the instrumented C++ source in the browser.
   *
   * Uses the modern Wasmer JS SDK (`@wasmer/sdk`) and pulls the `clang/clang`
   * package from the Wasmer registry on first use (~100 MB, cached by the
   * browser). No local `clang.wasm` file is required.
   *
   * Pipeline:
   *   1. Write instrumented source + retrace.h into a virtual Directory.
   *   2. `clang` (wasm32-wasi) compiles `/source.cpp` → `/program.wasm`.
   *   3. Run `/program.wasm`; retrace.h's `__WASM__` branch writes trace.json
   *      into the same virtual filesystem.
   *   4. Read `trace.json` back from the virtual Directory and return it.
   */
  private async runClangWasi(instrumentedSource: string): Promise<string> {
    let traceJson = "";
    const emitCb = (s: string) => {
      traceJson = s;
    };
    (window as any).__retrace_emit = emitCb;

    try {
      // Dynamic import from CDN — avoids bundling the heavy Wasmer SDK.
      // jsdelivr serves the prebuilt ESM entry; esm.sh occasionally 500s on
      // bundled wasmer SDK requests from browser UAs.
      const sdk: any = await import(
        /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@wasmer/sdk@0.8.0/dist/index.mjs"
      );
      const { Wasmer, Directory, init } = sdk;

      await init();

      // clang/clang from the Wasmer registry — first run downloads ~100 MB
      // and the browser caches it for subsequent runs.
      const clang = await Wasmer.fromRegistry("clang/clang");
      const project = new Directory();
      await project.writeFile("source.cpp", instrumentedSource);
      await project.writeFile("retrace.h", await fetchAdapterText(CPP_RETRACE_H));

      // --- Compile ---------------------------------------------------------
      const compileRun = await clang.entrypoint.run({
        args: [
          "-O0",
          "-g",
          "-std=c++17",
          "-I",
          "/",
          "/source.cpp",
          "-o",
          "/program.wasm",
        ],
        mount: { "/": project },
      });
      const compileOut = await compileRun.wait();
      if (!compileOut.ok) {
        const err =
          (compileOut.stderr as string) ||
          `clang exited with code ${compileOut.code}`;
        throw new Error("C++ 编译失败：\n" + err);
      }

      // --- Run -------------------------------------------------------------
      const wasmBytes = await project.readFile("program.wasm");
      const program = await Wasmer.fromBytes(wasmBytes);
      const runRun = await program.entrypoint.run({
        args: ["program"],
        mount: { "/": project },
      });
      // Program exit (even non-zero) is fine — trace is flushed at atexit.
      await runRun.wait().catch(() => {});

      // --- Read trace ------------------------------------------------------
      if (traceJson) return traceJson;

      try {
        const traceBytes = await project.readFile("trace.json");
        return new TextDecoder().decode(traceBytes);
      } catch {
        // trace.json not written — fall back to window.__retrace_last
        if ((window as any).__retrace_last) {
          return (window as any).__retrace_last as string;
        }
      }

      throw new Error("C++ 执行完成但未捕获 trace 输出");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("esm.sh") ||
        msg.includes("Failed to fetch dynamically imported module") ||
        msg.includes("network") ||
        msg.toLowerCase().includes("registry")
      ) {
        throw new Error(
          "C++ 浏览器录制需要从 CDN 加载 Wasmer SDK 并从 Wasmer registry 拉取 clang 包（首次约 100MB）。请检查网络连接。原始错误：" +
            msg
        );
      }
      throw e;
    }
  }
}
