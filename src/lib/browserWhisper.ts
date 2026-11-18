export const BROWSER_WHISPER_MODELS: Record<string, { id: string; size: string }> = {
  "tiny.en": { id: "Xenova/whisper-tiny.en", size: "~40 MB" },
  "base.en": { id: "Xenova/whisper-base.en", size: "~75 MB" },
};

const DEFAULT_MODEL = "tiny.en";

type WorkerResponse =
  | { type: "progress"; id: string; pct: number }
  | { type: "loaded"; id: string }
  | { type: "result"; id: string; text: string }
  | { type: "error"; id: string; error: string };

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (pct: number) => void;
}

let worker: Worker | null = null;
let modelReady = false;
const pending = new Map<string, PendingRequest>();

export function resolveModelId(modelName?: string): string {
  if (modelName && BROWSER_WHISPER_MODELS[modelName]) {
    return BROWSER_WHISPER_MODELS[modelName].id;
  }
  return BROWSER_WHISPER_MODELS[DEFAULT_MODEL].id;
}

export function isBrowserModelReady(): boolean {
  return modelReady;
}

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const req = pending.get(msg.id);
    if (!req) return;

    if (msg.type === "progress") {
      req.onProgress?.(msg.pct);
    } else if (msg.type === "loaded") {
      modelReady = true;
      pending.delete(msg.id);
      req.resolve("");
    } else if (msg.type === "result") {
      modelReady = true;
      pending.delete(msg.id);
      req.onProgress?.(100);
      req.resolve(msg.text);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      req.reject(new Error(msg.error));
    }
  });

  worker.addEventListener("error", (err) => {
    for (const [id, req] of pending.entries()) {
      pending.delete(id);
      req.reject(new Error(err.message || "Whisper worker error"));
    }
  });

  return worker;
}

export function cancelBrowserJob(jobId?: string): void {
  if (jobId && pending.has(jobId)) {
    const req = pending.get(jobId)!;
    pending.delete(jobId);
    req.reject(new Error("Transcription cancelled"));
  }
  if (worker) {
    worker.terminate();
    worker = null;
    modelReady = false;
  }
  for (const [id, req] of pending.entries()) {
    pending.delete(id);
    req.reject(new Error("Worker reset after cancellation"));
  }
}

export async function loadBrowserWhisper(
  modelName?: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  const modelId = resolveModelId(modelName);
  const id = `load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const w = getWorker();

  await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ type: "load", id, modelId });
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

  const w = getWorker();
  const text = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ type: "transcribe", id, modelId, pcm: copy }, [copy.buffer]);
  });

  return {
    text,
    language: "en",
    duration_ms: durationMs,
  };
}

export async function transcribeBrowserFile(
  file: File,
  modelName?: string,
  onProgress?: (pct: number) => void,
  jobId?: string
): Promise<{ text: string; language: string; duration_ms: number }> {
  const id = jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const modelId = resolveModelId(modelName);

  onProgress?.(5);
  const { pcm, durationMs } = await decodeFileTo16kHzMono(file);
  onProgress?.(20);

  const w = getWorker();
  const text = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ type: "transcribe", id, modelId, pcm }, [pcm.buffer]);
  });

  return {
    text,
    language: "en",
    duration_ms: durationMs,
  };
}
