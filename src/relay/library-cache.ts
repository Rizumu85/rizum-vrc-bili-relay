// Session-scoped cache for the login-gated video libraries (favorites,
// watch-later, history). First pages paint from memory while a stale entry
// revalidates in the background, so reopening a library is instant instead of
// waiting on Bilibili every time.
const TTL_MS = 120_000;

interface Entry {
  at: number;
  value: unknown;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export interface CachedRead<T> {
  value: T;
  fresh: boolean;
}

export function readLibraryCache<T>(key: string): CachedRead<T> | null {
  const entry = entries.get(key);
  if (!entry) return null;
  return { value: entry.value as T, fresh: Date.now() - entry.at <= TTL_MS };
}

export function fillLibraryCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = fetcher()
    .then((value) => {
      entries.set(key, { at: Date.now(), value });
      inflight.delete(key);
      return value;
    })
    .catch((error: unknown) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, promise);
  return promise;
}

// Warms a key without blocking the caller. Failures are swallowed because the
// real load path surfaces its own errors when the view actually opens.
export function primeLibraryCache(key: string, fetcher: () => Promise<unknown>): void {
  if (readLibraryCache(key)?.fresh) return;
  void fillLibraryCache(key, fetcher).catch(() => undefined);
}
