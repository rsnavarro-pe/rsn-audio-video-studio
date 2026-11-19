import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const CHUNK_SEC = 30;
const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_SEC;

type AsrOutput = {
  text?: string;
  chunks?: Array<{ timestamp?: [number, number | null]; text?: string }>;
};

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<AsrOutput | AsrOutput[]>;

type WorkerRequest =
  | { type: "load"; id: string; modelId: string }
  | { type: "transcribe"; id: string; modelId: string; pcm: Float32Array };

let cachedModelId: string | null = null;
let cachedPipeline: Promise<AsrPipeline> | null = null;

async function detectDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const nav = self.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (nav.gpu && (await nav.gpu.requestAdapter())) {
      return "webgpu";
    }
  } catch {
    // Fallback to WASM
  }
  return "wasm";
}

async function createPipelineWithDtype(
  modelId: string,
  device: "webgpu" | "wasm",
  requestId: string
): Promise<AsrPipeline> {
  const progress_callback = (info: { status?: string; progress?: number }) => {
    if (info.status === "progress" && typeof info.progress === "number") {
      self.postMessage({
        type: "progress",
        id: requestId,
        pct: Math.min(95, Math.round(info.progress * 0.5)),
      });
    }
  };

  if (device === "webgpu") {
    try {
      const pipe = await pipeline("automatic-speech-recognition", modelId, {
        device: "webgpu",
        dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
        progress_callback,
      });
      return pipe as unknown as AsrPipeline;
    } catch {
      // Fallback to q8 if q4 weights are unavailable for this repo
    }
  }

  const pipe = await pipeline("automatic-speech-recognition", modelId, {
    device,
    dtype: "q8",
    progress_callback,
  });
  return pipe as unknown as AsrPipeline;
}

async function getPipeline(modelId: string, requestId: string): Promise<AsrPipeline> {
  if (cachedPipeline && cachedModelId === modelId) {
    return cachedPipeline;
  }

  cachedModelId = modelId;
  cachedPipeline = (async () => {
    const device = await detectDevice();
    return createPipelineWithDtype(modelId, device, requestId);
  })();

  try {
    return await cachedPipeline;
  } catch (err) {
    cachedPipeline = null;
    cachedModelId = null;
    throw err;
  }
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      await getPipeline(msg.modelId, msg.id);
      self.postMessage({ type: "loaded", id: msg.id });
      return;
    }

    if (msg.type === "transcribe") {
      const transcriber = await getPipeline(msg.modelId, msg.id);
      const audio = msg.pcm;
      const totalChunks = Math.max(1, Math.ceil(audio.length / CHUNK_SAMPLES));
      const textParts: string[] = [];
      const allSegments: Array<{ timestamp: [number, number | null]; text: string }> = [];

      const options: Record<string, unknown> = { return_timestamps: true };
      if (!msg.modelId.endsWith(".en")) {
        options.language = "en";
        options.task = "transcribe";
      }

      self.postMessage({ type: "progress", id: msg.id, pct: 55 });

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SAMPLES;
        const end = Math.min(audio.length, start + CHUNK_SAMPLES);
        const slice = audio.subarray(start, end);
        const offsetSec = i * CHUNK_SEC;

        const output = await transcriber(slice, options);
        const single = Array.isArray(output) ? output[0] : output;
        const chunkText = Array.isArray(output)
          ? output.map((item) => item.text || "").join(" ").trim()
          : (output.text || "").trim();

        const rawChunks =
          single && Array.isArray(single.chunks) && single.chunks.length > 0
            ? single.chunks
            : [{ timestamp: [0, (end - start) / SAMPLE_RATE] as [number, number | null], text: chunkText }];

        for (const c of rawChunks) {
          const t0 = (c.timestamp?.[0] ?? 0) + offsetSec;
          const t1 =
            c.timestamp?.[1] != null
              ? c.timestamp[1] + offsetSec
              : offsetSec + (end - start) / SAMPLE_RATE;
          if (c.text && c.text.trim()) {
            allSegments.push({ timestamp: [t0, t1], text: c.text });
          }
        }

        if (chunkText) textParts.push(chunkText);

        const pct = 55 + Math.round(((i + 1) / totalChunks) * 45);
        self.postMessage({ type: "progress", id: msg.id, pct: Math.min(99, pct) });
      }

      self.postMessage({
        type: "result",
        id: msg.id,
        text: textParts.join(" ").trim(),
        chunks: allSegments,
      });
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
