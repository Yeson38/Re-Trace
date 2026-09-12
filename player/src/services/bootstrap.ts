/**
 * Phase 4 — Runtime recorder bootstrap.
 *
 * Entry point called once from main.ts:
 *   - window.__TAURI__ present → Native + Browser → Hybrid
 *   - otherwise → Browser standalone (Pyodide Python + clangWASM C++)
 */
import { BrowserRecorderService } from "./browser";
import { NativeRecorderService } from "./native";
import { HybridRecorderService } from "./hybrid";
import type { IRecorderService, RecorderInitOpts } from "./types";

declare global {
  interface Window {
    __TAURI__?: unknown;
  }
}

export function buildRecorder(): IRecorderService {
  const browser = new BrowserRecorderService();
  if (typeof window !== "undefined" && typeof window.__TAURI__ !== "undefined") {
    const native = new NativeRecorderService();
    return new HybridRecorderService(native, browser);
  }
  return browser;
}

export async function initRecorder(
  svc: IRecorderService,
  opts?: RecorderInitOpts
): Promise<ReturnType<IRecorderService["init"]>> {
  return svc.init(opts);
}
