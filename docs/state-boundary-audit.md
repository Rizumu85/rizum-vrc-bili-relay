# Session absence and cached-list boundary review — v0.1.32

Baseline: v0.1.31 (`79f16a4cbb4ea492ef46054f4f942de9111c4175`).
Reviewed runtime: `2badff84e5f40eaa595c3bdbf6756c14465c9661`.
Review workflow: 35550687344. This is a repair of two previously reported
issues, not another full-repository correctness claim.

## Confirmed absence is not an unknown session

The core retains stopped sessions for ten minutes and then removes them.
PlaybackFlow retained a stopped lease and unconditionally stopped it before
resolving the next selection. The core's explicit media_session_not_found reply
aborted that new conversion. Reconciliation treated absence like a temporary
status-read failure and kept the same stale lease, so retries also failed before
resolution.

The owner now has one retireMissingSession boundary. Only the exact
media_session_not_found reply, from the same still-live worker generation,
retires the matching lease and its matching prepared entry. Stop's required
postcondition is already satisfied when that session is absent. It can then
continue to resolve new content without restarting the worker or changing TTL.
Polling, reconciliation, prepared-start rejection and stale cleanup use the
same boundary. A new prepared selection is never erased for another expired ID.
The current intent is not invalidated merely because old metadata expired.

Temporary queue/status/transport failures are not converted to success. Unknown
state still retains ownership, and unconfirmed stale cleanup still invalidates
its exact worker generation. Stopped-but-existing sessions remain restartable.
An expired prepared selection still requires resolving again; this patch does
not silently retry a media mutation or retrieve replacement signed media URLs.

## Request-owned list state

The previous FavoritesView kept request epochs and loading flags independently.
After cancelling folder A, opening cached B returned before clearing A's loading
flag; A's late finalizer correctly ignored its obsolete epoch but consequently
left B permanently loading. The same fast-path pattern existed in the folder
list and flat history/watch-later lists.

ListRequestOwner gives data callbacks and loading phase the same ticket.
Cold loads, refreshing a stale cache, cache-only completion, failure, cancellation
and disposal have explicit transitions. A late response cannot publish data or
finish another request's loading phase. Unmount disposes the owner without
calling React setters. The actual loadFolders/loadVideos/loadFlat handlers use
this owner, rather than separate per-screen cache-return patches.

A stale cached list remains visible during refresh, but pagination is busy until
that refresh completes; this prevents appending to a page that is being replaced.
On refresh failure the usable cached data remains, with loading completed.
The account-scoped cache, thumbnail scheduling and search implementation were
not replaced. No changes were made to media time math, FFmpeg parameters,
authentication storage, the wire protocol, or the ten-minute core session TTL.

## Observation method and local before/after evidence

benchmarks/state-boundary.bench.ts runs the production PlaybackFlow and extracts
the actual current list handler bodies using the pinned TypeScript compiler.
It executes those handlers with simulated cache, setters and deferred backend
responses, not a duplicated implementation or a rendered GPUIX window.
The optional real-worker section requests a deliberately absent session ID from
the compiled worker; it does not wait ten minutes or start a real relay.
Settings and auth paths are isolated for that child process.

The local baseline used the unmodified v0.1.31 source blobs. Three repeated new
conversions after simulated expiry all failed with media_session_not_found and
made zero replacement resolve calls. The fixed owner completed all three and
made three resolve calls, with no worker invalidation. The non-expired control
also completed all three. A temporary stop plus status-read fault still blocked
replacement resolution and retained ownership, rather than pretending cleanup
succeeded.

In the extracted list-handler sequence, baseline fresh-cache B remained loading
and could not paginate after A's late reply. The fixed handler finished in ready
state, retained B rather than A, and appended the next page. Cold-cache and stale
revalidation controls also completed normally; cancellation became idle and
failure completed the current load. Disposed owners made zero additional phase
callbacks. Folder-list and flat-list cached fast paths no longer retained the
previous loading flag. These are module/handler observations, not user-window
acceptance measurements.

## Hosted Windows and Linux review observations

Both jobs in run 35550687344 completed at reviewed revision
2badff84e5f40eaa595c3bdbf6756c14465c9661. Builds and TypeScript checks completed;
Windows also packaged the application. Both used Bun 1.3.14. Existing media
observations used Windows FFmpeg 9.0.2 essentials and Ubuntu FFmpeg 6.1.1.
The JSON source hashes match the exact reviewed production files.

| Observation | Windows | Linux |
| --- | --- | --- |
| Three conversions after simulated stopped-session expiry | 3 completed, 3 resolves, 0 generation invalidations | same |
| Non-expired control | 3 completed | same |
| Temporary stop and query failure | lease retained, 0 replacement resolves | same |
| Missing old ID after preparing a new selection | new selection starts, no generation invalidation | same |
| Stopped but existing session restart | completed, no re-resolution | same |
| Missing session in poll / reconciliation | exact old lease retired | same |
| Stale cleanup: absent / unknown | absent: no kill; unknown: exact generation invalidated | same |
| Cached B after cancelled A; late A then completes | B remains ready; next page appends | same |
| Cold/stale-cache/error/cancel paths | current phase completes; old callback cannot take over | same |
| Disposed list owner | 0 subsequent phase callbacks | same |
| Real worker stop/status for nonexistent ID | both media_session_not_found; same generation alive | same |
| Existing 200 superseded startups | 0 residual sessions, 0 wrong owner | same |
| Existing cancel/replacement-failure/cleanup-failure workloads | 100 each, 0 residual sessions, 0 false recovery | same |
| Existing real-worker round trips | 768 inspections, 0 command errors, 0 drops | same |
| Media video/audio backward DTS steps | 0 / 0 | 0 / 0 |
| Existing ASS rollback first source time at 1x/2x/0.5x | 31 / 31 / 31 seconds | same |
| ASS visible frames at 10 fps, 1x/2x/0.5x | 40 / 20 / 80 | same |
| Boundary log records / maximum reported drops | 157 / 0 | 157 / 0 |
| UI stress log records / maximum reported drops | 1069 / 3803 | same |

The still-visible loading value inside a disposed observation is intentionally
not reset: no callbacks may target an unmounted component. The live cancellation
case does explicitly become idle. Failed cache revalidation retains cached B
and completes its load; cold failure reports the error instead.

Existing VOD and live raster observations still measured 25 and 40 visible
frames at both 720p and 1080p. Media captures contained 1042 video / 1635 audio
packets on Windows and 959 / 1504 on Linux. Their largest video/audio DTS intervals
were 0.155 / 0.111 seconds and 0.165 / 0.129 seconds respectively. ASS cases kept
one publisher PID per case, readable captures, null helper errors and zero
reported drops. This is not a zero-gap claim or a throughput guarantee.
The source marker resolves 1/6 second and capture sampling is 10 fps; ASS timing
observations do not establish sub-frame exactness.

Warnings were not universally zero. Deliberate unavailable-source/invalid-ASS
workloads produced errors. The local RTMP recorder retained its previously noted
demuxing I/O error at teardown while the capture remained decodable. Stress
logging overflowed the bounded writer as reported above; on-disk traces are not
complete under that workload, independently of its in-memory counters.

The formal release reruns these observations on its own exact revision and
attaches state-boundary.json along with the existing reports and ZIP verification.
Its timings, PIDs and sampling may differ from the review run; these are not
promises that incidental values reproduce identically.

## Local bounded diagnostics

worker-rpc*.jsonl now includes ui_session_absence_confirmed with operation,
worker generation and matching numeric lease ID when present. Lists record
list_load_started, list_cache_completed, list_load_completed, list_load_failed,
list_load_cancelled and list_reply_discarded with list_id and list_revision.
The existing local bounded writer and its dropped_records accounting are used.
No session ID, folder name, user ID, URL, cookie, stream key or data payload was
added to default logs. The existing directory is unchanged:

    %LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics

## Reproduction and scope limits

    bun install --frozen-lockfile
    bun run typecheck
    cargo build --locked --release --bin relay-worker
    # Set VRC_BILI_RELAY_WORKER to the compiled worker and select an isolated
    # VRC_BILI_RELAY_DIAGNOSTICS_DIR for the observation logs.
    bun run benchmarks/state-boundary.bench.ts

The reports contain source hashes, platform, runtime, revision, observations and
elapsed time. They report measurements without functional assertions. Builds,
type checks and the existing worker/UI/media/ASS benchmarks are the permitted
verification mechanisms; no unit/integration/e2e/smoke/visual-regression runner
was used. The branch-only source/editing transport is excluded from the release.

Native window interaction, a real ten-minute idle expiry, real Bilibili accounts,
long-running playback and VRCDN/VRChat end-to-end behavior are not newly verified.
The previously documented native-close durability and poll-driven core limits
are unchanged. A successful build is not evidence that those limits vanished.
