import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  BilibiliAuthStatus, FavoriteCover, FavoriteFolder, FavoriteResourceItem,
  FfmpegStatus, HealthReply, PlaybackOptions, ProductSettings, RelayReply,
  RelayStatus, SettingsUpdate, SourceInspection, SourceResolution,
} from "./protocol";
import { WorkerRpc, RelayWorkerError } from "./worker-rpc";
import { readWorkerLines } from "./worker-lines";
import { recordWorkerRpc, recordWorkerStderr } from "./worker-diagnostics";

export { RelayWorkerError } from "./worker-rpc";

export interface FavoriteResourcePage {
  items: FavoriteResourceItem[];
  page: number;
  hasMore: boolean;
}

interface WorkerContext {
  child: Bun.PipedSubprocess;
  rpc: WorkerRpc;
  generation: number;
  worker_pid: number;
  hello: Promise<HealthReply>;
  handshaken: boolean;
  failed: RelayWorkerError | null;
  exited: boolean;
  responsesDone: Promise<void>;
}

/** The sole UI-side process adapter. Views express intent; the core owns media.
 * Each subprocess has its own scheduler/readers/handshake, never shared pending
 * state that an old pipe callback can accidentally reject after a restart.
 */
export class RelayWorkerClient {
  private context: WorkerContext | null = null;
  private generation = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly generationListeners = new Set<(generation: number, error: RelayWorkerError) => void>();

  async ready(): Promise<number> {
    if (this.closing) throw new RelayWorkerError("worker_closed", "Rust relay worker is closing");
    const context = this.ensureStarted();
    await context.hello;
    if (!this.isGenerationCurrent(context.generation)) throw context.failed ?? new RelayWorkerError("worker_exited", "Worker generation ended");
    return context.generation;
  }

  isGenerationCurrent(generation: number): boolean {
    return Boolean(this.context && this.context.generation === generation && !this.context.failed && !this.context.exited && !this.closing);
  }

  invalidateGeneration(generation: number): void {
    const context = this.context;
    if (context?.generation === generation) {
      context.rpc.fail(new RelayWorkerError("playback_cleanup_failed", "Superseded playback could not be released; its worker generation is being stopped"));
    }
  }

  onGenerationEnded(listener: (generation: number, error: RelayWorkerError) => void): () => void {
    this.generationListeners.add(listener);
    return () => this.generationListeners.delete(listener);
  }

  async health(): Promise<HealthReply> {
    return this.typedRequest({ type: "health" }, "health");
  }

  async inspectSource(source: string): Promise<SourceInspection> {
    return (await this.typedRequest({ type: "inspect_source", source }, "source_inspection")).inspection;
  }

  async resolveSource(source: string, requestedPart?: number, generation?: number, operationId?: number): Promise<SourceResolution> {
    return (await this.typedRequest(
      { type: "resolve_source", source, requested_part: requestedPart }, "source_resolution", 30_000, generation, operationId,
    )).resolution;
  }

  async startRelay(sessionId: string, options: PlaybackOptions, startSeconds = 0, paused = false, generation?: number, operationId?: number): Promise<RelayStatus> {
    return this.relayRequest({ type: "start_relay", session_id: sessionId, start_seconds: startSeconds, paused, options }, 30_000, generation, operationId);
  }

  async retargetRelay(
    currentSessionId: string | undefined, source: string, requestedPart: number,
    options: PlaybackOptions, startSeconds: number, paused = false, generation?: number, operationId?: number,
  ): Promise<{ resolution: SourceResolution; relay: RelayStatus }> {
    const reply = await this.typedRequest({
      type: "retarget_relay", current_session_id: currentSessionId, source,
      requested_part: requestedPart, start_seconds: startSeconds, paused, options,
    }, "playback_state", 50_000, generation, operationId);
    return { resolution: reply.resolution, relay: reply.relay };
  }

  async relayStatus(sessionId: string, generation?: number, operationId?: number): Promise<RelayStatus> {
    return this.relayRequest({ type: "relay_status", session_id: sessionId }, 15_000, generation, operationId);
  }

  async setRelayPaused(sessionId: string, paused: boolean, options: PlaybackOptions, startSeconds: number, generation?: number, operationId?: number): Promise<RelayStatus> {
    return this.relayRequest({ type: "set_relay_paused", session_id: sessionId, paused, start_seconds: startSeconds, options }, 30_000, generation, operationId);
  }

  async setRelayRate(sessionId: string, options: PlaybackOptions, generation?: number, operationId?: number): Promise<RelayStatus> {
    return this.relayRequest({ type: "set_relay_rate", session_id: sessionId, options }, 30_000, generation, operationId);
  }

  async stopRelay(sessionId: string, generation?: number, operationId?: number): Promise<RelayStatus> {
    return this.relayRequest({ type: "stop_relay", session_id: sessionId }, 15_000, generation, operationId);
  }

  async ensureFfmpeg(): Promise<FfmpegStatus> {
    return (await this.typedRequest({ type: "ensure_ffmpeg" }, "ffmpeg_state")).ffmpeg;
  }

  async bilibiliAuthStatus(): Promise<BilibiliAuthStatus> {
    return this.bilibiliAuthRequest({ type: "bilibili_auth_status" });
  }

  async beginBilibiliLogin(): Promise<BilibiliAuthStatus> {
    return this.bilibiliAuthRequest({ type: "begin_bilibili_login" }, 30_000);
  }

  async pollBilibiliLogin(loginId: number): Promise<BilibiliAuthStatus> {
    return this.bilibiliAuthRequest({ type: "poll_bilibili_login", login_id: loginId }, 30_000);
  }

  async logoutBilibili(): Promise<BilibiliAuthStatus> {
    return this.bilibiliAuthRequest({ type: "logout_bilibili" });
  }

  async listFavoriteFolders(): Promise<FavoriteFolder[]> {
    return (await this.typedRequest({ type: "list_favorite_folders" }, "favorite_folders")).folders;
  }

  async listFavoriteResources(folderId: number, page: number): Promise<FavoriteResourcePage> {
    return this.favoriteResourcesRequest({ type: "list_favorite_resources", folder_id: folderId, page });
  }

  async searchFavoriteResources(folderId: number | null, keyword: string, page: number): Promise<FavoriteResourcePage> {
    return this.favoriteResourcesRequest({ type: "search_favorite_resources", folder_id: folderId, keyword, page });
  }

  async fetchFavoriteCovers(urls: string[]): Promise<FavoriteCover[]> {
    if (urls.length === 0) return [];
    return (await this.typedRequest({ type: "fetch_favorite_covers", urls }, "favorite_covers", 30_000)).covers;
  }

  async listWatchLater(): Promise<FavoriteResourcePage> {
    return this.favoriteResourcesRequest({ type: "list_watch_later" });
  }

  async listHistory(page: number): Promise<FavoriteResourcePage> {
    return this.favoriteResourcesRequest({ type: "list_history", page }, 20_000);
  }

  async getSettings(): Promise<ProductSettings> {
    return (await this.typedRequest({ type: "get_settings" }, "settings_state")).settings;
  }

  async revealStreamKey(): Promise<string> {
    return (await this.typedRequest({ type: "reveal_stream_key" }, "stream_key_value")).stream_key;
  }

  async saveSettings(settings: SettingsUpdate): Promise<ProductSettings> {
    return (await this.typedRequest({ type: "save_settings", settings }, "settings_state")).settings;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const context = this.context;
    this.closePromise = context ? this.closeContext(context) : Promise.resolve();
    return this.closePromise;
  }

  private async relayRequest(command: Record<string, unknown>, timeoutMs = 15_000, generation?: number, operationId?: number): Promise<RelayStatus> {
    return (await this.typedRequest(command, "relay_state", timeoutMs, generation, operationId)).relay;
  }

  private async bilibiliAuthRequest(command: Record<string, unknown>, timeoutMs = 15_000): Promise<BilibiliAuthStatus> {
    return (await this.typedRequest(command, "bilibili_auth_state", timeoutMs)).auth;
  }

  private async favoriteResourcesRequest(command: Record<string, unknown>, timeoutMs = 20_000): Promise<FavoriteResourcePage> {
    const reply = await this.typedRequest(command, "favorite_resources", timeoutMs);
    return { items: reply.items, page: reply.page, hasMore: reply.has_more };
  }

  private async typedRequest<T extends RelayReply["type"]>(
    command: Record<string, unknown>, expected: T, timeoutMs = 15_000, generation?: number, operationId?: number,
  ): Promise<Extract<RelayReply, { type: T }>> {
    const reply = await this.request(command, timeoutMs, generation, operationId);
    if (reply.type !== expected) {
      throw new RelayWorkerError("protocol_mismatch", `Expected ${expected}, received ${reply.type}`);
    }
    return reply as Extract<RelayReply, { type: T }>;
  }

  private async request(command: Record<string, unknown>, timeoutMs: number, generation?: number, operationId?: number): Promise<RelayReply> {
    if (this.closing) throw new RelayWorkerError("worker_closed", "Rust relay worker is closing");
    if (generation !== undefined && !this.isGenerationCurrent(generation)) {
      throw new RelayWorkerError("worker_exited", "The requested worker generation is no longer alive");
    }
    const context = this.ensureStarted();
    // All callers share one compatibility handshake for this generation.
    // Explicit health calls after startup still refresh FFmpeg install progress.
    if (command.type === "health" && !context.handshaken) return context.hello;
    await context.hello;
    if (this.closing) throw new RelayWorkerError("worker_closed", "Rust relay worker is closing");
    if (context.failed) throw context.failed;
    if (this.context !== context) throw new RelayWorkerError("worker_exited", "Rust relay worker generation ended");
    return context.rpc.request(command, timeoutMs, operationId);
  }

  private ensureStarted(): WorkerContext {
    if (this.context) {
      if (this.context.failed) throw this.context.failed;
      return this.context;
    }
    const executable = findWorkerExecutable();
    if (!executable) throw new RelayWorkerError("worker_unavailable", "Rust relay worker was not found; build the worker before starting the UI");
    const child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    let context: WorkerContext;
    const rpc = new WorkerRpc(async (line) => {
      if (context.failed || context.exited) throw new Error("Worker generation ended");
      child.stdin.write(line);
      await child.stdin.flush();
    }, (error) => this.endContext(context, error), (entry) => recordWorkerRpc(context, entry));
    context = {
      child, rpc, generation: ++this.generation, worker_pid: child.pid,
      handshaken: false, failed: null, exited: false,
      hello: undefined as unknown as Promise<HealthReply>, responsesDone: Promise.resolve(),
    };
    this.context = context;
    recordWorkerRpc(context, { event: "spawn" });
    context.responsesDone = this.readResponses(context);
    void this.readErrors(context);
    context.hello = rpc.request({ type: "health" }).then((reply) => {
      if (reply.type !== "health") throw new RelayWorkerError("protocol_mismatch", "Expected worker handshake");
      context.handshaken = true;
      return reply;
    });
    // Every requester awaits hello. Also observe it during shutdown/restart so
    // a rejected startup with no remaining requester is never unhandled.
    void context.hello.catch(() => undefined);
    void child.exited.then(async (exitCode) => {
      context.exited = true;
      // The exit notification can precede delivery of the final stdout chunk.
      // Drain it before rejecting pending requests, especially shutdown ACKs.
      await context.responsesDone;
      recordWorkerRpc(context, { event: "exited", code: `exit_${exitCode}` });
      if (this.context === context) this.context = null;
      rpc.fail(new RelayWorkerError(this.closing ? "worker_closed" : "worker_exited", `Rust relay worker exited with code ${exitCode}`));
    }).catch(() => rpc.fail(new RelayWorkerError("worker_io", "Could not observe worker exit")));
    return context;
  }

  private async readResponses(context: WorkerContext): Promise<void> {
    try {
      await readWorkerLines(context.child.stdout, 8 * 1024 * 1024, (line) => context.rpc.accept(line));
      if (!this.closing && !context.exited) {
        context.rpc.fail(new RelayWorkerError("worker_exited", "Rust relay worker closed its response pipe"));
      }
    } catch (error) {
      context.rpc.fail(error instanceof RelayWorkerError ? error : new RelayWorkerError("worker_io", "Could not read worker responses"));
    }
  }

  private async readErrors(context: WorkerContext): Promise<void> {
    try {
      await readWorkerLines(context.child.stderr, 8192,
        (line) => recordWorkerStderr(context, line),
        (bytes) => recordWorkerRpc(context, { event: "stderr_line_dropped", bytes }));
    } catch {
      recordWorkerRpc(context, { event: "stderr_read_failed" });
    }
  }

  private endContext(context: WorkerContext, error: RelayWorkerError): void {
    if (context.failed) return;
    context.failed = error;
    for (const listener of this.generationListeners) {
      try { listener(context.generation, error); } catch { /* observer cannot prevent process cleanup */ }
    }
    recordWorkerRpc(context, { event: "generation_ended", code: error.code });
    if (!context.exited) {
      try {
        context.child.kill("SIGKILL");
        recordWorkerRpc(context, { event: "kill_requested", code: error.code });
      } catch {
        recordWorkerRpc(context, { event: "kill_failed" });
      }
    }
    // Keep the context until child.exited. A failed kill must never permit a
    // second worker/publisher to start alongside this still-live generation.
  }

  private async closeContext(context: WorkerContext): Promise<void> {
    const closed = new RelayWorkerError("worker_closed", "Rust relay worker is closing");
    context.rpc.cancelQueued(closed);
    try {
      await withDeadline((async () => {
        await context.rpc.request({ type: "shutdown" }, 5_000);
        await context.child.exited;
        await context.responsesDone;
      })(), 5_000);
    } catch {
      context.rpc.fail(closed);
      // A deadline covers actual process exit, not just the shutdown reply.
      await withDeadline(context.child.exited, 1_000).catch(() => {
        recordWorkerRpc(context, { event: "exit_wait_expired" });
      });
    } finally {
      context.rpc.fail(closed);
    }
  }
}

function findWorkerExecutable(): string | null {
  const name = process.platform === "win32" ? "relay-worker.exe" : "relay-worker";
  const candidates = [process.env.VRC_BILI_RELAY_WORKER,
    join(dirname(process.execPath), name),
    resolve(process.cwd(), "target", "debug", name),
    resolve(process.cwd(), "target", "release", name)];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayWorkerError("worker_timeout", "Worker shutdown deadline expired")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
