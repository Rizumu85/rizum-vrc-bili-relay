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
- `shutdown`

The first source inspection classifies video, live-room, and short links and
returns the next resolution step without doing I/O. Source resolution then
expands b23.tv redirects and reads public Bilibili metadata. For videos it
returns the canonical BV id, title, parts, CIDs, durations, selected part, and
the best public H.264 DASH tracks. For live rooms it returns the canonical room
id, title, live/replay/offline state, and the preferred public H.264 FLV or
MPEG-TS candidate. Temporary upstream URLs stay inside the Rust module. The UI
only receives a route decision describing whether FFmpeg or a relay is needed.
It deliberately does not pretend that a playback URL or relay has already been
created.

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

Success and failure are explicit:

```json
{"status":"ok","id":1,"result":{"type":"source_inspection","inspection":{"kind":"video","source_id":"BV1UCVn66Eww","canonical_url":"https://www.bilibili.com/video/BV1UCVn66Eww","requires_network_resolution":true,"next_step":"probe_direct_playback"}}}
```

```json
{"status":"error","id":1,"error":{"code":"unsupported_source","message":"Only Bilibili video, live-room, and b23.tv links are supported"}}
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
worker running.

## Next Rust slices

Implement future behaviour in this order so every slice crosses the same seam:

1. Persist resolved upstream details in a short-lived Rust media session.
2. Start and stop FFmpeg from that session with clean cancellation.
3. Manage the local playback server and VRCDN publishing lifecycle.
4. Return the generated VRChat playback URL and live job state.
5. Download, verify, select, and launch a managed FFmpeg when the system copy is missing.
6. Fetch danmaku and render ASS filters through FFmpeg.
7. Move persisted product settings and credentials behind the Rust interface.

The approved UI may keep reference data while a slice is under construction,
but product actions must never manufacture a successful result in TypeScript.
