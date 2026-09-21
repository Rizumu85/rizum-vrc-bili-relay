# Playback observation and search query ownership — v0.1.33

Baseline: v0.1.32, `7702baff3e309caa079040aefef4f1f7cf218b3b`.
Reviewed runtime: `62d6ca7aa5164338d147d6fd64acbe584ae63d12`.
Review workflow: 35558186705. The release carries the same runtime files,
with version, workflow and release-document integration only.

## Playback observation is owned by the session, not a React dependency snapshot

The old effect captured the flow epoch. If a pending status read was followed
by a new conversion and cancellation before its mutation dispatched, the flow
correctly discarded the old read. The effect scheduled its next timer only on
an accepted reply, however. Its React dependencies could remain unchanged, so
there was neither another timer nor an effect restart although the original
session remained owned and active. Dropping stale data accidentally dropped
observation liveness too. React effect cleanup/dependency behavior is documented
at https://react.dev/reference/react/useEffect .

`PlaybackObserver` now follows the existing flow's lifecycle notifications.
There is one loop per app surface. It permits one in-flight read and one timer;
flow polling still shares the same serialized command path and generation checks
as mutations (core polling can itself advance media state). Beginning a mutation
suspends scheduled polling; completion/cancellation reconsiders the current lease.
Every completed read, including a null stale reply or transient failure, schedules
again from the CURRENT owner rather than an old effect epoch. Idle, stopped,
completed, missing-session and lost-generation owners do not create further reads.
Disposal removes the subscription and timer and forbids late UI callbacks.

The view publishes through a current callback ref, retaining seek-drag and
paused-position protection without rebuilding the loop for those presentation
changes. The existing 700 ms startup / 2000 ms steady polling cadence is retained.
No worker is started merely to ask about a dead generation. There is no retry of
an uncertain playback mutation and no duplicate FFmpeg ownership in TypeScript.

## Search draft, accepted query and pagination share an owner

The old search epoch changed only when the debounced request actually started.
During the 400 ms wait after editing the keyword or folder scope, an old response
could still set results, page and hasMore. Load-more then used the new draft text
with that old page number, e.g. A page 1 followed by B page 2 before B page 1.

`SearchRequestOwner` owns the immutable normalized keyword/folder query, query
revision, request revision, results, page and phase together. Input and scope
handlers revoke the old query synchronously. Debouncing delays network dispatch,
not revocation. Changing the query clears old result/pagination eligibility and
shows the existing loading presentation. `more()` derives its query and page
from the accepted owner state; the UI passes neither text nor page. A rapid extra
click is rejected by the synchronous loading phase before a React render.
Retry, clearing, returning to folders, account/view remount and disposal use the
same owner. Late successes AND failures cannot repaint or re-enable pagination.
The 400 ms delay is unchanged, as are the account-scoped cache and core search API.

The small state-boundary benchmark adapter supplies the new resetSearch refs;
its existing list workloads and observation criteria remain unchanged.

## Evidence and interpretation

`benchmarks/liveness.bench.ts` extracts the actual polling setup and search event
handler bodies using the pinned TypeScript parser. It runs them with production
PlaybackFlow/PlaybackObserver/SearchRequestOwner modules. Deferred backend replies
and a virtual timer clock make the event ordering explicit. This is NOT a native
React/GPUIX render, real Bilibili search, or real media relay. The report records
source SHA-256 hashes, revision, platform, runtime, call counts, scheduling state,
query/page sequences and a numeric trace sample. Virtual elapsed time is not a
network latency/throughput claim. Reports contain no functional assertion suite.

For the local unmodified baseline, the cancel scenario preserves the effect's
actual dependency values; in 100 iterations it retained the active session but
scheduled no next poll (zero unintended stops and zero replacement resolution).
The fixed workload rearmed all 100 times and delivered two subsequent statuses
per iteration during four seconds of virtual follow-up. The no-cancel control
continued polling. Other old-effect scenarios do not model every React rerender;
only the unchanged-dependency cancellation comparison establishes the old UI bug.

The fixed mode also observed:

- idle observation schedules no timer, then begins after a session is acquired;
- cancellation with a late successful or failed read keeps current observation;
- replacement observes the current lease, while stopped/completed/absent/lost
  generation states schedule no further polls;
- a transient read failure retains observation, and disposal delivers no late UI
  callback or additional scheduled read;
- paused but active sessions remain observed;
- keyword A-to-B and folder-to-all-scope changes discard the old result during
  debounce; B page 1 is requested before B page 2, with no mixed result list;
- a rapid duplicate load-more call causes one page request, not two;
- clearing, disposal and an old query's late failure do not publish stale data.

The unmodified keyword control produced `[A:page1, B:page2]` during debounce.
The fixed path had no eligible old results and requested A1, then B1, then B2.
The scope-change counterpart behaved equivalently. Original query text in this
benchmark is synthetic A/B fixture data, not user searches collected from logs.

The review and formal workflows run the existing UI-state, session-boundary,
real-worker and local-media/ASS benchmarks as well as the new observations.
Their JSON files carry their own exact commit, process IDs and outcomes. Build
exit success alone is not the acceptance criterion: inspect the report values.
Hosted build and measurement results are separately retained with the release.
Known RTMP recorder teardown warnings and bounded stress-trace drops in the
existing workloads remain disclosed, not reclassified as external-service success.

## Diagnostics and reproduction

The existing bounded `worker-rpc*.jsonl` writer now records `ui_poll_scheduled`,
`ui_poll_started`, `ui_poll_received`, `ui_poll_discarded` and `ui_poll_failed` with
operation IDs. They join to the flow's generation-pinned RPC records. Search adds
`search_query_changed`, `search_page_started/completed/failed`,
`search_page_blocked` and `search_reply_discarded` with numeric search IDs,
query revisions and page numbers. No keyword, folder ID/name, URL, credentials
or response payload is added to default logs. The existing directory remains:

    %LOCALAPPDATA%\VRC Bili Relay\runtime\diagnostics

The on-disk diagnostic writer remains bounded and potentially lossy; its drop
counter is authoritative. The new synthetic observer benchmark retains a bounded
sample of 100 numeric events rather than flooding the writer with its whole loop.

    bun install --frozen-lockfile
    bun run typecheck
    bun run benchmarks/liveness.bench.ts

`VRC_BILI_RELAY_LIVENESS_SOURCE` can select a local v0.1.32 source checkout for the
old-handler comparison; select an isolated diagnostics directory and report path
when doing so. No unit/integration/e2e/smoke/visual-regression runner is introduced.
Branch-only patch/source transport is excluded from the formal release tree.

## Limits

No real native-window event-ordering, Bilibili account/search, remote VRCDN or
VRChat playback acceptance was performed. Synthetic scheduling proves behavior
for the stated orderings, not their frequency in field use or exhaustive UI
correctness. Rust media clocks, FFmpeg flags, core TTLs, wire protocol, settings
and authentication storage, native-close durability and poll-driven core design
are unchanged. This fixes the two identified issues, not every repository bug.
