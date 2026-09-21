/** Quantitative event-loop observations using production owners and extracted
 * UI handlers/effects. Backend responses and the timer clock are simulated.
 * No assertion runner, native window, media process, or external service.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import type { PlaybackBackend } from "../src/relay/playback-flow";
import type { PlaybackOptions, RelayStatus, SourceResolution } from "../src/relay/protocol";
import { PlaybackObserver } from "../src/relay/playback-observer";
import { SearchRequestOwner, emptySearchState, type SearchState } from "../src/relay/search-request";
import { DEFAULT_SETTINGS } from "../src/settings";
import { recordUiState, flushWorkerDiagnostics } from "../src/relay/worker-diagnostics";

const root = resolve(process.env.VRC_BILI_RELAY_LIVENESS_SOURCE || join(import.meta.dir, ".."));
const { PlaybackFlow, hasActivePublisher } = await import(join(root, "src/relay/playback-flow.ts")) as typeof import("../src/relay/playback-flow");
const { RelayWorkerError } = await import(join(root, "src/relay/worker-rpc.ts")) as typeof import("../src/relay/worker-rpc");
const source = readFileSync(join(root, "src/app.tsx"), "utf8");
const ast = ts.createSourceFile("app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
let pollSetup = "";
let searchEffect = "";
let searchSetup = "";
const handlerNames = ["syncSearchQuery", "changeSearchText", "changeSearchScope", "toggleSearch", "resetSearch", "runSearch"];
function visit(n: ts.Node) {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && handlerNames.includes(n.name.text)) {
    handlers.set(n.name.text, `const ${n.name.text} = ${n.initializer.getText(ast)};`);
  }
  if (ts.isCallExpression(n) && n.expression.getText(ast) === "useEffect" && n.arguments[0]) {
    const callback = n.arguments[0].getText(ast);
    if (callback.includes("const ownedStatus = relayStatus") || callback.includes("new PlaybackObserver(")) pollSetup = callback;
    if (callback.includes("runSearch(keyword, 1, false)") || callback === "() => { syncSearchQuery(); }") searchEffect = callback;
    if (callback.includes("new SearchRequestOwner<")) searchSetup = callback;
  }
  ts.forEachChild(n, visit);
}
visit(ast);
const fixed = Boolean(searchSetup);
function execute(code: string, scope: Record<string, unknown>): any {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), js)(...Object.values(scope));
}
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
class Clock {
  time = 0; next = 0;
  tasks = new Map<number, { at: number; run: () => void }>();
  originalSet = globalThis.setTimeout; originalClear = globalThis.clearTimeout;
  install() {
    globalThis.setTimeout = ((fn: () => void, delay = 0) => {
      const id = ++this.next; this.tasks.set(id, { at: this.time + Number(delay), run: fn }); return id;
    }) as any;
    globalThis.clearTimeout = ((id: number) => { this.tasks.delete(Number(id)); }) as any;
  }
  restore() { globalThis.setTimeout = this.originalSet; globalThis.clearTimeout = this.originalClear; this.tasks.clear(); }
  async advance(ms: number) {
    const end = this.time + ms;
    for (let budget = 0; budget < 10000; budget++) {
      const due = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at; this.tasks.delete(due[0]); due[1].run(); await drain();
    }
    this.time = end; await drain();
  }
}
const events: Array<{ event: string; [key: string]: string | number }> = [];
const trace = (event: string, fields: Record<string, number> = {}) => { events.push({ event, ...fields }); };
const options: PlaybackOptions = { danmaku: DEFAULT_SETTINGS.danmaku, playback_rate: "1", output_resolution: "p720" };
class Backend implements PlaybackBackend {
  reads = 0; resolves = 0; stops = 0; live = true; current: RelayStatus | null = null;
  gate: ReturnType<typeof deferred<RelayStatus>> | null = null;
  listeners = new Set<(g: number, e: InstanceType<typeof RelayWorkerError>) => void>();
  ready() { return Promise.resolve(1); }
  isGenerationCurrent(g: number) { return this.live && g === 1; }
  onGenerationEnded(fn: (g: number, e: InstanceType<typeof RelayWorkerError>) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  invalidateGeneration(g: number) { if (!this.isGenerationCurrent(g)) return; this.live = false; this.current = null; for (const fn of this.listeners) fn(g, new RelayWorkerError("worker_exited", "synthetic exit")); }
  async resolveSource(): Promise<SourceResolution> { this.resolves++; return { kind: "video", source_id: "fixture", title: "fixture", canonical_url: "synthetic", session_id: "owned", routing: { kind: "relay_with_ffmpeg", reason: "requires_headers", has_separate_audio: false } }; }
  async startRelay(): Promise<RelayStatus> { return this.current = { session_id: "owned", stage: "running", paused: false, position_seconds: 5 }; }
  async stopRelay(): Promise<RelayStatus> { this.stops++; return this.current = { session_id: "owned", stage: "stopped", paused: false }; }
  async relayStatus(): Promise<RelayStatus> { this.reads++; if (this.gate) return this.gate.promise; if (!this.current) throw new RelayWorkerError("media_session_not_found", "synthetic absence"); return { ...this.current }; }
  async setRelayPaused(_id: string, paused: boolean): Promise<RelayStatus> { return this.current = { ...this.current!, paused }; }
  async setRelayRate(): Promise<RelayStatus> { return { ...this.current! }; }
  async retargetRelay() { return { resolution: await this.resolveSource(), relay: await this.startRelay() }; }
}
async function polling(mode: string) {
  const clock = new Clock(); clock.install();
  const b = new Backend(); const flow = new PlaybackFlow(b, () => {}, trace);
  let received = 0; let failures = 0; let cleanup: (() => void) | undefined;
  try {
    await flow.run(flow.begin("convert"), async t => { const r = await t.resolve("a"); await t.start(r.session_id!, options); });
    const status = flow.status!;
    const scope = { relayStatus: status, playbackFlow: { current: flow }, hasActivePublisher,
      playbackUpdating: null, playbackToggling: false, relayStopping: false,
      getPlaybackFlow: () => flow, setRelayStatus: () => { received++; }, setPlaybackPaused: () => {},
      pendingPausedPosition: { current: null }, seekInteractionActive: false, setPlaybackPosition: () => {},
      setRelayError: (e: unknown) => { if (e) failures++; }, relayFailureMessage: () => "failed", relayErrorMessage: () => "error",
      PlaybackObserver, recordUiState: trace, receiveRelayObservation: { current: () => { received++; } }, windowClosing: { current: false } };
    cleanup = execute(`const setup = ${pollSetup}; return setup();`, scope);
    b.gate = deferred<RelayStatus>();
    await clock.advance(2000);
    let action = Promise.resolve<unknown>(null);
    if (mode === "cancel" || mode === "cancel_query_error") {
      action = flow.run(flow.begin("convert"), async t => { await t.stop(); return t.resolve("b"); }).catch(() => null);
      flow.cancel();
    } else if (mode === "replace") {
      action = flow.run(flow.begin("convert"), async t => { await t.stop(); const r = await t.resolve("b"); return t.start(r.session_id!, options); }).catch(() => null);
    } else if (mode === "stop") {
      action = flow.run(flow.begin("stop"), t => t.stop()).catch(() => null);
    } else if (mode === "generation_lost") b.invalidateGeneration(1);
    else if (mode === "disposed") cleanup?.();
    const gate = b.gate; b.gate = null;
    if (mode === "transient_error" || mode === "cancel_query_error") gate.reject(new RelayWorkerError("worker_busy", "synthetic read failure"));
    else if (mode === "absent") { b.current = null; gate.reject(new RelayWorkerError("media_session_not_found", "synthetic absence")); }
    else gate.resolve({ ...status, stage: mode === "completed" ? "completed" : "running" });
    await drain(); await action; await drain();
    const rearmed = clock.tasks.size;
    await clock.advance(4000);
    return { mode, reads: b.reads, delivered: received, failure_callbacks: failures,
      timers_after_first: rearmed, timers_after_followup: clock.tasks.size, stop_calls: b.stops, replacement_resolves: b.resolves - 1, owned_stage: flow.status?.stage ?? null };
  } finally { cleanup?.(); flow.dispose(); clock.restore(); }
}
async function searchSequence(mode: string) {
  const clock = new Clock(); clock.install();
  let text = "A"; let searchScope = "folder"; let open = true;
  let state: SearchState<string> = emptySearchState();
  const input = { current: { text, scope: searchScope, open } };
  const searchRequest = { current: null as SearchRequestOwner<string> | null };
  const searchEpoch = { current: 0 };
  const requests: Array<{ keyword: string; folder: number | null; page: number }> = [];
  const gates: Array<ReturnType<typeof deferred<{ items: string[]; page: number; hasMore: boolean }>>> = [];
  let publications = 0; let cleanup: (() => void) | undefined; let effectCleanup: (() => void) | undefined;
  function render() {
    const scope = { searchText: text, searchScope, searchOpen: open, level: { kind: "videos", folder: { id: 17 } },
      searchInput: input, searchRequest, searchEpoch, cache: { scoped: (fn: () => unknown) => fn() }, recordUiState: trace, SearchRequestOwner,
      searchResourcesRef: { current: fetch }, searchResources: fetch,
      setSearchState: (v: SearchState<string>) => { state = v; publications++; },
      setSearchText: (v: string) => { text = v; }, setSearchScope: (v: string) => { searchScope = v; }, setSearchOpen: (v: boolean) => { open = v; },
      setSearchItems: (v: any) => { state.items = typeof v === "function" ? v(state.items) : v; publications++; },
      setSearchPage: (v: number) => { state.page = v; }, setSearchHasMore: (v: boolean) => { state.hasMore = v; },
      setSearchError: (v: unknown) => { state.error = v; }, setSearchLoading: (v: boolean) => { state.phase = v ? "loading" : "ready"; },
      favoriteErrorMessage: (e: unknown) => String(e) };
    return { scope, fn: execute([...handlers.values()].join("\n") + `\nreturn {${[...handlers.keys()].join(",")}};`, scope) };
  }
  function fetch(folder: number | null, keyword: string, page: number) {
    requests.push({ keyword, folder, page }); const gate = deferred<{ items: string[]; page: number; hasMore: boolean }>(); gates.push(gate); return gate.promise;
  }
  const complete = (index: number) => { const q = requests[index]; if (q) gates[index].resolve({ items: [`${q.keyword}:${q.folder}:${q.page}`], page: q.page, hasMore: q.page < 3 }); };
  try {
    let view = render();
    if (fixed) cleanup = execute(`const setup = ${searchSetup}; return setup();`, view.scope);
    effectCleanup = execute(`const setup = ${searchEffect}; return setup();`, { ...view.scope, ...view.fn });
    await clock.advance(400); // A has dispatched, its response is deliberately held.
    if (mode === "scope") {
      if (fixed) view.fn.changeSearchScope("all"); else { searchScope = "all"; effectCleanup?.(); view = render(); effectCleanup = execute(`const setup = ${searchEffect}; return setup();`, { ...view.scope, ...view.fn }); }
    } else if (mode === "clear") {
      if (fixed) view.fn.changeSearchText(""); else { text = ""; effectCleanup?.(); view = render(); effectCleanup = execute(`const setup = ${searchEffect}; return setup();`, { ...view.scope, ...view.fn }); }
    } else if (mode === "disposed") { cleanup?.(); effectCleanup?.(); if (!fixed) ++searchEpoch.current; }
    else {
      if (fixed) view.fn.changeSearchText("B"); else { text = "B"; effectCleanup?.(); view = render(); effectCleanup = execute(`const setup = ${searchEffect}; return setup();`, { ...view.scope, ...view.fn }); }
    }
    const beforeOld = publications;
    if (mode === "late_failure") gates[0].reject(new Error("synthetic old query failure")); else complete(0);
    await drain();
    const afterOld = { items: [...(state.items ?? [])], phase: state.phase, page: state.page, has_more: state.hasMore, error: state.error ? String(state.error) : null, publications: publications - beforeOld };
    const beforeMore = requests.length;
    if (fixed) void searchRequest.current?.more();
    else if (state.hasMore && state.phase !== "loading") { view = render(); void view.fn.runSearch(text.trim(), state.page + 1, true); }
    await drain();
    if (requests.length > beforeMore) complete(requests.length - 1);
    await drain();
    const duringDebounce = [...(state.items ?? [])];
    await clock.advance(400);
    complete(requests.length - 1); await drain();
    const afterFirst = [...(state.items ?? [])];
    const beforeDoubleMore = requests.length;
    if (mode !== "clear" && mode !== "disposed") {
      if (fixed) { void searchRequest.current?.more(); void searchRequest.current?.more(); }
      else if (state.hasMore && state.phase !== "loading") { view = render(); void view.fn.runSearch(text.trim(), state.page + 1, true); }
      await drain(); complete(requests.length - 1); await drain();
    }
    return { mode, after_old: afterOld, during_debounce: duringDebounce, after_current_first_page: afterFirst,
      extra_pagination_requests: requests.length - beforeDoubleMore, final_items: state.items, final_phase: state.phase, requests };
  } finally { cleanup?.(); effectCleanup?.(); searchRequest.current?.dispose(); clock.restore(); }
}
async function idleObserver() {
  const clock = new Clock(); clock.install();
  const b = new Backend(); const flow = new PlaybackFlow(b, () => {}, trace);
  let received = 0;
  const observer = new PlaybackObserver(flow, () => { received++; }, () => {}, trace);
  try {
    const idleTimers = clock.tasks.size;
    await flow.run(flow.begin("convert"), async t => { const r = await t.resolve("a"); await t.start(r.session_id!, options); });
    const startTimers = clock.tasks.size;
    await clock.advance(2000);
    await flow.run(flow.begin("pause"), t => t.pause("owned", true, options, 5));
    await clock.advance(2000);
    const beforeDispose = received; observer.dispose();
    flow.cancel(); await clock.advance(4000);
    return { idle_timers: idleTimers, timers_after_start: startTimers, delivered: received,
      delivered_after_disposal: received - beforeDispose, remaining_timers: clock.tasks.size, paused_owned: flow.status?.paused };
  } finally { observer.dispose(); flow.dispose(); clock.restore(); }
}
const at = performance.now();
const pollingRows = [];
for (const mode of ["control", "cancel", "cancel_query_error", "replace", "stop", "transient_error", "generation_lost", "completed", "absent", "disposed"]) pollingRows.push(await polling(mode));
let missingRearm = 0; let unintendedStops = 0; let delivered = 0;
for (let n = 0; n < 100; n++) { const r = await polling("cancel"); if (!r.timers_after_first) missingRearm++; unintendedStops += r.stop_calls; delivered += r.delivered; }
const searches = [];
for (const mode of ["keyword", "scope", "clear", "disposed", "late_failure"]) searches.push(await searchSequence(mode));
const report = { schema: 1, revision: process.env.GITHUB_SHA ?? "local", platform: process.platform, bun: Bun.version, fixed_owner: fixed,
  scope: "Production flow plus extracted polling setup/search handlers; virtual timers, simulated backend; not native-window or live-service acceptance",
  source_sha256: Object.fromEntries(["src/app.tsx", "src/relay/playback-flow.ts", ...(fixed ? ["src/relay/playback-observer.ts", "src/relay/search-request.ts"] : [])].map(p => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")])),
  idle_observer: fixed ? await idleObserver() : null, polling: pollingRows, repeated_cancel: { iterations: 100, missing_rearm: missingRearm, unintended_stops: unintendedStops, delivered }, searches, wall_ms: performance.now() - at };
// Emit a bounded sample after restoring the real clock, without logging query text.
for (const e of events.slice(0, 100)) { const { event, ...numbers } = e; recordUiState(event, numbers as Record<string, number>); }
await flushWorkerDiagnostics();
const out = process.env.VRC_BILI_RELAY_LIVENESS_REPORT || join(import.meta.dir, "../artifacts/benchmarks/liveness.json");
mkdirSync(resolve(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify({ ...report, trace_events: events.length, trace_sample: events.slice(0, 100) }, null, 2));
console.log(JSON.stringify(report, null, 2));
