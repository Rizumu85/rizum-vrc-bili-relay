# VRC Bili Relay — GPUIX + Rust experiment

An isolated Windows architecture experiment that combines a thin React/GPUIX UI
with a Rust product core. The existing WinUI 3 application remains a reference
and fallback; this repository has no C# runtime dependency.

```text
React + TypeScript UI
        │ JSON Lines over stdio
        ▼
relay-worker.exe
        │
        ▼
relay-core (Rust) ──► FFmpeg
```

## Current slice

The executable still opens in the detailed VOD-ready reference state for visual
comparison. The first real Rust-backed vertical slice is now connected:

- the Rust core recognizes Bilibili video URLs/IDs, live-room URLs, and b23.tv links;
- it expands b23.tv redirects and resolves public metadata through Bilibili APIs;
- videos return their real title, parts, CIDs, durations, and selected part;
- live rooms return their canonical room id, title, and live/replay/offline state;
- Rust selects public H.264 DASH tracks for VOD and H.264 FLV/MPEG-TS candidates for live rooms;
- public MP4, HLS, MPEG-TS, and FLV media URLs are inspected with FFprobe;
- stable public H.264/AAC MP4, HLS, and MPEG-TS URLs are returned directly without using VRCDN;
- expiring, header-bound, Bilibili-media, and FLV URLs are retained in a Rust relay session instead;
- temporary Bilibili media URLs remain private to Rust while the UI receives only a route decision;
- the worker exposes a versioned request/reply protocol over stdio;
- the TypeScript client owns worker startup, request correlation, timeout, shutdown,
  and packaged-executable discovery;
- source conversion uses the Rust network resolution instead of a frontend regex and timer;
- FFmpeg discovery runs in Rust and feeds the existing settings surface;
- when no system FFmpeg is present, the settings page can install a managed copy without blocking the worker;
- the managed installer verifies the publisher's SHA-256 value before activating `ffmpeg.exe` and `ffprobe.exe`;
- resolved media is held in short-lived Rust sessions instead of exposing temporary Bilibili URLs to React;
- Rust starts, observes, stops, and cleans up FFmpeg relay processes;
- a relay is reported as running only after FFmpeg has produced media output;
- FFmpeg playback progress is reported back to the seek control;
- changing a Bilibili part resolves fresh media and replaces the relay through one Rust workflow;
- seeking commits when the pointer is released, then restarts from the selected second;
- the ready view now follows the real starting/running/completed/stopped/failed lifecycle;
- release builds put `vrc-bili-relay-gpuix.exe` and `relay-worker.exe` together in `dist/`.

The following UI interactions also remain live:

- edit or paste a Bilibili page or supported media URL;
- generate a ready, loading, or error state;
- switch a real video part and seek across the full-width playback control;
- show or hide danmaku and edit its advanced settings;
- copy the generated VRChat URL;
- edit local VRCDN values and choose system/light/dark appearance.

The current relay path remuxes the selected Bilibili H.264 video and audio into
FLV and publishes it to the configured RTMP/RTMPS ingest. The user must copy the
ingest server, stream key, and complete playback URL from VRCDN; a playback URL
cannot be derived safely from the key. FFmpeg processes are stopped when the
user stops a relay, starts a replacement, or closes the app.

Danmaku rendering, account login, and persisted Rust-owned settings remain
future core slices. The untouched startup screen remains the approved visual
reference.

Direct playback is deliberately limited to a stable public URL that every
VRChat viewer can reach. The app does not publish a `localhost` proxy URL:
inside a shared VRChat instance, that address would point to each viewer's own
computer instead of the relay owner's machine.

## Managed FFmpeg

If both `ffmpeg.exe` and `ffprobe.exe` are already available on `PATH`, the app
uses them and does not offer a redundant download. Otherwise, the settings page
can download the Windows release-essentials ZIP published by
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/),
one of the Windows build providers linked by the official
[FFmpeg download page](https://ffmpeg.org/download.html).

Rust downloads the ZIP in the background, obtains the matching publisher
SHA-256 value, rejects oversized or mismatched files, extracts only
`bin/ffmpeg.exe` and `bin/ffprobe.exe`, checks both Windows executable
signatures, and activates the pair with an atomic replacement. The managed
toolchain and its source metadata live at:

```text
%LOCALAPPDATA%\VRC Bili Relay\media\ffmpeg\
```

The upstream Essentials build is GPLv3 software downloaded separately at the
user's request; it is not embedded in this repository or the application EXE.

## Run

```powershell
bun install
bun run dev
```

`bun run dev` builds the debug Rust worker first, then starts GPUIX with Bun HMR.
Changing TSX or Rizum Glass values does not rebuild Rust.

Build a standalone Windows distribution:

```powershell
bun run build
```

Keep both files from `dist/` in the same directory:

```text
vrc-bili-relay-gpuix.exe
relay-worker.exe
```

## Verification policy

This repository deliberately forbids ordinary test suites. Read `AGENTS.md`
before running any verification command. The only executable suite is the GPU
render benchmark:

```powershell
bun run bench
```

Rust compilation and TypeScript checking are permitted non-suite verification:

```powershell
cargo check --workspace
bun run typecheck
```

The benchmark reports the requested and actual offscreen viewport alongside
mount and idle-frame timings. GPUIX `0.5.1` currently ignores the requested
offscreen size on this Windows machine (`428×478` becomes `1536×1095.11`), so
the benchmark deliberately skips its screenshot when that mismatch occurs.

Capture the real application window instead:

```powershell
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme dark -OutputPath artifacts/live-window-dark.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light -Scene settings -OutputPath artifacts/settings-light.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme dark -Scene danmaku -OutputPath artifacts/danmaku-dark.png
```

## Design and runtime boundaries

`design/reference-contract.json` records the approved web source, dimensions,
states, tokens, motion, and GPUIX material fallback. The browser's ambient
presentation canvas is intentionally absent: the native window itself is the
product surface.

Runtime ownership and protocol rules are documented in
[`docs/architecture.md`](docs/architecture.md).
