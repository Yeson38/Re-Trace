/**
 * Re-Trace Player entry point.
 *
 * Loads the demo trace, instantiates the player and the three views, and
 * bridges every player state change into a view refresh. Views are dumb: they
 * receive state and re-render; the player is the single source of truth.
 *
 * Phase 3 additions (assembled here):
 *   - Timeline search bar (top-right): parseSearch + findAllMatches, jumps
 *     via Player.goto and cycles through matches on F3 / Enter.
 *   - Mark A / Mark B transport buttons: two anchors drive the Variables
 *     pane into a recursive, colour-coded diff view.
 *   - Per-loop complexity badges and a top-level program-order pill with
 *     click-to-toggle basis tooltip.
 *
 * Keyboard: ← / → step, Space toggles play, Home restarts, End jumps to last,
 *           F3 next match, Enter search (Shift+Enter previous).
 */
import { Player } from "./player";
import { CodeView } from "./ui/codeView";
import { VarTree } from "./ui/varTree";
import { Terminal } from "./ui/terminal";
import { Controls } from "./ui/controls";
import { SearchBar } from "./ui/searchBar";
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
  const file = await loadTrace();

  document.getElementById("sourceName")!.textContent = `${file.source.name} · ${file.steps.length} steps`;

  const player = new Player();
  player.load(file);

  // -----------------------------------------------------------------
  // Views
  // -----------------------------------------------------------------
  const codeView = new CodeView(el("code"), file);
  const varTree = new VarTree(el("vars"));
  const terminal = new Terminal(el("terminal"));

  // Diff anchors tracked by the main glue. When both are non-null, Variables
  // pane switches to the renderDiff view.
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

  // Topbar program-level complexity pill (click → basis tooltip).
  el("cpxHost").replaceChildren(controls.overallOrderPill());

  // Topbar search widget.
  new SearchBar(el("searchBar"), file, player, {
    onMatches: () => { /* matches chip is rendered inside SearchBar itself */ },
    onError: (msg) => { flashToast(msg, "err"); },
  });

  const stepCounter = el("stepCounter");
  const globalStep = el("globalStep");
  const depthCounter = el("depthCounter");

  // -----------------------------------------------------------------
  // Render loop (single source of truth = player state + mark anchors)
  // -----------------------------------------------------------------
  function render(): void {
    const state = player.getState();
    const step = player.currentStep();

    controls.sync(state);

    if (step) {
      codeView.highlight(step.line);

      // Variables pane: diff if both anchors are set, else live view.
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

  // -----------------------------------------------------------------
  // Transient toast (used by search errors).
  // -----------------------------------------------------------------
  let toastTimer: number | null = null;
  function flashToast(msg: string, tone: "err" | "ok" | "hint" = "hint"): void {
    let host = document.getElementById("__toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "__toast";
      host.className = "toast-host";
      document.body.append(host);
    }
    host.textContent = msg;
    host.className = `toast-host toast-${tone} toast-show`;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      host!.classList.remove("toast-show");
    }, 1800);
  }

  // -----------------------------------------------------------------
  // Keyboard
  // -----------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    // Ignore when typing in a form field.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
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
