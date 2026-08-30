/**
 * Source code pane.
 *
 * Renders the listing with a line-number gutter and highlights the line under
 * the cursor ("源码高亮联动"). Keeps the active line scrolled into view.
 * Phase 0 keeps token coloring out of scope — line-level linkage is the
 * contract; full syntax highlighting can be layered in later without touching
 * the data protocol.
 */
import type { TraceFile } from "../types";

export class CodeView {
  private readonly host: HTMLElement;
  private readonly lineEls: HTMLElement[] = [];
  private currentLine = -1;

  constructor(host: HTMLElement, file: TraceFile) {
    this.host = host;
    this.render(file);
  }

  private render(file: TraceFile): void {
    this.host.replaceChildren();
    this.lineEls.length = 0;
    const frag = document.createDocumentFragment();
    file.source.lines.forEach((text, i) => {
      const row = document.createElement("div");
      row.className = "code-line";
      row.dataset.line = String(i + 1);

      const ln = document.createElement("span");
      ln.className = "ln";
      ln.textContent = String(i + 1);

      const code = document.createElement("span");
      code.className = "code-text";
      code.textContent = text || " ";

      row.append(ln, code);
      frag.append(row);
      this.lineEls.push(row);
    });
    this.host.append(frag);
  }

  /** Highlight the given 1-based line and scroll it into view. */
  highlight(line: number): void {
    if (line === this.currentLine) return;
    this.lineEls.forEach((el) => el.classList.remove("current"));
    this.currentLine = line;
    if (line < 1 || line > this.lineEls.length) return;
    const el = this.lineEls[line - 1];
    el.classList.add("current");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
