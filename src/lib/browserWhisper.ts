import type { TranscriptSegment } from "./mediaExport";

export const BROWSER_WHISPER_MODELS: Record<string, { id: string; size: string }> = {
  "tiny.en": { id: "onnx-community/whisper-tiny.en", size: "~40 MB" },
  "base.en": { id: "onnx-community/whisper-base.en", size: "~75 MB" },
  "distil-small.en": { id: "distil-whisper/distil-small.en", size: "~165 MB" },
  "small": { id: "onnx-community/whisper-small", size: "~250 MB" },
};

const DEFAULT_MODEL = "base.en";

export function getMaxConcurrentWorkers(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const mem = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (mem !== undefined && mem <= 4) return 2;
  return Math.min(3, Math.max(2, Math.floor(cores / 2)));
}

type WorkerResult = { text: string; chunks: TranscriptSegment[] };

type WorkerResponse =
  | { type: "progress"; id: string; pct: number }
  | { type: "loaded"; id: string }
  | { type: "result"; id: string; text: string; chunks?: TranscriptSegment[] }
  | { type: "error"; id: string; error: string };

interface QueuedTask {
  id: string;
  type: "load" | "transcribe";
  modelId: string;
  pcm?: Float32Array;
  resolve: (value: WorkerResult) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (pct: number) => void;
}

interface WorkerSlot {
  worker: Worker;
  activeTask: QueuedTask | null;
}

const slots: WorkerSlot[] = [];
const queue: QueuedTask[] = [];
let modelReady = false;

export function resolveModelId(modelName?: string): string {
  if (modelName && BROWSER_WHISPER_MODELS[modelName]) {
    return BROWSER_WHISPER_MODELS[modelName].id;
  }
  return BROWSER_WHISPER_MODELS[DEFAULT_MODEL].id;
}

export function isBrowserModelReady(): boolean {
  return modelReady;
}

function createSlot(): WorkerSlot {
  const w = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const slot: WorkerSlot = { worker: w, activeTask: null };

  w.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const task = slot.activeTask;
    if (!task || task.id !== msg.id) return;

    if (msg.type === "progress") {
      task.onProgress?.(msg.pct);
    } else if (msg.type === "loaded") {
      modelReady = true;
      slot.activeTask = null;
      task.resolve({ text: "", chunks: [] });
      drainQueue();
    } else if (msg.type === "result") {
      modelReady = true;
      slot.activeTask = null;
      task.onProgress?.(100);
      task.resolve({ text: msg.text, chunks: msg.chunks || [] });
      drainQueue();
    } else if (msg.type === "error") {
      slot.activeTask = null;
      task.reject(new Error(msg.error));
      drainQueue();
    }
  });

  w.addEventListener("error", (err) => {
    const task = slot.activeTask;
    slot.activeTask = null;
    if (task) task.reject(new Error(err.message || "Whisper worker error"));
    drainQueue();
  });

  slots.push(slot);
  return slot;
}

function drainQueue(): void {
  const maxWorkers = getMaxConcurrentWorkers();
  while (queue.length > 0) {
    let freeSlot = slots.find((s) => s.activeTask === null);
    if (!freeSlot && slots.length < maxWorkers) {
      freeSlot = createSlot();
    }
    if (!freeSlot) break;

    const task = queue.shift()!;
    freeSlot.activeTask = task;
    if (task.type === "load") {
      freeSlot.worker.postMessage({ type: "load", id: task.id, modelId: task.modelId });
    } else if (task.pcm) {
      freeSlot.worker.postMessage(
        { type: "transcribe", id: task.id, modelId: task.modelId, pcm: task.pcm },
        [task.pcm.buffer]
      );
    }
  }
}

export function cancelBrowserJob(jobId?: string): void {
  if (!jobId) return;
  const qIdx = queue.findIndex((t) => t.id === jobId);
  if (qIdx !== -1) {
    const [removed] = queue.splice(qIdx, 1);
    removed.reject(new Error("Transcription cancelled"));
    return;
  }

  const sIdx = slots.findIndex((s) => s.activeTask?.id === jobId);
  if (sIdx !== -1) {
    const slot = slots[sIdx];
    const task = slot.activeTask;
    slot.activeTask = null;
    slot.worker.terminate();
    slots.splice(sIdx, 1);
    task?.reject(new Error("Transcription cancelled"));
    drainQueue();
  }
}

export async function loadBrowserWhisper(
  modelName?: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const modelId = resolveModelId(modelName);
  const id = `load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  await new Promise<WorkerResult>((resolve, reject) => {
    queue.push({ id, type: "load", modelId, resolve, reject, onProgress });
    drainQueue();
  });
}

async function decodeFileTo16kHzMono(file: File): Promise<{ pcm: Float32Array; durationMs: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();

  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const durationMs = Math.round(decoded.duration * 1000);
    const targetRate = 16000;
    if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
      return { pcm: new Float32Array(decoded.getChannelData(0)), durationMs };
    }
    const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return { pcm: rendered.getChannelData(0), durationMs };
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

export async function transcribeBrowserPcm(
  pcm: Float32Array,
  durationMs: number,
  modelName?: string,
  onProgress?: (pct: number) => void,
  jobId?: string
): Promise<{ text: string; language: string; duration_ms: number }> {
  const id = jobId || `mic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const modelId = resolveModelId(modelName);
  const copy = new Float32Array(pcm);

  const res = await new Promise<WorkerResult>((resolve, reject) => {
    queue.push({ id, type: "transcribe", modelId, pcm: copy, resolve, reject, onProgress });
    drainQueue();
  });

  return { text: res.text, language: "en", duration_ms: durationMs };
}

export async function transcribeBrowserFile(
  file: File,
  modelName?: string,
  onProgress?: (pct: number) => void,
  jobId?: string
): Promise<{ text: string; chunks: TranscriptSegment[]; language: string; duration_ms: number }> {
  const id = jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const modelId = resolveModelId(modelName);

  onProgress?.(5);
  const { pcm, durationMs } = await decodeFileTo16kHzMono(file);
  onProgress?.(20);

  const res = await new Promise<WorkerResult>((resolve, reject) => {
    queue.push({ id, type: "transcribe", modelId, pcm, resolve, reject, onProgress });
    drainQueue();
  });

  return {
    text: res.text,
    chunks: res.chunks,
    language: "en",
    duration_ms: durationMs,
  };
}
