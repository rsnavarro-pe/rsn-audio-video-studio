import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api, type TranscriptionResult, type ModelInfo } from "../lib/api";
import { transcribeBrowserFile, cancelBrowserJob } from "../lib/browserWhisper";
import { useI18n } from "../lib/i18n";

const isTauri = !!(window as any).__TAURI_INTERNALS__;

const AUDIO_EXTENSIONS = [
  "wav", "mp3", "flac", "ogg", "m4a", "wma", "aac", "opus", "webm",
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "ts",
];

type JobStatus = "transcribing" | "done" | "error" | "cancelled";

interface FileJob {
  id: string;
  filePath: string;
  filename: string;
  status: JobStatus;
  progress: number;
  text: string;
  language: string;
  durationMs: number;
  error: string;
  startedAt: number;
  elapsed: number;
}

function getFileExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() || "";
}

function getFileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function FileTranscriber() {
  const { t } = useI18n();
  const [jobs, setJobs] = createStore<FileJob[]>([]);
  const [dragOver, setDragOver] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [previewJob, setPreviewJob] = createSignal<FileJob | null>(null);
  const [models, setModels] = createSignal<ModelInfo[]>([]);
  const [activeModel, setActiveModel] = createSignal("");
  const [loadingModel, setLoadingModel] = createSignal(false);

  let unlisten: (() => void)[] = [];
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    // Load available models and detect active one
    try {
      const m = await api.getAvailableModels();
      setModels(m);
      const settings = await api.getSettings();
      setActiveModel(settings.model_name || m[0]?.name || "tiny.en");
    } catch (_) {}

    // Timer to update elapsed time on active jobs
    timerInterval = setInterval(() => {
      setJobs(
        produce((draft) => {
          for (const job of draft) {
            if (job.status === "transcribing") {
              job.elapsed = Date.now() - job.startedAt;
            }
          }
        })
      );
    }, 500);
  });

  onCleanup(() => {
    for (const u of unlisten) u();
    if (timerInterval) clearInterval(timerInterval);
  });

  const addFile = async (filePath: string) => {
    const ext = getFileExtension(filePath);
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      setStatusMsg(t("fileTranscriber.unsupportedFormat"));
      setTimeout(() => setStatusMsg(""), 3000);
      return;
    }

    const jobId = generateId();
    const job: FileJob = {
      id: jobId,
      filePath,
      filename: getFileName(filePath),
      status: "transcribing",
      progress: 0,
      text: "",
      language: "",
      durationMs: 0,
      error: "",
      startedAt: Date.now(),
      elapsed: 0,
    };

    setJobs(produce((draft) => { draft.unshift(job); }));

    try {
      await api.startFileJob(jobId, filePath);
    } catch (e) {
      setJobs(
        produce((draft) => {
          const j = draft.find((j) => j.id === jobId);
          if (j) {
            j.status = "error";
            j.error = String(e);
          }
        })
      );
    }
  };

  let fileInputRef: HTMLInputElement | undefined;

  const addBrowserFile = async (file: File) => {
    const ext = getFileExtension(file.name);
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      setStatusMsg(t("fileTranscriber.unsupportedFormat"));
      setTimeout(() => setStatusMsg(""), 3000);
      return;
    }

    const jobId = generateId();
    const job: FileJob = {
      id: jobId,
      filePath: file.name,
      filename: file.name,
      status: "transcribing",
      progress: 0,
      text: "",
      language: "en",
      durationMs: 0,
      error: "",
      startedAt: Date.now(),
      elapsed: 0,
    };

    setJobs(produce((draft) => { draft.unshift(job); }));

    try {
      const result = await transcribeBrowserFile(
        file,
        activeModel() || "tiny.en",
        (pct) => {
          setJobs(produce((draft) => {
            const j = draft.find((item) => item.id === jobId);
            if (j && j.status === "transcribing") j.progress = pct;
          }));
        },
        jobId
      );

      setJobs(produce((draft) => {
        const j = draft.find((item) => item.id === jobId);
        if (j && j.status !== "cancelled") {
          j.status = "done";
          j.text = result.text;
          j.language = result.language;
          j.durationMs = result.duration_ms;
          j.progress = 100;
          j.elapsed = Date.now() - j.startedAt;
        }
      }));
    } catch (e) {
      setJobs(produce((draft) => {
        const j = draft.find((item) => item.id === jobId);
        if (j && j.status !== "cancelled") {
          j.status = "error";
          j.error = String(e);
          j.elapsed = Date.now() - j.startedAt;
        }
      }));
    }
  };

  const pickFiles = async () => {
    if (!isTauri) {
      fileInputRef?.click();
      return;
    }
  };

  const confirmAction = async (message: string): Promise<boolean> => {
    try {
      const settings = await api.getSettings();
      if (!settings.file_confirm_actions) return true;
    } catch (_) {}
    return window.confirm(message);
  };

  const cancelJob = async (jobId: string) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const confirmed = await confirmAction(t("fileTranscriber.confirmCancel", { file: job.filename }));
    if (!confirmed) return;

    setJobs(
      produce((draft) => {
        const j = draft.find((j) => j.id === jobId);
        if (j) {
          j.status = "cancelled";
          j.elapsed = Date.now() - j.startedAt;
        }
      })
    );
    if (!isTauri) {
      cancelBrowserJob(jobId);
      return;
    }
    try {
      await api.cancelFileJob(jobId);
    } catch (_) {}
  };

  const removeJob = async (jobId: string) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const confirmed = await confirmAction(t("fileTranscriber.confirmRemove", { file: job.filename }));
    if (!confirmed) return;

    setJobs(produce((draft) => {
      const idx = draft.findIndex((j) => j.id === jobId);
      if (idx !== -1) draft.splice(idx, 1);
    }));
  };

  const copyResult = (text: string) => {
    navigator.clipboard.writeText(text);
    setStatusMsg(t("fileTranscriber.copied"));
    setTimeout(() => setStatusMsg(""), 2000);
  };

  const exportTxt = async (job: FileJob) => {
    const baseName = job.filename.replace(/\.[^.]+$/, "");
    downloadBlob(job.text, `${baseName}-transcript.txt`);
  };

  const downloadBlob = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const autoSaveResult = async (_job: FileJob) => {
    // Desktop filesystem auto-save disabled in web build
  };

  const activeCount = () => jobs.filter((j) => j.status === "transcribing").length;
  const doneCount = () => jobs.filter((j) => j.status === "done").length;

  return (
    <div class="file-transcriber">
      <h2>{t("fileTranscriber.title")}</h2>
      <p class="section-description">{t("fileTranscriber.description")}</p>

      {/* Model selector */}
      <div class="model-language-row" style={{ "margin-bottom": "12px" }}>
        <label>{t("meeting.model")}</label>
        <select
          value={activeModel()}
          onChange={async (e) => {
            const name = e.target.value;
            const model = models().find(m => m.name === name);
            if (!model?.path) return;
            setLoadingModel(true);
            setStatusMsg(t("models.loading", { name }));
            try {
              await api.loadModel(model.path);
              setActiveModel(name);
              const s = await api.getSettings();
              await api.saveSettings({ ...s, model_name: name, model_path: model.path });
              await api.initJobQueue();
              setStatusMsg(t("models.loadedReady", { name }));
            } catch (err) {
              setStatusMsg(t("models.loadFailed", { error: String(err) }));
            }
            setLoadingModel(false);
          }}
          disabled={loadingModel()}
        >
          <For each={models().filter(m => m.downloaded)}>
            {(m) => <option value={m.name}>{m.name} ({m.size})</option>}
          </For>
        </select>
        <Show when={loadingModel()}>
          <span class="setting-hint">{t("models.activating")}</span>
        </Show>
      </div>

      {/* Hidden file input for browser mode */}
      <input
        ref={(el) => { fileInputRef = el; }}
        type="file"
        multiple
        accept="audio/*,video/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files) {
            for (const f of Array.from(files)) {
              addBrowserFile(f);
            }
          }
          e.currentTarget.value = "";
        }}
      />

      {/* Drop zone — always clickable */}
      <div
        class={`file-drop-zone ${dragOver() ? "drag-over" : ""}`}
        onClick={pickFiles}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = e.dataTransfer?.files;
          if (files) {
            for (const f of Array.from(files)) {
              addBrowserFile(f);
            }
          }
        }}
      >
        <div class="file-drop-content">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p>{t("fileTranscriber.dropHint")}</p>
          <span class="file-drop-sub">{t("fileTranscriber.supportedFormats")}</span>
        </div>
      </div>

      <Show when={statusMsg()}>
        <div class="status-msg">{statusMsg()}</div>
      </Show>

      {/* Summary bar */}
      <Show when={jobs.length > 0}>
        <div class="file-summary">
          <Show when={activeCount() > 0}>
            <span class="file-summary-active">
              {t("fileTranscriber.activeJobs", { count: String(activeCount()) })}
            </span>
          </Show>
          <Show when={doneCount() > 0}>
            <span class="file-summary-done">
              {t("fileTranscriber.doneJobs", { count: String(doneCount()) })}
            </span>
          </Show>
        </div>
      </Show>

      {/* Job list */}
      <div class="file-jobs">
        <For each={jobs}>
          {(job) => (
            <div
              class={`file-job-card file-job-${job.status}`}
              onDblClick={() => job.status === "done" && job.text && setPreviewJob({ ...job })}
            >
              <div class="file-job-header">
                <span class="file-job-name">{job.filename}</span>
                <div class="file-job-badges">
                  <Show when={job.status === "transcribing"}>
                    <span class="file-job-badge transcribing">
                      {job.progress > 0 ? `${job.progress}%` : t("fileTranscriber.processing")}
                    </span>
                  </Show>
                  <Show when={job.status === "done"}>
                    <span class="file-job-badge done">{t("fileTranscriber.completed")}</span>
                  </Show>
                  <Show when={job.status === "error"}>
                    <span class="file-job-badge error">{t("fileTranscriber.failed")}</span>
                  </Show>
                  <Show when={job.status === "cancelled"}>
                    <span class="file-job-badge cancelled">{t("fileTranscriber.cancelledLabel")}</span>
                  </Show>
                  <span class="meta-tag">{formatDuration(job.elapsed)}</span>
                  <Show when={job.language && job.status === "done"}>
                    <span class="meta-tag">{job.language}</span>
                  </Show>
                </div>
              </div>

              {/* Progress bar */}
              <Show when={job.status === "transcribing"}>
                <div class="file-job-progress-track">
                  <div
                    class="file-job-progress-fill"
                    style={{ width: job.progress > 0 ? `${job.progress}%` : "100%" }}
                    classList={{ indeterminate: job.progress === 0 }}
                  />
                </div>
              </Show>

              {/* Error text */}
              <Show when={job.status === "error"}>
                <div class="file-job-error">{job.error}</div>
              </Show>

              <Show when={job.status === "done" && job.text}>
                <div class="file-job-hint">{t("fileTranscriber.doubleClickHint")}</div>
              </Show>

              {/* Actions */}
              <div class="file-job-actions">
                <Show when={job.status === "transcribing"}>
                  <button class="btn btn-small btn-danger" onClick={() => cancelJob(job.id)}>
                    {t("fileTranscriber.cancel")}
                  </button>
                </Show>
                <Show when={job.status === "done"}>
                  <button class="btn btn-small" onClick={() => copyResult(job.text)}>
                    {t("transcription.copy")}
                  </button>
                  <button class="btn btn-small" onClick={() => exportTxt(job)}>
                    {t("fileTranscriber.exportTxt")}
                  </button>
                </Show>
                <Show when={job.status !== "transcribing"}>
                  <button class="btn btn-small" onClick={() => removeJob(job.id)}>
                    {t("fileTranscriber.remove")}
                  </button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>

      {/* Preview modal */}
      <Show when={previewJob()}>
        {(job) => (
          <div class="file-modal-overlay" onClick={() => setPreviewJob(null)}>
            <div class="file-modal" onClick={(e) => e.stopPropagation()}>
              <div class="file-modal-header">
                <span class="file-modal-title">{job().filename}</span>
                <div class="file-modal-meta">
                  <span class="meta-tag">{job().language || "auto"}</span>
                  <span class="meta-tag">{formatDuration(job().durationMs)}</span>
                </div>
                <button class="file-modal-close" onClick={() => setPreviewJob(null)}>&#x2715;</button>
              </div>
              <textarea
                class="file-modal-text"
                readOnly
                value={job().text}
              />
              <div class="file-modal-actions">
                <button class="btn btn-primary btn-small" onClick={() => { copyResult(job().text); }}>
                  {t("transcription.copy")}
                </button>
                <button class="btn btn-small" onClick={() => exportTxt(job())}>
                  {t("fileTranscriber.exportTxt")}
                </button>
                <button class="btn btn-small" onClick={() => setPreviewJob(null)}>
                  {t("fileTranscriber.closePreview")}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
