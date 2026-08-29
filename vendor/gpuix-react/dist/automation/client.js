/// Playwright-like automation client for GPUIX.
///
/// In-process tests talk to TestRenderer through the same typed method catalog
/// as a live app on SSE stdin/stdout. Locators query the retained tree.
import { AutomationError, createSseDecoder, encodeSse, methods, parseResponse, parseWireMessage, PROTOCOL_VERSION, } from "./protocol.js";
function importNodeModule(specifier) {
    return import(specifier);
}
class ValidatedAutomationBackend {
    closed = false;
    async call(method, params) {
        if (this.closed) {
            throw new AutomationError("Closed", "Automation session is closed");
        }
        const parsedParams = methods[method].params.parse(params);
        const result = await this.request(method, parsedParams);
        return methods[method].result.parse(result);
    }
    closeSession() {
        if (this.closed)
            return false;
        this.closed = true;
        return true;
    }
}
export class InProcessBackend extends ValidatedAutomationBackend {
    renderer;
    constructor(renderer) {
        super();
        this.renderer = renderer;
    }
    request(method, params) {
        return this.handlers[method](params);
    }
    async close() {
        this.closeSession();
    }
    handlers = {
        initialize: () => ({
            protocolVersion: PROTOCOL_VERSION,
            pid: typeof process === "undefined" ? 0 : process.pid,
            capabilities: typeof window !== "undefined"
                ? ["input", "clock", "tree"]
                : ["input", "screenshot", "clock", "tree"],
            window: (() => {
                return {
                    width: typeof window === "undefined" ? 800 : window.innerWidth,
                    height: typeof window === "undefined" ? 600 : window.innerHeight,
                };
            })(),
        }),
        cancel: () => ({ ok: true }),
        click: (params) => {
            this.renderer.nativeSimulateClick(params.x, params.y, params.button, params.modifiers);
            return { ok: true };
        },
        mouseDown: (params) => {
            this.renderer.nativeSimulateMouseDown(params.x, params.y, params.button, params.modifiers);
            return { ok: true };
        },
        mouseUp: (params) => {
            this.renderer.nativeSimulateMouseUp(params.x, params.y, params.button, params.modifiers);
            return { ok: true };
        },
        mouseMove: (params) => {
            this.renderer.nativeSimulateMouseMove(params.x, params.y, params.pressedButton, params.modifiers);
            return { ok: true };
        },
        scrollWheel: (params) => {
            this.renderer.nativeSimulateScrollWheel(params.x, params.y, params.deltaX, params.deltaY, params.modifiers);
            return { ok: true };
        },
        keystrokes: (params) => {
            if (params.elementId == null) {
                this.renderer.simulateKeystrokes(params.keys);
            }
            else {
                this.renderer.nativeSimulateKeystrokes(params.elementId, params.keys);
            }
            return { ok: true };
        },
        keyDown: (params) => {
            this.renderer.nativeSimulateKeyDown(params.elementId ?? 0, params.key, params.isHeld);
            return { ok: true };
        },
        keyUp: (params) => {
            this.renderer.nativeSimulateKeyUp(params.elementId ?? 0, params.key);
            return { ok: true };
        },
        focus: (params) => {
            this.renderer.focusElement?.(params.elementId);
            return { ok: true };
        },
        blur: () => {
            this.renderer.blur?.();
            return { ok: true };
        },
        scrollTo: (params) => {
            this.renderer.scrollTo(params.elementId, params.x, params.y);
            return { ok: true };
        },
        getScrollOffset: (params) => ({
            offset: this.renderer.getScrollOffset(params.elementId),
        }),
        getTree: () => {
            const raw = JSON.parse(this.renderer.getAutomationTree());
            return { tree: raw === null ? null : raw };
        },
        getPaintedText: () => ({ text: this.renderer.getPaintedText() }),
        getAllText: () => ({ text: this.renderer.getAllText() }),
        getBounds: (params) => {
            const rect = this.renderer.getElementBounds(params.elementId);
            if (!rect)
                return { bounds: null };
            return {
                bounds: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] },
            };
        },
        getSelectedText: () => ({ text: this.renderer.getSelectedText() }),
        clearSelection: () => {
            this.renderer.clearSelection();
            return { ok: true };
        },
        screenshot: (params) => {
            this.renderer.captureScreenshot(params.path);
            return { path: params.path };
        },
        clockPause: () => ({ nowMs: this.renderer.clockPause() }),
        clockSet: (params) => ({ nowMs: this.renderer.clockSet(params.nowMs) }),
        clockFastForward: (params) => ({
            nowMs: this.renderer.clockFastForward(params.deltaMs),
        }),
        clockResume: () => ({ nowMs: this.renderer.clockResume() }),
    };
}
class PendingAutomationResponse {
    promise;
    resolve;
    reject;
    constructor() {
        let resolveResponse;
        let rejectResponse;
        this.promise = new Promise((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;
        });
        this.resolve = resolveResponse;
        this.reject = rejectResponse;
    }
}
export class SseBackend extends ValidatedAutomationBackend {
    write;
    onClose;
    nextId = 1;
    pending = new Map();
    constructor(write, feed, onClose) {
        super();
        this.write = write;
        this.onClose = onClose;
        const decoder = createSseDecoder((message) => {
            if ("method" in message)
                return;
            if ("event" in message)
                return;
            const waiter = this.pending.get(message.id);
            if (!waiter)
                return;
            this.pending.delete(message.id);
            waiter.resolve(message);
        });
        feed((chunk) => decoder.feed(chunk));
    }
    async request(method, params) {
        const id = this.nextId++;
        const request = { id, method, params };
        const pending = new PendingAutomationResponse();
        this.pending.set(id, pending);
        try {
            this.write(encodeSse(request));
        }
        catch (error) {
            this.pending.delete(id);
            pending.reject(error);
        }
        const response = await pending.promise;
        if ("error" in response) {
            throw new AutomationError(response.error.code, response.error.message, response.error.data);
        }
        return response.result;
    }
    async close() {
        if (!this.closeSession())
            return;
        for (const [id, waiter] of this.pending) {
            waiter.reject(new AutomationError("Closed", `Request ${id} cancelled`));
        }
        this.pending.clear();
        await this.onClose?.();
    }
}
function toKeystrokes(text) {
    return [...text]
        .map((ch) => {
        if (ch === " ")
            return "space";
        if (ch === "\n")
            return "enter";
        if (ch === "\t")
            return "tab";
        return ch;
    })
        .join(" ");
}
function matches(node, selector) {
    if (selector.testId != null && node.testId !== selector.testId)
        return false;
    if (selector.type != null && node.type !== selector.type)
        return false;
    if (selector.text != null && !(node.text ?? "").includes(selector.text)) {
        return false;
    }
    return true;
}
function collect(node, selector) {
    if (!node)
        return [];
    const roots = selector.parent
        ? collect(node, selector.parent)
        : [node];
    const found = [];
    const walk = (current) => {
        if (matches(current, selector))
            found.push(current);
        for (const child of current.children ?? [])
            walk(child);
    };
    for (const root of roots) {
        if (selector.parent) {
            for (const child of root.children ?? [])
                walk(child);
        }
        else {
            walk(root);
        }
    }
    return found;
}
function centerOf(bounds) {
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
function collectText(node) {
    let text = node.text ?? "";
    for (const child of node.children ?? [])
        text += collectText(child);
    return text;
}
export class Locator {
    app;
    selector;
    constructor(app, selector) {
        this.app = app;
        this.selector = selector;
    }
    getByTestId(testId) {
        return new Locator(this.app, { testId, parent: this.selector });
    }
    getByText(text) {
        return new Locator(this.app, { text, parent: this.selector });
    }
    getByType(type) {
        return new Locator(this.app, { type, parent: this.selector });
    }
    async all() {
        const { tree } = await this.app.call("getTree", {});
        return collect(tree, this.selector);
    }
    async count() {
        return (await this.all()).length;
    }
    async element() {
        const found = await this.all();
        if (found.length === 0) {
            throw new AutomationError("NotFound", "Locator did not match any element");
        }
        if (found.length > 1) {
            throw new AutomationError("Ambiguous", `Locator matched ${found.length} elements`);
        }
        return found[0];
    }
    async bounds() {
        const node = await this.element();
        if (node.bounds)
            return node.bounds;
        const { bounds } = await this.app.call("getBounds", { elementId: node.id });
        if (!bounds) {
            throw new AutomationError("NotFound", "Element has no painted bounds");
        }
        return bounds;
    }
    /** The centre of the last painted bounds, in window coordinates. */
    async center() {
        return centerOf(await this.bounds());
    }
    async click(options = {}) {
        const point = await this.center();
        await this.app.call("click", { ...point, ...options });
    }
    /** Move the pointer to the centre, so hover styles and tooltips fire. */
    async hover(options = {}) {
        await this.app.mouse.move(await this.center(), options);
    }
    /** Send one wheel event over the centre of this element. */
    async wheel(deltaX, deltaY, options = {}) {
        await this.app.mouse.wheel(await this.center(), deltaX, deltaY, options);
    }
    /** Press on this element, travel to `target`, release there. */
    async dragTo(target, options = {}) {
        await this.app.mouse.drag(this, target, options);
    }
    /** Press on this element and release `dx`/`dy` pixels away. */
    async dragBy(dx, dy, options = {}) {
        const start = await this.center();
        const offset = options.offset ?? { x: 0, y: 0 };
        await this.app.mouse.drag(this, { x: start.x + offset.x + dx, y: start.y + offset.y + dy }, options);
    }
    async fill(text) {
        const node = await this.element();
        const browserPlatform = typeof navigator === "undefined" ? "" : navigator.platform;
        const selectAll = browserPlatform.includes("Mac") ||
            (typeof process !== "undefined" && process.platform === "darwin")
            ? "cmd-a"
            : "ctrl-a";
        const replacement = text.length === 0 ? "backspace" : toKeystrokes(text);
        await this.app.call("keystrokes", {
            elementId: node.id,
            keys: `${selectAll} ${replacement}`,
        });
    }
    async press(key) {
        const node = await this.element();
        await this.app.call("keystrokes", {
            elementId: node.id,
            keys: key,
        });
    }
    /**
     * Own text plus every descendant's, concatenated in document order, like
     * DOM `textContent`. `<text>{value}</text>` puts the string on a child node,
     * so reading only `node.text` returned an empty string for every wrapper.
     */
    async textContent() {
        return collectText(await this.element());
    }
    async waitFor(options = {}) {
        const timeoutMs = options.timeoutMs ?? 5000;
        const started = Date.now();
        for (;;) {
            const found = await this.all();
            if (found.length === 1)
                return found[0];
            if (Date.now() - started >= timeoutMs) {
                throw new AutomationError(found.length === 0 ? "Timeout" : "Ambiguous", `waitFor timed out after ${timeoutMs}ms`);
            }
            await new Promise((resolve) => setTimeout(resolve, 16));
        }
    }
}
export class App {
    backend;
    clock;
    /**
     * Raw pointer input in window coordinates. Prefer a locator when the target
     * is an element; use this for empty space, marquee selection, and gestures
     * that end outside every hitbox.
     */
    mouse;
    constructor(backend) {
        this.backend = backend;
        this.mouse = {
            move: async (target, options = {}) => {
                const point = await this.resolvePoint(target);
                await this.call("mouseMove", {
                    ...point,
                    pressedButton: options.pressedButton,
                    modifiers: options.modifiers,
                });
            },
            down: async (target, options = {}) => {
                const point = await this.resolvePoint(target);
                await this.call("mouseDown", { ...point, ...options });
            },
            up: async (target, options = {}) => {
                const point = await this.resolvePoint(target);
                await this.call("mouseUp", { ...point, ...options });
            },
            click: async (target, options = {}) => {
                const point = await this.resolvePoint(target);
                await this.call("click", { ...point, ...options });
            },
            wheel: async (target, deltaX, deltaY, options = {}) => {
                const point = await this.resolvePoint(target);
                await this.call("scrollWheel", {
                    ...point,
                    deltaX,
                    deltaY,
                    modifiers: options.modifiers,
                });
            },
            drag: async (from, to, options = {}) => {
                const offset = options.offset ?? { x: 0, y: 0 };
                const origin = await this.resolvePoint(from);
                const start = { x: origin.x + offset.x, y: origin.y + offset.y };
                // Resolve the destination before the press. A locator target can move
                // under a live preview, and the caller means where it is now.
                const end = await this.resolvePoint(to);
                const button = options.button ?? 0;
                const modifiers = options.modifiers;
                const steps = Math.max(1, Math.floor(options.steps ?? 8));
                await this.call("mouseMove", { ...start, modifiers });
                await this.call("mouseDown", { ...start, button, modifiers });
                for (let step = 1; step <= steps; step += 1) {
                    const t = step / steps;
                    await this.call("mouseMove", {
                        x: start.x + (end.x - start.x) * t,
                        y: start.y + (end.y - start.y) * t,
                        pressedButton: button,
                        modifiers,
                    });
                }
                await this.call("mouseUp", { ...end, button, modifiers });
            },
        };
        this.clock = {
            pause: async () => (await this.call("clockPause", {})).nowMs,
            set: async (nowMs) => (await this.call("clockSet", { nowMs })).nowMs,
            fastForward: async (deltaMs) => (await this.call("clockFastForward", { deltaMs })).nowMs,
            resume: async () => (await this.call("clockResume", {})).nowMs,
        };
    }
    call(method, params) {
        return this.backend.call(method, params);
    }
    async resolvePoint(target) {
        return target instanceof Locator ? target.center() : target;
    }
    getByTestId(testId) {
        return new Locator(this, { testId });
    }
    getByText(text) {
        return new Locator(this, { text });
    }
    getByType(type) {
        return new Locator(this, { type });
    }
    async screenshot(options) {
        const { path: saved } = await this.call("screenshot", { path: options.path });
        return saved;
    }
    async captureFrames(dir, timesMs) {
        if (typeof process === "undefined") {
            throw new AutomationError("Unsupported", "Browser frame capture must use the controlling browser automation client");
        }
        const { mkdir } = await importNodeModule("node:fs/promises");
        const path = await importNodeModule("node:path");
        await mkdir(dir, { recursive: true });
        await this.clock.pause();
        const paths = [];
        for (const nowMs of timesMs) {
            await this.clock.set(nowMs);
            const file = path.join(dir, `t${nowMs}.png`);
            await this.screenshot({ path: file });
            paths.push(file);
        }
        return paths;
    }
    async close() {
        await this.backend.close();
    }
}
export function liveRendererAsTest(renderer) {
    const afterInput = () => {
        renderer.tick?.();
    };
    return {
        nativeSimulateClick(x, y, button, modifiers) {
            renderer.simulateClick(x, y, button, modifiers);
            afterInput();
        },
        nativeSimulateMouseDown(x, y, button, modifiers) {
            renderer.simulateMouseDown(x, y, button, modifiers);
            afterInput();
        },
        nativeSimulateMouseUp(x, y, button, modifiers) {
            renderer.simulateMouseUp(x, y, button, modifiers);
            afterInput();
        },
        nativeSimulateMouseMove(x, y, pressedButton, modifiers) {
            renderer.simulateMouseMove(x, y, pressedButton, modifiers);
            afterInput();
        },
        nativeSimulateScrollWheel(x, y, deltaX, deltaY, modifiers) {
            renderer.simulateScrollWheel(x, y, deltaX, deltaY, modifiers);
            afterInput();
        },
        simulateKeystrokes(keys) {
            if (!renderer.simulateKeystrokes) {
                throw new AutomationError("Unsupported", "keystrokes are not live yet");
            }
            renderer.simulateKeystrokes(keys);
            afterInput();
        },
        nativeSimulateKeystrokes(elementId, keys) {
            if (!renderer.simulateKeystrokes) {
                throw new AutomationError("Unsupported", "keystrokes are not live yet");
            }
            renderer.focusElement(elementId);
            renderer.simulateKeystrokes(keys);
            afterInput();
        },
        nativeSimulateKeyDown(elementId, key, isHeld) {
            if (!renderer.simulateKeyDown) {
                throw new AutomationError("Unsupported", "keyDown is not live yet");
            }
            if (elementId > 0)
                renderer.focusElement(elementId);
            renderer.simulateKeyDown(key, isHeld);
            afterInput();
        },
        nativeSimulateKeyUp(elementId, key) {
            if (!renderer.simulateKeyUp) {
                throw new AutomationError("Unsupported", "keyUp is not live yet");
            }
            if (elementId > 0)
                renderer.focusElement(elementId);
            renderer.simulateKeyUp(key);
            afterInput();
        },
        scrollTo: (id, x, y) => renderer.scrollTo(id, x, y),
        getScrollOffset: (id) => {
            const offset = renderer.getScrollOffset(id);
            return offset ? [offset[0], offset[1]] : null;
        },
        getAllText: () => renderer.getAllText(),
        getPaintedText: () => renderer.getPaintedText(),
        getSelectedText: () => renderer.getSelectedText(),
        clearSelection: () => renderer.clearSelection(),
        captureScreenshot(file) {
            if (!renderer.captureScreenshot) {
                throw new AutomationError("Unsupported", "Browser screenshots must use the controlling browser automation client");
            }
            renderer.captureScreenshot(file);
        },
        getAutomationTree: () => renderer.getAutomationTree(),
        getElementBounds: (id) => renderer.getElementBounds(id),
        clockPause: () => renderer.clockPause(),
        clockSet: (nowMs) => renderer.clockSet(nowMs),
        clockFastForward: (deltaMs) => renderer.clockFastForward(deltaMs),
        clockResume: () => renderer.clockResume(),
        focusElement: (id) => renderer.focusElement(id),
        blur: () => renderer.blur(),
    };
}
export function browserKeystrokeInit(keystroke, isHeld = false) {
    const parts = keystroke.split("-");
    const modifiers = new Set();
    while (parts.length > 1) {
        const modifier = parts[0].toLowerCase();
        if (!["alt", "cmd", "ctrl", "meta", "shift"].includes(modifier))
            break;
        modifiers.add(modifier);
        parts.shift();
    }
    const keyName = parts.join("-");
    const key = {
        backspace: "Backspace",
        delete: "Delete",
        down: "ArrowDown",
        enter: "Enter",
        escape: "Escape",
        left: "ArrowLeft",
        right: "ArrowRight",
        space: " ",
        tab: "Tab",
        up: "ArrowUp",
    }[keyName.toLowerCase()] ?? keyName;
    return {
        key,
        altKey: modifiers.has("alt"),
        bubbles: true,
        ctrlKey: modifiers.has("ctrl"),
        metaKey: modifiers.has("cmd") || modifiers.has("meta"),
        repeat: isHeld,
        shiftKey: modifiers.has("shift"),
    };
}
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
export const IME_MIRROR_SELECTOR = "[data-gpui-input]";
function dispatchBrowserKeystroke({ keystroke, type, isHeld = false, }) {
    const mirror = document.querySelector(IME_MIRROR_SELECTOR);
    if (!mirror) {
        throw new AutomationError("Unsupported", `No GPUI keyboard target: nothing matches "${IME_MIRROR_SELECTOR}". ` +
            "Call this only after render() has painted a frame in a browser page.");
    }
    mirror.dispatchEvent(new KeyboardEvent(type, browserKeystrokeInit(keystroke, isHeld)));
}
export function browserRendererAsTest(renderer) {
    const live = liveRendererAsTest(renderer);
    const keystrokes = (keys) => {
        for (const key of keys.split(/\s+/).filter(Boolean)) {
            dispatchBrowserKeystroke({ keystroke: key, type: "keydown" });
            dispatchBrowserKeystroke({ keystroke: key, type: "keyup" });
        }
    };
    return {
        ...live,
        simulateKeystrokes: keystrokes,
        nativeSimulateKeystrokes(elementId, keys) {
            renderer.focusElement(elementId);
            keystrokes(keys);
        },
        nativeSimulateKeyDown(elementId, key, isHeld) {
            if (elementId > 0)
                renderer.focusElement(elementId);
            dispatchBrowserKeystroke({ keystroke: key, type: "keydown", isHeld });
        },
        nativeSimulateKeyUp(elementId, key) {
            if (elementId > 0)
                renderer.focusElement(elementId);
            dispatchBrowserKeystroke({ keystroke: key, type: "keyup" });
        },
    };
}
export async function connectTest(renderer) {
    const app = new App(new InProcessBackend(renderer));
    await app.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        client: "@gpuix/react/automation",
    });
    return app;
}
export async function connectStdio(options) {
    const app = new App(new SseBackend(options.write, options.feed, options.close));
    await app.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        client: "@gpuix/react/automation",
    });
    return app;
}
export async function launch(options) {
    const { spawn } = await importNodeModule("node:child_process");
    const child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: {
            ...process.env,
            ...options.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const app = await connectStdio({
        write: (chunk) => {
            child.stdin.write(chunk);
        },
        feed: (listener) => {
            child.stdout.on("data", (buf) => listener(buf.toString("utf8")));
        },
        close: async () => {
            child.kill();
        },
    });
    return app;
}
export function handleAutomationRequest(raw, backend) {
    const request = parseWireMessage(raw);
    if (!("method" in request)) {
        throw new AutomationError("Protocol", "Server expected a request");
    }
    return backend.call(request.method, request.params).then((result) => encodeSse({ id: request.id, result }), (error) => {
        const failure = error instanceof AutomationError
            ? error
            : new AutomationError("Protocol", String(error));
        return encodeSse({
            id: request.id,
            error: {
                code: failure.code,
                message: failure.message,
                data: failure.data,
            },
        });
    });
}
export function serveAutomationStdio(backend) {
    const decoder = createSseDecoder((message) => {
        if (!("method" in message))
            return;
        void handleAutomationRequest(message, backend).then((reply) => {
            process.stdout.write(reply);
        });
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        decoder.feed(chunk);
    });
}
export function isServerEvent(message) {
    return (typeof message === "object" &&
        message !== null &&
        "event" in message &&
        !("method" in message));
}
//# sourceMappingURL=client.js.map