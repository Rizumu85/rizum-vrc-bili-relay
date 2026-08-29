import type { ReactNode } from "react";
import { GpuixRenderer } from "@gpuix/native";
import type { EventPayload, WindowOptions } from "@gpuix/native";
import { type Root } from "./reconciler.js";
import type { DebugFrameOverlayMode, NativeRenderer } from "../types/host.js";
import { App as AutomationApp, type LiveAutomationRenderer } from "../automation/client.js";
export { createRoot, flushSync, reconciler } from "./reconciler.js";
export type { Root } from "./reconciler.js";
export declare function createRenderer(onEvent?: (event: import("@gpuix/native").EventPayload) => void): GpuixRenderer;
export interface FrameLoop {
    stop: () => void;
}
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
export declare function enableAutomation(renderer: LiveAutomationRenderer): void;
export declare function startFrameLoop(renderer: Pick<GpuixRenderer, "requiresTick" | "tick">, options?: {
    frameMs?: number;
    onTerminated?: () => void;
}): FrameLoop;
declare global {
    var gpuix: AutomationApp | undefined;
}
export declare function installBrowserAutomation(renderer: LiveAutomationRenderer): AutomationApp;
export interface RenderOptions extends WindowOptions {
    onEvent?: (event: EventPayload) => void;
    renderer?: NativeRenderer;
    /** GPUI scene overlay. Does not go through React or layout. */
    debugFrameOverlay?: DebugFrameOverlayMode;
}
export declare function resetRender(): void;
/** Mount the app. Under `bun --hot`, later calls remount on the same native window. */
export declare function render(node: ReactNode, options?: RenderOptions): Root;
//# sourceMappingURL=renderer.d.ts.map