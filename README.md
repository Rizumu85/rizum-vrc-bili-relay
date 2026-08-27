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
- temporary Bilibili media URLs remain private to Rust while the UI receives only a route decision;
- the worker exposes a versioned request/reply protocol over stdio;
- the TypeScript client owns worker startup, request correlation, timeout, shutdown,
  and packaged-executable discovery;
- source conversion uses the Rust network resolution instead of a frontend regex and timer;
- FFmpeg discovery runs in Rust and feeds the existing settings surface;
- release builds put `vrc-bili-relay-gpuix.exe` and `relay-worker.exe` together in `dist/`.

The following UI interactions also remain live:

- edit or paste a Bilibili URL;
- generate a ready, loading, or error state;
- choose a video part and adjust playback position;
- show or hide danmaku and edit its advanced settings;
- copy the generated VRChat URL;
- edit local VRCDN values and choose system/light/dark appearance.

FFmpeg process orchestration, VRCDN streaming, managed FFmpeg download, account
login, and danmaku rendering are the next Rust core slices. The untouched startup
screen remains the approved visual reference.
After the user submits a link, its title and part data are real, while the UI
shows the real media route and explicitly marks it as waiting for FFmpeg relay startup.

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
