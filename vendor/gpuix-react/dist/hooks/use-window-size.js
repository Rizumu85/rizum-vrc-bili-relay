import { useState, useEffect } from "react";
import { useGpuix } from "./use-gpuix.js";
/** Fallback until the window answers. Only used if the renderer has no size yet. */
const DEFAULT_WINDOW_SIZE = { width: 800, height: 600 };
function readWindowSize(renderer) {
    try {
        const size = renderer?.getWindowSize?.();
        if (size && size.width > 0 && size.height > 0) {
            return { width: size.width, height: size.height };
        }
    }
    catch {
        // Renderer window is still opening.
    }
    return DEFAULT_WINDOW_SIZE;
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
export function useWindowSize(options = {}) {
    const { renderer } = useGpuix();
    const [size, setSize] = useState(() => readWindowSize(renderer));
    const intervalMs = options.intervalMs ?? 100;
    useEffect(() => {
        const update = () => {
            const next = readWindowSize(renderer);
            setSize((current) => current.width === next.width && current.height === next.height ? current : next);
        };
        update();
        if (intervalMs === false)
            return;
        const timer = setInterval(update, Math.max(16, intervalMs));
        return () => clearInterval(timer);
    }, [renderer, intervalMs]);
    return size;
}
const ZERO_EDGES = { top: 0, right: 0, bottom: 0, left: 0 };
function readWindowInsets(renderer) {
    let size = { width: 800, height: 600 };
    let insets = {
        safeArea: ZERO_EDGES,
        ime: ZERO_EDGES,
        effective: ZERO_EDGES,
    };
    try {
        size = renderer?.getWindowSize?.() ?? size;
        insets = renderer?.getWindowInsets?.() ?? insets;
    }
    catch {
        // Renderer window is still opening.
    }
    return {
        ...insets,
        keyboardTop: size.height - insets.ime.bottom,
        keyboardVisible: insets.ime.bottom > 0,
        visibleHeight: size.height - insets.effective.top - insets.effective.bottom,
    };
}
function sameWindowInsets(a, b) {
    return (a.keyboardTop === b.keyboardTop &&
        a.keyboardVisible === b.keyboardVisible &&
        a.visibleHeight === b.visibleHeight &&
        a.safeArea.top === b.safeArea.top &&
        a.safeArea.right === b.safeArea.right &&
        a.safeArea.bottom === b.safeArea.bottom &&
        a.safeArea.left === b.safeArea.left &&
        a.ime.top === b.ime.top &&
        a.ime.right === b.ime.right &&
        a.ime.bottom === b.ime.bottom &&
        a.ime.left === b.ime.left);
}
/** Get safe-area and keyboard geometry, sampled every 100ms by default. */
export function useWindowInsets(options = {}) {
    const { renderer } = useGpuix();
    const [insets, setInsets] = useState(() => readWindowInsets(renderer));
    const intervalMs = options.intervalMs ?? 100;
    useEffect(() => {
        const update = () => {
            try {
                const next = readWindowInsets(renderer);
                setInsets((current) => (sameWindowInsets(current, next) ? current : next));
            }
            catch {
                // Renderer window is still opening.
            }
        };
        update();
        if (intervalMs === false)
            return;
        const timer = setInterval(update, Math.max(16, intervalMs));
        return () => clearInterval(timer);
    }, [renderer, intervalMs]);
    return insets;
}
//# sourceMappingURL=use-window-size.js.map