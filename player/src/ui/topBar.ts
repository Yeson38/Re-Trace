/**
 * Phase 4 — Top bar widget.
 *
 * Provides file operation buttons (New / Import / Export / Record),
 * language toggle (Python ↔ C++), capability chips, and recording status.
 * All actions are delegated via callbacks — the widget owns no state logic.
 */
import type { RecorderCapabilities, RecorderLanguage } from "../services/types";

export interface TopBarHandlers {
  onNew: (lang: RecorderLanguage) => void;
  onImportFile: (file: File) => void;
  onExport: () => { name: string; content: string; lang: RecorderLanguage };
  onToggleRecord: () => void;
  onToggleLanguage: (next: RecorderLanguage) => void;
  onCxxFirstRunNotice?: () => Promise<boolean>;
}

type ChipKind = "idle" | "progress" | "success" | "error";

export class TopBarWidget {
  private recordBtn: HTMLButtonElement | null = null;
  private langBtn: HTMLButtonElement | null = null;
  private chipEl: HTMLElement | null = null;
  private capsEl: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private currentLang: RecorderLanguage = "python";

  constructor(private host: HTMLElement, private handlers: TopBarHandlers) {
    this.render();
  }

  private render(): void {
    this.host.innerHTML = "";
    this.host.style.cssText = `
      display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      padding:6px 12px;background:var(--bg-elev,#161922);
      border-bottom:1px solid var(--border,#2a2f3d);
      font:13px/1.4 var(--sans,sans-serif);
    `;

    // Mobile toggle: reveals the secondary header row (counters + search).
    // Only visible on narrow screens (CSS handles display).
    const toggle = document.createElement("button");
    toggle.className = "rt-mobile-toggle";
    toggle.textContent = "≡";
    toggle.title = "显示/隐藏状态与搜索";
    toggle.addEventListener("click", () => {
      const header = document.querySelector("header.topbar") as HTMLElement | null;
      header?.classList.toggle("open");
    });
    this.host.appendChild(toggle);

    // New button
    const newBtn = this.mkBtn("新建", () => {
      this.handlers.onNew(this.currentLang);
    });
    newBtn.title = "新建文件 (Ctrl+N)";
    this.host.appendChild(newBtn);

    // Language toggle
    this.langBtn = this.mkBtn("Python", () => {
      const next: RecorderLanguage =
        this.currentLang === "python" ? "cpp" : "python";
      this.currentLang = next;
      this.langBtn!.textContent = next === "python" ? "Python" : "C++";
      this.handlers.onToggleLanguage(next);
    });
    this.langBtn.title = "切换语言 (Python ↔ C++)";
    this.langBtn.style.cssText += "font-weight:600;color:var(--accent,#4ea1ff);";
    this.host.appendChild(this.langBtn);

    // Import
    const importBtn = this.mkBtn("导入", () => {
      this.fileInput?.click();
    });
    importBtn.title = "导入源码/trace (Ctrl+O)";
    this.host.appendChild(importBtn);

    // Hidden file input
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".py,.cpp,.cxx,.cc,.h,.hpp,.json";
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", () => {
      const f = this.fileInput!.files?.[0];
      if (f) this.handlers.onImportFile(f);
      this.fileInput!.value = "";
    });
    this.host.appendChild(this.fileInput);

    // Export
    const exportBtn = this.mkBtn("导出", () => {
      const { name, content } = this.handlers.onExport();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    });
    exportBtn.title = "导出源码 (Ctrl+S)";
    this.host.appendChild(exportBtn);

    // Spacer
    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    this.host.appendChild(spacer);

    // Capability chips
    this.capsEl = document.createElement("span");
    this.capsEl.className = "rt-caps";
    this.capsEl.style.cssText = "display:inline-flex;gap:4px;";
    this.host.appendChild(this.capsEl);

    // Status chip
    this.chipEl = document.createElement("span");
    this.chipEl.className = "rt-chip rt-chip-idle";
    this.chipEl.textContent = "就绪";
    this.host.appendChild(this.chipEl);

    // Record button
    this.recordBtn = this.mkBtn("▶ 录制", () => {
      this.handlers.onToggleRecord();
    });
    this.recordBtn.style.cssText +=
      "background:var(--accent,#4ea1ff);color:#fff;font-weight:600;border:none;";
    this.recordBtn.title = "录制/停止 (Ctrl+F5)";
    this.host.appendChild(this.recordBtn);
  }

  private mkBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = "rt-btn";
    btn.style.cssText = `
      padding:4px 12px;border:1px solid var(--border,#2a2f3d);
      background:var(--bg-soft,#1c2030);color:var(--text,#e6e9f2);
      border-radius:6px;cursor:pointer;font-size:13px;
      transition:background .15s;
    `;
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "var(--bg,#0f1115)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "var(--bg-soft,#1c2030)";
    });
    btn.addEventListener("click", onClick);
    return btn;
  }

  setCapabilities(caps: RecorderCapabilities): void {
    if (!this.capsEl) return;
    this.capsEl.innerHTML = "";
    const langs = caps.languages.map((l) => l.toUpperCase()).join(" + ");
    const chip = document.createElement("span");
    chip.className = "rt-cap-chip";
    chip.textContent = `${caps.backendName}: ${langs}`;
    chip.style.cssText = `
      padding:2px 8px;border-radius:10px;font-size:11px;
      background:var(--accent-soft,rgba(78,161,255,.14));
      color:var(--accent,#4ea1ff);
    `;
    this.capsEl.appendChild(chip);
    // Update language toggle visibility
    if (this.langBtn) {
      const hasCpp = caps.languages.includes("cpp");
      this.langBtn.style.opacity = hasCpp ? "1" : "0.5";
    }
  }

  setRecordingDisabled(reason: string): void {
    if (this.recordBtn) {
      this.recordBtn.disabled = true;
      this.recordBtn.textContent = reason;
      this.recordBtn.style.opacity = "0.6";
      this.recordBtn.style.cursor = "not-allowed";
    }
  }

  setRecordingIdle(): void {
    if (this.recordBtn) {
      this.recordBtn.disabled = false;
      this.recordBtn.textContent = "▶ 录制";
      this.recordBtn.style.opacity = "1";
      this.recordBtn.style.cursor = "pointer";
    }
  }

  setRecordingRunning(label: string, pct: number): void {
    if (this.recordBtn) {
      this.recordBtn.textContent = "■ 停止";
      this.recordBtn.style.background = "var(--err,#ff6b6b)";
    }
    this.setChipState({ kind: "progress", text: label, pct });
  }

  setChipState(state: {
    kind: ChipKind;
    text?: string;
    pct?: number;
  }): void {
    if (!this.chipEl) return;
    const colors: Record<ChipKind, string> = {
      idle: "var(--text-dim,#9aa3b8)",
      progress: "var(--accent,#4ea1ff)",
      success: "var(--ok,#5ad17f)",
      error: "var(--err,#ff6b6b)",
    };
    this.chipEl.style.color = colors[state.kind];
    const prefix: Record<ChipKind, string> = {
      idle: "●",
      progress: "◐",
      success: "✓",
      error: "✗",
    };
    let text = state.text ?? "";
    if (state.kind === "progress" && state.pct != null) {
      text = `${text} ${state.pct}%`;
    } else if (state.kind === "idle") {
      text = "就绪";
    }
    this.chipEl.textContent = `${prefix[state.kind]} ${text}`;
  }

  notify(msg: string, tone: "error" | "info" = "info"): void {
    this.setChipState({
      kind: tone === "error" ? "error" : "idle",
      text: msg,
    });
  }
}
