/**
 * Re-Trace unified data protocol.
 *
 * The `TraceStep` interface is the iron contract between every language
 * adapter (backend) and the player (frontend). It is intentionally
 * language-agnostic: adapters only emit JSON conforming to this shape.
 *
 * `TraceFile` wraps the step stream with the source listing so the player
 * can render line-highlight linkage. The wrapper does NOT alter the per-step
 * protocol; adapters that only produce a raw `TraceStep[]` are still valid.
 */

/** A single visible variable in the current scope. */
export interface TraceVar {
  name: string;
  value: unknown;
  type: string;
}

/** Loop iteration counter for the inspector side panel. */
export interface TraceLoop {
  id: string;
  current: number;
  total: number;
}

/** One frame in the recorded execution timeline. */
export interface TraceStep {
  /** Currently executing line number (1-based). */
  line: number;
  /** Call stack depth (1 = global scope). */
  depth: number;
  /** Variables visible in the current scope at this frame. */
  vars: TraceVar[];
  /** Active loop counters shown in the side panel. */
  loops: TraceLoop[];
  /** Stdout/print output appended by this step. */
  output: string;
  /** Monotonically increasing global step counter. */
  globalStep: number;
}

/** Source listing for the player's code pane. */
export interface TraceSource {
  name: string;
  language: string;
  lines: string[];
}

/** A complete trace artifact loadable by the player. */
export interface TraceFile {
  source: TraceSource;
  steps: TraceStep[];
}
