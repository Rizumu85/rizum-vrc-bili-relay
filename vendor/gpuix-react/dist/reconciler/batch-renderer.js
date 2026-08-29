/// BatchingRenderer — buffers individual napi mutation calls into a single
/// applyBatch() FFI call, reducing N FFI boundary crossings to 1 per commit.
///
/// Queue raw objects for setStyle / setCustomProp. Do not JSON.stringify them
/// first. The outer applyBatch stringify would escape that string again, and
/// Rust would parse twice. A 10k-row mount spent 626ms in applyBatch that way.
///
/// Implemented as a JS Proxy: mutation method calls on the NativeRenderer are
/// captured as ["methodName", ...args] in a queue. On commitMutations(), the
/// entire queue is flushed via applyBatch(json).
///
/// Adding a new mutation method to NativeRenderer requires adding it to
/// BATCHED_METHODS below — nothing else.
///
/// ## Batch timing
///
/// The batch boundary is React's commit phase (synchronous):
///
///   setState() → React render → reconciler mutation callbacks → resetAfterCommit()
///                                ↓ each callback queues ops     ↓ flushes queue
///                                queue.push([name, ...args])    applyBatch(json)
///
/// Multiple setState calls batched by React into one render = one batch.
/// Multiple separate commits in the same event loop tick = multiple batches.
///
/// ## Render-phase isolation
///
/// React's createInstance / createTextInstance / appendInitialChild callbacks
/// only build lightweight JS host nodes. A placement callback materializes the
/// accepted subtree during commit, so abandoned concurrent renders never enter
/// this queue.
import { containerForRenderer, unregisterEventHandlers } from "./event-registry.js";
/// Methods that should be batched (queued instead of called immediately).
/// Any method NOT in this set is passed through to the inner renderer directly.
/// This prevents accidental queuing of getters, queries, or future non-mutation
/// methods that would return undefined and enqueue garbage ops.
const BATCHED_METHODS = new Set([
    "createElement",
    "appendChild",
    "removeChild",
    "insertBefore",
    "setStyle",
    "setText",
    "setEventListener",
    "setRoot",
    "setCustomProp",
]);
/**
 * Wrap a NativeRenderer with batching support.
 *
 * If the inner renderer has applyBatch(), returns a Proxy that buffers
 * all mutation calls and flushes them in one applyBatch() per React commit.
 * setCustomProp is queued as setCustomPropValue so raw strings stay strings.
 * Without applyBatch, style and custom-prop objects are stringified for the
 * string-only napi methods.
 */
export function wrapWithBatching(inner) {
    if (typeof inner.applyBatch !== "function") {
        return new Proxy(inner, {
            get(target, prop) {
                if (prop === "setStyle") {
                    return (id, style) => {
                        target.setStyle(id, typeof style === "string" ? style : JSON.stringify(style));
                    };
                }
                if (prop === "setCustomProp") {
                    return (id, key, value) => {
                        target.setCustomProp(id, key, JSON.stringify(value ?? null));
                    };
                }
                const method = target[prop];
                if (typeof method === "function") {
                    return method.bind(target);
                }
                return method;
            },
        });
    }
    const batchable = inner;
    let queue = [];
    return new Proxy(inner, {
        get(_target, prop) {
            // commitMutations: flush the queue via a single applyBatch() FFI call.
            // Called by resetAfterCommit() at the end of React's commit phase.
            if (prop === "commitMutations") {
                return () => {
                    if (queue.length === 0) {
                        batchable.commitMutations();
                        return;
                    }
                    const json = JSON.stringify(queue);
                    // applyBatch may throw on malformed ops — queue is preserved
                    // on failure so state doesn't desync between JS and Rust.
                    const destroyedIds = batchable.applyBatch(json);
                    const container = containerForRenderer(inner);
                    if (container) {
                        for (const id of destroyedIds) {
                            unregisterEventHandlers(container.eventHandlers, id);
                        }
                    }
                    // applyBatch already invalidates, so only clear after batch + cleanup.
                    queue = [];
                };
            }
            // destroyElement: queue the op, return [] (destroyed IDs come from applyBatch).
            if (prop === "destroyElement") {
                return (id) => {
                    queue.push(["destroyElement", id]);
                    return [];
                };
            }
            if (prop === "setCustomProp") {
                return (...args) => {
                    queue.push(["setCustomPropValue", ...args]);
                };
            }
            // Batched mutation methods: queue as [methodName, ...args].
            if (BATCHED_METHODS.has(prop)) {
                return (...args) => {
                    queue.push([prop, ...args]);
                };
            }
            // Everything else (getters, queries, applyBatch, future methods):
            // pass through to the inner renderer directly.
            const value = batchable[prop];
            if (typeof value === "function") {
                return value.bind(batchable);
            }
            return value;
        },
    });
}
//# sourceMappingURL=batch-renderer.js.map