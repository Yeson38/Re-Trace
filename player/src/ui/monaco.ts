/**
 * Phase 4 — Monaco Editor widget.
 *
 * Wraps the Monaco editor instance, providing:
 *   - Syntax highlighting (Python / C++)
 *   - Error/warning gutter markers (setDiagnostics)
 *   - Frame highlight decorations (setFrameDecorations)
 *   - Dirty-state tracking
 *   - Language switching
 *
 * The widget replaces Phase 0's read-only CodeView with a full editor.
 */
import type * as Monaco from "monaco-editor";

export interface MonacoSetOptions {
  markClean?: boolean;
  language?: "python" | "cpp";
}

export interface MonacoDiag {
  severity: "error" | "warning";
  line?: number;
  column?: number;
  message: string;
  raw?: string;
}

export class MonacoEditorWidget {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monacoApi: typeof Monaco | null = null;
  private dirty = false;
  private dirtyListeners: Array<() => void> = [];
  private frameDecorations: string[] = [];
  private diagDecorations: string[] = [];

  constructor(private host: HTMLElement) {}

  /** Lazily create the Monaco editor (heavy import). */
  async ensureLoaded(): Promise<void> {
    if (this.editor) return;
    this.monacoApi = await import("monaco-editor");
    const monaco = this.monacoApi;
    const isMobile =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(max-width: 760px)").matches ||
        ("ontouchstart" in window && navigator.maxTouchPoints > 0));
    this.editor = monaco.editor.create(this.host, {
      value: "",
      language: "python",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: isMobile ? 15 : 13,
      lineHeight: isMobile ? 24 : undefined,
      fontFamily: '"JetBrains Mono","Fira Code",Consolas,monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: "on",
      glyphMargin: isMobile ? false : true,
      tabSize: 4,
      insertSpaces: true,
      wordWrap: "on",
      smoothScrolling: true,
      cursorBlinking: "smooth",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      // Mobile-friendly: hide context menu bits that are hard to tap
      mobileLayout: isMobile ? "fixed" : "pratfall",
      // Allow the on-screen keyboard to overlap without breaking layout
      fixedOverflowWidgets: true,
    });

    // Track dirty state
    this.editor.onDidChangeModelContent(() => {
      this.dirty = true;
      this.dirtyListeners.forEach((fn) => fn());
    });
  }

  /** Set editor value. Optionally mark clean and/or switch language. */
  setValue(value: string, opts?: MonacoSetOptions): void {
    if (!this.editor || !this.monacoApi) return;
    if (opts?.language) this.setLanguage(opts.language);
    this.editor.setValue(value);
    if (opts?.markClean) {
      this.dirty = false;
      this.dirtyListeners.forEach((fn) => fn());
    }
  }

  getValue(): string {
    return this.editor?.getValue() ?? "";
  }

  setLanguage(lang: "python" | "cpp"): void {
    if (!this.monacoApi || !this.editor) return;
    const model = this.editor.getModel();
    if (!model) return;
    this.monacoApi.editor.setModelLanguage(
      model,
      lang === "python" ? "python" : "cpp"
    );
  }

  getLanguage(): "python" | "cpp" {
    if (!this.monacoApi || !this.editor) return "python";
    const model = this.editor.getModel();
    if (!model) return "python";
    const id = model.getLanguageId?.() ?? "python";
    return id === "cpp" ? "cpp" : "python";
  }

  /** Show error/warning markers in the gutter. */
  setDiagnostics(diags: MonacoDiag[]): void {
    if (!this.monacoApi || !this.editor) return;
    const monaco = this.monacoApi;
    // Clear previous diag decorations
    if (this.diagDecorations.length) {
      this.editor.deltaDecorations(this.diagDecorations, []);
      this.diagDecorations = [];
    }
    if (!diags.length) return;

    const newDecorations: Monaco.editor.IModelDeltaDecoration[] = diags.map(
      (d) => {
        const line = d.line ?? 1;
        const col = d.column ?? 1;
        const severity =
          d.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Error;
        // We use decorations for the gutter glyph + inline message
        return {
          range: new monaco.Range(line, col, line, col + 1),
          options: {
            isWholeLine: false,
            glyphMarginClassName:
              d.severity === "warning"
                ? "rt-glyph-warning"
                : "rt-glyph-error",
            glyphMarginHoverMessage: { value: d.message },
            className:
              d.severity === "warning"
                ? "rt-line-warning"
                : "rt-line-error",
            hoverMessage: { value: d.raw ?? d.message },
            severity,
          },
        };
      }
    );

    this.diagDecorations = this.editor.deltaDecorations(
      [],
      newDecorations
    );

    // Also set Monaco markers for the problems pane
    const model = this.editor.getModel();
    if (model) {
      monaco.editor.setModelMarkers(
        model,
        "retrace",
        diags.map((d) => ({
          startLineNumber: d.line ?? 1,
          startColumn: d.column ?? 1,
          endLineNumber: d.line ?? 1,
          endColumn: (d.column ?? 1) + 1,
          message: d.message,
          severity:
            d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Error,
        }))
      );
    }
  }

  /** Highlight the current execution line + mark A/B anchors. */
  setFrameDecorations(opts: {
    currentLine?: number;
    markALine?: number;
    markBLine?: number;
  }): void {
    if (!this.monacoApi || !this.editor) return;
    const monaco = this.monacoApi;

    if (this.frameDecorations.length) {
      this.editor.deltaDecorations(this.frameDecorations, []);
      this.frameDecorations = [];
    }

    const decos: Monaco.editor.IModelDeltaDecoration[] = [];

    if (opts.markALine) {
      decos.push({
        range: new monaco.Range(opts.markALine, 1, opts.markALine, 1),
        options: {
          isWholeLine: true,
          className: "rt-mark-a",
          glyphMarginClassName: "rt-glyph-mark-a",
        },
      });
    }
    if (opts.markBLine) {
      decos.push({
        range: new monaco.Range(opts.markBLine, 1, opts.markBLine, 1),
        options: {
          isWholeLine: true,
          className: "rt-mark-b",
          glyphMarginClassName: "rt-glyph-mark-b",
        },
      });
    }
    if (opts.currentLine) {
      decos.push({
        range: new monaco.Range(opts.currentLine, 1, opts.currentLine, 1),
        options: {
          isWholeLine: true,
          className: "rt-current-line",
        },
      });
    }

    if (decos.length) {
      this.frameDecorations = this.editor.deltaDecorations([], decos);
    }
  }

  revealLine(line: number): void {
    this.editor?.revealLineInCenter(line);
  }

  isDirty(): boolean {
    return this.dirty;
  }

  setDirtyChangeHandler(fn: () => void): void {
    this.dirtyListeners.push(fn);
  }

  focus(): void {
    this.editor?.focus();
  }

  dispose(): void {
    this.editor?.dispose();
    this.editor = null;
  }
}
