/// GPUIX TestRenderer — thin wrapper over the native TestGpuixRenderer.
///
/// All state lives in Rust's RetainedTree. All mutations go directly to
/// the native renderer via napi. Inspection methods (findByType, getAllText,
/// toJSON, etc.) query the Rust tree via napi — no JS-side shadow copy.
///
/// All event simulation goes through the native GPUI pipeline (coordinate-based
/// hit testing, GPUI dispatch, emit_event_full). The nativeSimulate* methods
/// flush the tree, dispatch through GPUI, drain events, and feed them into
/// the React event registry via handleGpuixEvent.
import { createRequire } from "node:module";
import { createRoot, flushSync } from "./reconciler/reconciler.js";
import { handleGpuixEvent } from "./reconciler/event-registry.js";
export { applyMacCpuThrottleFromEnv, MAC_CPU_THROTTLES, readMacCpuThrottle, } from "./cpu-throttle.js";
// The native test renderer is exported by macOS and Windows builds.
//
// Loaded through `createRequire`, never a bare `require`. This file ships as
// ESM, and Node has no `require` there: in a workspace vitest inlines it and
// happens to provide one, but a real dependency is externalized and run by
// Node, where the bare call threw `require is not defined`. The `catch` then
// made `hasNativeTestRenderer` false, so every suite that guards on it
// silently skipped for anyone consuming the published package.
let NativeTestRenderer = null;
try {
    const native = createRequire(import.meta.url)("@gpuix/native");
    if (native.TestGpuixRenderer) {
        NativeTestRenderer = native.TestGpuixRenderer;
    }
}
catch {
    // Native module not available — native simulation methods will throw.
}
/** Whether the native TestGpuixRenderer is available (for conditional test registration). */
export const hasNativeTestRenderer = NativeTestRenderer != null;
// ── TestRenderer ─────────────────────────────────────────────────────
export class TestRenderer {
    commitCount = 0;
    /** Native TestGpuixRenderer — all state lives here in Rust's RetainedTree. */
    native;
    constructor(options = {}) {
        if (!NativeTestRenderer) {
            throw new Error("Native TestGpuixRenderer not available. Build with test-support to run tests.");
        }
        this.native = new NativeTestRenderer(options.width, options.height);
    }
    // ── NativeRenderer interface (all mutations delegate to native) ──
    createElement(id, elementType) {
        this.native.createElement(id, elementType);
    }
    destroyElement(id) {
        return this.native.destroyElement(id);
    }
    appendChild(parentId, childId) {
        this.native.appendChild(parentId, childId);
    }
    removeChild(parentId, childId) {
        this.native.removeChild(parentId, childId);
    }
    insertBefore(parentId, childId, beforeId) {
        this.native.insertBefore(parentId, childId, beforeId);
    }
    setStyle(id, styleJson) {
        this.native.setStyle(id, styleJson);
    }
    setText(id, content) {
        this.native.setText(id, content);
    }
    setEventListener(id, eventType, hasHandler) {
        this.native.setEventListener(id, eventType, hasHandler);
    }
    setRoot(id) {
        this.native.setRoot(id);
    }
    setCustomProp(id, key, valueJson) {
        this.native.setCustomProp(id, key, valueJson);
    }
    commitMutations() {
        this.native.commitMutations();
        this.commitCount++;
    }
    applyBatch(json) {
        return this.native.applyBatch(json);
    }
    // ── GPUI pipeline methods ───────────────────────────────────────
    /** Trigger the real GPUI rendering pipeline (GpuixView::render() →
     *  build_element() → apply_styles() → layout). */
    flush() {
        this.native.flush();
    }
    /** Drain events collected by the native GPUI event handlers. */
    drainEvents() {
        return this.native.drainEvents();
    }
    // ── Native end-to-end simulation ────────────────────────────────
    // These methods go through the full GPUI pipeline:
    //   native simulate → GPUI dispatch → hit test → event handler →
    //   emit_event_full → drainEvents → handleGpuixEvent → React handler
    /** Drain events from the native GPUI pipeline and feed them into the
     *  React event registry, triggering state updates synchronously.
     *  Loops until no more events are produced — handles re-entrant events
     *  that may be generated during React state updates. */
    dispatchNativeEvents() {
        for (;;) {
            const events = this.native.drainEvents();
            if (events.length === 0)
                break;
            for (const event of events) {
                flushSync(() => {
                    handleGpuixEvent(event, this);
                });
            }
        }
    }
    /** End-to-end: focus element → simulate keystrokes through GPUI →
     *  dispatch resulting events to React.
     *  @param elementId - element to focus (must have onKeyDown/onKeyUp)
     *  @param keystrokes - space-separated keys, e.g. "a", "enter", "cmd-shift-p"
     */
    /** Send keystrokes to whatever currently holds focus.
     *
     *  Unlike `nativeSimulateKeystrokes`, this focuses nothing first, which is
     *  the only way to test that `autoFocus` (or a click) actually moved focus. */
    simulateKeystrokes(keystrokes) {
        this.native.flush();
        this.native.simulateKeystrokes(keystrokes);
        this.dispatchNativeEvents();
        this.native.flush();
    }
    nativeSimulateKeystrokes(elementId, keystrokes) {
        this.native.flush();
        this.native.focusElement(elementId);
        this.native.simulateKeystrokes(keystrokes);
        this.dispatchNativeEvents();
    }
    /** End-to-end: focus element → simulate a single key down through GPUI →
     *  dispatch resulting events to React. Unlike nativeSimulateKeystrokes,
     *  this dispatches ONLY a KeyDownEvent — no automatic KeyUpEvent follows.
     *  @param elementId - element to focus (must have onKeyDown)
     *  @param keystroke - modifier-key string, e.g. "a", "enter", "cmd-s"
     *  @param isHeld - whether this is a key-repeat event (default: false)
     */
    nativeSimulateKeyDown(elementId, keystroke, isHeld) {
        this.native.flush();
        this.native.focusElement(elementId);
        this.native.simulateKeyDown(keystroke, isHeld);
        this.dispatchNativeEvents();
    }
    /** End-to-end: focus element → simulate a single key up through GPUI →
     *  dispatch resulting events to React. Pairs with nativeSimulateKeyDown.
     *  @param elementId - element to focus (must have onKeyUp)
     *  @param keystroke - modifier-key string, e.g. "a", "enter", "cmd-s"
     */
    nativeSimulateKeyUp(elementId, keystroke) {
        this.native.flush();
        this.native.focusElement(elementId);
        this.native.simulateKeyUp(keystroke);
        this.dispatchNativeEvents();
    }
    /** End-to-end: simulate a click through GPUI hit testing →
     *  dispatch resulting events to React. */
    nativeSimulateClick(x, y, button, modifiers) {
        this.native.flush();
        this.native.simulateClick(x, y, button, modifiers);
        this.dispatchNativeEvents();
        // Flush again after React state updates so the Rust RetainedTree
        // is fully rebuilt and GPUI has re-laid-out before any screenshot.
        this.native.flush();
    }
    /** End-to-end: simulate scroll wheel through GPUI →
     *  dispatch resulting events to React. */
    nativeSimulateScrollWheel(x, y, deltaX, deltaY, modifiers) {
        this.native.flush();
        this.native.simulateScrollWheel(x, y, deltaX, deltaY, modifiers);
        this.dispatchNativeEvents();
    }
    /** Dispatch a wheel without the surrounding flushes, for perf sampling.
     *  Call `flush()` yourself, or the sample is the React update only and
     *  none of the GPUI build, layout and paint that follows. */
    dispatchScrollWheel(x, y, deltaX, deltaY, modifiers) {
        this.native.simulateScrollWheel(x, y, deltaX, deltaY, modifiers);
        this.dispatchNativeEvents();
    }
    /** Dispatch a move without the surrounding flushes, for perf sampling.
     *  `nativeSimulateMouseMove` flushes before and after, so a drag timed with
     *  it contains two complete paints and cannot be compared to a wheel. */
    dispatchMouseMove(x, y, pressedButton, modifiers) {
        this.native.simulateMouseMove(x, y, pressedButton, modifiers);
        this.dispatchNativeEvents();
    }
    /** End-to-end: simulate mouse move through GPUI →
     *  dispatch resulting events to React.
     *  @param pressedButton - optional button held during move (0=left, 1=middle, 2=right) for drag simulation */
    nativeSimulateMouseMove(x, y, pressedButton, modifiers) {
        this.native.flush();
        this.native.simulateMouseMove(x, y, pressedButton, modifiers);
        this.dispatchNativeEvents();
        // Flush again after React state updates so hover styles are applied
        // and the Rust tree is current before any screenshot.
        this.native.flush();
    }
    /** End-to-end: simulate mouse down through GPUI hit testing →
     *  dispatch resulting events to React.
     *  @param button - 0=left (default), 1=middle, 2=right */
    nativeSimulateMouseDown(x, y, button, modifiers) {
        this.native.flush();
        this.native.simulateMouseDown(x, y, button ?? 0, modifiers);
        this.dispatchNativeEvents();
        this.native.flush();
    }
    /** End-to-end: simulate mouse up through GPUI hit testing →
     *  dispatch resulting events to React.
     *  @param button - 0=left (default), 1=middle, 2=right */
    nativeSimulateMouseUp(x, y, button, modifiers) {
        this.native.flush();
        this.native.simulateMouseUp(x, y, button ?? 0, modifiers);
        this.dispatchNativeEvents();
        this.native.flush();
    }
    // ── Tree inspection (queries Rust RetainedTree via napi) ────────
    /** Build a flat map of TestElements from the native tree JSON.
     *  One FFI call to get the full tree, then parse into TestElement objects. */
    buildElementMap() {
        const json = JSON.parse(this.native.getTreeJson());
        const map = new Map();
        const walk = (node, parentId) => {
            if (!node)
                return;
            map.set(node.id, {
                id: node.id,
                type: node.type,
                style: node.style ?? {},
                text: node.text ?? null,
                events: new Set(node.events ?? []),
                children: (node.children ?? []).map((c) => c.id),
                parentId,
                ...(node.testId ? { testId: node.testId } : {}),
                ...(node.customProps ? { customProps: node.customProps } : {}),
            });
            for (const child of node.children ?? []) {
                walk(child, node.id);
            }
        };
        walk(json, null);
        return map;
    }
    /** Get the root element. */
    getRoot() {
        const rootId = this.native.getRootId();
        if (rootId == null)
            return undefined;
        return this.buildElementMap().get(rootId);
    }
    /** Get an element by ID. */
    getElement(id) {
        return this.buildElementMap().get(id);
    }
    /** Find elements by type (e.g. "div", "text"). */
    findByType(type) {
        return [...this.buildElementMap().values()].filter((el) => el.type === type);
    }
    /** Find the first text element containing the given string. */
    findByText(text) {
        return [...this.buildElementMap().values()].find((el) => el.text != null && el.text.includes(text));
    }
    findByTestId(testId) {
        return [...this.buildElementMap().values()].find((el) => el.testId === testId);
    }
    /** Get all text content in the tree (depth-first). */
    getAllText() {
        return this.native.getAllText();
    }
    /** Print the tree structure for debugging. Only includes non-empty fields. */
    toJSON() {
        return JSON.parse(this.native.getTreeJson());
    }
    getAutomationTree() {
        return this.native.getAutomationTree();
    }
    /** Every element the native tree holds, reachable or not. `toJSON()` walks
     *  from the root, so only this can see a node that was detached and leaked. */
    getRetainedElementCount() {
        return this.native.getRetainedElementCount();
    }
    getElementBounds(elementId) {
        return this.native.getElementBounds(elementId);
    }
    clockPause() {
        return this.native.clockPause();
    }
    clockSet(nowMs) {
        return this.native.clockSet(nowMs);
    }
    clockFastForward(deltaMs) {
        return this.native.clockFastForward(deltaMs);
    }
    clockResume() {
        return this.native.clockResume();
    }
    focusElement(elementId) {
        this.native.flush();
        this.native.focusElement(elementId);
        this.dispatchNativeEvents();
    }
    /** The offscreen window size, so `useWindowSize()` works under test. */
    getWindowSize() {
        return this.native.getWindowSize();
    }
    // ── Scroll API ──────────────────────────────────────────────────
    /** Set the scroll offset of a scrollable element (overflow: "scroll").
     *  x and y are negative pixel values (scroll down = more negative y).
     *  Call flush() internally to apply. */
    scrollTo(elementId, x, y) {
        this.native.flush();
        this.native.scrollTo(elementId, x, y);
        // Flush again to re-render with the new offset
        this.native.flush();
    }
    /** Scroll a child into view by its index in the children list.
     *
     *  `offsetInItem` is in pixels. A negative value anchors the viewport top
     *  above the item, resolved against measured row heights at layout time, so
     *  a row stays pixel-stable while unmeasured rows are spliced in above it. */
    scrollToItem(elementId, index, offsetInItem) {
        this.native.flush();
        this.native.scrollToItem(elementId, index, offsetInItem);
        this.dispatchNativeEvents();
        this.native.flush();
    }
    /** Get the current scroll offset [x, y] or null if element is not scrollable. */
    getScrollOffset(elementId) {
        this.native.flush();
        const result = this.native.getScrollOffset(elementId);
        if (!result)
            return null;
        return [result[0], result[1]];
    }
    /** The logical scroll anchor of a `<virtual-list>`:
     *  `[itemIndex, offsetInItemPx, viewportHeightPx]`, or null for anything
     *  else. `itemIndex == item count` is gpui's at-end sentinel. Exact even
     *  while row heights are still estimates, because it is the anchor gpui
     *  itself scrolls by. */
    getListScrollTop(elementId) {
        this.native.flush();
        const result = this.native.getListScrollTop(elementId);
        if (!result)
            return null;
        return [result[0], result[1], result[2]];
    }
    // ── Selection API ───────────────────────────────────────────────
    /** Drag-select from (x1,y1) to (x2,y2) and return the selected text.
     *
     *  Selection listeners are registered during **paint**, so the native helper
     *  flushes between every step. Calling simulateMouseDown/Move/Up by hand
     *  without those flushes selects nothing. */
    dragSelect(x1, y1, x2, y2) {
        this.native.dragSelect(x1, y1, x2, y2);
        return this.native.getSelectedText();
    }
    /** The current selection joined in document order, or null. */
    getSelectedText() {
        return this.native.getSelectedText();
    }
    /** Every string painted in the last frame, in paint order.
     *
     *  `getAllText()` only sees `<text>` nodes in the retained tree. Native
     *  elements like `<code>` and `<diff>` paint their text inside GPUI, so this
     *  is the only way to assert on what they rendered. */
    getPaintedText() {
        return this.native.getPaintedText();
    }
    /** Every highlight wash painted in the last frame, in paint order.
     *
     *  A quad never lands in `getPaintedText()`, and a soft-wrapped match must
     *  draw one box per visual row, so each entry carries its `rects`. */
    getPaintedHighlights() {
        return this.native.getPaintedHighlights();
    }
    /** Syntax-cache counters as `[hits, misses, documents]`. */
    getSyntaxCacheStats() {
        const [hits, misses, documents] = this.native.getSyntaxCacheStats();
        return [hits, misses, documents];
    }
    clearSelection() {
        this.native.clearSelection();
        this.native.flush();
    }
    setDebugFrameOverlay(mode) {
        return this.native.setDebugFrameOverlay(mode);
    }
    getDebugFrameOverlay() {
        return this.native.getDebugFrameOverlay();
    }
    cycleDebugFrameOverlay() {
        return this.native.cycleDebugFrameOverlay();
    }
    resetDebugFrameOverlayStats() {
        this.native.resetDebugFrameOverlayStats();
    }
    getDebugFrameOverlayStats() {
        return this.native.getDebugFrameOverlayStats();
    }
    /** Capture the current Metal or DirectX frame and save it as a PNG. */
    captureScreenshot(path) {
        this.native.flush();
        this.native.captureScreenshot(path);
    }
    /** Whether the native GPUI test renderer is available. Always true. */
    get hasNative() {
        return true;
    }
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
export function createTestRoot(options = {}) {
    const renderer = new TestRenderer(options);
    const root = createRoot(renderer);
    const render = (node) => {
        flushSync(() => root.render(node));
        // Trigger GPUI rendering pipeline after the synchronous React commit.
        renderer.flush();
    };
    return {
        root,
        renderer,
        render,
        unmount: root.unmount,
    };
}
//# sourceMappingURL=testing.js.map