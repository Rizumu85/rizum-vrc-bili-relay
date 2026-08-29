import type { NativeRenderer } from "../types/host.js";
export type MutationTuple = (number | string | boolean | object | null)[];
/**
 * Wrap a NativeRenderer with batching support.
 *
 * If the inner renderer has applyBatch(), returns a Proxy that buffers
 * all mutation calls and flushes them in one applyBatch() per React commit.
 * setCustomProp is queued as setCustomPropValue so raw strings stay strings.
 * Without applyBatch, style and custom-prop objects are stringified for the
 * string-only napi methods.
 */
export declare function wrapWithBatching(inner: NativeRenderer): NativeRenderer;
//# sourceMappingURL=batch-renderer.d.ts.map