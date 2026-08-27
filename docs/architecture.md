# Architecture

## Runtime ownership

The product uses a thin presentation module and a deep Rust module.

| Concern | Owner |
| --- | --- |
| Layout, tokens, motion, visible state | React + TypeScript |
| GPUI rendering | `@gpuix/react` + its native GPUI binding |
| Product decisions and media workflow | `relay-core` in Rust |
| Process seam | `relay-worker` + `src/relay/worker-client.ts` |
| Media codecs and container conversion | external FFmpeg process |
| Legacy reference implementation | WinUI/C#, outside this repository |

Changing the UI must stay on the Bun HMR path. Do not move layout values,
Rizum Glass tokens, copy, or motion into Rust. Conversely, React must not decide
whether a source can play directly, needs relay, needs FFmpeg, or needs VRCDN.

## Rust module

`RelayCore::handle(Command)` is the external interface of the Rust module. It
hides URL parsing, environment inspection, and future network/media workflow
behind a small set of commands. `relay-worker` is only a transport adapter and
must not accumulate product rules.

Current commands:

- `health`
- `inspect_source`
- `resolve_source`
- `start_relay`
- `retarget_relay`
- `relay_status`
- `stop_relay`
- `ensure_ffmpeg`
- `bilibili_auth_status`
- `begin_bilibili_login`
- `poll_bilibili_login`
- `logout_bilibili`
- `shutdown`

The first source inspection classifies video, live-room, short, and generic
media links and returns the next resolution step without doing I/O. Source
resolution then expands b23.tv redirects and reads public Bilibili metadata.
For videos it
returns the canonical BV id, title, parts, CIDs, durations, selected part, and
the best public H.264 DASH tracks. For live rooms it returns the canonical room
id, title, live/replay/offline state, and the preferred public H.264 FLV or
MPEG-TS candidate. Generic MP4, HLS, MPEG-TS, and FLV URLs are inspected by
FFprobe. A stable public H.264/AAC input can cross the seam as a direct playback
URL; expiring, header-bound, Bilibili-media, and FLV inputs stay inside Rust and
become relay sessions. The UI receives the route decision, not private upstream
credentials or temporary URLs.
When a usable input is found, Rust retains it in a ten-minute media session and
returns only the opaque session id. `start_relay` validates the user-provided
VRCDN target and starts FFmpeg from that private session. `relay_status` reports
starting, running, completed, stopped, or failed; running requires observed
FFmpeg media progress, not merely a live operating-system process. VOD status
also includes the current source position parsed from FFmpeg's progress stream.

`retarget_relay` owns the complete part/position replacement workflow. It
validates the target and resolves fresh Bilibili media before suspending the
current session, then starts a new short-lived session at the requested second.
If the new FFmpeg process cannot launch, Rust attempts to resume the suspended
session. React only supplies user intent and renders the resulting resolution
and relay state.

Public VOD resolution also retains the Bilibili CID and duration inside the
same private media session. When `options.danmaku.enabled` is true, Rust fetches
the remaining six-minute protobuf segments as a guest, applies the UI's style
and type filters, and atomically writes a bounded temporary ASS file. FFmpeg
then scales and pads to 1280×720 at 30 FPS, burns that ASS overlay, and encodes
H.264/AAC for the FLV relay. Seeking starts both the media and the regenerated
ASS timeline at the normalized source position. The media session owns the ASS
file, so replacement, completion, failure, stop, expiry, and shutdown all clean
it up. No upstream media URL or danmaku payload crosses into React.

For a live room, Rust obtains an anonymous Bilibili identity and danmaku server
configuration, then reads Bilibili's binary websocket protocol on a dedicated
thread. Plain, zlib, and Brotli envelopes are decoded with nesting and size
limits; only supported `DANMU_MSG` events enter a bounded queue. FFmpeg exposes
24 named `drawtext` slots behind a loopback-only ZMQ filter. A second Rust
thread assigns lanes and slots, sends reinitialization commands, and clears
expired fixed text. Relay status counts commands accepted by FFmpeg rather than
messages merely received from the websocket. The selected FFmpeg executable is
preflighted once per path for `drawtext` and `zmq` support. Cancellation closes
the active TCP connection before joining both threads, keeping relay shutdown
bounded.

`bilibili_auth` owns the QR login lifecycle and authenticated browser cookies.
React receives only an opaque login id, display state, account name after
success, and the QR module path needed for the visible code. The QR session key
and authenticated cookies remain inside Rust. Successful credentials are
validated against Bilibili's navigation endpoint, then attached to metadata and
danmaku requests. Logout clears both pending and authenticated state. This slice
is intentionally memory-only; it does not write credentials to the TypeScript
settings file.

Temporary upstream URLs never cross into React. The stream key is supplied by
the settings UI only in the `start_relay` command and is never returned or
logged. FFmpeg is launched without a shell or console window. Its bounded
diagnostic tail is scrubbed of the output URL and stream key before it can be
returned. Replacing, stopping, or dropping a session kills and waits for its
child process.

`ffmpeg_manager` is the single Rust module responsible for FFmpeg/FFprobe
toolchain selection and managed installation. Its external interface is
deliberately small: report status, ensure availability, return selected tool
paths, and cancel on shutdown. System-path detection, data-directory selection,
background HTTP transfer, byte progress, size limits, SHA-256 verification,
safe ZIP extraction, install metadata, and atomic replacement remain inside the
module.

Installation follows `missing → installing → managed | failed`. Because the
download runs on its own Rust thread, the stdio worker remains responsive to
health and shutdown commands. `health` carries current byte progress; React
polls that existing command rather than gaining a second download-status
interface. A stale partial file is never considered installed and is replaced
on the next attempt.

## Wire protocol

Each request and response is one UTF-8 JSON object followed by a newline.
Requests have a caller-generated numeric `id` and a tagged command:

```json
{"id":1,"type":"inspect_source","source":"https://www.bilibili.com/video/BV1UCVn66Eww"}
```

Network resolution uses a separate command so callers can inspect without I/O:

```json
{"id":2,"type":"resolve_source","source":"https://www.bilibili.com/video/BV1UCVn66Eww?p=2"}
```

Resolved media can then be published through its opaque session:

```json
{"id":3,"type":"start_relay","session_id":"19c0-1","target":{"ingest_server":"rtmp://ingest.vrcdn.live/live","stream_key":"<secret>","playback_url":"rtspt://stream.vrcdn.live/live/<id>","start_seconds":0},"options":{"danmaku":{"enabled":true}}}
```

A running Bilibili VOD can be replaced without exposing its temporary media
URLs or duplicating the stop/start workflow in React:

```json
{"id":4,"type":"retarget_relay","current_session_id":"19c0-1","source":"https://www.bilibili.com/video/BV1PGNQesEkG","requested_part":2,"target":{"ingest_server":"rtmp://ingest.vrcdn.live/live","stream_key":"<secret>","playback_url":"rtspt://stream.vrcdn.live/live/<id>","start_seconds":15},"options":{"danmaku":{"enabled":true}}}
```

The playback URL is an independent value copied from VRCDN. It is never
constructed from the secret stream key.

When FFmpeg is missing, installation starts through the same protocol:

```json
{"id":5,"type":"ensure_ffmpeg"}
```

The immediate reply reports `installing`; subsequent `health` replies report
downloaded and total bytes until availability becomes `managed` or `failed`.

Bilibili QR login uses a short-lived opaque session. The UI starts a session,
polls only that id, and can clear it without ever receiving the cookie:

```json
{"id":6,"type":"begin_bilibili_login"}
{"id":7,"type":"poll_bilibili_login","login_id":1}
{"id":8,"type":"logout_bilibili"}
```

Success and failure are explicit:

```json
{"status":"ok","id":1,"result":{"type":"source_inspection","inspection":{"kind":"video","source_id":"BV1UCVn66Eww","canonical_url":"https://www.bilibili.com/video/BV1UCVn66Eww","requires_network_resolution":true,"next_step":"probe_direct_playback"}}}
```

```json
{"status":"error","id":1,"error":{"code":"unsupported_source","message":"Only Bilibili pages and HTTP(S) MP4, HLS, MPEG-TS, or FLV media links are supported"}}
```

Protocol version changes are reported by `health`. The UI rejects a worker with
a different version instead of attempting a silent compatibility fallback.

Stdout is reserved for protocol messages. Rust diagnostics must use stderr so a
log line can never corrupt request correlation.

## Packaging and lifecycle

Development builds the worker at `target/debug/relay-worker.exe`. Release builds
copy it beside the GPUIX executable. The TypeScript adapter checks an explicit
`VRC_BILI_RELAY_WORKER` override, development targets, and then the packaged
sibling path.

The worker exits after a `shutdown` command or when its stdin closes. Killing or
closing the GPUIX host therefore does not intentionally leave a background
worker running. Dropping the Rust session store also terminates every owned
FFmpeg process.

## Next Rust slices

Implement future behaviour in this order so every slice crosses the same seam:

1. Move persisted product settings behind the Rust interface.
2. Add encrypted Windows credential persistence only after its lifecycle and
   failure states are represented explicitly at the same boundary.

The approved UI may keep reference data while a slice is under construction,
but product actions must never manufacture a successful result in TypeScript.
