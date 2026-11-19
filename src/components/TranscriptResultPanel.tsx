import { createSignal, Show, For } from "solid-js";
import {
  buildWordDocHtml,
  downloadContent,
  formatTime,
  segmentsToSrt,
  type TranscriptSegment,
} from "../lib/mediaExport";

export interface TranscriptResultPanelProps {
  fileName: string;
  modelName: string;
  durationMs: number;
  elapsedMs: number;
  text: string;
  segments: TranscriptSegment[];
  includeTimestamps: boolean;
}

export default function TranscriptResultPanel(props: TranscriptResultPanelProps) {
  const [gdocCopied, setGdocCopied] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const baseName = () => (props.fileName || "transcript").replace(/\.[^.]+$/, "");
  const hasSegments = () => props.segments && props.segments.length > 0;
  const hasResult = () => Boolean(props.text || hasSegments());

  const copyPlain = async () => {
    await navigator.clipboard.writeText(props.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyForGoogleDocs = async () => {
    const html = buildWordDocHtml({
      fileName: props.fileName,
      modelLabel: props.modelName,
      durationSec: props.durationMs / 1000,
      elapsedSec: props.elapsedMs / 1000,
      segments: props.segments,
      fullText: props.text,
      includeTimestamps: props.includeTimestamps,
    });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([props.text], { type: "text/plain" }),
        }),
      ]);
      setGdocCopied(true);
      setTimeout(() => setGdocCopied(false), 2500);
    } catch {
      await copyPlain();
    }
  };

  const downloadWordDoc = () => {
    const html = buildWordDocHtml({
      fileName: props.fileName,
      modelLabel: props.modelName,
      durationSec: props.durationMs / 1000,
      elapsedSec: props.elapsedMs / 1000,
      segments: props.segments,
      fullText: props.text,
      includeTimestamps: props.includeTimestamps,
    });
    downloadContent(html, `${baseName()}.doc`, "application/msword;charset=utf-8");
  };

  const downloadTxt = () => {
    downloadContent(props.text, `${baseName()}.txt`, "text/plain;charset=utf-8");
  };

  const downloadSrt = () => {
    downloadContent(segmentsToSrt(props.segments), `${baseName()}.srt`, "text/plain;charset=utf-8");
  };

  return (
    <div class="transcript-result-module">
      <div class="transcript-result-header">
        <div>
          <div class="transcript-result-eyebrow">TRANSCRIPT</div>
          <div class="transcript-result-title-row">
            <h3>Result</h3>
            <Show when={props.elapsedMs > 0}>
              <span class="transcript-elapsed-pill">⏱ {formatTime(props.elapsedMs / 1000)}</span>
            </Show>
          </div>
        </div>
        <div class="transcript-export-actions">
          <button class="btn btn-small btn-secondary" disabled={!hasResult()} onClick={copyPlain}>
            {copied() ? "Copied!" : "Copy"}
          </button>
          <button class="btn btn-small btn-secondary" disabled={!hasResult()} onClick={copyForGoogleDocs}>
            {gdocCopied() ? "Copied for Google Docs!" : "Copy for Google Docs"}
          </button>
          <button class="btn btn-small btn-secondary" disabled={!hasResult()} onClick={downloadWordDoc}>
            Download Word (.doc)
          </button>
          <button class="btn btn-small btn-secondary" disabled={!hasResult()} onClick={downloadTxt}>
            Download .txt
          </button>
          <button class="btn btn-small btn-secondary" disabled={!hasSegments()} onClick={downloadSrt}>
            Download .srt
          </button>
        </div>
      </div>

      <div class="transcript-result-body">
        <Show
          when={hasResult()}
          fallback={<div class="transcript-empty">Select an audio or video file to view the transcript here.</div>}
        >
          <Show
            when={props.includeTimestamps && hasSegments()}
            fallback={<div class="transcript-plain-text">{props.text}</div>}
          >
            <div class="transcript-segments">
              <For each={props.segments}>
                {(seg) => (
                  <div class="transcript-segment-row">
                    <span class="transcript-segment-time">
                      [{formatTime(seg.timestamp?.[0])} – {seg.timestamp?.[1] != null ? formatTime(seg.timestamp[1]) : "…"}]
                    </span>
                    <span class="transcript-segment-text">{seg.text}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
