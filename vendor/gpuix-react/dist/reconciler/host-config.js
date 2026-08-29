/// Host config for React's reconciler — mutation-based protocol.
///
/// Each reconciler callback (createInstance, appendChild, commitUpdate, etc.)
/// makes a direct napi call to the Rust retained tree. No JSON serialization
/// of the full element tree. Only changed elements cross the FFI boundary.
import { createContext } from "react";
import { DefaultEventPriority } from "react-reconciler/constants.js";
const NoEventPriority = 0;
import { registerEventHandler, unregisterEventHandler, unregisterEventHandlers, } from "./event-registry.js";
let currentUpdatePriority = NoEventPriority;
const hostNodeStates = new WeakMap();
function stateFor(node) {
    const state = hostNodeStates.get(node);
    if (!state) {
        throw new Error(`GPUIX host node ${node.id} does not belong to a root`);
    }
    return state;
}
function containerFor(node) {
    return stateFor(node).container;
}
function rendererFor(node) {
    return containerFor(node).renderer;
}
function nextId(container) {
    return ++container.ids.nextElementId;
}
// ── Event wiring helpers ─────────────────────────────────────────────
const EVENT_PROPS = [
    // Custom element events
    ["onToggleFile", "toggleFile"],
    ["onShowMore", "showMore"],
    ["onLineClick", "lineClick"],
    ["onLinkClick", "linkClick"],
    ["onVisibleRange", "visibleRange"],
    ["onHighlight", "highlight"],
    ["onChange", "change"],
    ["onSubmit", "submit"],
    // Mouse events
    ["onClick", "click"],
    ["onAuxClick", "auxClick"],
    ["onMouseDown", "mouseDown"],
    ["onMouseUp", "mouseUp"],
    ["onMouseEnter", "mouseEnter"],
    ["onMouseLeave", "mouseLeave"],
    ["onMouseMove", "mouseMove"],
    ["onMouseDownOutside", "mouseDownOutside"],
    // Keyboard events (require focus — tabIndex or autoFocus)
    ["onKeyDown", "keyDown"],
    ["onKeyUp", "keyUp"],
    // Focus events
    ["onFocus", "focus"],
    ["onBlur", "blur"],
    // Scroll events
    ["onScroll", "scroll"],
];
const EVENT_PROP_NAMES = new Set(EVENT_PROPS.map(([name]) => name));
function syncEventListeners(container, id, props) {
    for (const [propName, eventType] of EVENT_PROPS) {
        const handler = props[propName];
        if (handler) {
            registerEventHandler(container.eventHandlers, id, eventType, handler);
            container.renderer.setEventListener(id, eventType, true);
        }
    }
}
function diffEventListeners(container, id, oldProps, newProps) {
    for (const [propName, eventType] of EVENT_PROPS) {
        const oldHandler = oldProps[propName];
        const newHandler = newProps[propName];
        if (oldHandler && !newHandler) {
            unregisterEventHandler(container.eventHandlers, id, eventType);
            container.renderer.setEventListener(id, eventType, false);
        }
        else if (newHandler && newHandler !== oldHandler) {
            registerEventHandler(container.eventHandlers, id, eventType, newHandler);
            if (!oldHandler) {
                container.renderer.setEventListener(id, eventType, true);
            }
        }
    }
}
// ── Style helper ─────────────────────────────────────────────────────
function sendStyle(renderer, id, props) {
    const style = props.style;
    if (style == null || Object.keys(style).length === 0)
        return;
    renderer.setStyle(id, style);
}
// ── Custom prop forwarding ───────────────────────────────────────────
// Props that are handled by the reconciler directly (not forwarded as custom props).
const RESERVED_PROPS = new Set(["style", "className", "children", "key", "ref"]);
// Built-in element types that don't use custom props.
const BUILT_IN_TYPES = new Set(["div", "text"]);
// Props that reach Rust on EVERY element type, including div and text.
// Custom props are otherwise skipped for built-ins.
const UNIVERSAL_PROPS = new Set([
    "autoFocus",
    "tabIndex",
    "motion",
    "testId",
    // `highlight` is scoped by where it sits in the tree, so it has to reach a
    // plain `div`. Without it here, custom props are dropped for built-ins and
    // the prop silently never arrives in Rust.
    "highlight",
]);
function isReservedProp(name) {
    return RESERVED_PROPS.has(name) || EVENT_PROP_NAMES.has(name);
}
function serializeCustomProp(_type, _key, value) {
    if (value === undefined || typeof value === "function")
        return null;
    return value;
}
/** Send all custom props to Rust for non-built-in element types. */
function syncCustomProps(renderer, id, type, props) {
    const builtIn = BUILT_IN_TYPES.has(type);
    for (const [key, value] of Object.entries(props)) {
        if (isReservedProp(key))
            continue;
        if (builtIn && !UNIVERSAL_PROPS.has(key))
            continue;
        renderer.setCustomProp(id, key, serializeCustomProp(type, key, value));
    }
}
/** Diff and send changed custom props to Rust. */
function diffCustomProps(renderer, id, type, oldProps, newProps) {
    const builtIn = BUILT_IN_TYPES.has(type);
    const oldEntries = Object.entries(oldProps);
    const newKeys = Object.keys(newProps);
    // Updated or added props
    for (const [key, value] of Object.entries(newProps)) {
        if (isReservedProp(key))
            continue;
        if (builtIn && !UNIVERSAL_PROPS.has(key))
            continue;
        const oldValue = oldEntries.find(([oldKey]) => oldKey === key)?.[1];
        if (oldValue !== value) {
            renderer.setCustomProp(id, key, serializeCustomProp(type, key, value));
        }
    }
    // Removed props
    for (const key of Object.keys(oldProps)) {
        if (isReservedProp(key))
            continue;
        if (builtIn && !UNIVERSAL_PROPS.has(key))
            continue;
        if (!newKeys.includes(key)) {
            renderer.setCustomProp(id, key, JSON.stringify(null));
        }
    }
}
/**
 * Materialize a render-phase host node only after React places its subtree in
 * the commit phase. Abandoned concurrent renders stay as collectable JS
 * objects and never enter the native mutation queue.
 */
function materialize(node) {
    const state = stateFor(node);
    if (state.mounted)
        return state;
    const renderer = state.container.renderer;
    if ("type" in node) {
        renderer.createElement(node.id, node.type);
        sendStyle(renderer, node.id, node.props);
        syncEventListeners(state.container, node.id, node.props);
        syncCustomProps(renderer, node.id, node.type, node.props);
    }
    else {
        renderer.createElement(node.id, "text");
        renderer.setText(node.id, node.text);
    }
    state.mounted = true;
    for (const child of state.initialChildren) {
        materialize(child);
        renderer.appendChild(node.id, child.id);
    }
    state.initialChildren.length = 0;
    return state;
}
// ── Host config ──────────────────────────────────────────────────────
export const hostConfig = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    // React creates host nodes while rendering and may abandon that work in
    // concurrent mode. Keep the description in JS; materialize it only from a
    // commit-phase placement callback.
    createInstance(type, props, rootContainerInstance, _hostContext) {
        const instance = { id: nextId(rootContainerInstance), type, props };
        hostNodeStates.set(instance, {
            container: rootContainerInstance,
            initialChildren: [],
            mounted: false,
        });
        return instance;
    },
    appendChild(parent, child) {
        const parentState = materialize(parent);
        materialize(child);
        parentState.container.renderer.appendChild(parent.id, child.id);
    },
    // React only calls this from the deletion path, never to move a node, so the
    // child is gone for good and has to be freed here. Detaching alone leaked
    // every removed text node: `detachDeletedInstance` runs for host components
    // only, so nothing else would ever destroy a `HostText`.
    removeChild(parent, child) {
        const container = containerFor(parent);
        const destroyed = container.renderer.destroyElement(child.id);
        for (const id of destroyed) {
            unregisterEventHandlers(container.eventHandlers, id);
        }
    },
    insertBefore(parent, child, beforeChild) {
        const parentState = materialize(parent);
        materialize(child);
        parentState.container.renderer.insertBefore(parent.id, child.id, beforeChild.id);
    },
    insertInContainerBefore(_parent, _child, _beforeChild) { },
    removeChildFromContainer(parent, child) {
        const destroyed = parent.renderer.destroyElement(child.id);
        for (const id of destroyed) {
            unregisterEventHandlers(parent.eventHandlers, id);
        }
    },
    prepareForCommit(_containerInfo) {
        return null;
    },
    // Batch flush point: commitMutations() sends all queued mutations to Rust
    // in a single applyBatch() FFI call. This is the end of React's synchronous
    // commit phase — all mutations from this render are flushed together.
    resetAfterCommit(containerInfo) {
        containerInfo.renderer.commitMutations();
    },
    getRootHostContext(_rootContainerInstance) {
        return { isInsideText: false };
    },
    getChildHostContext(parentHostContext, type, _rootContainerInstance) {
        const isInsideText = type === "text";
        return { ...parentHostContext, isInsideText };
    },
    shouldSetTextContent(_type, _props) {
        return false;
    },
    createTextInstance(text, rootContainerInstance, _hostContext) {
        const instance = {
            id: nextId(rootContainerInstance),
            text,
            parentId: null,
        };
        hostNodeStates.set(instance, {
            container: rootContainerInstance,
            initialChildren: [],
            mounted: false,
        });
        return instance;
    },
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1,
    shouldAttemptEagerTransition() {
        return false;
    },
    finalizeInitialChildren(_instance, _type, _props, _rootContainerInstance, _hostContext) {
        return false;
    },
    commitMount(_instance, _type, _props, _internalInstanceHandle) { },
    commitUpdate(instance, _type, oldProps, newProps, _internalInstanceHandle) {
        const container = containerFor(instance);
        // Always resend style — per-element JSON is small, and this avoids
        // bugs from same-reference mutations or style removal.
        container.renderer.setStyle(instance.id, newProps.style ?? {});
        diffEventListeners(container, instance.id, oldProps, newProps);
        // Custom prop diff (for non-div/text elements)
        diffCustomProps(container.renderer, instance.id, instance.type, oldProps, newProps);
        instance.props = newProps;
    },
    commitTextUpdate(textInstance, _oldText, newText) {
        rendererFor(textInstance).setText(textInstance.id, newText);
        textInstance.text = newText;
    },
    appendChildToContainer(container, child) {
        materialize(child);
        container.renderer.setRoot(child.id);
    },
    appendInitialChild(parent, child) {
        stateFor(parent).initialChildren.push(child);
    },
    hideInstance(instance) {
        rendererFor(instance).setStyle(instance.id, { visibility: "hidden" });
    },
    unhideInstance(instance, _props) {
        rendererFor(instance).setStyle(instance.id, instance.props.style ?? {});
    },
    hideTextInstance(_textInstance) { },
    unhideTextInstance(_textInstance, _text) { },
    clearContainer(_container) { },
    setCurrentUpdatePriority(newPriority) {
        currentUpdatePriority = newPriority;
    },
    getCurrentUpdatePriority: () => currentUpdatePriority,
    resolveUpdatePriority() {
        if (currentUpdatePriority !== NoEventPriority) {
            return currentUpdatePriority;
        }
        return DefaultEventPriority;
    },
    maySuspendCommit() {
        return false;
    },
    NotPendingTransition: null,
    HostTransitionContext: createContext(null),
    resetFormInstance() { },
    requestPostPaintCallback() { },
    trackSchedulerEvent() { },
    resolveEventType() {
        return null;
    },
    resolveEventTimeStamp() {
        return -1.1;
    },
    preloadInstance() {
        return true;
    },
    startSuspendingCommit() { },
    suspendInstance() { },
    waitForCommitToBeReady() {
        return null;
    },
    detachDeletedInstance(instance) {
        const container = containerFor(instance);
        const destroyed = container.renderer.destroyElement(instance.id);
        for (const id of destroyed) {
            unregisterEventHandlers(container.eventHandlers, id);
        }
    },
    getPublicInstance(instance) {
        return instance;
    },
    preparePortalMount(_containerInfo) { },
    isPrimaryRenderer: true,
    getInstanceFromNode() {
        return null;
    },
    beforeActiveInstanceBlur() { },
    afterActiveInstanceBlur() { },
    prepareScopeUpdate() { },
    getInstanceFromScope() {
        return null;
    },
};
//# sourceMappingURL=host-config.js.map