import type { StateTrace } from "./playback-flow";

export interface SearchQuery { readonly keyword: string; readonly folderId: number | null; }
export interface SearchPage<T> { items: T[]; page: number; hasMore: boolean; }
export interface SearchState<T> {
  query: SearchQuery | null;
  items: T[] | null;
  page: number;
  hasMore: boolean;
  phase: "idle" | "debouncing" | "loading" | "ready" | "failed";
  error: unknown;
}
export function emptySearchState<T>(): SearchState<T> {
  return { query: null, items: null, page: 0, hasMore: false, phase: "idle", error: null };
}
let nextSearch = 0;

/** Query identity owns results AND pagination. Input invalidates immediately;
 * only network dispatch is debounced. Old callbacks cannot re-enable paging.
 * The owner supplies every page's query; the UI never combines text with an
 * unrelated result's page number. Cancellation does not replay a sent request.
 */
export class SearchRequestOwner<T> {
  private state: SearchState<T> = emptySearchState<T>();
  private revision = 0;
  private request = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly id = ++nextSearch;

  constructor(
    private readonly fetch: (query: SearchQuery, page: number) => Promise<SearchPage<T>>,
    private readonly changed: (state: SearchState<T>) => void,
    private readonly trace: StateTrace = () => undefined,
  ) {}

  setQuery(value: SearchQuery | null): void {
    if (this.disposed) return;
    const query = value?.keyword.trim()
      ? Object.freeze({ keyword: value.keyword.trim(), folderId: value.folderId }) : null;
    const previous = this.state.query;
    if (query?.keyword === previous?.keyword && query?.folderId === previous?.folderId) return;
    this.clearTimer();
    ++this.revision;
    ++this.request;
    this.state = query
      ? { query, items: [], page: 0, hasMore: false, phase: "debouncing", error: null }
      : emptySearchState<T>();
    this.record("search_query_changed");
    this.changed(this.state);
    if (query) {
      const revision = this.revision;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.disposed && revision === this.revision) void this.load(1, false);
      }, 400);
    }
  }

  more(): Promise<void> {
    if (this.disposed || this.state.phase !== "ready" || !this.state.hasMore || this.state.page < 1) {
      this.record("search_page_blocked");
      return Promise.resolve();
    }
    return this.load(this.state.page + 1, true);
  }

  retry(): Promise<void> {
    if (this.disposed || this.state.phase !== "failed") return Promise.resolve();
    return this.load(1, false);
  }

  dispose(): void {
    this.disposed = true;
    ++this.revision;
    ++this.request;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async load(page: number, append: boolean): Promise<void> {
    const query = this.state.query;
    if (this.disposed || !query) return;
    const revision = this.revision;
    const request = ++this.request;
    const current = () => !this.disposed && this.revision === revision && this.request === request;
    const items = append ? (this.state.items ?? []) : [];
    this.state = { ...this.state, items, phase: "loading", error: null };
    this.changed(this.state);
    this.record("search_page_started", page, revision);
    try {
      const result = await this.fetch(query, page);
      if (!current()) { this.record("search_reply_discarded", page, revision); return; }
      this.state = { query, items: append ? [...items, ...result.items] : result.items,
        page: result.page, hasMore: result.hasMore, phase: "ready", error: null };
      this.changed(this.state);
      this.record("search_page_completed", page, revision);
    } catch (error) {
      if (!current()) { this.record("search_reply_discarded", page, revision); return; }
      this.state = { ...this.state, phase: "failed", error };
      this.changed(this.state);
      this.record("search_page_failed", page, revision);
    }
  }

  private record(event: string, page = 0, revision = this.revision): void {
    this.trace(event, { search_id: this.id, search_revision: revision, page });
  }
}
