/**
 * Re-Trace Player entry point.
 *
 * Loads the demo trace, instantiates the player and the three views, and
 * bridges every player state change into a view refresh. Views are dumb: they
 * receive state and re-render; the player is the single source of truth.
 *
 * Keyboard: ← / → step, Space toggles play, Home restarts.
 */
import { Player } from "./player";
import { CodeView } from "./ui/codeView";
import { VarTree } from "./ui/varTree";
import { Terminal } from "./ui/terminal";
import { Controls } from "./ui/controls";
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

  const codeView = new CodeView(el("code"), file);
  const varTree = new VarTree(el("vars"));
  const terminal = new Terminal(el("terminal"));
  const controls = new Controls(el("controls"), el("loops"), player);

  const stepCounter = el("stepCounter");
  const globalStep = el("globalStep");
  const depthCounter = el("depthCounter");

  function render(): void {
    const state = player.getState();
    const step = player.currentStep();

    controls.sync(state);

    if (step) {
      codeView.highlight(step.line);
      varTree.render(step.vars);
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
  render();

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
