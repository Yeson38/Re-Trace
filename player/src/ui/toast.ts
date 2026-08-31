/**
 * Phase 4 — Toast notification stack.
 *
 * Lightweight singleton: import { toastStack } and call success/warn/error.
 * Auto-dismisses after timeout; supports manual dismiss on click.
 */

type ToastTone = "success" | "warn" | "error" | "info";

interface ToastEntry {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
}

class ToastStack {
  private host: HTMLElement | null = null;
  private entries: ToastEntry[] = [];

  private ensureHost(): HTMLElement {
    if (this.host && document.body.contains(this.host)) return this.host;
    this.host = document.createElement("div");
    this.host.className = "rt-toast-stack";
    this.host.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483000;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;";
    document.body.appendChild(this.host);
    return this.host;
  }

  show(message: string, tone: ToastTone = "info", durationMs = 2400): void {
    const host = this.ensureHost();
    const el = document.createElement("div");
    const colors: Record<ToastTone, string> = {
      success: "var(--ok,#5ad17f)",
      warn: "var(--warn,#ffb454)",
      error: "var(--err,#ff6b6b)",
      info: "var(--accent,#4ea1ff)",
    };
    el.className = "rt-toast rt-toast-" + tone;
    el.style.cssText = `
      pointer-events:auto;cursor:pointer;max-width:420px;
      background:var(--bg-elev,#161922);border:1px solid var(--border,#2a2f3d);
      border-left:4px solid ${colors[tone]};
      border-radius:8px;padding:10px 14px;font:13px/1.5 var(--sans,sans-serif);
      color:var(--text,#e6e9f2);box-shadow:0 4px 16px rgba(0,0,0,.2);
      opacity:0;transform:translateX(20px);transition:all .2s ease;
    `;
    el.textContent = message;
    el.addEventListener("click", () => this.dismiss(el));
    host.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(0)";
    });
    const timer = setTimeout(() => this.dismiss(el), durationMs);
    this.entries.push({ el, timer });
  }

  success(msg: string, ms?: number): void {
    this.show(msg, "success", ms);
  }
  warn(msg: string, ms?: number): void {
    this.show(msg, "warn", ms);
  }
  error(msg: string, ms?: number): void {
    this.show(msg, "error", ms ?? 4000);
  }
  info(msg: string, ms?: number): void {
    this.show(msg, "info", ms);
  }

  private dismiss(el: HTMLElement): void {
    const idx = this.entries.findIndex((e) => e.el === el);
    if (idx >= 0) {
      clearTimeout(this.entries[idx].timer);
      this.entries.splice(idx, 1);
    }
    el.style.opacity = "0";
    el.style.transform = "translateX(20px)";
    setTimeout(() => el.remove(), 200);
  }
}

export const toastStack = new ToastStack();
