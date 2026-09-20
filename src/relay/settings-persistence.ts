import type { ProductSettings, SettingsUpdate } from "./protocol";
import type { StateTrace } from "./playback-flow";
interface Pending { revision: number; update: SettingsUpdate; signature: string; }

/** All settings reads/writes share one order. Automatic preferences coalesce
 * BEFORE dispatch; dispatched snapshots are immutable. flush() observes errors
 * rather than treating a caught rejection as a successful shutdown barrier.
 */
export class SettingsPersistence {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestedSignature: string | null = null;
  private automaticError: unknown = null;
  private latestPreferenceRevision = 0;
  private explicitError: unknown = null;
  constructor(
    private readonly readSettings: () => Promise<ProductSettings>,
    private readonly writeSettings: (update: SettingsUpdate) => Promise<ProductSettings>,
    private readonly committed: (settings: ProductSettings) => void,
    private readonly failed: (error: unknown) => void,
    private readonly trace: StateTrace = () => undefined,
  ) {}
  baseline(signature: string): void {
    if (this.requestedSignature === null) this.requestedSignature = signature;
  }
  schedule(update: SettingsUpdate, signature: string, delayMs = 250): void {
    if (signature === this.requestedSignature) return;
    this.requestedSignature = signature;
    this.latestPreferenceRevision = ++this.revision;
    this.pending = { revision: this.latestPreferenceRevision, update: structuredClone(update), signature };
    this.trace("settings_pending", { settings_revision: this.revision });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.dispatchPending(); }, delayMs);
  }
  read(): Promise<ProductSettings> {
    this.dispatchPending();
    return this.enqueue(async () => {
      const result = await this.readSettings();
      this.committed(result);
      return result;
    });
  }
  save(update: SettingsUpdate): Promise<ProductSettings> {
    this.dispatchPending();
    const revision = ++this.revision;
    const snapshot = structuredClone(update);
    return this.enqueue(async () => {
      try {
        const result = await this.writeSettings(snapshot);
        this.explicitError = null;
        this.committed(result);
        this.trace("settings_committed", { settings_revision: revision });
        return result;
      } catch (error) {
        this.explicitError = error;
        this.failed(error);
        this.trace("settings_commit_failed", { settings_revision: revision });
        throw error;
      }
    });
  }
  async flush(): Promise<void> {
    this.dispatchPending();
    // New writes may be enqueued while earlier ones settle. The caller freezes
    // UI input during close; this also accounts for already-queued callbacks.
    let barrier: Promise<void>;
    do { barrier = this.tail; await barrier; } while (barrier !== this.tail);
    if (this.pending || this.automaticError || this.explicitError) {
      throw this.automaticError ?? this.explicitError ?? new Error("Settings remain pending");
    }
    this.trace("settings_flushed", { settings_revision: this.revision });
  }
  private dispatchPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    void this.enqueue(async () => {
      try {
        const result = await this.writeSettings(pending.update);
        this.automaticError = null;
        this.committed(result);
        this.trace("settings_committed", { settings_revision: pending.revision });
      } catch (error) {
        this.automaticError = error;
        // Do not overwrite a newer desired snapshot or launch an infinite retry.
        if (pending.revision === this.latestPreferenceRevision) this.pending = pending;
        this.failed(error);
        this.trace("settings_commit_failed", { settings_revision: pending.revision });
      }
    });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** A timeout aborts closing, not the pending disk/RPC operation. The window
 * stays open and its worker stays alive so the user can resolve/retry saving. */
export async function flushSettingsBeforeClose(store: SettingsPersistence, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([store.flush(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Settings flush is still pending; close cancelled")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
