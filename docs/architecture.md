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
- `set_relay_paused`
- `stop_relay`
- `ensure_ffmpeg`
- `bilibili_auth_status`
- `begin_bilibili_login`
- `poll_bilibili_login`
- `logout_bilibili`
- `get_settings`
- `save_settings`
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
returns only the opaque session id. `start_relay` loads and validates the
Rust-owned VRCDN target, then starts FFmpeg from that private session. A VOD
may start with `paused: true`: the publisher connects and sends the generated
hold frame, but the source clock remains at the requested position until the
UI explicitly resumes it. The default product flow uses that prepared state so
copying and loading the address in VRChat cannot consume the beginning.
`relay_status` reports
starting, running, draining, completed, stopped, or failed; running requires observed
FFmpeg media progress, not merely a live operating-system process. VOD status
also includes the current source position parsed from FFmpeg's progress stream
and an explicit paused flag.

Relay-backed playback uses two FFmpeg layers joined by a loopback-only MPEG-TS
bridge. The outer publisher owns one RTMP connection for the complete session
and remuxes a normalized H.264/AAC stream. The replaceable inner producer reads
the upstream media, applies scaling and danmaku, and advances the source clock.
Startup first feeds a generated still frame and silence into the publisher;
only after RTMP output is observed does Rust start the real source, preventing
probe and connection setup from consuming the beginning of a video.

`set_relay_paused` replaces only the inner producer. While paused, a low-cost
still frame and silence continue across the existing RTMP connection, while
the reported VOD position remains frozen. Resume starts a fresh inner producer
at that frozen or user-selected position with monotonically continued bridge
timestamps. A one-hour paused session is closed on the next backend status
refresh; normal application polling enforces that cutoff while the app remains
open. `stop_relay` still closes the outer publisher explicitly.

When a VOD producer reaches its natural end, Rust freezes the reported source
position and swaps in the same hold-frame producer used by pause. The session
enters `draining` while the outer publisher and playback URL remain live for
five minutes, allowing downstream VRChat playback buffers to finish before the
publisher is released. A user stop or a newly generated source still releases
that hold immediately.

`retarget_relay` owns the complete part/position replacement workflow. It
loads the target and resolves fresh Bilibili media while the current content
continues, then transfers the existing outer publisher to the new private
media session and replaces only its inner producer. Seeking, part changes, and
danmaku updates therefore retain the same RTMP process, playback URL, and
monotonic bridge timeline. A paused retarget transfers the live hold producer
without starting the target source. If the target producer cannot launch,
Rust restores the previous input and position through the same publisher;
React only supplies user intent and renders the resulting state.

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
danmaku requests. `bilibili_session` encrypts the validated cookie, account name,
and UID as one DPAPI payload using entropy distinct from the VRCDN stream key.
The payload lives in `bilibili-session.json`, never in product settings. QR login
is the explicit opt-in; returning to guest mode deletes primary, backup, and
temporary session files before the in-memory account is cleared.

The auth reply reports only `none`, `session`, `saved`, or `unavailable`
persistence state. A storage failure does not discard a newly validated login:
it remains usable for the current run and the UI labels it `session`. An
unreadable or user-mismatched DPAPI payload starts in guest mode and can be
replaced by scanning again or removed by returning to guest mode.

`settings` is the only module that reads or writes product configuration. It
loads the existing `%LOCALAPPDATA%\VRC Bili Relay\settings.json` shape, accepts
legacy playback-prefix data, validates bounded fields, writes through a synced
temporary file, and keeps a recoverable backup during replacement. React gets
host, playback URL, theme, and a `streamKeyStatus`; it never reads the file or
receives the stored key or protected value. `windows_secret` wraps DPAPI without
machine scope, so the protected key is bound to the current Windows user. A v1
plaintext key is protected and atomically rewritten as v2 on first read.

Temporary upstream URLs never cross into React. The stream key is supplied by
the settings UI only when it changes, is persisted by Rust, and is represented
in replies only as `missing`, `available`, or `unavailable`. Unreadable DPAPI
data is preserved when unrelated settings change, and can be replaced or
cleared explicitly. Relay commands load the plaintext inside Rust; they never
carry or return it. FFmpeg is launched without a shell or console window. Its bounded
diagnostic tail is scrubbed of the output URL and stream key before it can be
returned. Replacing, stopping, or dropping a session shuts down and waits for its
child processes. Normal replacement first sends FFmpeg its `q` command and
waits for a clean shutdown, allowing the ingest service to release the stream
key before a seek or part switch starts the next publisher. Pause and resume
do not replace that publisher: only the loopback media producer changes. A
bounded timeout falls back to terminating a child when FFmpeg is unresponsive.
On Windows, the worker also assigns each FFmpeg child to its own unnamed Job
Object with `KILL_ON_JOB_CLOSE`. Normal cleanup still uses the explicit stop and
wait path, while abrupt worker termination delegates final process recovery to
the operating system instead of relying on Rust destructors being allowed to run.

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
{"id":3,"type":"start_relay","session_id":"19c0-1","start_seconds":0,"paused":true,"options":{"danmaku":{"enabled":true}}}
```

A VOD pause keeps that publisher connected; resume may use the position shown
by the UI after the user adjusts the seek bar:

```json
{"id":4,"type":"set_relay_paused","session_id":"19c0-1","paused":true,"start_seconds":15,"options":{"danmaku":{"enabled":true}}}
{"id":5,"type":"set_relay_paused","session_id":"19c0-1","paused":false,"start_seconds":15,"options":{"danmaku":{"enabled":true}}}
```

A running Bilibili VOD can be replaced without exposing its temporary media
URLs or duplicating the stop/start workflow in React:

```json
{"id":6,"type":"retarget_relay","current_session_id":"19c0-1","source":"https://www.bilibili.com/video/BV1PGNQesEkG","requested_part":2,"start_seconds":15,"paused":false,"options":{"danmaku":{"enabled":true}}}
```

The playback URL is an independent value copied from VRCDN. It is never
constructed from the secret stream key.

Settings use a separate read/update interface. Omitting `streamKey` preserves
the stored value; an empty value explicitly clears it. Replies never echo it:

```json
{"id":7,"type":"get_settings"}
{"id":8,"type":"save_settings","settings":{"host":"vrcdn.live","playbackUrl":"rtspt://stream.vrcdn.live/live/<id>","theme":"system","streamKey":"<secret>"}}
```

When FFmpeg is missing, installation starts through the same protocol:

```json
{"id":9,"type":"ensure_ffmpeg"}
```

The immediate reply reports `installing`; subsequent `health` replies report
downloaded and total bytes until availability becomes `managed` or `failed`.

Bilibili QR login uses a short-lived opaque session. The UI starts a session,
polls only that id, and can clear it without ever receiving the cookie:

```json
{"id":10,"type":"begin_bilibili_login"}
{"id":11,"type":"poll_bilibili_login","login_id":1}
{"id":12,"type":"logout_bilibili"}
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
`VRC_BILI_RELAY_WORKER` override, then the packaged sibling path, and finally
repository debug and release targets. A packaged executable therefore cannot
select a stale development worker merely because it was launched from the
repository root.

The worker exits after a `shutdown` command or when its stdin closes. Killing or
closing the GPUIX host therefore does not intentionally leave a background
worker running. Dropping the Rust session store also terminates every owned
FFmpeg process.

The production UI starts in an `idle` scene with no sample source or output.
`src/platform/window.ts` owns the Windows-only shell adapter: it locates the
visible window belonging to the current process, preserves its DPI-scaled
non-client frame, and changes only client height as the scene moves between the
compact input and full player/settings surfaces. Explicit `ready-vod` launch
state remains available to captures and the render benchmark.

When Rust has already resolved a relay-backed source but public settings are not
ready, React keeps that opaque session id and marks the settings detour as
resumable. Returning from settings starts the same Rust session only when the
new public state reports an available stream key and non-empty playback URL.
Leaving without valid settings cancels the pending resume and preserves the
existing explanation; it never manufactures an output URL or repeats source
resolution.

## Next product boundary

The core media, FFmpeg, danmaku, settings, and authentication seams are now
implemented. Further slices should start from a user-visible gap rather than
adding another transport or persistence layer speculatively.

Reference data is confined to the explicit `ready-vod` design fixture. Product
startup and product actions never manufacture a successful result in TypeScript.
