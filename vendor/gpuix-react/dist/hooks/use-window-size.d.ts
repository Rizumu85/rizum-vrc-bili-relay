import type { NativeWindowInsets } from "../types/host.js";
export interface WindowSize {
    width: number;
    height: number;
}
export interface WindowSizeOptions {
    /** Poll interval in milliseconds. Defaults to 100. Set false for one read. */
    intervalMs?: number | false;
}
/**
 * The current window size, sampled every 100ms by default.
 *
 * It polls rather than reading once, for the same reason `useWindowInsets`
 * does: the first read can land before the platform window has a size, and a
 * value that stays at the fallback forever is far worse than a late one. Code
 * that converts a mouse position into layout coordinates silently points at the
 * wrong row when this number is stale.
 */
export declare function useWindowSize(options?: WindowSizeOptions): WindowSize;
export interface WindowInsets extends NativeWindowInsets {
    /** Y coordinate where unobscured content ends. Equals window height when closed. */
    keyboardTop: number;
    keyboardVisible: boolean;
    visibleHeight: number;
}
export interface WindowInsetsOptions {
    /** Poll interval in milliseconds. Defaults to 100. Set false for one read. */
    intervalMs?: number | false;
}
/** Get safe-area and keyboard geometry, sampled every 100ms by default. */
export declare function useWindowInsets(options?: WindowInsetsOptions): WindowInsets;
//# sourceMappingURL=use-window-size.d.ts.map