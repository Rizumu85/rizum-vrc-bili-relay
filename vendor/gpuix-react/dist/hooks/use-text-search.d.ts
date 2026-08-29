import type { Props } from "../types/host.js";
export interface TextSearchOptions {
    query: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    color?: string;
    activeColor?: string;
    radius?: number;
    /**
     * Match bookkeeping you did yourself, for content native cannot see whole.
     *
     * A `<virtual-list>` mounts a window of its rows, so native both counts and
     * numbers that window only. Supplying one number without the other is always
     * wrong, which is why they travel together: `total` replaces the count native
     * reports, and `indexOffset` is how many matches sit above the window, so
     * `next()` still lands on the right row.
     *
     * Both are MATCH counts, not row indices. Sum `findRanges` over your rows.
     */
    matches?: {
        total: number;
        indexOffset: number;
    };
}
export interface TextSearch {
    /** Spread onto the container to search: `<div {...search.props}>`. */
    props: Pick<Props, "highlight" | "onHighlight">;
    /** Matches in retained text, or the `total` you supplied. */
    total: number;
    /** Index of the active match, clamped into `[0, total)`. */
    active: number;
    next(): void;
    previous(): void;
    /** Jump to a specific match. Out-of-range values are ignored. */
    goTo(index: number): void;
}
/**
 * Drive a find bar.
 *
 * `next` and `previous` are plain event handlers, so nothing here needs an
 * effect. The count arrives through `onHighlight` after the build that resolved
 * it, never during, so a `setState` in that handler cannot re-enter the build.
 */
export declare function useTextSearch(options: TextSearchOptions): TextSearch;
export interface FindRangesOptions {
    text: string;
    query: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
}
/**
 * Non-overlapping `[start, end)` matches of `query` in `text`, in UTF-16 code
 * units. Same contract as the native matcher: leftmost first, non-overlapping,
 * Unicode **lowercasing** (not full case folding, so `ﬀ` does not match `ff`),
 * and a word boundary is any code point that is not Unicode Alphabetic, a
 * digit, or `_`.
 */
export declare function findRanges(options: FindRangesOptions): Array<[number, number]>;
//# sourceMappingURL=use-text-search.d.ts.map