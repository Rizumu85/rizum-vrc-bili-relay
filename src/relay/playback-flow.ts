import type { PlaybackOptions, RelayStatus, SourceResolution } from "./protocol";
import { RelayWorkerError } from "./worker-rpc";

export interface PlaybackBackend {
  ready(): Promise<number>;
  invalidateGeneration(generation: number): void;
  isGenerationCurrent(generation: number): boolean;
  onGenerationEnded(listener: (generation: number, error: RelayWorkerError) => void): () => void;
  resolveSource(source: string, part?: number, generation?: number, operationId?: number): Promise<SourceResolution>;
  startRelay(id: string, options: PlaybackOptions, start?: number, paused?: boolean, generation?: number, operationId?: number): Promise<RelayStatus>;
  retargetRelay(id: string | undefined, source: string, part: number, options: PlaybackOptions, start: number, paused?: boolean, generation?: number, operationId?: number): Promise<{ resolution: SourceResolution; relay: RelayStatus }>;
  relayStatus(id: string, generation?: number, operationId?: number): Promise<RelayStatus>;
  stopRelay(id: string, generation?: number, operationId?: number): Promise<RelayStatus>;
  setRelayPaused(id: string, paused: boolean, options: PlaybackOptions, start: number, generation?: number, operationId?: number): Promise<RelayStatus>;
  setRelayRate(id: string, options: PlaybackOptions, generation?: number, operationId?: number): Promise<RelayStatus>;
}
export type PlaybackAction = "convert" | "retarget" | "pause" | "rate" | "stop" | "resume" | "completion";
export interface PlaybackIntent { readonly id: number; readonly action: PlaybackAction; }
export type StateTrace = (event: string, numbers?: Record<string, number>) => void;
interface Lease { status: RelayStatus; generation: number; acquiredBy: number; number: number; }

export function hasActivePublisher(status: RelayStatus | null | undefined): boolean {
  return status?.stage === "starting" || status?.stage === "running" || status?.stage === "draining";
}
export class PlaybackSuperseded extends Error {
  constructor() { super("Playback intent was superseded"); }
}
/** The error includes observed state, never an inference from a negative list
 * of error codes. Reconciliation is pinned to the original worker generation. */
export class PlaybackFailure extends Error {
  constructor(readonly original: unknown, readonly confirmedStatus: RelayStatus | null) {
    super(original instanceof Error ? original.message : "Playback operation failed");
  }
}

/** Owns UI intent, command ordering and resource leases, not media policy.
 * A stale start/retarget is retired before the next operation can dispatch.
 * A stale pause/rate does not create a new resource and must not kill a lease
 * that predates it. React state is never consulted to discover owned processes.
 */
export class PlaybackFlow {
  private revision = 0;
  private latestPending: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private lease: Lease | null = null;
  private nextLease = 0;
  private prepared = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly backend: PlaybackBackend,
    private readonly invalidated: (error?: unknown) => void,
    private readonly trace: StateTrace = () => undefined,
  ) {
    this.unsubscribe = backend.onGenerationEnded((generation, error) => {
      this.revision++;
      this.latestPending = null;
      this.prepared.clear();
      if (this.lease?.generation === generation) this.lease = null;
      this.trace("ui_generation_lost", { generation, operation_id: this.revision });
      this.invalidated(error);
    });
  }

  get status(): RelayStatus | null { return this.lease?.status ?? null; }
  get epoch(): number { return this.revision; }
  get busy(): boolean { return this.latestPending !== null; }
  isCurrent(intent: PlaybackIntent): boolean { return intent.id === this.revision; }
  begin(action: PlaybackAction): PlaybackIntent {
    const intent = { id: ++this.revision, action };
    this.latestPending = intent.id;
    this.trace(`ui_${action}_intent`, { operation_id: intent.id });
    return intent;
  }
  cancel(): void {
    ++this.revision;
    this.latestPending = null;
    this.trace("ui_intent_cancelled", { operation_id: this.revision });
  }
  dispose(): void { this.cancel(); this.unsubscribe(); }

  run<T>(intent: PlaybackIntent, work: (task: PlaybackTask) => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      const check = () => { if (!this.isCurrent(intent)) throw new PlaybackSuperseded(); };
      check();
      let generation: number | undefined;
      try {
        generation = await this.backend.ready();
        check();
        const task = new PlaybackTask(this.backend, generation, intent.id, check,
          (status, acquired) => this.adopt(status, generation!, intent, acquired),
          () => this.lease,
          (id) => this.prepared.get(id) === generation,
          (resolution) => this.remember(resolution, generation!),
        );
        const result = await work(task);
        check();
        this.trace("ui_operation_completed", { operation_id: intent.id, generation });
        return result;
      } catch (error) {
        if (!this.isCurrent(intent) || error instanceof PlaybackSuperseded) throw new PlaybackSuperseded();
        // Do not start a replacement worker to ask about a dead generation.
        const confirmed = generation === undefined ? null : await this.reconcile(generation, intent.id);
        check();
        this.trace("ui_operation_failed", { operation_id: intent.id, restored: Number(hasActivePublisher(confirmed)) });
        throw new PlaybackFailure(error, confirmed);
      } finally {
        if (this.latestPending === intent.id) this.latestPending = null;
        if (!this.isCurrent(intent) && this.lease?.acquiredBy === intent.id) {
          const stale = this.lease;
          this.trace("ui_stale_lease_release", { operation_id: intent.id, lease_id: stale.number, generation: stale.generation });
          if (this.backend.isGenerationCurrent(stale.generation)) {
            try { await this.backend.stopRelay(stale.status.session_id, stale.generation, intent.id); }
            catch (error) {
              // No newer mutation can have dispatched (we still own the
              // serialized slot). End this exact generation rather than leave
              // an unobserved publisher or release a newer session by mistake.
              this.trace("ui_stale_release_unconfirmed", { lease_id: stale.number });
              this.backend.invalidateGeneration(stale.generation);
              throw error;
            }
          }
          if (this.lease === stale) this.lease = null;
          this.invalidated();
        }
      }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Status also calls core transition logic. Serialize it with mutations and
   * reject late snapshots when another UI intent or generation has taken over. */
  poll(): Promise<RelayStatus | null> {
    const revision = this.revision;
    const observation = this.tail.then(async () => {
      const lease = this.lease;
      if (revision !== this.revision || !lease || !this.backend.isGenerationCurrent(lease.generation)) return null;
      try {
        const status = await this.backend.relayStatus(lease.status.session_id, lease.generation, revision);
        if (revision !== this.revision || this.lease !== lease || !this.backend.isGenerationCurrent(lease.generation)) return null;
        lease.status = status;
        return status;
      } catch (error) {
        // Generation loss is broadcast by the process adapter. A transient
        // status-read failure keeps the lease so polling/stop can still own it.
        throw error;
      }
    });
    this.tail = observation.then(() => undefined, () => undefined);
    return observation;
  }

  private remember(resolution: SourceResolution, generation: number): void {
    if (!resolution.session_id) return;
    // Only the current UI selection can be restarted. Old resolved sessions
    // remain managed/expired in Rust, not retained indefinitely by the UI.
    this.prepared.clear();
    this.prepared.set(resolution.session_id, generation);
  }
  private adopt(status: RelayStatus, generation: number, intent: PlaybackIntent, acquired: boolean): void {
    if (!this.backend.isGenerationCurrent(generation)) throw new PlaybackSuperseded();
    const previous = this.lease;
    this.lease = { status, generation,
      acquiredBy: acquired ? intent.id : previous?.acquiredBy ?? intent.id,
      number: acquired ? ++this.nextLease : previous?.number ?? ++this.nextLease };
    if (!this.isCurrent(intent) && !hasActivePublisher(status)) this.invalidated();
    this.trace("ui_lease_observed", { operation_id: intent.id, lease_id: this.lease.number, generation,
      active: Number(hasActivePublisher(status)), paused: Number(status.paused) });
  }
  private async reconcile(generation: number, operationId: number): Promise<RelayStatus | null> {
    const lease = this.lease;
    if (!lease || lease.generation !== generation || !this.backend.isGenerationCurrent(generation)) return null;
    try {
      const observed = await this.backend.relayStatus(lease.status.session_id, generation, operationId);
      if (this.lease !== lease || !this.backend.isGenerationCurrent(generation)) return null;
      lease.status = observed;
      this.trace("ui_failure_state_observed", { lease_id: lease.number, generation, active: Number(hasActivePublisher(observed)) });
      return observed;
    } catch {
      this.trace("ui_failure_state_unknown", { lease_id: lease.number, generation });
      return null;
    }
  }
}

export class PlaybackTask {
  constructor(
    private readonly backend: PlaybackBackend, private readonly generation: number, private readonly operationId: number,
    readonly check: () => void,
    private readonly adopt: (status: RelayStatus, acquired: boolean) => void,
    private readonly lease: () => Lease | null,
    private readonly prepared: (id: string) => boolean,
    private readonly remember: (resolution: SourceResolution) => void,
  ) {}
  private owned(id?: string): string {
    this.check();
    const lease = this.lease();
    if (!lease || lease.generation !== this.generation || (id && id !== lease.status.session_id)) {
      throw new RelayWorkerError("playback_session_changed", "The playback session is no longer owned by this operation");
    }
    return lease.status.session_id;
  }
  async resolve(source: string, part?: number): Promise<SourceResolution> {
    this.check();
    const resolution = await this.backend.resolveSource(source, part, this.generation, this.operationId);
    this.check(); this.remember(resolution); return resolution;
  }
  async start(id: string, options: PlaybackOptions, start = 0, paused = false): Promise<RelayStatus> {
    this.check();
    if (!this.prepared(id)) throw new RelayWorkerError("media_session_not_found", "Resolve the source again for this worker generation");
    // A previous unconfirmed stale cleanup must finish before a new start.
    if (hasActivePublisher(this.lease()?.status)) await this.stop();
    const status = await this.backend.startRelay(id, options, start, paused, this.generation, this.operationId);
    this.adopt(status, true); this.check(); return status;
  }
  async retarget(source: string, part: number, options: PlaybackOptions, start: number, paused = false): Promise<{ resolution: SourceResolution; relay: RelayStatus }> {
    this.check();
    const id = hasActivePublisher(this.lease()?.status) ? this.owned() : undefined;
    const result = await this.backend.retargetRelay(id, source, part, options, start, paused, this.generation, this.operationId);
    this.remember(result.resolution); this.adopt(result.relay, true); this.check(); return result;
  }
  async pause(id: string, paused: boolean, options: PlaybackOptions, start: number): Promise<RelayStatus> {
    const status = await this.backend.setRelayPaused(this.owned(id), paused, options, start, this.generation, this.operationId);
    this.adopt(status, false); this.check(); return status;
  }
  async rate(id: string, options: PlaybackOptions): Promise<RelayStatus> {
    const status = await this.backend.setRelayRate(this.owned(id), options, this.generation, this.operationId);
    this.adopt(status, false); this.check(); return status;
  }
  async stop(): Promise<RelayStatus | null> {
    this.check();
    const lease = this.lease();
    if (!lease || lease.generation !== this.generation) return null;
    const status = await this.backend.stopRelay(lease.status.session_id, this.generation, this.operationId);
    this.adopt(status, false); this.check(); return status;
  }
}
