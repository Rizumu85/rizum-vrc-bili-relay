import type { CachedRead } from "./library-cache";
import type { StateTrace } from "./playback-flow";

export type ListLoadPhase = "idle" | "loading" | "refreshing" | "ready" | "failed";
export function listLoadPending(phase: ListLoadPhase): boolean {
  return phase === "loading" || phase === "refreshing";
}
let nextOwner = 0;

/** Own one list's complete request lifecycle, including cache-only completion.
 * The data and loading state use the SAME ticket. Replaced replies/finalizers
 * cannot overwrite a current list, and cached revalidation counts as pending
 * so pagination cannot accidentally supersede the page it would append to.
 */
export class ListRequestOwner {
  private revision = 0;
  private disposed = false;
  private readonly id = ++nextOwner;
  constructor(
    private readonly changed: (phase: ListLoadPhase) => void,
    private readonly trace: StateTrace = () => undefined,
  ) {}

  cancel(): void {
    if (this.disposed) return;
    ++this.revision;
    this.changed("idle");
    this.record("list_load_cancelled");
  }
  dispose(): void {
    this.disposed = true;
    ++this.revision;
  }

  async load<T>(
    cached: CachedRead<T> | null,
    fetcher: () => Promise<T>,
    accept: (value: T) => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.revision;
    const current = () => !this.disposed && revision === this.revision;
    this.changed(cached?.fresh ? "ready" : cached ? "refreshing" : "loading");
    this.record(cached?.fresh ? "list_cache_completed" : "list_load_started", revision);
    if (cached) accept(cached.value);
    if (!current() || cached?.fresh) return;
    try {
      const value = await fetcher();
      if (!current()) {
        this.record("list_reply_discarded", revision);
        return;
      }
      accept(value);
      if (current()) {
        this.changed("ready");
        this.record("list_load_completed", revision);
      }
    } catch (error) {
      if (!current()) {
        this.record("list_reply_discarded", revision);
        return;
      }
      // Keep a usable cached list when revalidation fails, as before.
      if (!cached) failed(error);
      if (current()) {
        this.changed(cached ? "ready" : "failed");
        this.record("list_load_failed", revision);
      }
    }
  }

  private record(event: string, revision = this.revision): void {
    this.trace(event, { list_id: this.id, list_revision: revision });
  }
}
