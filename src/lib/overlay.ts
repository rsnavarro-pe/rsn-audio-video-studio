/**
 * Single owner of the dictation overlay window.
 *
 * All overlay communication goes through ONE event ("overlay-show") with a
 * typed payload. Progress animation happens locally in the overlay window
 * (requestAnimationFrame) — the main window only sends the estimated
 * duration once, so there is no per-frame IPC traffic.
 */

const isTauri = !!(window as any).__TAURI_INTERNALS__;

const LABEL = "dictation-overlay";
const WIDTH = 296;
const HEIGHT = 44;
const MARGIN = 16;
const TASKBAR = 48;

export type OverlayPayload =
  | { state: "recording" }
  | { state: "transcribing"; estimatedMs: number }
  | { state: "done"; text: string }
  | { state: "error"; text: string };

let creating: Promise<void> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureWindow(): Promise<void> {
  // Desktop overlay disabled in web build
}

export async function showOverlay(_payload: OverlayPayload): Promise<void> {
  if (!isTauri) return;
}

export async function emitOverlayAudioLevel(_level: number): Promise<void> {
  if (!isTauri) return;
}

/**
 * Hide the overlay window, optionally after a delay.
 */
export function closeOverlay(_delayMs = 0): void {
  if (!isTauri) return;
}
