/**
 * Transport controls + loop inspector + Mark A/B + complexity badges.
 *
 * Wires the prev / next / play / pause / restart buttons, the timeline slider,
 * and the speed selector to the Player. Also renders the active-loop counters
 * returned by each TraceStep. `sync` is called by the main loop on every
 * state change to reflect the cursor position back into the controls.
 *
 * Phase 3 additions:
 *   - Mark A / Mark B buttons to set the two diff anchors. Pressing either
 *     emits the supplied callback so the main glue can track anchors and
 *     switch the variables pane into Diff mode.
 *   - Per-loop complexity badges rendered next to the progress bar. Clicking
 *     a badge opens a small inline tooltip showing the estimate's basis.
 *   - `overallOrderPill()` helper returns an `HTMLElement` suitable for a
 *     topbar chip showing the program-level asymptotic estimate.
 */
import type { Player, PlayerState } from "../player";
import type { TraceLoop } from "../types";
import { estimateLoopComplexity, estimateProgram, type ComplexityEstimate } from "../analysis";
import type { TraceFile } from "../types";

const SPEEDS: { label: string; ms: number }[] = [
  { label: "0.25×", ms: 1600 },
  { label: "0.5×", ms: 1000 },
  { label: "1×", ms: 600 },
  { label: "2×", ms: 300 },
  { label: "4×", ms: 150 },
];

export type MarkHandler = (currentStepIndex: number) => void;
export type ClearMarkHandler = () => void;

export class Controls {
  private readonly player: Player;
  private readonly file: TraceFile;
  private readonly loopsHost: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly restartBtn: HTMLButtonElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly stepLabel: HTMLElement;
  private readonly markABtn: HTMLButtonElement;
  private readonly markBBtn: HTMLButtonElement;
  private readonly clearMarkBtn: HTMLButtonElement;
  private readonly onMarkA: MarkHandler;
  private readonly onMarkB: MarkHandler;
  private readonly onClearMarks: ClearMarkHandler;
  private readonly isMobile: boolean;

  constructor(
    host: HTMLElement,
    loopsHost: HTMLElement,
    player: Player,
    file: TraceFile,
    handlers: { onMarkA?: MarkHandler; onMarkB?: MarkHandler; onClearMarks?: ClearMarkHandler } = {},
  ) {
    this.player = player;
    this.file = file;
    this.loopsHost = loopsHost;
    this.onMarkA = handlers.onMarkA ?? (() => {});
    this.onMarkB = handlers.onMarkB ?? (() => {});
    this.onClearMarks = handlers.onClearMarks ?? (() => {});

    host.replaceChildren();

    // On narrow screens, use icon-only button labels so the transport bar
    // fits in a single row. Desktop keeps the full text labels.
    this.isMobile =
      typeof window !== "undefined" &&
      window.matchMedia?.("(max-width: 760px)").matches;
    const isMobile = this.isMobile;

    this.restartBtn = this.btn(isMobile ? "⏮" : "⏮ Restart", "Restart from first step", () => player.restart());
    this.prevBtn = this.btn(isMobile ? "◀" : "◀ Step", "Step backward", () => player.prev());
    this.playBtn = this.btn(isMobile ? "▶" : "▶ Play", "Toggle autoplay", () => player.toggle());
    this.playBtn.classList.add("primary");
    this.nextBtn = this.btn(isMobile ? "▶" : "Step ▶", "Step forward", () => player.next());

    const sliderWrap = document.createElement("label");
    sliderWrap.className = "transport-label";
    sliderWrap.textContent = "Timeline";

    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.className = "slider";
    this.slider.min = "0";
    this.slider.max = "0";
    this.slider.value = "0";
    this.slider.addEventListener("input", () => {
      this.player.goto(Number(this.slider.value));
    });

    this.stepLabel = document.createElement("span");
    this.stepLabel.className = "transport-label";

    this.speedSel = document.createElement("select");
    this.speedSel.className = "speed-select";
    this.speedSel.title = "Playback speed";
    for (const s of SPEEDS) {
      const o = document.createElement("option");
      o.value = String(s.ms);
      o.textContent = s.label;
      if (s.ms === 600) o.selected = true;
      this.speedSel.append(o);
    }
    this.speedSel.addEventListener("change", () => {
      this.player.setSpeed(Number(this.speedSel.value));
    });

    const divider1 = document.createElement("span");
    divider1.className = "transport-sep";
    divider1.setAttribute("aria-hidden", "true");

    this.markABtn = this.btn(isMobile ? "◉A" : "◉ Mark A", "Anchor first time-point for variable diff (A)",
      () => this.onMarkA(player.getState().index));
    this.markABtn.classList.add("mark-btn", "mark-a");

    this.markBBtn = this.btn(isMobile ? "◉B" : "◉ Mark B", "Anchor second time-point for variable diff (B)",
      () => this.onMarkB(player.getState().index));
    this.markBBtn.classList.add("mark-btn", "mark-b");

    this.clearMarkBtn = this.btn(isMobile ? "✕" : "✕ Clear", "Clear diff anchors and return to live variables",
      () => this.onClearMarks());
    this.clearMarkBtn.classList.add("mark-btn", "mark-clear");
    this.clearMarkBtn.disabled = true;

    host.append(
      this.restartBtn,
      this.prevBtn,
      this.playBtn,
      this.nextBtn,
      sliderWrap,
      this.slider,
      this.stepLabel,
      this.speedSel,
      divider1,
      this.markABtn,
      this.markBBtn,
      this.clearMarkBtn,
    );
  }

  /** Update the Mark A/B buttons to reflect the currently set anchor indices. */
  setMarks(a: number | null, b: number | null): void {
    if (this.isMobile) {
      this.markABtn.textContent = a === null ? "◉A" : `◉A#${a + 1}`;
      this.markBBtn.textContent = b === null ? "◉B" : `◉B#${b + 1}`;
    } else {
      if (a === null) {
        this.markABtn.classList.remove("set");
        this.markABtn.textContent = "◉ Mark A";
      } else {
        this.markABtn.classList.add("set");
        this.markABtn.textContent = `◉ A = #${a + 1}`;
      }
      if (b === null) {
        this.markBBtn.classList.remove("set");
        this.markBBtn.textContent = "◉ Mark B";
      } else {
        this.markBBtn.classList.add("set");
        this.markBBtn.textContent = `◉ B = #${b + 1}`;
      }
    }
    this.clearMarkBtn.disabled = a === null && b === null;
  }

  /** Build a standalone chip showing the overall program complexity order. */
  overallOrderPill(): HTMLElement {
    const est = estimateProgram(this.file);
    const pill = document.createElement("span");
    pill.className = "complexity-pill";
    pill.title = `Overall estimate · ${est.basis}`;
    pill.dataset.order = est.order;
    pill.textContent = est.order;
    pill.addEventListener("click", () => {
      // Toggle a small tooltip under the pill.
      let tip = pill.querySelector<HTMLElement>(".complexity-tip");
      if (tip) { tip.remove(); return; }
      tip = document.createElement("span");
      tip.className = "complexity-tip";
      tip.textContent = est.basis;
      pill.append(tip);
    });
    return pill;
  }

  private btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "btn";
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  /** Reflect player state into the controls. */
  sync(state: PlayerState): void {
    const max = Math.max(0, state.total - 1);
    this.slider.min = "0";
    this.slider.max = String(max);
    this.slider.value = String(Math.min(state.index, max));
    this.playBtn.textContent = this.isMobile
      ? state.playing ? "⏸" : "▶"
      : state.playing ? "⏸ Pause" : "▶ Play";
    this.prevBtn.disabled = state.index <= 0;
    this.restartBtn.disabled = state.index <= 0;
    this.nextBtn.disabled = state.index >= max;
    this.stepLabel.textContent = `${state.index + 1} / ${state.total}`;
  }

  /** Render the active loop counters for a step. */
  renderLoops(loops: TraceLoop[]): void {
    this.loopsHost.replaceChildren();
    if (loops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "loops-empty";
      empty.textContent = "(no active loops)";
      this.loopsHost.append(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const loop of loops) {
      const total = Math.max(1, loop.total);
      const pct = Math.max(0, Math.min(100, (loop.current / total) * 100));
      const row = document.createElement("div");
      row.className = "loop-row";

      const id = document.createElement("span");
      id.className = "loop-id";
      id.textContent = loop.id;

      const bar = document.createElement("div");
      bar.className = "loop-bar";
      const fill = document.createElement("div");
      fill.className = "loop-fill";
      fill.style.width = `${pct}%`;
      bar.append(fill);

      const txt = document.createElement("span");
      txt.className = "loop-text";
      txt.textContent = `${loop.current} / ${loop.total}`;

      // Phase 3: complexity badge (per loop). Click toggles basis tooltip.
      const badge = this.loopBadge(loop.id);

      row.append(id, bar, txt, badge);
      frag.append(row);
    }
    this.loopsHost.append(frag);
  }

  private loopBadge(loopId: string): HTMLElement {
    let est: ComplexityEstimate;
    try { est = estimateLoopComplexity(this.file, loopId); }
    catch { est = { order: "O(?)", basis: "estimate failed", confidence: "low" }; }
    const el = document.createElement("span");
    el.className = "loop-cpx";
    el.title = "Click for estimate basis";
    el.dataset.confidence = est.confidence;
    el.textContent = est.order;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      let tip = el.querySelector<HTMLElement>(".loop-cpx-tip");
      if (tip) { tip.remove(); return; }
      tip = document.createElement("span");
      tip.className = "loop-cpx-tip";
      tip.textContent = est.basis;
      el.append(tip);
    });
    return el;
  }
}
