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
exports.NativeRecorderService = void 0;
exports.convertRustResult = convertRustResult;
const factories_1 = require("./factories");
/** Default invoke bridge — uses Tauri's @tauri-apps/api/core.invoke */
function defaultInvoke(cmd, args) {
    // Dynamic import so non-Tauri builds don't crash at module load
    return Promise.resolve().then(() => __importStar(require("@tauri-apps/api/core"))).then(({ invoke }) => invoke(cmd, args));
}
/** Cross the Rust → TS type boundary. Exported for unit testing. */
function convertRustResult(rust, lang) {
    if (!rust || typeof rust !== "object") {
        return (0, factories_1.makeError)({
            lang,
            summary: `Tauri 返回值非法：${JSON.stringify(rust).slice(0, 120)}`,
        });
    }
    const timing = {
        instrumentMs: Number(rust.timing?.instrument_ms ?? 0),
        compileMs: typeof rust.timing?.compile_ms === "number"
            ? Number(rust.timing.compile_ms)
            : undefined,
        runMs: Number(rust.timing?.run_ms ?? 0),
    };
    const diagnostics = Array.isArray(rust.diagnostics)
        ? rust.diagnostics.map((d) => (0, factories_1.makeDiagnostic)(d.severity === "warning" ? "warning" : "error", String(d.message ?? ""), {
            line: typeof d.line === "number" ? d.line : undefined,
            column: typeof d.column === "number" ? d.column : undefined,
            raw: typeof d.raw === "string" ? d.raw : undefined,
        }))
        : [];
    if (rust.ok && typeof rust.trace_file_json === "string") {
        let trace;
        try {
            trace = JSON.parse(rust.trace_file_json);
        }
        catch (e) {
            return (0, factories_1.makeError)({
                lang,
                summary: "trace.json 解析失败：" +
                    (e instanceof Error ? e.message : String(e)),
                diagnostics,
                ...timing,
            });
        }
        return (0, factories_1.makeSuccess)({
            lang,
            trace,
            ...timing,
        });
    }
    return (0, factories_1.makeError)({
        lang,
        summary: typeof rust.summary === "string"
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
class NativeRecorderService {
    constructor(invoke) {
        this.caps = {
            languages: [],
            backendName: "native",
        };
        this.pyAdapter = "";
        this.cppAdapter = "";
        this.retraceH = "";
        this.invokeFn = invoke ?? defaultInvoke;
    }
    async init(opts) {
        opts?.onProgress?.("init.backend", 0);
        try {
            const info = (await this.invokeFn("native_check_toolchains"));
            const langs = [];
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
        }
        catch {
            // Non-Tauri environment or toolchain check failed
            this.caps.languages = [];
        }
        opts?.onProgress?.("init.backend", 100);
        return { ...this.caps };
    }
    getCapabilities() {
        return { ...this.caps };
    }
    async recordPython(source, opts = {}) {
        if (!this.caps.languages.includes("python")) {
            return (0, factories_1.makeError)({
                lang: "python",
                summary: "本机未检测到 python3（请安装或等待 HybridRecorderService 回退到 Pyodide）",
            });
        }
        try {
            const rust = (await this.invokeFn("python_record", {
                source,
                adapterScript: this.pyAdapter,
                maxSteps: opts.maxSteps ?? 10000,
                timeoutMs: opts.timeoutMs ?? 5000,
                tempFileName: opts.tempFileName ?? "untitled.py",
            }));
            return convertRustResult(rust, "python");
        }
        catch (e) {
            return (0, factories_1.makeError)({
                lang: "python",
                summary: e instanceof Error ? e.message : String(e),
            });
        }
    }
    async recordCpp(source, opts = {}) {
        if (!this.caps.languages.includes("cpp")) {
            return (0, factories_1.makeError)({
                lang: "cpp",
                summary: "本机未检测到 g++（请安装或等待 HybridRecorderService 回退到 clangWASM）",
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
            }));
            return convertRustResult(rust, "cpp");
        }
        catch (e) {
            return (0, factories_1.makeError)({
                lang: "cpp",
                summary: e instanceof Error ? e.message : String(e),
            });
        }
    }
}
exports.NativeRecorderService = NativeRecorderService;
