export interface TranscriptSegment {
  timestamp: [number, number | null];
  text: string;
}

export function formatTime(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "00:00";
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function formatSrtTime(seconds?: number | null): string {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

export function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, idx) => {
      const start = formatSrtTime(seg.timestamp?.[0] ?? 0);
      const end = formatSrtTime(seg.timestamp?.[1] ?? (seg.timestamp?.[0] ?? 0) + 4);
      return `${idx + 1}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join("\n");
}

function esc(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildWordDocHtml(opts: {
  fileName?: string;
  modelLabel?: string;
  durationSec: number;
  elapsedSec: number;
  segments: TranscriptSegment[];
  fullText: string;
  includeTimestamps: boolean;
}): string {
  const dateStr = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const title = (opts.fileName || "Transcript").replace(/\.[^.]+$/, "");

  const bodyContent =
    opts.includeTimestamps && opts.segments.length > 0
      ? `<table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead>
            <tr style="background:#2C2C2E;color:#FFFFFF;">
              <th style="text-align:left;padding:8px 10px;width:130px;font-size:12px;">Timestamp</th>
              <th style="text-align:left;padding:8px 10px;font-size:12px;">Transcript</th>
            </tr>
          </thead>
          <tbody>
            ${opts.segments
              .map((seg, i) => {
                const start = formatTime(seg.timestamp?.[0]);
                const end = seg.timestamp?.[1] != null ? formatTime(seg.timestamp[1]) : "…";
                const bg = i % 2 === 1 ? "#F5F0EC" : "#FFFFFF";
                return `<tr style="background:${bg};border-bottom:1px solid #DDD5CE;">
                  <td style="padding:8px 10px;font-family:Consolas,monospace;font-size:12px;color:#90472D;vertical-align:top;white-space:nowrap;">${esc(start)} – ${esc(end)}</td>
                  <td style="padding:8px 10px;font-size:14px;line-height:1.55;color:#2C2C2E;">${esc(seg.text.trim())}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`
      : `<p style="font-size:14px;line-height:1.65;color:#2C2C2E;white-space:pre-wrap;">${esc(opts.fullText)}</p>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)} — Transcript</title>
  <style>@page{size:letter;margin:0.85in;}body{font-family:'Aptos','Calibri','Arial',sans-serif;color:#2C2C2E;margin:0;}</style>
</head>
<body>
  <div style="border-bottom:2px solid #90472D;padding-bottom:10px;margin-bottom:16px;">
    <div style="font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#90472D;">RSN AUDIO-VIDEO STUDIO · TRANSCRIPT REPORT</div>
    <h1 style="margin:4px 0 6px;font-size:24px;font-weight:600;color:#2C2C2E;">${esc(title)}</h1>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#F5F0EC;margin-bottom:18px;font-size:12px;">
    <tr>
      <td style="padding:6px 10px;"><strong>Source File:</strong> ${esc(opts.fileName || "N/A")}</td>
      <td style="padding:6px 10px;"><strong>Date:</strong> ${esc(dateStr)}</td>
    </tr>
    <tr>
      <td style="padding:6px 10px;"><strong>Model:</strong> ${esc(opts.modelLabel || "Whisper")}</td>
      <td style="padding:6px 10px;"><strong>Media Duration:</strong> ${esc(formatTime(opts.durationSec))} · <strong>Time:</strong> ${esc(formatTime(opts.elapsedSec))}</td>
    </tr>
  </table>
  ${bodyContent}
</body>
</html>`;
}

export function downloadContent(content: string | Blob, filename: string, mime = "text/plain;charset=utf-8"): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface LameJsModule {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
    encodeBuffer: (left: Int16Array, right?: Int16Array) => Int8Array;
    flush: () => Int8Array;
  };
}

let lamePromise: Promise<LameJsModule> | null = null;
function loadLameJs(): Promise<LameJsModule> {
  const win = window as unknown as { lamejs?: LameJsModule };
  if (win.lamejs) return Promise.resolve(win.lamejs);
  if (lamePromise) return lamePromise;
  lamePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
    script.onload = () => (win.lamejs ? resolve(win.lamejs) : reject(new Error("Failed to load MP3 encoder.")));
    script.onerror = () => reject(new Error("Could not load MP3 encoder from CDN."));
    document.head.appendChild(script);
  });
  return lamePromise;
}

function floatToInt16(floatArr: Float32Array): Int16Array {
  const out = new Int16Array(floatArr.length);
  for (let i = 0; i < floatArr.length; i++) {
    const s = Math.max(-1, Math.min(1, floatArr[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export async function encodeFileToMp3(
  file: File,
  onProgress?: (pct: number) => void,
  kbps = 192
): Promise<{ blob: Blob; durationSec: number }> {
  onProgress?.(5);
  const [arrayBuffer, lamejs] = await Promise.all([file.arrayBuffer(), loadLameJs()]);
  onProgress?.(20);

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close().catch(() => {});
  }

  const channels = Math.min(2, decoded.numberOfChannels || 1);
  const sampleRate = decoded.sampleRate || 44100;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const left = floatToInt16(decoded.getChannelData(0));
  const right = channels === 2 ? floatToInt16(decoded.getChannelData(1)) : null;

  const blockSize = 1152;
  const mp3Chunks: BlobPart[] = [];
  const total = left.length;

  for (let i = 0, block = 0; i < total; i += blockSize, block++) {
    const leftChunk = left.subarray(i, i + blockSize);
    const mp3buf = right
      ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
      : encoder.encodeBuffer(leftChunk);
    if (mp3buf.length > 0) mp3Chunks.push(new Uint8Array(mp3buf));

    if (block % 120 === 0) {
      onProgress?.(Math.min(95, 25 + Math.round((i / total) * 70)));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const endBuf = encoder.flush();
  if (endBuf.length > 0) mp3Chunks.push(new Uint8Array(endBuf));
  onProgress?.(100);

  return { blob: new Blob(mp3Chunks, { type: "audio/mpeg" }), durationSec: decoded.duration };
}
