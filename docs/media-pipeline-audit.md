# Media pipeline root-cause review — v0.1.29

Baseline: `cb4e405022981c4a4dc0244c80911ab1bc9f75cd` (v0.1.28).
Final reviewed runtime: `0a70d7c395fc618556d695274339578eb3c45c6b`.
The release consolidates that runtime with this audit and README corrections;
its own build and measurement reports identify the final release commit.

Scope: Rust media producer/publisher ownership, media timing, audio topology,
ASS/filter syntax, live drawtext geometry, and local evidence collection.
This is not an assertion that every UI, Bilibili, VRCDN or VRChat path was tested.
The stable outer RTMP publisher / replaceable MPEG-TS producer design remains;
there is no speculative codec rewrite, UI redesign, or timeout/buffer increase.

## Shared invariants and owning modules

### Producer lifetime and the two media clocks

`ffmpeg.rs` now drains each terminated child's progress/stderr readers before
using its final available progress to retire the producer. Pause, resume,
content replacement, and a partly emitting failed producer use the same
retirement path. The bridge offset advances by that producer's observed output
interval and the existing switch gap; it is not advanced from a racing reader.
Resume uses the same observed-output readiness path as content switching, and
also checks publisher liveness. A successful OS spawn is not playback success.

The source clock remains `source_start + rate * producer_relative_progress`.
The muxer's bridge timestamp offset is a different coordinate system. A manual
FFmpeg 7.1.5 invocation with `-output_ts_offset 120` reported one second of
progress for one second of generated media, not 121 seconds. No speculative
subtraction of the muxer offset was introduced.

`media_session.rs` consumes an explicit pause outcome (unchanged, paused,
resumed), preserving the actual producer's ASS resource on repeated intents.
It synchronizes the paused flag from process ownership after fallback. Observed
positions clamp to duration, while the existing seek-away-from-EOF rule remains
only at the command boundary. `lib.rs` warms the danmaku cache before resampling
position for a rate change, rather than restarting at a position captured before
network preparation. This is not a frame-accurate seek guarantee.

Forced termination can still omit a final FFmpeg progress record; draining the
available stream is not a proof of packet-exact recovery for every hard crash.
The relay position describes producer source time, not a remote player's buffer.

### One normalized audio/video contract

`MediaInput` now carries `MediaAudio::{Separate, Embedded, Silence}`. Resolver
modules own that decision; FFmpeg no longer confuses a missing separate URL with
an embedded audio track. Confirmed audio-less sources get generated stereo AAC.
Generated audio is subordinate to video EOF even when an unknown-duration input
is classified live. VOD audio is padded and video-owned; live embedded audio is
not padded into an infinite source. Bilibili live candidates still expect their
embedded audio; this patch does not introduce a new network probe there.

Both hold and content producers emit even-sized H.264 and 48 kHz stereo AAC.
Content normalization respects display aspect ratio and declares square pixels.
Every fresh MPEG-TS producer sets `+initial_discontinuity`: its continuity
counters restart even though bridge timestamps continue. Merely adjusting
`-output_ts_offset` does not communicate that transport boundary.

The bitrate, GOP, x264 slice policy, existing switch gap and startup timeouts were
not blindly retuned. Short switching gaps remain measurable.

### Syntax, frame-time rendering, and slot ownership

`filter_syntax.rs` owns option-value escaping, the extra filtergraph layer, and
the separate outer whitespace-token layer of a ZMQ command. A path that worked
without punctuation was not proof the old single-quoted builder was correct.
Full reinit arguments, not just comment text, pass through ZMQ token escaping.
No shell is invoked; literal text expansion remains disabled at initialization.

`live_danmaku_render.rs` owns pure geometry and slot reservations, separate from
websocket/network handling. Motion and self-expiry start at the first actually
rendered frame via expression-local state, not a thread's wall-clock epoch.
Position and font size scale with frame dimensions; bottom text subtracts its
actual height. Fixed text self-expires without requiring a successful clear.
An unconfirmed clear does not release its slot/lane for a new comment.

Rust's wall-time retention is still a bounded real-time chat policy: a long
video stall may discard stale chat. It is not claimed to be source-frame-exact
live synchronization. The displayed count still means accepted commands, not
proof of rendered pixels; actual pixels are measured separately by the benchmark.

During review, the first patch repeated `expansion=none` in runtime reinit.
Windows FFmpeg 9.0.2 rejected that non-runtime option, producing zero live text
frames despite a successful benchmark process exit. This was a caught review
regression, not an existing v0.1.28 defect. Initialization-only policy now stays
in `filter_graph`; dynamic commands contain runtime options only. There is no
Windows-specific workaround or FFmpeg-version branch.

## Actual observations

### Manual before/after observations — Linux FFmpeg 7.1.5

- Three 0.8-second TS segments at offsets 0, 0.87 and 1.74 seconds: the original
  remux logged six corrupt/drop warnings; declaring initial discontinuity logged
  zero. Both commands exited 0, so exit status alone missed the symptom.
- An ASS file under `O'Brien,[notes];`: the old quoted builder exited 8; the
  two-layer builder exited 0. These are observed syntax failures, not a guessed
  connection or font-cache problem.
- A five-second thread/frame-clock mismatch: the original live command was
  acknowledged successfully but rendered zero visible frames; a frame-anchored
  prototype rendered 19 frames in its two-second rolling-text interval.
- A finite 0.8-second video with infinite generated silence remained alive at a
  three-second observation cutoff without video-owned termination; `-shortest`
  allowed normal EOF. The production benchmark now covers this for live-classified
  audio-less media as well.

### Final reviewed production-code measurements

Review runs (2026-09-20):

- [Windows build and measurements, run 35522650591](https://github.com/Rizumu85/rizum-vrc-bili-relay/actions/runs/35522650591)
- [Linux media measurements, run 35522650535](https://github.com/Rizumu85/rizum-vrc-bili-relay/actions/runs/35522650535)

Both used runtime revision `0a70d7c395fc618556d695274339578eb3c45c6b`.
Windows used Gyan FFmpeg 9.0.2 essentials, verified against the publisher's
SHA-256; Linux used Ubuntu FFmpeg 6.1.1. The reports include exact version strings.

| Observation | Windows 9.0.2 | Linux 6.1.1 |
| --- | --- | --- |
| Helper process / pipeline error | exit 0 / null | exit 0 / null |
| Publisher PID through all transitions | 3388, unchanged | 6641, unchanged |
| Captured video/audio packets | 975 / 1530 | 962 / 1511 |
| Backward video/audio DTS steps | 0 / 0 | 0 / 0 |
| Largest video/audio DTS interval | 0.139 / 0.133 s | 0.165 / 0.129 s |
| Finite video with live-classified generated audio | source EOF, 12.557 s | source EOF, 12.010 s |
| Media diagnostic records / reported drops | 97 / 0 | 96 / 0 |

The captured stream was H.264 1280x720, SAR 1:1, with AAC 48 kHz stereo on both
platforms, including the video-only transition. Operations included prepared
pause, resume, repeated pause, seek/resume at 2x, video-only source, deliberate
HTTP 404, recovery, natural completion and live-classified video EOF. Repeated
pause retained the same producer and source position. The observed-position
clamp preserved 11.8 seconds in a 12-second fixture; a requested EOF seek still
normalized to 11 seconds under the existing policy.

At both 720p and 1080p on both platforms, the VOD raster observation produced 35
frames at 10 fps, with 25 visible frames starting at frame 10: an event at source
31 seconds appeared one second after starting at 30. The live observation shifted
frame time by five seconds, sent a real ZMQ command and deliberately sent no clear.
It produced 65 frames with exactly 40 visible frames (12 through 51), i.e. four
seconds followed by self-expiry. All four raster commands per platform exited 0
with empty stderr after the runtime-option correction. Pixel bounds remained
inside both canvases; this is numeric raster evidence, not a visual assertion suite.

Windows also measured 768 actual worker inspection requests at concurrency
1/8/32 with no reported command errors and zero transport drops. This workload
does not exercise network resolution or user account state.

Warnings were NOT universally zero. The deliberate 404 produced HTTP error
counters; some other-category stop/EOF warnings were retained. The loopback
RTMP recorder logged an I/O/demuxing error when the publishing session closed,
although the resulting FLV was readable and the helper reported source EOF.
That teardown observation is not silently deleted or presented as remote-service
acceptance. Short-run timings include startup and buffering, not sustained
throughput guarantees. The release rebuild's own JSON contains its own timings
and PIDs; it is not expected to reproduce these incidental values exactly.

## Collecting field evidence

Default directory:

```text
%LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics
```

Keep `relay-health.jsonl`, `relay-health.previous.jsonl`, `worker-rpc.jsonl` and
`worker-rpc.previous.jsonl`, plus operation time, product version and FFmpeg
version. Correlate worker PID and time window. Media transitions record publisher
and producer PIDs, bridge offset, source start/position, rate, pause/draining,
and output dimensions. Live samples count dequeued/capacity-dropped events,
accepted/unconfirmed reinit/clear commands and exchange latency. Filter parsing,
non-runtime options and failed commands have separate warning categories.

Logs are local and bounded; no raw upstream URL, cookie, stream key, complete
command or comment payload is persisted by default. A nonzero `dropped_records`
means evidence may be incomplete; abrupt shutdown can also lose final queued
records. The optional `VRC_BILI_RELAY_DIAGNOSTICS_DIR` isolates measurement logs.
Product version comes from the release/package manifest; the existing independent
Rust crate version reported by health remains 0.1.6.

## Reproduction and limits

`benchmarks/media-pipeline.bench.ts` generates local synthetic media, serves it
on loopback HTTP, records a loopback RTMP publisher, and collects actual FFprobe
packets and text pixel counts. The feature-gated Rust example calls production
builders and process ownership. It is not enabled in the shipped worker and adds
no UI command. It does not read account credentials, change product settings or
publish to a public stream. With repository assets and FFmpeg/FFprobe available:

```text
cargo build --locked --release -p relay-core --features media-measurements --example media-measurements
bun run benchmarks/media-pipeline.bench.ts
```

Only builds, type checking, manual invocations and quantitative benchmarks were
executed, consistent with AGENTS.md. No unit/integration/e2e/smoke/visual-regression
suite was added or run. Green jobs are not substituted for reading their reports:
this review caught the FFmpeg 9 regression precisely because pixel measurements
were inspected rather than treating exit 0 as success.

Unverified: real Bilibili account/DPAPI state, real VRCDN and VRChat playback,
long-duration load, every lost-ACK/slot-exhaustion path, and every full UI/session
command path. Process recovery was observed without an ASS overlay; subtitle
alignment during failed-change rollback was not validated. Rolling VOD glyph-
width collision packing and arbitrary font differences were not rewritten.
Paused output remains a generated indicator, not the video's actual last frame;
the README now describes that accurately. These limits are not claims that those
areas are correct or that further measured fixes will never be needed.
