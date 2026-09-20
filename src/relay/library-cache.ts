import type { StateTrace } from "./playback-flow";

const TTL_MS = 120_000;
const MAX_ENTRIES = 128;
interface Entry { at: number; value: unknown; }
export interface CachedRead<T> { value: T; fresh: boolean; }
export class LibraryScopeChanged extends Error {
  constructor() { super("Library account scope changed"); }
}

/** Per-app, account-and-worker-scoped cache. Revocation invalidates BOTH cached
 * values and in-flight results. A response from an old account cannot refill
 * this cache or be returned to a new view, even after logging into the same UID.
 */
export class LibraryCache {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
  private scope: string | null = null;
  private version = 0;
  constructor(private readonly trace: StateTrace = () => undefined) {}
  get epoch(): number { return this.version; }
  get size(): number { return this.entries.size; }
  setScope(scope: string | null, force = false): number {
    if (!force && scope === this.scope) return this.version;
    this.scope = scope;
    this.version++;
    this.entries.clear();
    this.inflight.clear();
    this.trace("library_scope_changed", { scope_epoch: this.version });
    return this.version;
  }
  read<T>(key: string): CachedRead<T> | null {
    if (this.scope === null) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key); this.entries.set(key, entry);
    this.trace("library_cache_hit", { scope_epoch: this.version });
    return { value: entry.value as T, fresh: Date.now() - entry.at <= TTL_MS };
  }
  /** Guards uncached pages/searches as well as cache fills. */
  async scoped<T>(fetcher: () => Promise<T>): Promise<T> {
    const epoch = this.version;
    if (this.scope === null) throw new LibraryScopeChanged();
    const value = await fetcher();
    if (epoch !== this.version || this.scope === null) {
      this.trace("library_late_result_dropped", { scope_epoch: epoch });
      throw new LibraryScopeChanged();
    }
    return value;
  }
  fill<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.scope === null) return Promise.reject(new LibraryScopeChanged());
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const epoch = this.version;
    const promise = Promise.resolve().then(() => {
      if (epoch !== this.version) throw new LibraryScopeChanged();
      return this.scoped(fetcher);
    }).then((value) => {
      if (epoch !== this.version) throw new LibraryScopeChanged();
      this.entries.delete(key);
      this.entries.set(key, { at: Date.now(), value });
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
      return value;
    }).finally(() => {
      // A late old request must not remove the NEW account's pending request.
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }
  prime(key: string, fetcher: () => Promise<unknown>): void {
    if (this.scope === null || this.read(key)?.fresh) return;
    void this.fill(key, fetcher).catch(() => undefined);
  }
}
