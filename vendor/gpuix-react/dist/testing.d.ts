import type { ReactNode } from "react";
import type { EventPayload } from "@gpuix/native";
import type { DebugFrameOverlayMode, DebugFrameOverlayStats, HighlightMatch, NativeRenderer } from "./types/host.js";
import { type Root } from "./reconciler/reconciler.js";
export { applyMacCpuThrottleFromEnv, MAC_CPU_THROTTLES, readMacCpuThrottle, } from "./cpu-throttle.js";
export type { MacCpuThrottle } from "./cpu-throttle.js";
/** Offscreen window size for a test root. Defaults to 1280x800 in native. */
export interface TestWindowOptions {
    width?: number;
    height?: number;
}
/** Whether the native TestGpuixRenderer is available (for conditional test registration). */
export declare const hasNativeTestRenderer: boolean;
export interface TestElement {
    id: number;
    type: string;
    style: Record<string, unknown>;
    text: string | null;
    events: Set<string>;
    children: number[];
    parentId: number | null;
    testId?: string;
    customProps?: Record<string, unknown>;
}
export declare class TestRenderer implements NativeRenderer {
    commitCount: number;
    /** Native TestGpuixRenderer — all state lives here in Rust's RetainedTree. */
    private native;
    constructor(options?: TestWindowOptions);
    createElement(id: number, elementType: string): void;
    destroyElement(id: number): Array<number>;
    appendChild(parentId: number, childId: number): void;
    removeChild(parentId: number, childId: number): void;
    insertBefore(parentId: number, childId: number, beforeId: number): void;
    setStyle(id: number, styleJson: string): void;
    setText(id: number, content: string): void;
    setEventListener(id: number, eventType: string, hasHandler: boolean): void;
    setRoot(id: number): void;
    setCustomProp(id: number, key: string, valueJson: string): void;
    commitMutations(): void;
    applyBatch(json: string): Array<number>;
    /** Trigger the real GPUI rendering pipeline (GpuixView::render() →
     *  build_element() → apply_styles() → layout). */
    flush(): void;
    /** Drain events collected by the native GPUI event handlers. */
    drainEvents(): EventPayload[];
    /** Drain events from the native GPUI pipeline and feed them into the
     *  React event registry, triggering state updates synchronously.
     *  Loops until no more events are produced — handles re-entrant events
     *  that may be generated during React state updates. */
    dispatchNativeEvents(): void;
    /** End-to-end: focus element → simulate keystrokes through GPUI →
     *  dispatch resulting events to React.
     *  @param elementId - element to focus (must have onKeyDown/onKeyUp)
     *  @param keystrokes - space-separated keys, e.g. "a", "enter", "cmd-shift-p"
     */
    /** Send keystrokes to whatever currently holds focus.
     *
     *  Unlike `nativeSimulateKeystrokes`, this focuses nothing first, which is
     *  the only way to test that `autoFocus` (or a click) actually moved focus. */
    simulateKeystrokes(keystrokes: string): void;
    nativeSimulateKeystrokes(elementId: number, keystrokes: string): void;
    /** End-to-end: focus element → simulate a single key down through GPUI →
     *  dispatch resulting events to React. Unlike nativeSimulateKeystrokes,
     *  this dispatches ONLY a KeyDownEvent — no automatic KeyUpEvent follows.
     *  @param elementId - element to focus (must have onKeyDown)
     *  @param keystroke - modifier-key string, e.g. "a", "enter", "cmd-s"
     *  @param isHeld - whether this is a key-repeat event (default: false)
     */
    nativeSimulateKeyDown(elementId: number, keystroke: string, isHeld?: boolean): void;
    /** End-to-end: focus element → simulate a single key up through GPUI →
     *  dispatch resulting events to React. Pairs with nativeSimulateKeyDown.
     *  @param elementId - element to focus (must have onKeyUp)
     *  @param keystroke - modifier-key string, e.g. "a", "enter", "cmd-s"
     */
    nativeSimulateKeyUp(elementId: number, keystroke: string): void;
    /** End-to-end: simulate a click through GPUI hit testing →
     *  dispatch resulting events to React. */
    nativeSimulateClick(x: number, y: number, button?: number, modifiers?: string): void;
    /** End-to-end: simulate scroll wheel through GPUI →
     *  dispatch resulting events to React. */
    nativeSimulateScrollWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): void;
    /** Dispatch a wheel without the surrounding flushes, for perf sampling.
     *  Call `flush()` yourself, or the sample is the React update only and
     *  none of the GPUI build, layout and paint that follows. */
    dispatchScrollWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): void;
    /** Dispatch a move without the surrounding flushes, for perf sampling.
     *  `nativeSimulateMouseMove` flushes before and after, so a drag timed with
     *  it contains two complete paints and cannot be compared to a wheel. */
    dispatchMouseMove(x: number, y: number, pressedButton?: number, modifiers?: string): void;
    /** End-to-end: simulate mouse move through GPUI →
     *  dispatch resulting events to React.
     *  @param pressedButton - optional button held during move (0=left, 1=middle, 2=right) for drag simulation */
    nativeSimulateMouseMove(x: number, y: number, pressedButton?: number, modifiers?: string): void;
    /** End-to-end: simulate mouse down through GPUI hit testing →
     *  dispatch resulting events to React.
     *  @param button - 0=left (default), 1=middle, 2=right */
    nativeSimulateMouseDown(x: number, y: number, button?: number, modifiers?: string): void;
    /** End-to-end: simulate mouse up through GPUI hit testing →
     *  dispatch resulting events to React.
     *  @param button - 0=left (default), 1=middle, 2=right */
    nativeSimulateMouseUp(x: number, y: number, button?: number, modifiers?: string): void;
    /** Build a flat map of TestElements from the native tree JSON.
     *  One FFI call to get the full tree, then parse into TestElement objects. */
    private buildElementMap;
    /** Get the root element. */
    getRoot(): TestElement | undefined;
    /** Get an element by ID. */
    getElement(id: number): TestElement | undefined;
    /** Find elements by type (e.g. "div", "text"). */
    findByType(type: string): TestElement[];
    /** Find the first text element containing the given string. */
    findByText(text: string): TestElement | undefined;
    findByTestId(testId: string): TestElement | undefined;
    /** Get all text content in the tree (depth-first). */
    getAllText(): string[];
    /** Print the tree structure for debugging. Only includes non-empty fields. */
    toJSON(): unknown;
    getAutomationTree(): string;
    /** Every element the native tree holds, reachable or not. `toJSON()` walks
     *  from the root, so only this can see a node that was detached and leaked. */
    getRetainedElementCount(): number;
    getElementBounds(elementId: number): number[] | null;
    clockPause(): number;
    clockSet(nowMs: number): number;
    clockFastForward(deltaMs: number): number;
    clockResume(): number;
    focusElement(elementId: number): void;
    /** The offscreen window size, so `useWindowSize()` works under test. */
    getWindowSize(): {
        width: number;
        height: number;
    };
    /** Set the scroll offset of a scrollable element (overflow: "scroll").
     *  x and y are negative pixel values (scroll down = more negative y).
     *  Call flush() internally to apply. */
    scrollTo(elementId: number, x: number, y: number): void;
    /** Scroll a child into view by its index in the children list.
     *
     *  `offsetInItem` is in pixels. A negative value anchors the viewport top
     *  above the item, resolved against measured row heights at layout time, so
     *  a row stays pixel-stable while unmeasured rows are spliced in above it. */
    scrollToItem(elementId: number, index: number, offsetInItem?: number): void;
    /** Get the current scroll offset [x, y] or null if element is not scrollable. */
    getScrollOffset(elementId: number): [number, number] | null;
    /** The logical scroll anchor of a `<virtual-list>`:
     *  `[itemIndex, offsetInItemPx, viewportHeightPx]`, or null for anything
     *  else. `itemIndex == item count` is gpui's at-end sentinel. Exact even
     *  while row heights are still estimates, because it is the anchor gpui
     *  itself scrolls by. */
    getListScrollTop(elementId: number): [number, number, number] | null;
    /** Drag-select from (x1,y1) to (x2,y2) and return the selected text.
     *
     *  Selection listeners are registered during **paint**, so the native helper
     *  flushes between every step. Calling simulateMouseDown/Move/Up by hand
     *  without those flushes selects nothing. */
    dragSelect(x1: number, y1: number, x2: number, y2: number): string | null;
    /** The current selection joined in document order, or null. */
    getSelectedText(): string | null;
    /** Every string painted in the last frame, in paint order.
     *
     *  `getAllText()` only sees `<text>` nodes in the retained tree. Native
     *  elements like `<code>` and `<diff>` paint their text inside GPUI, so this
     *  is the only way to assert on what they rendered. */
    getPaintedText(): string[];
    /** Every highlight wash painted in the last frame, in paint order.
     *
     *  A quad never lands in `getPaintedText()`, and a soft-wrapped match must
     *  draw one box per visual row, so each entry carries its `rects`. */
    getPaintedHighlights(): HighlightMatch[];
    /** Syntax-cache counters as `[hits, misses, documents]`. */
    getSyntaxCacheStats(): [number, number, number];
    clearSelection(): void;
    setDebugFrameOverlay(mode: DebugFrameOverlayMode): string;
    getDebugFrameOverlay(): string;
    cycleDebugFrameOverlay(): string;
    resetDebugFrameOverlayStats(): void;
    getDebugFrameOverlayStats(): DebugFrameOverlayStats;
    /** Capture the current Metal or DirectX frame and save it as a PNG. */
    captureScreenshot(path: string): void;
    /** Whether the native GPUI test renderer is available. Always true. */
    get hasNative(): boolean;
}
export interface TestRoot {
    root: Root;
    renderer: TestRenderer;
    render: (node: ReactNode) => void;
    unmount: () => void;
}
/**
 * Create a test root for rendering React components.
 * All mutations go to the real GPUI pipeline via native TestGpuixRenderer.
 * Returns the Root (for rendering), the TestRenderer (for inspection/events),
 * and convenience methods.
 *
 * Pass `width` / `height` to size the offscreen window. The 1280x800 default is
 * wide enough to keep a centered max-width column capped, so a layout test that
 * needs to observe re-wrapping must ask for a narrower window.
 */
export declare function createTestRoot(options?: TestWindowOptions): TestRoot;
//# sourceMappingURL=testing.d.ts.map