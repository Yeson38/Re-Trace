/**
 * Top-bar inline search widget (Phase 3 feature A).
 *
 * Sits on the topbar (right of the three counters) and provides:
 *   - a syntax-aware input with placeholder hints
 *   - "Find" button → jumps to the earliest matching step
 *   - "Next" button → advances to the next matching step (wraps around)
 *   - a matches counter chip showing, e.g. "3 matches · at #7 #12 #27"
 *   - error badge for malformed queries
 *
 * Widget owns zero state about the trace. On every construction (or an
 * explicit `setFile` / `onFindFirst` registration) it calls back into the
 * main glue to run `findFirstMatch` / `findAllMatches` from analysis.ts and
 * jump via Player.goto.
 */
import { parseSearch, findAllMatches, type SearchPredicate, type ParseError } from "../analysis";
import type { TraceFile } from "../types";
import type { Player } from "../player";

export interface SearchBarHandlers {
  /** Called after any successful or failed parse; if matches are found caller should goto first index. */
  onMatches?(indices: number[]): void;
  /** Optional: flash a transient message on errors (main glue might show a toast-like chip). */
  onError?(msg: string): void;
}

const PLACEHOLDER = 'n == 4 · data[3] == 8 · arr ~= 5 · score >= 60.5';

export class SearchBar {
  private readonly input: HTMLInputElement;
  private readonly findBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly chip: HTMLSpanElement;
  private readonly file: TraceFile;
  private readonly player: Player;
  private readonly handlers: SearchBarHandlers;
  private lastMatches: number[] = [];
  private lastCursor = -1; // index in lastMatches[] of the currently shown step
  private pred: SearchPredicate | null = null;

  constructor(host: HTMLElement, file: TraceFile, player: Player, handlers: SearchBarHandlers = {}) {
    this.file = file;
    this.player = player;
    this.handlers = handlers;

    host.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "search-bar";

    const prefix = document.createElement("span");
    prefix.className = "search-label";
    prefix.textContent = "🔎";
    prefix.title = "Search timeline (e.g. n == 4)";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "search-input";
    this.input.placeholder = PLACEHOLDER;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.title = "Query: <path> <op> <value>  — ops: == != > < >= <= ~= (~= contains)";
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (e.shiftKey) this.findPrevious();
        else this.findFirst();
        e.preventDefault();
      } else if (e.key === "Escape") {
        this.input.value = "";
        this.clearChip();
        this.input.blur();
      } else if (e.key === "F3") {
        this.findNext();
        e.preventDefault();
      }
    });
    this.input.addEventListener("input", () => {
      // Live validation: show a small status icon while typing.
      const v = this.input.value.trim();
      if (!v) { this.clearChip(); return; }
      const r = parseSearch(v);
      if ("error" in r) this.setChipError(r);
      else this.setChipHint(r as SearchPredicate);
    });

    this.findBtn = document.createElement("button");
    this.findBtn.type = "button";
    this.findBtn.className = "btn search-btn";
    this.findBtn.textContent = "Find";
    this.findBtn.title = "Jump to the first matching step (Enter)";
    this.findBtn.addEventListener("click", () => this.findFirst());

    this.nextBtn = document.createElement("button");
    this.nextBtn.type = "button";
    this.nextBtn.className = "btn search-btn";
    this.nextBtn.textContent = "Next ▶";
    this.nextBtn.title = "Next match (F3)";
    this.nextBtn.addEventListener("click", () => this.findNext());

    this.chip = document.createElement("span");
    this.chip.className = "search-chip";

    wrap.append(prefix, this.input, this.findBtn, this.nextBtn, this.chip);
    host.append(wrap);
  }

  /** Re-search current input text and jump to the earliest match. */
  findFirst(fromIndex?: number): void {
    const start = typeof fromIndex === "number" ? fromIndex : this.player.getState().index;
    const v = this.input.value.trim();
    if (!v) return;
    const pr = parseSearch(v);
    if ("error" in pr) { this.setChipError(pr); return; }
    this.pred = pr as SearchPredicate;
    this.lastMatches = findAllMatches(this.file.steps, this.pred);
    this.handlers.onMatches?.(this.lastMatches);

    if (this.lastMatches.length === 0) {
      this.setChip("no matches", "error");
      this.handlers.onError?.(`no step satisfies: ${this.pred.raw}`);
      return;
    }
    // First match index >= start, else wrap.
    const next = this.lastMatches.find((i) => i >= start);
    const target = next ?? this.lastMatches[0];
    this.lastCursor = this.lastMatches.indexOf(target);
    this.setChipMatches(target);
    this.player.goto(target);
  }

  /** Advance to the next match (wraps to first). */
  findNext(): void {
    if (!this.pred || this.lastMatches.length === 0) { this.findFirst(); return; }
    const from = this.player.getState().index;
    const next = this.lastMatches.find((i) => i > from);
    if (next === undefined) {
      this.lastCursor = 0;
      const first = this.lastMatches[0];
      this.setChipMatches(first);
      this.player.goto(first);
      return;
    }
    this.lastCursor = this.lastMatches.indexOf(next);
    this.setChipMatches(next);
    this.player.goto(next);
  }

  /** Go to the previous match (for Shift-Enter). */
  findPrevious(): void {
    if (!this.pred || this.lastMatches.length === 0) { this.findFirst(); return; }
    const from = this.player.getState().index;
    const below = this.lastMatches.filter((i) => i < from);
    if (below.length === 0) {
      const last = this.lastMatches[this.lastMatches.length - 1];
      this.lastCursor = this.lastMatches.length - 1;
      this.setChipMatches(last);
      this.player.goto(last);
      return;
    }
    const target = below[below.length - 1];
    this.lastCursor = this.lastMatches.indexOf(target);
    this.setChipMatches(target);
    this.player.goto(target);
  }

  private clearChip(): void {
    this.chip.textContent = "";
    this.chip.className = "search-chip";
  }

  private setChipMatches(currentIndex: number): void {
    const total = this.lastMatches.length;
    const n = total;
    const idxOf = this.lastCursor + 1; // 1-based UI
    this.chip.classList.remove("error", "ok", "hint");
    this.chip.classList.add("ok");
    // Short summary — show indices of first up to 3 matches if short enough.
    const preview = (n <= 5 ? this.lastMatches.map((i) => i + 1).join(", ") : `${this.lastMatches.slice(0, 3).map((i) => i + 1).join(", ")}, …`);
    this.chip.textContent = `${idxOf}/${n} at #${currentIndex + 1} · matches: ${preview}`;
    this.chip.title = `Matches (${n} total): step #${this.lastMatches.map((i) => i + 1).join(", #")}`;
  }

  private setChipHint(_p: SearchPredicate): void {
    this.chip.classList.remove("error", "ok");
    this.chip.classList.add("hint");
    this.chip.textContent = "Enter = search, F3 = next, Shift+Enter = previous";
  }

  private setChipError(err: ParseError): void {
    this.chip.classList.remove("ok", "hint");
    this.chip.classList.add("error");
    this.chip.textContent = err.error;
    this.chip.title = `Query error at col ${err.column}`;
  }

  private setChip(text: string, kind: "error" | "ok" | "hint"): void {
    this.chip.classList.remove("error", "ok", "hint");
    this.chip.classList.add(kind);
    this.chip.textContent = text;
  }
}
