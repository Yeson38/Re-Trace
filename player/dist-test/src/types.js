"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
