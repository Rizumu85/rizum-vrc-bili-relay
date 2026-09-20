# Worker transport root-cause review

Scope: UI/process transport and the stdio adapter, based on main at
`41ca3f6ee2d32b656322c79e59506af97da942a2`. This is not a claim that all media,
GPUIX, Bilibili, or VRChat behavior has been exercised.

## Evidence and changes

The previous worker-client wrote concurrent commands directly into a pipe,
started their deadlines immediately, and performed an extra health RPC before
almost every operation. The Rust worker handles commands synchronously. A slow
command therefore consumes the deadlines of unrelated commands waiting behind
it. On timeout, the UI deleted the pending entry, although the core could still
execute the command and produce a response that nobody would consume.

The transport now has one in-flight request and a bounded FIFO of unsent work.
Queue wait and dispatched execution time are measured separately. No command
is reordered or automatically retried. A queue timeout removes only unsent
work. A dispatched timeout or corrupt protocol ends that worker generation;
its Windows FFmpeg Job Objects then recover child processes. This deliberately
stops an active relay when the worker's state is no longer known, rather than
silently permitting a late mutation or duplicate publisher. A replacement
worker cannot start until exit of the old worker has been observed.

A compatibility handshake is shared per process generation; explicit health
calls still read fresh FFmpeg installation status. Errors, readers, pending
requests, and callbacks belong to that same generation.

The previous stderr reader buffered until worker exit. It now drains complete
lines immediately, retaining at most an 8 KiB diagnostic line. Stdout has an
8 MiB response-frame limit, and the worker limits a request to 1 MiB during
reading instead of checking after unlimited allocation. Oversized request tails
are discarded through the newline, never treated as another command.

Shutdown has one five-second graceful budget including both acknowledgement
and actual exit, with a bounded one-second forced-exit observation window. It
cancels unsent work, attempts core shutdown, and never waits indefinitely just
because an acknowledgement arrived. Pipe flush failures are awaited and handled.

## Ownership

- `worker-client.ts`: typed product facade and the sole UI process adapter;
  spawning, handshake, process ownership, and shutdown.
- `worker-rpc.ts`: FIFO, deadlines, correlation, envelope/reply validation;
  no process spawning or media decisions.
- `worker-lines.ts`: bounded UTF-8 line framing, no domain decisions.
- `worker-diagnostics.ts`: bounded asynchronous metadata recording.
- `relay-worker/src/main.rs`: bounded stdio adaptation, not product rules.
- `relay-worker/src/diagnostics.rs`: exhaustive command-name/timing spans,
  never Debug formatting a request that could contain secrets.
- `relay-core` retains media resolution, state, FFmpeg, persistence, and routing.

No UI layout, media time math, publisher/producer switching, or playback
semantics were rewritten as part of this transport repair.

## Collecting actual evidence

Reproduce the problem, then copy these files from
`%LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics`:

- `worker-rpc.jsonl` and `worker-rpc.previous.jsonl`;
- existing `relay-health.jsonl` and `relay-health.previous.jsonl`.

RPC telemetry is always enabled; there is no special launch flag. It stores
request ids, command names, process generation and pid, queue duration,
dispatched round-trip duration, actual Rust execution duration, byte counts,
error codes, and lifecycle events. It does not store command payloads,
upstream URLs, error message bodies, cookies, or stream keys. Unknown stderr
is represented by a byte count, not persisted verbatim.

Group RPC events by `(ui_pid, generation, worker_pid, request_id)`. Read `queued`,
`dispatched`, Rust `command_started`/`command_finished`, then `completed` or
`command_error`. `queue_ms` distinguishes blocked queued work from a command
that was actually executing. The `elapsed_ms` in `command_finished` is Rust's
monotonic execution duration; in `completed` it is the UI's dispatched round
trip. The file's unix time is the UI receipt/write-enqueue time, not a promise
that independently scheduled stdout and stderr records arrive in causal order.
Join FFmpeg measurements by worker pid and time window; this does not pretend
that existing FFmpeg samples already carry request ids.

The new writer has a 512-record queue, two files of at most 2 MiB each, and
reports cumulative `dropped_records`. Disk failures disable recording briefly
rather than blocking playback. A nonzero drop count means the trace may be
incomplete. Abrupt process termination can also lose the final buffered records.
An optional `VRC_BILI_RELAY_DIAGNOSTICS_DIR` selects an isolated directory for
measurement runs; product operation does not require it.

## Verification and limits

`benchmarks/worker-roundtrip.bench.ts` measures actual local worker startup,
256 source-inspection calls each at concurrency 1, 8, and 32, latency
percentiles, throughput, memory, errors, shutdown, and recorded command counts.
It performs no network requests, login, settings mutation, or stream publishing.
It reports measurements without a functional assertion suite.

The Windows workflow retains the JSON report and raw JSONL separately from
the portable archive. Review the recorded errors/drop counts as well as the
build status. Compilation and latency measurements are not proof of end-to-end
VRChat playback correctness. Live service behavior and a user's DPAPI/login
state need field evidence from that user's run.

The core remains synchronous: this change prevents false queue/execution
attribution but does not make a slow Bilibili/cover operation interruptible.
Use the new spans before designing a separate read-only/background job model;
do not introduce concurrent mutable access to RelayCore as a speculative fix.

## Rejected hypothesis

A local manual FFmpeg 7.1.5 Linux invocation generated one second of synthetic
media with MPEG-TS `-output_ts_offset 120`. Its progress reported
`out_time_us=1000000`, while initial packet timestamps were approximately 120
seconds. Therefore that measurement does not justify subtracting the muxer
offset from the progress clock. The existing clock math was left unchanged.
This observation is version/platform-specific, not a Windows player validation.
