import { GpuixRenderer } from "@gpuix/native";
import { createRoot, flushSync } from "./reconciler.js";
import { handleGpuixEvent } from "./event-registry.js";
import { App as AutomationApp, browserRendererAsTest, InProcessBackend, liveRendererAsTest, serveAutomationStdio, } from "../automation/client.js";
export { createRoot, flushSync, reconciler } from "./reconciler.js";
export function createRenderer(onEvent) {
    const renderer = new GpuixRenderer((err, event) => {
        if (err) {
            console.error("[GPUIX] Native event error:", err);
            return;
        }
        if (event) {
            handleGpuixEvent(event, renderer);
            if (onEvent) {
                onEvent(event);
            }
        }
    });
    // A pipe means a controller owns stdin. A TTY is a human keyboard.
    if (typeof process !== "undefined" && process.stdin && !process.stdin.isTTY) {
        const init = renderer.init.bind(renderer);
        renderer.init = (options) => {
            init(options);
            enableAutomation(renderer);
        };
    }
    return renderer;
}
/** ~125fps. Above any common display refresh rate, so frames are never the
 *  bottleneck, while still leaving the Node event loop almost entirely idle. */
const DEFAULT_FRAME_MS = 8;
/**
 * Drive GPUI's embedded macOS event loop at a fixed rate.
 *
 * On Windows and Linux, GPUI owns a blocking event loop on a Rust UI thread,
 * so this function returns a no-op handle without creating a timer.
 *
 * On macOS, `renderer.tick()` pumps AppKit and asks GPUI for a frame, so it
 * must be called repeatedly. Do NOT call it from a `setImmediate` loop: that
 * spins the CPU at tens of thousands of ticks per second (measured: 73% CPU on
 * an idle app, versus 1.5% when paced).
 *
 * Pacing lives in JS rather than blocking inside `tick()` on purpose. Node owns
 * the event loop here, so a blocking tick would stall every timer, promise and
 * socket in the process.
 *
 * Each frame is scheduled only after the previous one finishes, so a slow frame
 * delays the next one instead of letting timers pile up.
 *
 * If `tick()` already used the whole budget, wait 0ms. A fixed 8ms sleep after a
 * 10ms frame would cap scroll at ~55fps on a 120Hz display.
 *
 * `tick()` returning false means the last window closed. The loop stops and
 * `onTerminated` runs. `render()` uses that to exit the process.
 */
export function enableAutomation(renderer) {
    serveAutomationStdio(new InProcessBackend(liveRendererAsTest(renderer)));
}
export function startFrameLoop(renderer, options = {}) {
    if (!renderer.requiresTick()) {
        return { stop: () => { } };
    }
    const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    let timer = null;
    let stopped = false;
    const stop = () => {
        stopped = true;
        if (timer !== null)
            clearTimeout(timer);
        timer = null;
    };
    const loop = () => {
        if (stopped)
            return;
        const started = performance.now();
        const running = renderer.tick();
        if (running === false) {
            stop();
            options.onTerminated?.();
            return;
        }
        const wait = Math.max(0, frameMs - (performance.now() - started));
        timer = setTimeout(loop, wait);
    };
    loop();
    return { stop };
}
const RENDER_HOST_KEY = "__gpuixRenderHost";
const BROWSER_AUTOMATION_KEY = "gpuix";
export function installBrowserAutomation(renderer) {
    const existing = Reflect.get(globalThis, BROWSER_AUTOMATION_KEY);
    if (existing instanceof AutomationApp)
        return existing;
    const automation = new AutomationApp(new InProcessBackend(browserRendererAsTest(renderer)));
    Reflect.set(globalThis, BROWSER_AUTOMATION_KEY, automation);
    return automation;
}
function renderSlot() {
    const existing = Reflect.get(globalThis, RENDER_HOST_KEY);
    if (existing) {
        return existing;
    }
    const created = {};
    Reflect.set(globalThis, RENDER_HOST_KEY, created);
    return created;
}
export function resetRender() {
    const slot = Reflect.get(globalThis, RENDER_HOST_KEY);
    slot?.loop?.stop();
    slot?.root?.unmount();
    const automation = Reflect.get(globalThis, BROWSER_AUTOMATION_KEY);
    void automation?.close();
    Reflect.deleteProperty(globalThis, BROWSER_AUTOMATION_KEY);
    Reflect.deleteProperty(globalThis, RENDER_HOST_KEY);
}
/** Mount the app. Under `bun --hot`, later calls remount on the same native window. */
export function render(node, options = {}) {
    const { onEvent, renderer: injected, debugFrameOverlay, ...windowOptions } = options;
    const slot = renderSlot();
    const remount = slot.root != null;
    if (!slot.renderer) {
        if (injected) {
            slot.renderer = injected;
        }
        else {
            const renderer = createRenderer(onEvent);
            renderer.init(windowOptions);
            slot.renderer = renderer;
            console.log("[gpuix] created native window");
        }
    }
    const host = slot.renderer;
    if (!host) {
        throw new Error("GPUIX renderer is not initialized");
    }
    if (typeof window !== "undefined" &&
        host instanceof GpuixRenderer &&
        !Reflect.has(globalThis, BROWSER_AUTOMATION_KEY)) {
        installBrowserAutomation(host);
    }
    if (debugFrameOverlay) {
        host.setDebugFrameOverlay?.(debugFrameOverlay);
    }
    if (slot.root) {
        console.log("[gpuix] remount: unmount previous tree");
        slot.root.unmount();
    }
    const root = createRoot(host);
    slot.root = root;
    flushSync(() => {
        root.render(node);
    });
    if (!injected && slot.renderer instanceof GpuixRenderer) {
        const native = slot.renderer;
        slot.loop?.stop();
        slot.loop = startFrameLoop(native, {
            onTerminated: () => {
                process.exit(0);
            },
        });
    }
    console.log(remount ? "[gpuix] remount complete" : "[gpuix] mount complete");
    return root;
}
//# sourceMappingURL=renderer.js.map