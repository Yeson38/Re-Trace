"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserRecorderService = void 0;
exports.parsePyDiagnostic = parsePyDiagnostic;
exports.parseGccDiagnostics = parseGccDiagnostics;
exports.parseTraceJson = parseTraceJson;
exports.buildTraceFile = buildTraceFile;
const factories_1 = require("./factories");
// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------
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
            // Next non-empty line is usually the error message
            const next = lines[i + 2]?.trim() || lines[i + 1]?.trim();
            if (next)
                msgLine = next;
        }
    }
    // Also check for SyntaxError format: "  SyntaxError: invalid syntax"
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
let _pyodidePromise = null;
async function loadPyodide() {
    if (_pyodidePromise)
        return _pyodidePromise;
    _pyodidePromise = (async () => {
        // Dynamic import of Pyodide from CDN
        const mod = await Promise.resolve().then(() => __importStar(require(
        /* @vite-ignore */ "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.mjs")));
        const pyodide = await mod.loadPyodide();
        return pyodide;
    })();
    return _pyodidePromise;
}
async function fetchAdapterText(path) {
    const base = import.meta.env.BASE_URL ?? "./";
    const url = new URL(path, new URL(base, document.baseURI)).href;
    const r = await fetch(url);
    if (!r.ok)
        throw new Error(`fetch ${url} → HTTP ${r.status}`);
    return r.text();
}
const PY_ADAPTER = "adapters/python/instrument.py";
const CPP_ADAPTER = "adapters/cpp/instrument.py";
const CPP_RETRACE_H = "adapters/cpp/retrace.h";
class BrowserRecorderService {
    constructor() {
        this.caps = {
            languages: ["python"], // C++ added after first clang-wasm download
            backendName: "browser",
            pyodideReady: false,
            cppBrowserNotice: "C++ 录制首次需下载浏览器内编译器 (~100MB)，Chromium 内核浏览器体验最佳",
        };
    }
    getCapabilities() {
        return { ...this.caps };
    }
    async init(opts) {
        opts?.onProgress?.("init.backend", 0);
        try {
            // Pre-load Pyodide (lazy: only when first needed, but init can trigger it)
            // For init we just mark ready status — actual Pyodide load is deferred
            // to the first recordPython call to avoid blocking UI startup.
            this.caps.pyodideReady = false;
            opts?.onProgress?.("init.backend", 100);
        }
        catch {
            // Non-fatal: Pyodide loads on demand
        }
        return { ...this.caps };
    }
    async recordPython(source, opts = {}) {
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
            const traceStr = typeof traceBytes === "string"
                ? traceBytes
                : new TextDecoder().decode(traceBytes);
            const trace = parseTraceJson(traceStr);
            if (!trace) {
                return (0, factories_1.makeError)({
                    lang: "python",
                    summary: "trace.json 解析失败或格式不合法",
                    instrumentMs: performance.now() - t0,
                    runMs: 0,
                });
            }
            return (0, factories_1.makeSuccess)({
                lang: "python",
                trace,
                instrumentMs: performance.now() - t0,
                runMs: 0,
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const diags = parsePyDiagnostic(msg);
            return (0, factories_1.makeError)({
                lang: "python",
                summary: msg,
                diagnostics: diags.length ? diags : undefined,
                instrumentMs: performance.now() - t0,
            });
        }
    }
    async recordCpp(source, opts = {}) {
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
            const instBytes = pyodide.FS.readFile("/retrace_cpp/source_inst.cpp", { encoding: "utf-8" });
            const instrumentedSource = typeof instBytes === "string"
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
                return (0, factories_1.makeError)({
                    lang: "cpp",
                    summary: "C++ trace.json 解析失败或格式不合法",
                    compileMs,
                    instrumentMs: compileMs,
                    runMs,
                });
            }
            return (0, factories_1.makeSuccess)({
                lang: "cpp",
                trace,
                instrumentMs: compileMs,
                compileMs,
                runMs,
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const diags = parseGccDiagnostics(msg);
            return (0, factories_1.makeError)({
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
    async runClangWasi(instrumentedSource) {
        // Try to use the Wasmer JS SDK if available
        // Fall back to window.__retrace_last polling
        // Set up the trace emission callback
        let traceJson = "";
        const emitCb = (s) => {
            traceJson = s;
        };
        window.__retrace_emit = emitCb;
        // Write source to a virtual FS for clang WASM
        // This requires the Wasmer JS SDK (@wasmer/wasi + @wasmer/wasmfs)
        // For now, we use a simplified approach:
        // 1. Try dynamic import of wasmer SDK
        // 2. If unavailable, throw a clear error
        try {
            // Dynamic import — these packages are optional peer deps
            const WASI = (await Promise.resolve().then(() => __importStar(require("@wasmer/wasi")))).default;
            const WasmFs = (await Promise.resolve().then(() => __importStar(require("@wasmer/wasmfs")))).default;
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
            const clangUrl = new URL("assets/wasm/clang.wasm", new URL(base, document.baseURI)).href;
            const clangResp = await fetch(clangUrl);
            if (!clangResp.ok) {
                throw new Error(`clang.wasm 未找到 (HTTP ${clangResp.status})。请设置 SKIP_CLANG_WASM=false 或手动下载。`);
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
                }
                catch (e) {
                    // Program exit is normal — trace is flushed via __retrace_emit
                }
            }
            // Check if trace was captured via callback
            if (traceJson)
                return traceJson;
            // Fall back to reading trace.json from virtual FS
            if (fs.existsSync("/trace.json")) {
                return fs.readFileSync("/trace.json", "utf-8");
            }
            // Fall back to window.__retrace_last
            if (window.__retrace_last) {
                return window.__retrace_last;
            }
            throw new Error("C++ 执行完成但未捕获 trace 输出");
        }
        catch (e) {
            // If Wasmer SDK isn't available, provide a clear error
            if (e instanceof Error && e.message.includes("Cannot find module")) {
                throw new Error("C++ 浏览器录制需要 Wasmer SDK (@wasmer/wasi, @wasmer/wasmfs) 和 clang-17 WASM。请运行 npm install @wasmer/wasi @wasmer/wasmfs 并确保 clang.wasm 已下载到 public/assets/wasm/。");
            }
            throw e;
        }
    }
}
exports.BrowserRecorderService = BrowserRecorderService;
