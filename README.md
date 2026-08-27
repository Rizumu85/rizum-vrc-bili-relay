# VRC Bili Relay — GPUIX spike

An isolated Windows UI feasibility spike that ports the approved VRC Bili Relay
Rizum Glass reference to React running on GPUI through GPUIX. It does not modify
or replace the existing WinUI 3 application.

## Current slice

The executable opens in the most detailed VOD-ready state so visual comparison
does not require a backend. The following interactions are live:

- edit or paste a Bilibili URL;
- generate a ready, loading, or error state;
- choose a video part;
- adjust playback position with click or arrow keys;
- show or hide danmaku;
- open the advanced danmaku surface and adjust size, area, speed, opacity,
  font, weight, outline, and hidden types;
- copy the generated VRChat URL;
- open the settings surface, edit VRCDN values, detect a system FFmpeg,
  persist settings under local app data, and choose system/light/dark appearance.

The source resolver, VRCDN relay, FFmpeg download/transcode pipeline, account
login, and danmaku rendering pipeline remain outside this UI spike for now.

## Run

```powershell
bun install
bun run dev
```

Build a standalone Windows executable:

```powershell
bun run build
```

## Verification policy

This repository deliberately forbids ordinary test suites. Read `AGENTS.md`
before running any verification command. The only executable suite is the GPU
render benchmark:

```powershell
bun run bench
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

## Design boundary

`design/reference-contract.json` records the approved web source, dimensions,
states, tokens, motion, and GPUIX material fallback. The browser's ambient
presentation canvas is intentionally absent: the native window itself is the
product surface.
