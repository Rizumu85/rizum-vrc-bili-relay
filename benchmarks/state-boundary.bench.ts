/** Quantitative observations; no functional assertion suite or native window.
 * Real production owners/handler bodies, with explicit in-memory faults. The
 * optional worker section observes only the missing-session protocol response.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import type { PlaybackBackend } from "../src/relay/playback-flow";
import type { PlaybackOptions, RelayStatus, SourceResolution } from "../src/relay/protocol";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ListRequestOwner, listLoadPending, type ListLoadPhase } from "../src/relay/list-request";
import { recordUiState, flushWorkerDiagnostics } from "../src/relay/worker-diagnostics";

const root = resolve(process.env.VRC_BILI_RELAY_BOUNDARY_SOURCE || join(import.meta.dir, ".."));
const { PlaybackFlow, PlaybackFailure } = await import(join(root, "src/relay/playback-flow.ts")) as typeof import("../src/relay/playback-flow");
const { RelayWorkerError } = await import(join(root, "src/relay/worker-rpc.ts")) as typeof import("../src/relay/worker-rpc");
const { RelayWorkerClient } = await import(join(root, "src/relay/worker-client.ts")) as typeof import("../src/relay/worker-client");
const traces: Record<string, number> = {};
function trace(event: string, fields: Record<string, number> = {}) {
  traces[event] = (traces[event] ?? 0) + 1;
  recordUiState(event, fields);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options: PlaybackOptions = { danmaku: DEFAULT_SETTINGS.danmaku, playback_rate: "1", output_resolution: "p720" };
function resolution(id: string): SourceResolution {
  return { kind: "video", source_id: id, canonical_url: "synthetic-local", title: "fixture", session_id: id,
    routing: { kind: "relay_with_ffmpeg", reason: "requires_headers", has_separate_audio: false } };
}
class Backend implements PlaybackBackend {
  generation = 1; live = true; next = 0; resolves = 0; stops = 0; killed = 0;
  stopFault: string | null = null; queryFault: string | null = null;
  startGate: ReturnType<typeof deferred> | null = null;
  startEntered = deferred();
  sessions = new Map<string, RelayStatus>();
  listeners = new Set<(generation: number, error: InstanceType<typeof RelayWorkerError>) => void>();
  ready() { return Promise.resolve(this.generation); }
  isGenerationCurrent(g: number) { return this.live && this.generation === g; }
  onGenerationEnded(fn: (generation: number, error: InstanceType<typeof RelayWorkerError>) => void) {
    this.listeners.add(fn); return () => { this.listeners.delete(fn); };
  }
  invalidateGeneration(g: number) {
    if (!this.isGenerationCurrent(g)) return;
    this.killed++; this.live = false; this.sessions.clear();
    for (const fn of this.listeners) fn(g, new RelayWorkerError("playback_cleanup_failed", "synthetic unconfirmed cleanup"));
  }
  private check(g?: number) {
    if (g !== undefined && !this.isGenerationCurrent(g)) throw new RelayWorkerError("worker_exited", "synthetic generation ended");
  }
  private get(id: string): RelayStatus {
    const s = this.sessions.get(id);
    if (!s) throw new RelayWorkerError("media_session_not_found", "synthetic expired metadata");
    return { ...s };
  }
  async resolveSource(_source: string, _part?: number, g?: number) {
    this.check(g); this.resolves++;
    const id = `synthetic-${++this.next}`;
    this.sessions.set(id, { session_id: id, stage: "stopped", paused: false });
    return resolution(id);
  }
  async startRelay(id: string, _options: PlaybackOptions, _start = 0, paused = false, g?: number) {
    this.check(g); this.startEntered.resolve(); if (this.startGate) await this.startGate.promise;
    const s = { ...this.get(id), stage: "running" as const, paused }; this.sessions.set(id, s); return { ...s };
  }
  async stopRelay(id: string, g?: number) {
    this.check(g); this.stops++;
    if (this.stopFault) throw new RelayWorkerError(this.stopFault, "synthetic stop fault");
    const s = { ...this.get(id), stage: "stopped" as const, paused: false }; this.sessions.set(id, s); return { ...s };
  }
  async relayStatus(id: string, g?: number) {
    this.check(g); if (this.queryFault) throw new RelayWorkerError(this.queryFault, "synthetic query fault");
    return this.get(id);
  }
  async setRelayPaused(id: string, paused: boolean, _o: PlaybackOptions, _s: number, g?: number) {
    this.check(g); const s = { ...this.get(id), paused }; this.sessions.set(id, s); return { ...s };
  }
  async setRelayRate(id: string, _o: PlaybackOptions, g?: number) { this.check(g); return this.get(id); }
  async retargetRelay(_id: string | undefined, source: string, part: number, o: PlaybackOptions, start: number, paused = false, g?: number) {
    const r = await this.resolveSource(source, part, g); return { resolution: r, relay: await this.startRelay(r.session_id!, o, start, paused, g) };
  }
}
function errorCode(e: unknown): string {
  if (e instanceof PlaybackFailure) return errorCode(e.original);
  return e instanceof RelayWorkerError ? e.code : e instanceof Error ? e.constructor.name : "unknown";
}
async function seed() {
  const backend = new Backend(); let invalidations = 0;
  const flow = new PlaybackFlow(backend, () => { invalidations++; }, trace);
  await flow.run(flow.begin("convert"), async t => { const r = await t.resolve("first"); await t.start(r.session_id!, options); });
  return { backend, flow, invalidations: () => invalidations };
}
async function expiration(expired: boolean) {
  const { backend: b, flow } = await seed();
  await flow.run(flow.begin("stop"), t => t.stop());
  if (expired) b.sessions.clear();
  const before = b.resolves; const attempts = [];
  for (let i = 0; i < 3; i++) {
    try {
      await flow.run(flow.begin("convert"), async t => { await t.stop(); const r = await t.resolve("next"); await t.start(r.session_id!, options); });
      attempts.push("completed");
    } catch (e) { attempts.push(errorCode(e)); }
  }
  const result = { expired, attempts, replacement_resolves: b.resolves - before, generation_invalidations: b.killed, owned_stage: flow.status?.stage ?? null };
  flow.dispose(); return result;
}
async function absencePaths() {
  const rows = [];
  for (const path of ["poll", "reconcile", "new_selection", "restart_stopped", "stop_unknown"] as const) {
    const { backend: b, flow } = await seed(); const id = flow.status!.session_id;
    if (path === "restart_stopped") await flow.run(flow.begin("stop"), t => t.stop());
    else if (path === "stop_unknown") { b.stopFault = "worker_queue_timeout"; b.queryFault = "worker_busy"; }
    else b.sessions.clear();
    const before = b.resolves; let outcome = "completed";
    try {
      if (path === "poll") await flow.poll();
      else if (path === "reconcile") await flow.run(flow.begin("rate"), t => t.rate(id, options));
      else if (path === "restart_stopped") await flow.run(flow.begin("resume"), t => t.start(id, options));
      else await flow.run(flow.begin("convert"), async t => {
        if (path === "new_selection") { const r = await t.resolve("new"); await t.stop(); await t.start(r.session_id!, options); }
        else { await t.stop(); await t.resolve("must-not-dispatch-after-unknown-stop"); }
      });
    } catch (e) { outcome = errorCode(e); }
    rows.push({ path, outcome, lease_retained: flow.status !== null, replacement_resolves: b.resolves - before, generation_invalidations: b.killed });
    flow.dispose();
  }
  for (const fault of ["media_session_not_found", "worker_busy"]) {
    const b = new Backend(); const flow = new PlaybackFlow(b, () => {}, trace);
    b.startGate = deferred();
    const op = flow.run(flow.begin("convert"), async t => { const r = await t.resolve("first"); await t.start(r.session_id!, options); }).catch(errorCode);
    await b.startEntered.promise; flow.cancel(); b.stopFault = fault; b.startGate.resolve(undefined);
    const outcome = await op;
    rows.push({ path: `stale_cleanup_${fault}`, outcome, lease_retained: flow.status !== null, replacement_resolves: 0, generation_invalidations: b.killed }); flow.dispose();
  }
  return rows;
}

// Extract the current production handler bodies. This is not a copied alternate
// implementation of loadVideos/loadFlat/loadFolders, nor a React/native render.
const appText = readFileSync(join(root, "src/app.tsx"), "utf8");
const ast = ts.createSourceFile("app.tsx", appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ["loadVideos", "loadFlat", "loadFolders", "backToFolders", "resetSearch"].includes(node.name.text)) {
    handlers.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpileModule([...handlers.values()].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
async function listSequence(mode: "fresh" | "cold" | "refresh" | "refresh_failed" | "failed" | "cancel" | "disposed", kind: "videos" | "flat" | "folders" = "videos") {
  const phases: ListLoadPhase[] = [];
  const state = { loading: false, page: 0, hasMore: false, items: [] as string[], error: null as string | null };
  const first = deferred<any>(); const second = deferred<any>();
  const page = (id: string, n = 1) => ({ items: [id], page: n, hasMore: true });
  const cached = mode === "fresh" || mode === "refresh" || mode === "refresh_failed" ? { value: page("B"), fresh: mode === "fresh" } : null;
  let warm = false;
  const cache = {
    read: (key: string) => !warm ? null : key === "folder:2:1" || key === "watch-later" || key === "folders" ? cached : null,
    fill: (_key: string, f: () => Promise<any>) => f(), scoped: (f: () => Promise<any>) => f(),
  };
  const owner = new ListRequestOwner(phase => { phases.push(phase); state.loading = listLoadPending(phase); }, trace);
  const scope: Record<string, any> = {
    cache, source: "watchLater", videosRequest: { current: owner }, foldersRequest: { current: owner },
    videosEpoch: { current: 0 }, foldersEpoch: { current: 0 }, searchEpoch: { current: 0 },
    searchInput: { current: { text: "", scope: "folder", open: false } }, searchRequest: { current: null },
    setVideosLoading: (value: boolean) => { state.loading = value; }, setFoldersLoading: (value: boolean) => { state.loading = value; },
    setVideosError: (value: string | null) => { state.error = value; }, setFoldersError: () => {},
    setVideos: (value: any) => { state.items = typeof value === "function" ? value(state.items) : value; }, setFolders: (value: any) => { state.items = value.items ?? value; },
    setVideosPage: (n: number) => { state.page = n; }, setVideosHasMore: (v: boolean) => { state.hasMore = v; },
    listResources: (id: number, n: number) => n > 1 ? Promise.resolve(page("B-next", n)) : id === 1 ? first.promise : second.promise,
    listFolders: () => warm ? second.promise : first.promise, listWatchLater: () => warm ? second.promise : first.promise, listHistory: () => warm ? second.promise : first.promise,
    favoriteErrorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
  };
  for (const setter of ["setLevel", "setSearchOpen", "setSearchText", "setSearchScope", "setSearchItems", "setSearchPage", "setSearchHasMore", "setSearchLoading", "setSearchError"]) scope[setter] = () => {};
  const functions = new Function(...Object.keys(scope), `${compiled}\nreturn {loadVideos, loadFlat, loadFolders, backToFolders};`)(...Object.values(scope));
  const a: Promise<void> = kind === "videos" ? functions.loadVideos({ id: 1 }, 1, false)
    : kind === "flat" ? functions.loadFlat(1, false) : functions.loadFolders();
  if (kind === "videos") functions.backToFolders();
  warm = true;
  let b: Promise<void> = Promise.resolve();
  if (mode !== "cancel") b = kind === "videos" ? functions.loadVideos({ id: 2 }, 1, false)
    : kind === "flat" ? functions.loadFlat(1, false) : functions.loadFolders();
  const loadingBeforeOldReply = state.loading;
  first.resolve(page("A")); await a;
  const afterOldReply = { ...state, items: [...state.items] };
  const phasesBeforeDispose = phases.length;
  if (mode === "disposed") { owner.dispose(); ++scope.videosEpoch.current; ++scope.foldersEpoch.current; }
  if (mode === "failed" || mode === "refresh_failed") second.reject(new Error("synthetic list failure")); else second.resolve(page("B"));
  await b;
  const afterCompletion = { ...state, items: [...state.items] };
  let paginationCalls = 0;
  if (kind === "videos" && !state.loading && state.hasMore && mode !== "cancel" && mode !== "disposed") {
    paginationCalls++; await functions.loadVideos({ id: 2 }, 2, true);
  }
  const result = { mode, kind, callbacks_after_dispose: mode === "disposed" ? phases.length - phasesBeforeDispose : null, loading_before_old_reply: loadingBeforeOldReply, after_old_reply: afterOldReply,
    after_completion: afterCompletion, pagination_calls: paginationCalls, final_items: state.items, phases };
  owner.dispose(); return result;
}
async function realWorker() {
  if (!process.env.VRC_BILI_RELAY_WORKER || !existsSync(process.env.VRC_BILI_RELAY_WORKER)) return { skipped: true };
  const isolated = mkdtempSync(join(tmpdir(), "relay-boundary-"));
  const keys = ["LOCALAPPDATA", "APPDATA", "VRC_BILI_RELAY_SETTINGS", "VRC_BILI_RELAY_AUTH"] as const;
  const saved = keys.map(key => process.env[key]);
  process.env.LOCALAPPDATA = isolated; process.env.APPDATA = isolated;
  process.env.VRC_BILI_RELAY_SETTINGS = join(isolated, "settings.json");
  process.env.VRC_BILI_RELAY_AUTH = join(isolated, "auth.json");
  const worker = new RelayWorkerClient(); const codes: string[] = [];
  try {
    const generation = await worker.ready();
    for (const action of ["stop", "status"] as const) {
      try {
        if (action === "stop") await worker.stopRelay("boundary-observation-missing", generation);
        else await worker.relayStatus("boundary-observation-missing", generation);
        codes.push("unexpected-success");
      } catch (e) { codes.push(errorCode(e)); }
    }
    return { skipped: false, codes, same_generation_alive: worker.isGenerationCurrent(generation),
      scope: "Actual worker, deliberately nonexistent ID; not a timed ten-minute expiry or FFmpeg relay" };
  } finally {
    await worker.close();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    rmSync(isolated, { recursive: true, force: true });
  }
}
const at = performance.now();
const report = { schema: 1, revision: process.env.GITHUB_SHA ?? "local", platform: process.platform, bun: Bun.version,
  scope: "Production coordinator and extracted list handlers with simulated backend; no native-window/live-service acceptance",
  source_sha256: Object.fromEntries(["src/relay/playback-flow.ts", "src/app.tsx"].map(p => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")])),
  expiry_control: await expiration(false), expiry: await expiration(true), absence_paths: await absencePaths(),
  lists: await Promise.all((["fresh", "cold", "refresh", "refresh_failed", "failed", "cancel", "disposed"] as const).map(mode => listSequence(mode))),
  other_cached_handlers: await Promise.all((["flat", "folders"] as const).map(kind => listSequence("fresh", kind))),
  real_worker: await realWorker(), traces, wall_ms: performance.now() - at };
await flushWorkerDiagnostics();
const out = process.env.VRC_BILI_RELAY_BOUNDARY_REPORT || join(import.meta.dir, "../artifacts/benchmarks/state-boundary.json");
mkdirSync(resolve(out, ".."), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
