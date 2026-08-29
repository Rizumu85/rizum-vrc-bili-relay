import { type AutomationServerEvent, type ElementBounds, type MethodName, type ParamsOf, type ResultOf, type TreeNode } from "./protocol.js";
export interface AutomationBackend {
    call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
    close(): Promise<void>;
}
declare abstract class ValidatedAutomationBackend implements AutomationBackend {
    private closed;
    call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
    protected closeSession(): boolean;
    protected abstract request<M extends MethodName>(method: M, params: ParamsOf<M>): unknown | Promise<unknown>;
    abstract close(): Promise<void>;
}
export interface TestAutomationRenderer {
    nativeSimulateClick(x: number, y: number, button?: number, modifiers?: string): void;
    nativeSimulateMouseDown(x: number, y: number, button?: number, modifiers?: string): void;
    nativeSimulateMouseUp(x: number, y: number, button?: number, modifiers?: string): void;
    nativeSimulateMouseMove(x: number, y: number, pressedButton?: number, modifiers?: string): void;
    nativeSimulateScrollWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): void;
    simulateKeystrokes(keystrokes: string): void;
    nativeSimulateKeystrokes(elementId: number, keystrokes: string): void;
    nativeSimulateKeyDown(elementId: number, keystroke: string, isHeld?: boolean): void;
    nativeSimulateKeyUp(elementId: number, keystroke: string): void;
    scrollTo(elementId: number, x: number, y: number): void;
    getScrollOffset(elementId: number): [number, number] | null;
    getAllText(): string[];
    getPaintedText(): string[];
    getSelectedText(): string | null;
    clearSelection(): void;
    captureScreenshot(path: string): void;
    getAutomationTree(): string;
    getElementBounds(elementId: number): number[] | null;
    clockPause(): number;
    clockSet(nowMs: number): number;
    clockFastForward(deltaMs: number): number;
    clockResume(): number;
    focusElement?(elementId: number): void;
    blur?(): void;
}
export declare class InProcessBackend extends ValidatedAutomationBackend {
    private readonly renderer;
    constructor(renderer: TestAutomationRenderer);
    protected request<M extends MethodName>(method: M, params: ParamsOf<M>): unknown | Promise<unknown>;
    close(): Promise<void>;
    private readonly handlers;
}
export declare class SseBackend extends ValidatedAutomationBackend {
    private readonly write;
    private readonly onClose?;
    private nextId;
    private readonly pending;
    constructor(write: (chunk: string) => void, feed: (listener: (chunk: string) => void) => void, onClose?: (() => Promise<void>) | undefined);
    protected request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<unknown>;
    close(): Promise<void>;
}
interface Selector {
    testId?: string;
    text?: string;
    type?: string;
    parent?: Selector;
}
/** A window-space point, or a locator resolved to the centre of its bounds. */
export type PointTarget = {
    x: number;
    y: number;
} | Locator;
export interface MouseOptions {
    /** 0 = left (default), 1 = middle, 2 = right. */
    button?: number;
    /** Held modifiers in `press()` syntax: `"cmd"`, `"cmd-shift"`, `"alt"`. */
    modifiers?: string;
}
export interface DragOptions extends MouseOptions {
    /**
     * Move events sent between the press and the release. Default 8.
     *
     * One jump would test nothing that matters: snapping, live previews and
     * per-move commits only appear when the pointer actually travels.
     */
    steps?: number;
    /** Pixels from the source centre where the press lands. */
    offset?: {
        x: number;
        y: number;
    };
}
export declare class Locator {
    private readonly app;
    private readonly selector;
    constructor(app: App, selector: Selector);
    getByTestId(testId: string): Locator;
    getByText(text: string): Locator;
    getByType(type: string): Locator;
    all(): Promise<TreeNode[]>;
    count(): Promise<number>;
    element(): Promise<TreeNode>;
    bounds(): Promise<ElementBounds>;
    /** The centre of the last painted bounds, in window coordinates. */
    center(): Promise<{
        x: number;
        y: number;
    }>;
    click(options?: MouseOptions): Promise<void>;
    /** Move the pointer to the centre, so hover styles and tooltips fire. */
    hover(options?: MouseOptions): Promise<void>;
    /** Send one wheel event over the centre of this element. */
    wheel(deltaX: number, deltaY: number, options?: MouseOptions): Promise<void>;
    /** Press on this element, travel to `target`, release there. */
    dragTo(target: PointTarget, options?: DragOptions): Promise<void>;
    /** Press on this element and release `dx`/`dy` pixels away. */
    dragBy(dx: number, dy: number, options?: DragOptions): Promise<void>;
    fill(text: string): Promise<void>;
    press(key: string): Promise<void>;
    /**
     * Own text plus every descendant's, concatenated in document order, like
     * DOM `textContent`. `<text>{value}</text>` puts the string on a child node,
     * so reading only `node.text` returned an empty string for every wrapper.
     */
    textContent(): Promise<string>;
    waitFor(options?: {
        timeoutMs?: number;
    }): Promise<TreeNode>;
}
export declare class App {
    private readonly backend;
    readonly clock: {
        pause: () => Promise<number>;
        set: (nowMs: number) => Promise<number>;
        fastForward: (deltaMs: number) => Promise<number>;
        resume: () => Promise<number>;
    };
    /**
     * Raw pointer input in window coordinates. Prefer a locator when the target
     * is an element; use this for empty space, marquee selection, and gestures
     * that end outside every hitbox.
     */
    readonly mouse: {
        move: (target: PointTarget, options?: MouseOptions & {
            pressedButton?: number;
        }) => Promise<void>;
        down: (target: PointTarget, options?: MouseOptions) => Promise<void>;
        up: (target: PointTarget, options?: MouseOptions) => Promise<void>;
        click: (target: PointTarget, options?: MouseOptions) => Promise<void>;
        wheel: (target: PointTarget, deltaX: number, deltaY: number, options?: MouseOptions) => Promise<void>;
        drag: (from: PointTarget, to: PointTarget, options?: DragOptions) => Promise<void>;
    };
    constructor(backend: AutomationBackend);
    call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
    private resolvePoint;
    getByTestId(testId: string): Locator;
    getByText(text: string): Locator;
    getByType(type: string): Locator;
    screenshot(options: {
        path: string;
    }): Promise<string>;
    captureFrames(dir: string, timesMs: readonly number[]): Promise<string[]>;
    close(): Promise<void>;
}
export interface LiveAutomationRenderer {
    simulateClick(x: number, y: number, button?: number, modifiers?: string): void;
    simulateMouseDown(x: number, y: number, button?: number, modifiers?: string): void;
    simulateMouseUp(x: number, y: number, button?: number, modifiers?: string): void;
    simulateMouseMove(x: number, y: number, pressedButton?: number, modifiers?: string): void;
    simulateScrollWheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): void;
    simulateKeystrokes?(keystrokes: string): void;
    simulateKeyDown?(keystroke: string, isHeld?: boolean): void;
    simulateKeyUp?(keystroke: string): void;
    tick?(): void;
    focusElement(elementId: number): void;
    blur(): void;
    scrollTo(elementId: number, x: number, y: number): void;
    getScrollOffset(elementId: number): number[] | null;
    getAllText(): string[];
    getPaintedText(): string[];
    getSelectedText(): string | null;
    clearSelection(): void;
    captureScreenshot?(path: string): void;
    getAutomationTree(): string;
    getElementBounds(elementId: number): number[] | null;
    clockPause(): number;
    clockSet(nowMs: number): number;
    clockFastForward(deltaMs: number): number;
    clockResume(): number;
}
export declare function liveRendererAsTest(renderer: LiveAutomationRenderer): TestAutomationRenderer;
export declare function browserKeystrokeInit(keystroke: string, isHeld?: boolean): KeyboardEventInit;
/**
 * The hidden element GPUI's browser platform appends to `<body>`.
 *
 * A GPUI web app has two event surfaces: the `<canvas>` takes pointer events,
 * and this element takes **every keyboard and IME event**. `gpui_web` attaches
 * its `keydown` / `keyup` listeners here, not to the window or the canvas, so
 * dispatching a synthetic `KeyboardEvent` at this element is the only way to
 * type into a browser GPUIX app.
 *
 * Match on the attribute alone. The element used to be an `<input>` and is now
 * a `<textarea>`, because a single-line input strips newlines from an assigned
 * value and would desynchronise the mirror from the document. See
 * zed-industries/zed#63201 and `gpui_web/src/ime_mirror.rs`. A tag-qualified
 * selector silently turns every keystroke into an "unavailable" error.
 */
export declare const IME_MIRROR_SELECTOR = "[data-gpui-input]";
export declare function browserRendererAsTest(renderer: LiveAutomationRenderer): TestAutomationRenderer;
export declare function connectTest(renderer: TestAutomationRenderer): Promise<App>;
export declare function connectStdio(options: {
    write: (chunk: string) => void;
    feed: (listener: (chunk: string) => void) => void;
    close?: () => Promise<void>;
}): Promise<App>;
export declare function launch(options: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<App>;
export declare function handleAutomationRequest(raw: unknown, backend: AutomationBackend): Promise<string>;
export declare function serveAutomationStdio(backend: AutomationBackend): void;
export declare function isServerEvent(message: unknown): message is AutomationServerEvent;
export {};
//# sourceMappingURL=client.d.ts.map