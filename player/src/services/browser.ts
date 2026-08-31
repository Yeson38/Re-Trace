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
sys.argv = ['instrument.py', '/retrace/source.py', '-o', '/retrace/trace.json', '--max-steps', ${maxSteps}]
exec(open('/retrace/instrument.py').read())
`;
      await pyodide.runPythonAsync(pyCode);

      // Read back the trace
      const traceBytes = pyodide.FS.readFile("/retrace/trace.json", {
        encoding: "utf-8",
      });
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
sys.argv = ['instrument.py', '/retrace_cpp/source.cpp', '-o', '/retrace_cpp/source_inst.cpp', '--retrace-header', '/retrace_cpp/retrace.h']
exec(open('/retrace_cpp/instrument.py').read())
`;
      await pyodide.runPythonAsync(instPy);

      const instBytes = pyodide.FS.readFile(
        "/retrace_cpp/source_inst.cpp",
        { encoding: "utf-8" }
      );
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
      const msg = e instanceof Error ? e.message : String(e);
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
   * Run clang-17 WASM to compile + execute the instrumented C++ source.
   * This is a simplified implementation that uses the Wasmer JS SDK
   * to instantiate clang.wasm and pipe source through it.
   *
   * In production, this downloads clang.wasm + lld.wasm from public/assets/wasm/
   * (staged by download_clang_wasm.ts script or CI).
   */
  private async runClangWasi(instrumentedSource: string): Promise<string> {
    // Try to use the Wasmer JS SDK if available
    // Fall back to window.__retrace_last polling

    // Set up the trace emission callback
    let traceJson = "";
    const emitCb = (s: string) => {
      traceJson = s;
    };
    (window as any).__retrace_emit = emitCb;

    // Write source to a virtual FS for clang WASM
    // This requires the Wasmer JS SDK (@wasmer/wasi + @wasmer/wasmfs)
    // For now, we use a simplified approach:
    // 1. Try dynamic import of wasmer SDK
    // 2. If unavailable, throw a clear error

    try {
      // Dynamic import from CDN (esm.sh) — avoids bundling the heavy Wasmer
      // SDK and lets both `vite dev` and `vite build` start without the npm
      // packages installed. Browser fetches them on-demand at record time.
      const WASI = (await import(
        /* @vite-ignore */ "https://esm.sh/@wasmer/wasi@1.2.2"
      )).default;
      const WasmFs = (await import(
        /* @vite-ignore */ "https://esm.sh/@wasmer/wasmfs@1.0.2"
      )).default;

      const wasmFs = new WasmFs();
      const fs = wasmFs.fs;

      // Write source file
      fs.writeFileSync("/source.cpp", instrumentedSource);
      fs.writeFileSync("/retrace.h", await fetchAdapterText(CPP_RETRACE_H));

      // Create a WASI instance for clang
      const wasi = new WASI({
        args: [
          "clang",
          "-O0",
          "-g",
          "-std=c++17",
          "-I",
          "/",
          "/source.cpp",
          "-o",
          "/program.wasm",
        ],
        env: {},
        fs: fs,
        preopens: { "/": "/" },
      });

      // Fetch clang.wasm
      const base = import.meta.env.BASE_URL ?? "./";
      const clangUrl = new URL(
        "assets/wasm/clang.wasm",
        new URL(base, document.baseURI)
      ).href;
      const clangResp = await fetch(clangUrl);
      if (!clangResp.ok) {
        throw new Error(
          `clang.wasm 未找到 (HTTP ${clangResp.status})。请设置 SKIP_CLANG_WASM=false 或手动下载。`
        );
      }
      const clangWasm = await clangResp.arrayBuffer();

      // Instantiate clang
      const module = await WebAssembly.compile(clangWasm);
      await WebAssembly.instantiate(module, {
        ...wasi.getImports(module),
      });

      // clang writes program.wasm — now we need to run it
      // Run the compiled program
      if (fs.existsSync("/program.wasm")) {
        const progWasm = fs.readFileSync("/program.wasm");
        const progModule = await WebAssembly.compile(progWasm);
        const progWasi = new WASI({
          args: ["program"],
          env: {},
          fs: fs,
          preopens: { "/": "/" },
        });
        const progInstance = await WebAssembly.instantiate(progModule, {
          ...progWasi.getImports(progModule),
        });
        try {
          progWasi.start(progInstance);
        } catch (e) {
          // Program exit is normal — trace is flushed via __retrace_emit
        }
      }

      // Check if trace was captured via callback
      if (traceJson) return traceJson;

      // Fall back to reading trace.json from virtual FS
      if (fs.existsSync("/trace.json")) {
        return fs.readFileSync("/trace.json", "utf-8");
      }

      // Fall back to window.__retrace_last
      if ((window as any).__retrace_last) {
        return (window as any).__retrace_last as string;
      }

      throw new Error("C++ 执行完成但未捕获 trace 输出");
    } catch (e) {
      // CDN load failure or runtime WASM error — surface a clear, actionable
      // message. Network/CDN errors and missing clang.wasm are the two main
      // failure modes for the browser C++ pipeline.
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("esm.sh") ||
        msg.includes("Failed to fetch dynamically imported module") ||
        msg.includes("clang.wasm") ||
        msg.includes("网络")
      ) {
        throw new Error(
          "C++ 浏览器录制需要从 CDN 加载 Wasmer SDK 并下载 clang-17 WASM 到 public/assets/wasm/。请检查网络连接，并确保已运行 npm run download:clang-wasm。原始错误：" + msg
        );
      }
      throw e;
    }
  }
}
