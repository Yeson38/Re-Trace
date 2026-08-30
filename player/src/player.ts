/**
 * Player state machine.
 *
 * Owns the loaded TraceFile and the current cursor over its steps. Exposes
 * transport primitives (prev/next/goto/play/pause/restart/speed) and notifies
 * subscribers on every state mutation so views can re-render. The player
 * itself knows nothing about the DOM — views subscribe and pull data.
 */
import type { TraceFile, TraceStep } from "./types";

export interface PlayerState {
  /** Current step index, or -1 when no file is loaded. */
  index: number;
  /** Total number of steps. */
  total: number;
  /** Whether autoplay is running. */
  playing: boolean;
  /** Delay between steps during autoplay, in milliseconds. */
  speedMs: number;
}

export type PlayerListener = (state: PlayerState) => void;

const DEFAULT_SPEED_MS = 600;
const MIN_SPEED_MS = 80;

export class Player {
  private file: TraceFile | null = null;
  private index = -1;
  private playing = false;
  private speedMs = DEFAULT_SPEED_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<PlayerListener>();

  /** Load a trace file and reset the cursor to the first step. */
  load(file: TraceFile): void {
    this.pause();
    this.file = file;
    this.index = file.steps.length > 0 ? 0 : -1;
    this.emit();
  }

  get total(): number {
    return this.file ? this.file.steps.length : 0;
  }

  getState(): PlayerState {
    return {
      index: this.index,
      total: this.total,
      playing: this.playing,
      speedMs: this.speedMs,
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: PlayerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The step under the cursor, or null. */
  currentStep(): TraceStep | null {
    if (!this.file || this.index < 0) return null;
    return this.file.steps[this.index] ?? null;
  }

  /** Jump to an absolute step index (clamped). */
  goto(target: number): void {
    if (!this.file || this.total === 0) return;
    const clamped = Math.max(0, Math.min(this.total - 1, Math.trunc(target)));
    if (clamped === this.index) return;
    this.index = clamped;
    // Reaching the end via manual jump pauses autoplay.
    if (this.index >= this.total - 1) this.pause();
    this.emit();
  }

  next(): void {
    this.goto(this.index + 1);
  }

  prev(): void {
    this.goto(this.index - 1);
  }

  restart(): void {
    this.pause();
    this.goto(0);
  }

  play(): void {
    if (!this.file || this.total === 0) return;
    if (this.index >= this.total - 1) this.index = 0;
    this.playing = true;
    this.emit();
    this.scheduleTick();
  }

  pause(): void {
    if (!this.playing && this.timer === null) return;
    this.playing = false;
    this.clearTimer();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Set step delay in ms (clamped to a sane floor). */
  setSpeed(ms: number): void {
    this.speedMs = Math.max(MIN_SPEED_MS, Math.trunc(ms));
    if (this.playing) {
      this.clearTimer();
      this.scheduleTick();
    }
    this.emit();
  }

  private scheduleTick(): void {
    this.clearTimer();
    this.timer = setTimeout(this.tick, this.speedMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick = (): void => {
    if (!this.playing || !this.file) return;
    if (this.index >= this.total - 1) {
      this.pause();
      return;
    }
    this.index += 1;
    this.emit();
    if (this.index >= this.total - 1) {
      this.pause();
      return;
    }
    this.scheduleTick();
  };

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) fn(state);
  }
}
