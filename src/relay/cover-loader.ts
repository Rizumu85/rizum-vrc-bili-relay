import type { FavoriteCover } from "./protocol";
import type { StateTrace } from "./playback-flow";

interface CoverJob { attempts: number; retryAt: number; done: boolean; }
const BATCH_SIZE = 8;
const MAX_ATTEMPTS = 3;
const MAX_VISIBLE_URLS = 600;

/** A failed/omitted thumbnail completes its attempt, not the entire queue.
 * Retries are bounded and lower-priority than never-attempted visible images.
 * Disposed views cannot receive late images or schedule more worker requests.
 */
export class CoverLoader {
  private jobs = new Map<string, CoverJob>();
  private active = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly fetch: (urls: string[]) => Promise<FavoriteCover[]>,
    private readonly receive: (covers: FavoriteCover[]) => void,
    private readonly trace: StateTrace = () => undefined,
    private readonly retryDelayMs = 1_000,
  ) {}
  setUrls(urls: string[]): void {
    if (this.disposed) return;
    const wanted = new Set([...new Set(urls.filter(Boolean))].slice(0, MAX_VISIBLE_URLS));
    for (const url of this.jobs.keys()) if (!wanted.has(url)) this.jobs.delete(url);
    for (const url of wanted) if (!this.jobs.has(url)) this.jobs.set(url, { attempts: 0, retryAt: 0, done: false });
    this.wake();
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.jobs.clear();
  }
  get counts(): { total: number; done: number; exhausted: number; in_flight: boolean } {
    const values = [...this.jobs.values()];
    return { in_flight: this.active, total: values.length, done: values.filter((j) => j.done).length,
      exhausted: values.filter((j) => !j.done && j.attempts >= MAX_ATTEMPTS).length };
  }
  private wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active && !this.disposed) void this.pump();
  }
  private async pump(): Promise<void> {
    if (this.active || this.disposed) return;
    this.active = true;
    try {
      while (!this.disposed) {
        const now = performance.now();
        const pending = [...this.jobs.entries()].filter(([, j]) => !j.done && j.attempts < MAX_ATTEMPTS);
        const batch = pending.filter(([, j]) => j.retryAt <= now)
          .sort((a, b) => a[1].attempts - b[1].attempts).slice(0, BATCH_SIZE);
        if (batch.length === 0) {
          if (pending.length) {
            const delay = Math.max(1, Math.min(...pending.map(([, j]) => j.retryAt)) - now);
            this.timer = setTimeout(() => { this.timer = null; this.wake(); }, delay);
          }
          break;
        }
        for (const [, job] of batch) job.attempts++;
        const started = performance.now();
        let result: FavoriteCover[] = [];
        try { result = await this.fetch(batch.map(([url]) => url)); }
        catch { /* Missing results and whole-batch errors share bounded retirement. */ }
        if (this.disposed) return;
        const succeeded = new Map(result.map((cover) => [cover.url, cover]));
        const accepted: FavoriteCover[] = [];
        let failed = 0;
        for (const [url, job] of batch) {
          if (this.jobs.get(url) !== job) continue;
          const cover = succeeded.get(url);
          if (cover) { job.done = true; accepted.push(cover); }
          else { failed++; job.retryAt = performance.now() + this.retryDelayMs * 2 ** (job.attempts - 1); }
        }
        this.trace("cover_batch_completed", { accepted_count: accepted.length, failed_count: failed,
          attempt: Math.max(...batch.map(([, j]) => j.attempts)), elapsed_ms: performance.now() - started });
        if (accepted.length) this.receive(accepted);
      }
    } finally { this.active = false; }
  }
}
