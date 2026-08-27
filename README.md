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

The executable opens in a compact empty state. The detailed VOD-ready state is
kept only as an explicit design and benchmark fixture. The real Rust-backed
vertical slice is connected end to end:

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
- the Windows shell expands from the compact input state to the full player or settings surface, then contracts on return;
- a resolved relay that needs setup is retained while the user opens settings, then resumes from the same media session after valid settings are saved and the user returns;
- FFmpeg discovery runs in Rust and feeds the existing settings surface;
- when no system FFmpeg is present, the settings page can install a managed copy without blocking the worker;
- the managed installer verifies the publisher's SHA-256 value before activating `ffmpeg.exe` and `ffprobe.exe`;
- resolved media is held in short-lived Rust sessions instead of exposing temporary Bilibili URLs to React;
- Rust starts, observes, stops, and cleans up FFmpeg relay processes;
- on Windows, every FFmpeg process belongs to a kill-on-close Job Object so a
  crashed or forcibly terminated worker cannot leave media running in the background;
- a relay is reported as running only after FFmpeg has produced media output;
- FFmpeg playback progress is reported back to the seek control;
- changing a Bilibili part resolves fresh media and replaces the relay through one Rust workflow;
- seeking commits when the pointer is released, then restarts from the selected second;
- public VOD danmaku is fetched as Bilibili's segmented protobuf data and rendered into ASS;
- enabling danmaku switches the relay to a 1280×720 H.264/AAC transcode and burns the selected style into the picture;
- danmaku visibility, size, area, speed, opacity, font, weight, outline, and type filters cross the versioned Rust protocol;
- changing danmaku settings, switching parts, or seeking regenerates the overlay for the new source position;
- temporary ASS files stay owned by their Rust media session and are removed on replacement, stop, failure, and shutdown;
- live-room danmaku connects as a guest over Bilibili's websocket protocol and handles plain, zlib, and Brotli packets;
- a bounded Rust queue drives named FFmpeg `drawtext` filters through a loopback-only ZMQ socket;
- live danmaku is counted only after FFmpeg accepts the render command, and the websocket is interrupted during shutdown;
- FFmpeg builds without both `drawtext` and `zmq` are rejected before a live-danmaku relay starts;
- the settings page can start Bilibili's QR login, show waiting/scanned/expired states, and return to guest mode;
- authenticated API and danmaku requests reuse the Rust-owned session while cookies never cross into React or plaintext storage;
- a successful QR login is encrypted for the current Windows user and restored on restart; returning to guest mode removes it;
- VRCDN values and appearance are loaded and saved by Rust with legacy `settings.json` migration and transactional replacement;
- legacy plaintext stream keys migrate to Windows current-user encryption, while replies expose only `missing`, `available`, or `unavailable` state;
- the stream key and its protected value stay inside Rust, and relay commands no longer carry either one;
- the ready view now follows the real starting/running/completed/stopped/failed lifecycle;
- release builds put `vrc-bili-relay-gpuix.exe` and `relay-worker.exe` together in `dist/`;
- a packaged UI prefers its sibling worker over repository build artifacts, while
  the explicit worker override remains available for development diagnostics.

The following UI interactions also remain live:

- edit or paste a Bilibili page or supported media URL;
- generate a ready, loading, or error state;
- switch a real video part and seek across the full-width playback control;
- show or hide danmaku and edit its advanced settings;
- copy the generated VRChat URL;
- edit local VRCDN values, choose system/light/dark appearance, and sign in to Bilibili by QR code.

The current relay path remuxes the selected Bilibili H.264 video and audio when
no picture processing is needed. With danmaku enabled it transcodes to
1280×720 at 30 FPS and publishes H.264/AAC FLV to the configured RTMP/RTMPS
ingest. VOD uses a temporary ASS overlay; live rooms update bounded `drawtext`
slots without restarting FFmpeg. The user must copy the
ingest server, stream key, and complete playback URL from VRCDN; a playback URL
cannot be derived safely from the key. FFmpeg processes are stopped when the
user stops a relay, starts a replacement, or closes the app.

VRCDN stream keys are protected with Windows DPAPI for the current user before
they enter `settings.json`. Existing plaintext keys migrate on first read. A
protected value copied from another user or machine remains recoverable as an
explicit `unavailable` state until the user replaces or clears it. Bilibili
credentials use a separate encrypted session file with independent recovery and
logout semantics. The detailed ready state remains available as an approved
visual reference without appearing as fake product output on startup.

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
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light -Scene idle -OutputPath artifacts/idle-light.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light -Scene idle -Source "https://www.bilibili.com/video/BV1UCVn66Eww" -GenerateAddress -OutputPath artifacts/real-resolution.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme dark -OutputPath artifacts/live-window-dark.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light -Scene settings -OutputPath artifacts/settings-light.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme light -Scene settings -OpenLogin -OutputPath artifacts/login-light.png
powershell -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Theme dark -Scene danmaku -OutputPath artifacts/danmaku-dark.png
```

## Design and runtime boundaries

`design/reference-contract.json` records the approved web source, dimensions,
states, tokens, motion, and GPUIX material fallback. The browser's ambient
presentation canvas is intentionally absent: the native window itself is the
product surface.

Runtime ownership and protocol rules are documented in
[`docs/architecture.md`](docs/architecture.md).
