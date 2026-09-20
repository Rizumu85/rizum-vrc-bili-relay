# ASS rollback clock review — v0.1.30

Baseline: v0.1.29, `0adaa6badc945b59f8070a1778e1968f4db273a9`.
Reviewed runtime and measurement adapter: `349b6172226c20175e14748b9a8bc8bed5e0fa3b`.
Review run: [35527127107](https://github.com/Rizumu85/rizum-vrc-bili-relay/actions/runs/35527127107).
The release keeps that runtime and adds release integration/documentation; its
own JSON reports record the final release revision, timings and process IDs.

This review closes the specific ASS-alignment gap documented in the v0.1.29
media audit. It is not a full-repository or real-service acceptance claim.

## Root cause and shared ownership

`render_ass` stores event timestamps relative to the origin supplied when the
file is generated. Previously `DanmakuOverlay` retained only the file path and
count. Both `MediaSessionStore::switch` and `::set_playback_rate` could recover
at a later `previous_position`, reuse the original ASS, and feed it zero-based
frames. The resource was alive, but no longer interpreted in its own clock.

The VOD resource now owns its immutable `source_origin_seconds`. Its unbound
`ass_path` accessor was removed; consumers obtain `ass_binding(producer_start)`.
Every content producer receives its actual source start through the shared
FFmpeg filter builder, including startup, resume, pause fallback and rollback.
The builder converts frame time into the borrowed ASS resource's clock only
while rasterizing it, then resets to producer-relative time before rate scaling.
Audio filters, mux offsets, codec parameters, UI, wire protocol, authentication,
configuration storage and the existing rollback ownership are unchanged.

The repair does not mutate the original subtitle file, add a per-command
compensation constant, or regenerate subtitles over the network during recovery.
Its path, count and origin stay owned by the same resource. The live overlay
variant does not have an ASS binding and does not enter this conversion.

Let A be the immutable ASS origin, S the producer source start, E an event's
source time and r the playback rate. ASS stores E-A. Feeding frames at
`t+(S-A)` gives visibility at `t=E-S`. After restoring the relative frame clock
and applying rate r, output time is `(E-S)/r`. The outer publisher/bridge offset
is deliberately absent. See FFmpeg's [setpts](https://ffmpeg.org/ffmpeg-filters.html#setpts_002c-asetpts)
and [ASS filter](https://ffmpeg.org/ffmpeg-filters.html#ass) documentation.

## Evidence

### Isolated manual FFmpeg observation

Linux FFmpeg 7.1.5; origin 20, producer start 25, event at source 31 lasting four
source seconds; output sampled at 10 fps. The unbound-clock control first drew
at relative 11.0 seconds (source 36), with 40 visible frames. The bound normal,
double and half-rate invocations first drew at 6.0, 3.0 and 12.0 output seconds,
with 40, 20 and 80 visible frames. All exits were 0 with empty stderr.

An already-active event resumed at source 32 drew immediately for the remaining
three seconds: 30 visible frames, relative 0.0 through 2.9. These are isolated
filter observations, not a full old-version application run or an active-event
failure injection through the complete session owner.

### Production-code Windows and Linux observations

`benchmarks/ass-clock.bench.ts` uses a 45-second synthetic 320x180 video whose
moving stripe encodes original source time in pixels. It starts at source 20
with an ASS event at 31, then calls the actual session owner's rate-change and
cross-session retarget methods. The proposed rate producer gets an invalid new
ASS; the proposed target gets HTTP 404. Recovery is performed by production
`MediaSessionStore`, not hand-written in the observation adapter. A redundant
resume follows. The loopback RTMP capture is decoded and each visible caption
is correlated with the source stripe in that same frame, independently of
worker progress, logs, acknowledgement arrival or publisher buffering.

Both platforms used reviewed revision `349b6172226c20175e14748b9a8bc8bed5e0fa3b`.
Windows used verified Gyan FFmpeg 9.0.2 essentials; Ubuntu used FFmpeg 6.1.1.

| Platform | Original rate | First caption source time from pixels | Visible frames at 10 fps |
| --- | --- | --- | --- |
| Windows | 1 | 31.000 s | 40 |
| Windows | 2 | 31.167 s | 20 |
| Windows | 0.5 | 31.000 s | 80 |
| Linux | 1 | 31.000 s | 40 |
| Linux | 2 | 31.000 s | 20 |
| Linux | 0.5 | 31.000 s | 80 |

These readings are quantized: the stripe resolves 1/6 source second and capture
sampling is 10 fps (0.2 source second per sample at 2x). They do not establish
sub-frame exactness. Existing input seek formatting also retains millisecond
precision. The multi-second stale-origin displacement is no longer present in
these observed recoveries.

In all six cases, both injected changes returned `ffmpeg_start_failed`, the
original session returned to `running`, the original ASS survived recovery,
unused/failed proposed resources were removed, and stopping removed the original.
The outer publisher PID was unchanged within each case. Captured video and
audio DTS backward-step counts were zero; reported diagnostic drops were zero.
The largest observed packet intervals across these review cases were 0.208 s
for video and 0.137 s for audio: this is not a zero-gap or zero-latency claim.
Every caption frame had a readable source marker.

The existing media pipeline was also measured on both platforms: no helper
pipeline error; video/audio DTS backward counts zero. Existing VOD rasters at
720p/1080p retained 25 visible frames, frames 10–34, and live rasters retained
40, frames 12–51; decoder stderr was empty. Builds and TypeScript checks ran,
and Windows packaging completed.

Warnings were not universally zero. The deliberate invalid ASS and HTTP 404
produced retained error counters. The loopback RTMP recorder reported a demuxing
I/O error on closure, although its exit was 0 and its FLV decoded successfully.
This known teardown observation was not hidden or called remote-service success.

## Diagnostics and reproduction

New `ass_bound` records in the existing bounded `relay-health*.jsonl` contain:

- `ass_origin_seconds`: the resource's immutable generation origin;
- `ass_source_start_seconds`: this producer's source start;
- `ass_offset_seconds`: the conversion used only during ASS drawing.

Existing worker/child PID and numeric source/bridge fields correlate the record
with lifecycle events. No subtitle path/body, cookie, key or upstream URL is
added to default logs. Logs remain in
`%LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics`; `dropped_records` and abrupt
termination still limit evidence completeness.

With the repository's assets and FFmpeg/FFprobe available:

```text
cargo build --locked --release -p relay-core --features media-measurements --example media-measurements
bun run benchmarks/ass-clock.bench.ts
```

The benchmark isolates account storage for its child processes, uses only
loopback endpoints, reports quantitative observations and contains no assertion
suite. Its Rust adapter is feature-gated out of the shipped worker. It adds no
production wire command. The one-shot patch-applicator and review workflow are
retained only on the review branch, not in the release tree.

Release workflows rerun these observations and retain `ass-clock.json` plus
bounded raw logs. The formal release attaches `ass-clock.json` alongside its
other reports and exact-archive SHA-256 verification.

## Limits

No real Bilibili account, VRCDN service, VRChat world, long-duration load or
exhaustive UI-path acceptance was exercised here. Failed pause-hold creation,
all crash/timeout combinations and active-comment rollback through the full
session owner were not newly injected. The shared clock boundary covers those
producer constructors, but static coverage is not an execution claim.

This change does not recreate events already filtered out at ASS generation,
redesign rolling-text glyph/collision layout or guarantee frame-perfect seeking.
The player's downstream buffer is still independent of producer source time.
No claim is made that every structural bug in the repository is fixed.
