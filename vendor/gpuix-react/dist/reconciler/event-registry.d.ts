import type { EventPayload } from "@gpuix/native";
import type { Container, EventHandlerMap, NativeRenderer } from "../types/host.js";
export declare function attachRoot(renderer: NativeRenderer, container: Container): void;
/** Only the owner may detach. Otherwise unmounting a rejected or stale root
 *  would delete the live root's event mapping and every handler would go dead. */
export declare function detachRoot(renderer: NativeRenderer, container: Container): void;
export declare function containerForRenderer(renderer: NativeRenderer): Container | undefined;
export declare function handleGpuixEvent(payload: EventPayload, renderer: NativeRenderer): void;
export declare function registerEventHandler(eventHandlers: EventHandlerMap, elementId: number, eventType: string, handler: (event: EventPayload) => void): void;
export declare function unregisterEventHandler(eventHandlers: EventHandlerMap, elementId: number, eventType: string): void;
export declare function unregisterEventHandlers(eventHandlers: EventHandlerMap, elementId: number): void;
//# sourceMappingURL=event-registry.d.ts.map