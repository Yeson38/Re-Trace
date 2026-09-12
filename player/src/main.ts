/**
 * Re-Trace Player entry point.
 *
 * Phase 0-3: Loads demo trace, instantiates player + views, wires transport.
 * Phase 4: Two-phase bootstrap — Phase 0-3 runs immediately, Phase 4 (Monaco
 * editor, TopBar, recorder service) initializes in parallel via bootstrapPhase4().
 *
 * Keyboard: ← / → step, Space toggles play, Home restarts, End jumps to last,
 *           F3 next match, Enter search (Shift+Enter previous).
 *           Ctrl+F5 toggle record, Ctrl+O import, Ctrl+S export.
 */
import { Player } from "./player";
import { CodeView } from "./ui/codeView";
import { VarTree } from "./ui/varTree";
import { Terminal } from "./ui/terminal";
import { Controls } from "./ui/controls";
import { SearchBar } from "./ui/searchBar";
// Phase 4 imports
import { MonacoEditorWidget } from "./ui/monaco";
import { TopBarWidget } from "./ui/topBar";
import { toastStack } from "./ui/toast";
import { buildRecorder, initRecorder } from "./services/bootstrap";
import { PYTHON_BUBBLE, CPP_BUBBLE } from "./templates/loaders";
import type {
  IRecorderService,
  RecorderLanguage,
  RecordResult,
} from "./services/types";
import type { TraceFile } from "./types";

async function loadTrace(): Promise<TraceFile> {
  const url = `${import.meta.env.BASE_URL}samples/bubble_sort.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load trace: ${res.status} ${url}`);
  return (await res.json()) as TraceFile;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

async function main(): Promise<void> {
  // =================================================================
  // Phase 0-3: Load trace + instantiate views
  // =================================================================
  const file = await loadTrace();

  document.getElementById("sourceName")!.textContent = `${file.source.name} · ${file.steps.length} steps`;

  const player = new Player();
  player.load(file);

  // --- Views ---
  // CodeView is kept hidden as fallback; Monaco replaces it when ready.
  const codeView = new CodeView(el("code"), file);
  const varTree = new VarTree(el("vars"));
  const terminal = new Terminal(el("terminal"));

  // Diff anchors tracked by the main glue.
  let markA: number | null = null;
  let markB: number | null = null;

  const markChipsHost = el("markChips");
  function renderMarkChips(): void {
    markChipsHost.replaceChildren();
    const mkChip = (label: string, idx: number | null, tone: "a" | "b") => {
      const s = document.createElement("span");
      s.className = `mark-chip mark-chip-${tone}${idx === null ? " dim" : ""}`;
      if (idx === null) {
        s.textContent = `${label}: —`;
        s.title = `No ${label} anchor set. Click "Mark ${label.toUpperCase()}" on the transport bar.`;
      } else {
        s.textContent = `${label}: #${idx + 1}`;
        s.title = `Click to jump to ${label} anchor (step #${idx + 1}).`;
        s.style.cursor = "pointer";
        s.addEventListener("click", () => player.goto(idx));
      }
      return s;
    };
    markChipsHost.append(mkChip("A", markA, "a"), mkChip("B", markB, "b"));
  }

  const controls = new Controls(el("controls"), el("loops"), player, file, {
    onMarkA: (i) => { markA = i; controls.setMarks(markA, markB); renderMarkChips(); render(); },
    onMarkB: (i) => { markB = i; controls.setMarks(markA, markB); renderMarkChips(); render(); },
    onClearMarks: () => { markA = null; markB = null; controls.setMarks(null, null); renderMarkChips(); render(); },
  });

  el("cpxHost").replaceChildren(controls.overallOrderPill());

  new SearchBar(el("searchBar"), file, player, {
    onMatches: () => {},
    onError: (msg) => { toastStack.warn(msg); },
  });

  const stepCounter = el("stepCounter");
  const globalStep = el("globalStep");
  const depthCounter = el("depthCounter");

  // --- Render loop ---
  // Module-level references for Phase 4 (Monaco + recorder)
  let monaco: MonacoEditorWidget | null = null;
  let monacoReady = false;

  function render(): void {
    const state = player.getState();
    const step = player.currentStep();

    controls.sync(state);

    if (step) {
      // Use Monaco if ready, else CodeView
      if (monacoReady && monaco) {
        monaco.setFrameDecorations({
          currentLine: step.line,
          markALine: markA != null ? file.steps[markA]?.line : undefined,
          markBLine: markB != null ? file.steps[markB]?.line : undefined,
        });
      } else {
        codeView.highlight(step.line);
      }

      if (markA !== null && markB !== null) {
        const aStep = file.steps[markA];
        const bStep = file.steps[markB];
        varTree.renderDiff(aStep.vars, bStep.vars, {
          aLabel: `#${markA + 1}`,
          bLabel: `#${markB + 1}`,
        });
      } else {
        varTree.render(step.vars);
      }

      controls.renderLoops(step.loops);
      terminal.render(file.steps, state.index);
      stepCounter.textContent = `${state.index + 1} / ${state.total}`;
      globalStep.textContent = String(step.globalStep);
      depthCounter.textContent = String(step.depth);
    } else {
      varTree.render([]);
      controls.renderLoops([]);
      terminal.render(file.steps, -1);
      stepCounter.textContent = `0 / ${state.total}`;
      globalStep.textContent = "0";
      depthCounter.textContent = "0";
    }
  }

  player.subscribe(render);
  renderMarkChips();
  controls.setMarks(null, null);
  render();

  // =================================================================
  // Phase 4: Bootstrap Monaco + TopBar + Recorder (async, parallel)
  // =================================================================
  let recorder: IRecorderService | null = null;
  let topbar: TopBarWidget | null = null;

  // Debug hook for E2E/browser tests (harmless in production).
  Object.defineProperty(window, "__retrace", {
    configurable: true,
    get: () => ({ recorder, monaco, topbar, doRecord }),
  });
  let currentEditorFilename = "bubble_sort.py";

  async function bootstrapPhase4(): Promise<void> {
    // 1. Monaco editor
    const editorHost = el("editorHost");
    monaco = new MonacoEditorWidget(editorHost);
    await monaco.ensureLoaded();
    monacoReady = true;
    monaco.setLanguage("python");
    monaco.setValue(PYTHON_BUBBLE, { markClean: true, language: "python" });

    // 3. Editor header (declared before first use to avoid TDZ on `header`)
    const header = el("editorHeader");
    function renderEditorHeader(): void {
      if (!monaco || !header) return;
      header.innerHTML = "";
      const left = document.createElement("div");
      left.className = "rt-filename";
      left.textContent = currentEditorFilename;
      if (monaco.isDirty()) left.classList.add("rt-filename-dirty");
      header.appendChild(left);
      const right = document.createElement("div");
      right.style.cssText = "display:inline-flex;align-items:center;gap:8px;";
      const lg = monaco.getLanguage();
      right.innerHTML = `<span class="rt-cap-chip">${lg === "python" ? "Python · UTF-8" : "C++ · UTF-8"}</span>`;
      header.appendChild(right);
    }

    // Render header
    renderEditorHeader();

    // 2. TopBar
    topbar = new TopBarWidget(el("topBar"), {
      onNew: (lang: RecorderLanguage) => {
        if (!monaco) return;
        if (lang === "python") {
          monaco.setValue(PYTHON_BUBBLE, { language: "python", markClean: true });
          currentEditorFilename = "untitled.py";
        } else {
          monaco.setValue(CPP_BUBBLE, { language: "cpp", markClean: true });
          currentEditorFilename = "untitled.cpp";
        }
        renderEditorHeader();
      },
      onImportFile: async (f: File) => {
        if (!monaco) return;
        const text = await f.text();
        let lang: RecorderLanguage = "python";
        if (/\.(cpp|cxx|cc|h|hpp)$/i.test(f.name)) lang = "cpp";
        // Load trace.json directly
        if (/\.json$/i.test(f.name) && f.name.includes("trace")) {
          try {
            const tf = JSON.parse(text) as TraceFile;
            loadTraceFromMemory(tf);
            toastStack.success(`已加载 trace：${f.name}（共 ${tf.steps.length} 步）`);
            return;
          } catch {
            toastStack.warn(`${f.name} 不是合法 trace.json，按源码导入`);
          }
        }
        monaco.setValue(text, { language: lang, markClean: true });
        monaco.setLanguage(lang);
        currentEditorFilename = f.name;
        renderEditorHeader();
      },
      onExport: () => {
        const lang = monaco?.getLanguage() ?? "python";
        const ext = lang === "python" ? "py" : "cpp";
        const name = currentEditorFilename.endsWith("." + ext)
          ? currentEditorFilename
          : `${currentEditorFilename.replace(/\.[^.]+$/, "") || "untitled"}.${ext}`;
        return { name, content: monaco?.getValue() ?? "", lang };
      },
      onToggleRecord: () => {
        void doRecord();
      },
      onToggleLanguage: (next: RecorderLanguage) => {
        if (!monaco) return;
        monaco.setLanguage(next);
        const newExt = next === "python" ? "py" : "cpp";
        currentEditorFilename = currentEditorFilename.replace(/\.[^.]+$/, `.${newExt}`);
        if (!/\.[^.]+$/.test(currentEditorFilename)) currentEditorFilename += `.${newExt}`;
        renderEditorHeader();
      },
    });

    monaco.setDirtyChangeHandler(() => renderEditorHeader());

    // 4. Init recorder
    topbar.setRecordingDisabled("正在初始化录制服务…");
    recorder = buildRecorder();
    const caps = await initRecorder(recorder, {
      onProgress: (stage: string, pct?: number) => {
        topbar?.setChipState({ kind: "progress", text: translateStage(stage), pct });
      },
    });
    topbar.setCapabilities(caps);
    topbar.setRecordingIdle();
    topbar.setChipState({ kind: "idle" });

    // Notice if Tauri toolchains missing
    if (caps.backendName === "hybrid" && (!caps.nativePythonPath || !caps.nativeGxxPath)) {
      const missing: string[] = [];
      if (!caps.nativePythonPath) missing.push("python3");
      if (!caps.nativeGxxPath) missing.push("g++");
      toastStack.warn(`Tauri 端未检测到：${missing.join(", ")}。将自动回退到浏览器录制。`);
    }
  }

  function translateStage(s: string): string {
    const map: Record<string, string> = {
      "init.backend": "加载录制后端",
      instrument: "代码插桩",
      compile: "编译 C++",
      run: "执行代码",
      flush: "写入 trace",
    };
    return map[s] ?? s;
  }

  // --- Record controller ---
  let recording = false;
  async function doRecord(): Promise<void> {
    if (recording || !recorder || !monaco || !topbar) return;
    recording = true;
    topbar.setRecordingRunning("插桩中", 5);
    monaco.setDiagnostics([]);
    const source = monaco.getValue();
    const lang = monaco.getLanguage();
    const startMs = performance.now();
    try {
      const result: RecordResult =
        lang === "python"
          ? await recorder.recordPython(source, { tempFileName: currentEditorFilename })
          : await recorder.recordCpp(source, { tempFileName: currentEditorFilename });
      handleRecordResult(result, Math.round(performance.now() - startMs));
    } catch (e) {
      topbar.setChipState({ kind: "error", text: "录制异常中断" });
      topbar.notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      recording = false;
      topbar.setRecordingIdle();
    }
  }

  function handleRecordResult(r: RecordResult, wallMs: number): void {
    if (!topbar || !monaco) return;
    if (r.ok && r.traceFile) {
      topbar.setChipState({
        kind: "success",
        text: `${r.traceFile.steps.length} 步 · ${wallMs}ms`,
      });
      loadTraceFromMemory(r.traceFile);
      toastStack.success(
        `录制成功：${r.traceFile.steps.length} 步` +
          (r.timing.compileMs
            ? `（插桩 ${r.timing.instrumentMs}ms / 编译 ${r.timing.compileMs}ms / 执行 ${r.timing.runMs}ms）`
            : `（插桩 ${r.timing.instrumentMs}ms / 执行 ${r.timing.runMs}ms）`),
        2800
      );
    } else {
      topbar.setChipState({ kind: "error", text: r.summary ?? "录制失败" });
      monaco.setDiagnostics(r.diagnostics ?? []);
      if (r.diagnostics?.[0]?.line) monaco.revealLine(r.diagnostics[0].line);
      topbar.notify(r.summary ?? "录制失败（查看编辑器错误标记）", "error");
    }
  }

  /** Load a trace from memory (from recording result or imported JSON). */
  function loadTraceFromMemory(tf: TraceFile): void {
    if (!monaco) return;
    // Sync Monaco with the trace source
    if (tf.source?.lines?.length) {
      const srcText = tf.source.lines.join("\n");
      if (srcText && srcText !== monaco.getValue()) {
        const lang: RecorderLanguage = tf.source.language === "cpp" ? "cpp" : "python";
        monaco.setValue(srcText, { language: lang, markClean: true });
      }
    }
    // Update player with new trace
    player.load(tf);
    document.getElementById("sourceName")!.textContent =
      `${tf.source.name} · ${tf.steps.length} steps`;
    // Re-render
    render();
    monaco.setDiagnostics([]);
  }

  // --- Launch Phase 4 bootstrap in parallel ---
  void bootstrapPhase4().catch((e) => {
    toastStack.error("Phase 4 初始化失败：" + (e instanceof Error ? e.message : String(e)));
  });

  // =================================================================
  // Keyboard (Phase 0-3 + Phase 4 shortcuts)
  // =================================================================
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;

    // Phase 4 shortcuts
    if (e.ctrlKey && e.key === "F5") {
      e.preventDefault();
      void doRecord();
      return;
    }
    if (e.ctrlKey && e.key === "o") {
      e.preventDefault();
      // Trigger file input click
      (document.querySelector("#topBar input[type=file]") as HTMLElement)?.click();
      return;
    }
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      // Trigger export via the export button
      const exportBtn = document.querySelector("#topBar .rt-btn:nth-of-type(4)") as HTMLElement;
      exportBtn?.click();
      return;
    }

    switch (e.key) {
      case "ArrowLeft":
        player.prev();
        e.preventDefault();
        break;
      case "ArrowRight":
        player.next();
        e.preventDefault();
        break;
      case " ":
        player.toggle();
        e.preventDefault();
        break;
      case "Home":
        player.restart();
        e.preventDefault();
        break;
      case "End":
        player.goto(player.getState().total - 1);
        e.preventDefault();
        break;
    }
  });
}

main().catch((err) => {
  console.error(err);
  const code = document.getElementById("code");
  if (code) code.textContent = `Failed to start player: ${String(err)}`;
});
