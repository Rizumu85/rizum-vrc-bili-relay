# UI state ownership review — v0.1.31

Baseline: v0.1.30 (`9f1e967fbb92f349a1986579609d61adbc582179`).
Reviewed runtime: `98f883421ed72a2a17cb91a8b2808757d151cc15`.
Review run: https://github.com/Rizumu85/rizum-vrc-bili-relay/actions/runs/35535917820

This patch follows the five reported groups in order. It does not claim a full
repository audit, native-window acceptance, or real-service playback acceptance.
The formal release keeps this runtime and adds release integration/documentation.

## 1. Playback intent and session ownership

The old UI's epoch checks discarded stale results but did not consistently
release the resources those results created. Individual handlers also discovered
active sessions from React render snapshots, not from a single resource owner.
A newer conversion could start while an earlier start was still pending, then
fail resolution after the earlier result was discarded, leaving an orphan relay.

`PlaybackFlow` now serializes complete UI playback workflows, including polling,
and owns the session lease with its worker generation and acquiring intent.
Start/retarget successes are adopted before checking whether their intent became
stale. A newly acquired stale lease is released by exact session and generation
before the next mutation dispatches. Pausing/rate-changing an existing lease does
not make that operation its creator. Failed stale release ends that same worker
generation; it does not run a blanket stop against a new worker or silently retry.
This fallback can stop an active relay and invalidate a queued new intention.

`AppSurface` uses the coordinator for generation, prepared resume, retarget,
rate, pause, completion and stop. An immediate busy guard does not wait for a
React rerender. Rust still owns media routing, core rollback and FFmpeg processes;
the UI coordinator does not duplicate those decisions or run FFmpeg itself.

## 2. Evidence-based failure state

The old UI considered any error other than `retarget_restore_failed` or
`rate_restore_failed` proof that playback was restored. That incorrectly included
worker timeouts/protocol failures which terminate the process generation.

`PlaybackFailure.confirmedStatus` now comes from a real status readback in the
same still-live worker generation. An unconfirmed read is unknown, not success.
The owner retains the lease for later polling/stop after a transient read failure.
Worker generation loss is broadcast from the sole process adapter and revokes
all old UI sessions and account scopes. Generation-pinned requests fail before
spawn, so polling an old session cannot create a fresh worker. Commands are not
replayed after an uncertain mutation. The stdout protocol remains version 25.

## 3. Authenticated library scopes

The old module-global map used keys such as `folders`, `watch-later`, `history:1`
without an account namespace. Logout did not revoke cache/inflight ownership.

Each app now has a `LibraryCache` with an account/worker scope and revocable
epoch. Login/logout revoke before dispatch. Auth reads and login polling also
carry local auth epochs. Old replies cannot repaint a remounted view, repopulate
a new scope, or remove a newer scope's inflight entry. Noncached search and
pagination results are scoped too. Entries are bounded to 128, retaining the
existing 120-second freshness policy. Account IDs are used only in memory and
are not written to default diagnostics. No cookie or authentication format changed.

## 4. Cover task retirement

The old effect only advanced when some of the first eight missing covers
succeeded. An empty reply/error left the same URLs at the front forever.

`CoverLoader` explicitly owns attempted/completed/exhausted tasks. Never-attempted
URLs have priority over retries. Empty replies and batch errors retire an attempt;
normal thumbnails behind failed ones still run. Each view has at most 600 tracked
URLs, eight per batch and three attempts (1/2-second retry delays). Disposal
prevents late callbacks and new retries. Missing thumbnails remain nonfatal.

Rust records numeric cover outcome categories, groups URLs by parsed/normalized
download key, and preserves every original result-correlation key. The download
body is capped at 2 MiB while reading. Unique temporary files are cleaned on
failure. Pruning protects files returned in the current batch. Full URLs,
response bodies and image pixels are not logged. This is not a new image decoder,
and the CDN/network branches were not exercised by the simulated UI workload.

## 5. Settings snapshot revisions and close ordering

`SettingsPersistence` serializes reads, manual saves and debounced automatic
preferences. Undispatched preferences coalesce; dispatched updates are immutable.
Synchronous intent refs capture an edit even before React's effect runs. Failed
old writes cannot resurrect a snapshot after a newer dispatched preference.
`SettingsDraftState` tracks field revisions: a save acknowledgement hydrates
clean fields only, and clears a secret only if that exact secret revision was
included. New input made while saving remains dirty and visible.

The application's in-window close button flushes pending preferences and queued
saves before closing the worker. The five-second flush budget cancels closing
on timeout/failure, leaving the worker and window available rather than cancelling
the save. An earlier failed explicit save still requires a successful retry;
it is not erased merely because a later read succeeded. Unsaved manual form
fields still require the Save action, not automatic persistence on exit.
The preference barrier does not intercept every OS/native exit path; Alt-F4,
shutdown, forced termination and loss of power are not durability guarantees.
No DPAPI, settings schema, media clock, codec parameter or UI layout changed.

## Diagnostics

`worker-rpc*.jsonl` includes local `operation_id`, numeric lease/scope/settings
revisions and outcomes. The same operation ID is attached to RPC measurements,
so it joins to request IDs and actual worker generation/PID without changing the
wire payload. `relay-health*.jsonl` includes numeric cover categories/byte counts.
No user ID, input text, cookie, stream key, cover/media URL, complete commands or
settings values are added to these default local logs.

The existing bounded asynchronous writer remains deliberately lossy under a
burst or disk failure. `dropped_records` means the disk trace is incomplete.
Synthetic tight-loop workloads can overflow the 512-record queue; their in-memory
benchmark counters remain independently reported. A drop count is not hidden
or treated as proof of a complete trace. Normal operation still uses:

```text
%LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics
```

## Verification model

`benchmarks/ui-state.bench.ts` runs the actual coordinator/cache/cover/settings
modules against explicit synthetic backend delays and failures. It measures
ownership outcomes, response revocation, retry counts and snapshot/flush behavior.
These are NOT actual Bilibili accounts, cover downloads, a rendered GPUIX window,
or a real playback relay. The optional process section uses the actual compiled
Rust worker to observe generation exit/replacement and old-generation rejection.

The existing worker-roundtrip, media-pipeline and ASS-clock benchmarks also run
on real local processes. They measure synthetic HTTP/RTMP media and raster pixels,
not real Bilibili/VRCDN/VRChat service behavior. No forbidden functional runner,
unit/integration/e2e/smoke or screenshot-comparison suite was invoked.

### Reviewed observations (2026-09-20)

Both jobs in run 35535917820 completed builds and TypeScript checking; Windows
also packaged the application. Reports name runtime revision 98f883421ed72a2a17cb91a8b2808757d151cc15.
Bun was 1.3.14; the media runs used Windows Gyan FFmpeg 9.0.2 essentials and
Ubuntu FFmpeg 6.1.1. The UI module workloads use simulated backends as stated above.

| Measurement | Windows | Linux |
| --- | --- | --- |
| Superseded startup workload | 200 iterations, 0 residual sessions, 0 wrong owner | same |
| Cancel / replacement failure / cleanup failure | 100 each, 0 residual sessions, 0 false recovery | same |
| Real worker replacement | generation 1 to 2, one end event | same |
| Request pinned to old real worker | worker_exited, rejected | same |
| Old account reply after revocation | rejected; 0 cross-account value | same |
| 64 cover jobs, first 8 always failing | 56 succeeded; first success in batch 2; max 3 attempts | same |
| 1000 automatic preference edits | coalesced to 1 write | same |
| Newer host/key/theme while old save settles | all preserved; secret not wrongly cleared | same |
| Flush deadline while write pending | closing cancelled; write later completed once | same |
| Actual worker source inspection | 768 requests, 0 command errors, 0 reported drops | same |
| Existing media video/audio backward DTS steps | 0 / 0 | 0 / 0 |
| Existing VOD / live raster visible frames at 720p and 1080p | 25 / 40 at each resolution | same |
| ASS rollback first caption source time, rates 1 / 2 / 0.5 | 31 / 31 / 31 seconds | same |
| ASS visible frames, rates 1 / 2 / 0.5 at 10 fps | 40 / 20 / 80 | same |
| UI stress trace disk records / maximum reported drops | 1070 / 3802 | 1069 / 3803 |

For simulated command failure the same-generation readback confirmed running.
For simulated status-read failure recovery was not confirmed, but ownership was
retained for future polling/stop. For simulated fatal transport failure no status
read was sent into a replacement generation, and the lease was revoked.
The deadline workloads use 5 milliseconds instead of the product's five-second
flush budget to observe ordering; measured wall time varies with OS scheduling.

The existing media capture had 957 video / 1504 audio packets on Windows and
959 / 1506 on Linux. Largest video/audio DTS intervals were 0.138 / 0.099 seconds
and 0.162 / 0.129 seconds respectively. This is not a zero-gap claim. Media and
ASS helper reports had null pipeline errors, readable captures and successful
raster decoders. ASS pixels remain quantized by the 1/6-second source marker and
10-fps capture sampling; the readings are not sub-frame accuracy guarantees.

Warnings were not universally zero: deliberate unavailable inputs/invalid ASS
produced diagnostic counters; closing the loopback RTMP recorder produced the
previously documented demuxing I/O error, while the capture remained readable.
UI stress trace drops above are intentional evidence of the bounded writer,
not hidden losses. The workload's in-memory counters are separate from the
incomplete on-disk trace. The normal worker-roundtrip and ASS runs reported zero
drops. Formal release rebuilds rerun the same workloads; their reports contain
their own commit, timings, PIDs and drop counts, not these incidental values.

## Reproduction and remaining limits

```text
bun install --frozen-lockfile
bun run typecheck
cargo build --locked --release --bin relay-worker
# Select target/release/relay-worker.exe (Windows) or relay-worker (Linux) in
# VRC_BILI_RELAY_WORKER, and use an isolated VRC_BILI_RELAY_DIAGNOSTICS_DIR.
bun run benchmarks/ui-state.bench.ts
```

Full application event ordering still needs native manual interaction and field
logs. Real multi-account login, real CDN failures, slow/full disks, all native
window-close paths, long-running sessions and full UI/session coverage are not
claimed here. Rust core polling remains synchronous/poll-driven. app.tsx still
contains substantial presentation code; this is not an all-at-once UI rewrite.
The temporary payload/application workflows exist only on the review branch,
not in the formal release tree. Reports identify their own exact revision.
