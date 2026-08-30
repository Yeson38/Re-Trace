/**
 * Transport controls + loop inspector.
 *
 * Wires the prev / next / play / pause / restart buttons, the timeline slider,
 * and the speed selector to the Player. Also renders the active-loop counters
 * returned by each TraceStep. `sync` is called by the main loop on every
 * state change to reflect the cursor position back into the controls.
 */
import type { Player, PlayerState } from "../player";
import type { TraceLoop } from "../types";

const SPEEDS: { label: string; ms: number }[] = [
  { label: "0.25×", ms: 1600 },
  { label: "0.5×", ms: 1000 },
  { label: "1×", ms: 600 },
  { label: "2×", ms: 300 },
  { label: "4×", ms: 150 },
];

export class Controls {
  private readonly player: Player;
  private readonly loopsHost: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly restartBtn: HTMLButtonElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly stepLabel: HTMLElement;

  constructor(host: HTMLElement, loopsHost: HTMLElement, player: Player) {
    this.player = player;
    this.loopsHost = loopsHost;

    host.replaceChildren();

    this.restartBtn = this.btn("⏮ Restart", "Restart from first step", () => player.restart());
    this.prevBtn = this.btn("◀ Step", "Step backward", () => player.prev());
    this.playBtn = this.btn("▶ Play", "Toggle autoplay", () => player.toggle());
    this.playBtn.classList.add("primary");
    this.nextBtn = this.btn("Step ▶", "Step forward", () => player.next());

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

    host.append(
      this.restartBtn,
      this.prevBtn,
      this.playBtn,
      this.nextBtn,
      sliderWrap,
      this.slider,
      this.stepLabel,
      this.speedSel,
    );
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
    this.playBtn.textContent = state.playing ? "⏸ Pause" : "▶ Play";
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

      row.append(id, bar, txt);
      frag.append(row);
    }
    this.loopsHost.append(frag);
  }
}
