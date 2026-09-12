/**
 * Output terminal pane.
 *
 * Replays accumulated stdout up to the current cursor. Computed from scratch
 * each render — cheap for Phase 0 demo traces; Phase 4 will swap in paged
 * lazy-loading / Web Worker parsing for large recordings.
 */
import type { TraceStep } from "../types";

export class Terminal {
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  render(steps: TraceStep[], upToIndex: number): void {
    let text = "";
    const end = Math.min(upToIndex, steps.length - 1);
    for (let i = 0; i <= end; i++) text += steps[i]?.output ?? "";
    // textContent avoids reflow churn and is XSS-safe for recorded output.
    this.host.textContent = text.replace(/\n$/, "");
  }
}
