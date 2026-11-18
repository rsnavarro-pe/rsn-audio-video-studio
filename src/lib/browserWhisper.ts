import { pipeline, env } from "@huggingface/transformers";

// Always fetch models from Hugging Face Hub and cache in browser Cache API
env.allowLocalModels = false;

export const BROWSER_WHISPER_MODELS: Record<string, { id: string; size: string }> = {
  "tiny.en": { id: "Xenova/whisper-tiny.en", size: "~40 MB" },
  "base.en": { id: "Xenova/whisper-base.en", size: "~75 MB" },
};

const DEFAULT_MODEL = "tiny.en";

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>;

let cachedModelId: string | null = null;
let cachedPipeline: Promise<AsrPipeline> | null = null;

export function resolveModelId(modelName?: string): string {
  if (modelName && BROWSER_WHISPER_MODELS[modelName]) {
    return BROWSER_WHISPER_MODELS[modelName].id;
  }
  return BROWSER_WHISPER_MODELS[DEFAULT_MODEL].id;
}

export function isBrowserModelReady(): boolean {
  return cachedPipeline !== null;
}

async function detectDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } };
    if (nav.gpu && (await nav.gpu.requestAdapter())) {
      return "webgpu";
    }
  } catch {
    // Fallback to WASM
  }
  return "wasm";
}

export async function loadBrowserWhisper(
  modelName?: string,
  onProgress?: (pct: number) => void
): Promise<AsrPipeline> {
  const modelId = resolveModelId(modelName);
  if (cachedPipeline && cachedModelId === modelId) {
    return cachedPipeline;
  }

  cachedModelId = modelId;
  cachedPipeline = (async () => {
    const device = await detectDevice();
    const pipe = await pipeline("automatic-speech-recognition", modelId, {
      device,
      dtype: "q8",
      progress_callback: (info: { status?: string; progress?: number }) => {
        if (info.status === "progress" && typeof info.progress === "number") {
          onProgress?.(Math.min(95, Math.round(info.progress * 0.6)));
        }
      },
    });
    return pipe as unknown as AsrPipeline;
  })();

  try {
    return await cachedPipeline;
  } catch (err) {
    cachedPipeline = null;
    cachedModelId = null;
    throw err;
  }
}

async function decodeFileTo16kHzMono(file: File): Promise<{ pcm: Float32Array; durationMs: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

export async function transcribeBrowserFile(
  file: File,
  modelName?: string,
  onProgress?: (pct: number) => void
): Promise<{ text: string; language: string; duration_ms: number }> {
  onProgress?.(5);
  const transcriber = await loadBrowserWhisper(modelName, onProgress);
  onProgress?.(65);

  const { pcm, durationMs } = await decodeFileTo16kHzMono(file);
  onProgress?.(75);

  const output = await transcriber(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });

  onProgress?.(100);
  const text = Array.isArray(output)
    ? output.map((item) => item.text || "").join(" ").trim()
    : (output.text || "").trim();

  return {
    text,
    language: "en",
    duration_ms: durationMs,
  };
}
