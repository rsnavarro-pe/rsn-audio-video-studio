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

export interface StructuredParagraph {
  startSec: number | null;
  text: string;
}

const MAX_SENTENCES_PER_PARA = 5;
const MAX_WORDS_PER_PARA = 135;
const MIN_WORDS_FOR_PAUSE = 25;
const PAUSE_GAP_SEC = 1.8;
const SECTION_INTERVAL_SEC = 300; // 5 minutes

export function groupSegmentsIntoParagraphs(
  segments: TranscriptSegment[],
  fullText: string,
  _durationSec: number
): StructuredParagraph[] {
  const maxSentences = MAX_SENTENCES_PER_PARA;
  const maxWords = MAX_WORDS_PER_PARA;
  const minWordsForPause = MIN_WORDS_FOR_PAUSE;
  const pauseSec = PAUSE_GAP_SEC;

  if (!segments || segments.length === 0) {
    const sentences = (fullText || "").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length === 0) return [];
    const paras: StructuredParagraph[] = [];
    let buf: string[] = [];
    let words = 0;
    for (const s of sentences) {
      buf.push(s);
      words += s.split(/\s+/).length;
      if (buf.length >= maxSentences || words >= maxWords) {
        paras.push({ startSec: null, text: buf.join(" ") });
        buf = [];
        words = 0;
      }
    }
    if (buf.length > 0) paras.push({ startSec: null, text: buf.join(" ") });
    return paras;
  }

  const paras: StructuredParagraph[] = [];
  let texts: string[] = [];
  let words = 0;
  let sentences = 0;
  let paraStart: number | null = null;
  let lastEnd: number | null = null;

  const flush = () => {
    if (texts.length === 0) return;
    paras.push({ startSec: paraStart, text: texts.join(" ").replace(/\s+/g, " ").trim() });
    texts = [];
    words = 0;
    sentences = 0;
    paraStart = null;
  };

  for (const seg of segments) {
    const segText = (seg.text || "").trim();
    if (!segText) continue;
    const t0 = seg.timestamp?.[0] ?? 0;
    const t1 = seg.timestamp?.[1] ?? t0;

    if (texts.length > 0 && lastEnd != null && t0 - lastEnd >= pauseSec && words >= minWordsForPause) {
      flush();
    }

    if (paraStart === null) paraStart = t0;
    texts.push(segText);
    words += segText.split(/\s+/).length;
    sentences += (segText.match(/[.!?]+(?=\s|$)/g) || []).length;
    lastEnd = t1;

    const endsSentence = /[.!?]["']?$/.test(segText);
    if (sentences >= maxSentences || (words >= maxWords && endsSentence) || words >= maxWords + 25) {
      flush();
    }
  }
  flush();
  return paras;
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
  const paragraphs = groupSegmentsIntoParagraphs(opts.segments, opts.fullText, opts.durationSec);
  const showSections = opts.durationSec >= SECTION_INTERVAL_SEC;
  let nextSectionAt = SECTION_INTERVAL_SEC;

  const bodyContent =
    opts.includeTimestamps && paragraphs.some((p) => p.startSec !== null)
      ? `<table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead>
            <tr style="background:#2C2C2E;color:#FFFFFF;">
              <th style="text-align:left;padding:8px 10px;width:90px;font-size:12px;">Time</th>
              <th style="text-align:left;padding:8px 10px;font-size:12px;">Transcript</th>
            </tr>
          </thead>
          <tbody>
            ${paragraphs
              .map((p, i) => {
                let sectionRow = "";
                if (showSections && p.startSec != null && p.startSec >= nextSectionAt) {
                  const secNum = Math.floor(p.startSec / SECTION_INTERVAL_SEC) + 1;
                  nextSectionAt = secNum * SECTION_INTERVAL_SEC;
                  sectionRow = `<tr style="background:#F2E4DD;"><td colspan="2" style="padding:6px 10px;font-size:11px;font-weight:600;color:#90472D;text-transform:uppercase;letter-spacing:0.6px;">Section ${secNum} · ${esc(formatTime(p.startSec))}</td></tr>`;
                }
                const bg = i % 2 === 1 ? "#F5F0EC" : "#FFFFFF";
                const timeLabel = p.startSec != null ? formatTime(p.startSec) : "—";
                return `${sectionRow}<tr style="background:${bg};border-bottom:1px solid #DDD5CE;">
                  <td style="padding:10px;font-family:Consolas,monospace;font-size:12px;color:#90472D;vertical-align:top;white-space:nowrap;">${esc(timeLabel)}</td>
                  <td style="padding:10px;font-size:13.5px;line-height:1.6;color:#2C2C2E;">${esc(p.text)}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>`
      : paragraphs
          .map((p) => {
            let heading = "";
            if (showSections && p.startSec != null && p.startSec >= nextSectionAt) {
              const secNum = Math.floor(p.startSec / SECTION_INTERVAL_SEC) + 1;
              nextSectionAt = secNum * SECTION_INTERVAL_SEC;
              heading = `<h3 style="margin:18pt 0 6pt;font-size:11pt;color:#90472D;border-bottom:1px solid #DDD5CE;padding-bottom:3pt;">Section ${secNum} · ${esc(formatTime(p.startSec))}</h3>`;
            }
            return `${heading}<p style="margin:0 0 11pt 0;font-size:11pt;line-height:1.6;color:#2C2C2E;">${esc(p.text)}</p>`;
          })
          .join("");

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
