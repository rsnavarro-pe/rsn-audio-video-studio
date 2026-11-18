import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text?: string } | Array<{ text?: string }>>;

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

async function getPipeline(modelId: string, requestId: string): Promise<AsrPipeline> {
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
          self.postMessage({
            type: "progress",
            id: requestId,
            pct: Math.min(95, Math.round(info.progress * 0.6)),
          });
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
      self.postMessage({ type: "progress", id: msg.id, pct: 75 });

      const output = await transcriber(msg.pcm, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });

      const text = Array.isArray(output)
        ? output.map((item) => item.text || "").join(" ").trim()
        : (output.text || "").trim();

      self.postMessage({ type: "result", id: msg.id, text });
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
