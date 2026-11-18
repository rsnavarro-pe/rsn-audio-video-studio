# RSN Audio-Video Studio

Web-only English audio/video transcription studio built with SolidJS + Vite (stripped from Open Speech Studio without Tauri desktop dependencies).

## Features

- **Web-Only Interface** — Pure SolidJS + Vite frontend ready for browser & Vercel deployment.
- **English Transcription** — Configured for English transcription (`models/ggml-base.bin`).
- **Audio & Video File Transcription** — Upload or drag-and-drop audio/video files and export transcripts as `.txt`.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production bundle is output to `dist/`.

## Deploy to Vercel

```bash
vercel link
vercel --prod
```

Or import the GitHub repository directly in the Vercel dashboard (Framework Preset: Vite, Build Command: `npm run build`, Output Directory: `dist`).
