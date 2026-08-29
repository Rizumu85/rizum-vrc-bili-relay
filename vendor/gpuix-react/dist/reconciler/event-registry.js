/** One renderer, one root. This map is also the ownership guard: a renderer
 *  owns one window, one native root id, and one event handler map, so a second
 *  root would replace all three without the first root ever knowing. */
const containersByRenderer = new WeakMap();
export function attachRoot(renderer, container) {
    const owner = containersByRenderer.get(renderer);
    if (owner && owner !== container) {
        throw new Error("This renderer already drives a mounted GPUIX root. One renderer owns one window, one native root id, and one event map, so a second root would silently take both over. Unmount the first root first.");
    }
    containersByRenderer.set(renderer, container);
}
/** Only the owner may detach. Otherwise unmounting a rejected or stale root
 *  would delete the live root's event mapping and every handler would go dead. */
export function detachRoot(renderer, container) {
    if (containersByRenderer.get(renderer) === container) {
        containersByRenderer.delete(renderer);
    }
}
export function containerForRenderer(renderer) {
    return containersByRenderer.get(renderer);
}
export function handleGpuixEvent(payload, renderer) {
    const container = containersByRenderer.get(renderer);
    if (!container)
        return;
    const elementHandlers = container.eventHandlers.get(payload.elementId);
    if (!elementHandlers)
        return;
    const handler = elementHandlers.get(payload.eventType);
    if (handler)
        handler(payload);
}
export function registerEventHandler(eventHandlers, elementId, eventType, handler) {
    let elementHandlers = eventHandlers.get(elementId);
    if (!elementHandlers) {
        elementHandlers = new Map();
        eventHandlers.set(elementId, elementHandlers);
    }
    elementHandlers.set(eventType, handler);
}
export function unregisterEventHandler(eventHandlers, elementId, eventType) {
    const m = eventHandlers.get(elementId);
    if (!m)
        return;
    m.delete(eventType);
    if (m.size === 0)
        eventHandlers.delete(elementId);
}
export function unregisterEventHandlers(eventHandlers, elementId) {
    eventHandlers.delete(elementId);
}
//# sourceMappingURL=event-registry.js.map