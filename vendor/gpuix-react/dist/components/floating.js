import { jsx as _jsx } from "@gpuix/react/jsx-runtime";
/** Shared state, slot, and positioning helpers for headless floating controls. */
import React, { cloneElement, forwardRef, isValidElement, useCallback, useState } from "react";
export function resolveStyle(style, state) {
    return typeof style === "function" ? style(state) : style;
}
export function mergeStyles(base, override) {
    if (!base)
        return override;
    if (!override)
        return base;
    return { ...base, ...override };
}
export function floatingRootStyle(style) {
    return {
        display: "flex",
        position: "relative",
        alignItems: "start",
        ...style,
    };
}
export function useControllableState({ value, defaultValue, onChange, }) {
    const [internalValue, setInternalValue] = useState(defaultValue);
    const controlled = value !== undefined;
    const currentValue = controlled ? value : internalValue;
    const setValue = useCallback((nextValue) => {
        if (!controlled)
            setInternalValue(nextValue);
        if (!Object.is(currentValue, nextValue))
            onChange?.(nextValue);
    }, [controlled, currentValue, onChange]);
    return [currentValue, setValue];
}
export function setRefs(value, ...refs) {
    for (const ref of refs) {
        if (typeof ref === "function") {
            ref(value);
        }
        else if (ref) {
            ref.current = value;
        }
    }
}
function mergeRefs(...refs) {
    return (value) => {
        for (const ref of refs) {
            if (typeof ref === "function") {
                ref(value);
            }
            else if (ref) {
                ref.current = value;
            }
        }
    };
}
function getElementRef(element) {
    if (element.props.ref)
        return element.props.ref;
    const descriptor = Object.getOwnPropertyDescriptor(element, "ref");
    return descriptor?.value;
}
function composeHandlers(first, second) {
    if (!first)
        return second;
    if (!second)
        return first;
    return (event) => {
        first(event);
        second(event);
    };
}
export function renderSlot({ asChild, children, props, ref, }) {
    if (!asChild) {
        return _jsx("div", { ...props, ref: ref, children: children });
    }
    if (!isValidElement(children)) {
        throw new Error("asChild requires exactly one React element");
    }
    const child = children;
    const childProps = child.props;
    const merged = {
        ...childProps,
        ...props,
        style: mergeStyles(childProps.style, props.style),
        onClick: composeHandlers(childProps.onClick, props.onClick),
        onMouseDown: composeHandlers(childProps.onMouseDown, props.onMouseDown),
        onMouseUp: composeHandlers(childProps.onMouseUp, props.onMouseUp),
        onMouseEnter: composeHandlers(childProps.onMouseEnter, props.onMouseEnter),
        onMouseLeave: composeHandlers(childProps.onMouseLeave, props.onMouseLeave),
        onMouseMove: composeHandlers(childProps.onMouseMove, props.onMouseMove),
        onMouseDownOutside: composeHandlers(childProps.onMouseDownOutside, props.onMouseDownOutside),
        onKeyDown: composeHandlers(childProps.onKeyDown, props.onKeyDown),
        onKeyUp: composeHandlers(childProps.onKeyUp, props.onKeyUp),
        onFocus: composeHandlers(childProps.onFocus, props.onFocus),
        onBlur: composeHandlers(childProps.onBlur, props.onBlur),
        onScroll: composeHandlers(childProps.onScroll, props.onScroll),
        onChange: composeHandlers(childProps.onChange, props.onChange),
        onSubmit: composeHandlers(childProps.onSubmit, props.onSubmit),
    };
    if (props.tabIndex === undefined)
        merged.tabIndex = childProps.tabIndex;
    const childRef = getElementRef(child);
    if (childRef || ref)
        merged.ref = mergeRefs(childRef, ref);
    return cloneElement(child, merged);
}
export const FloatingLayer = forwardRef(function FloatingLayer({ side = "bottom", sideOffset = 0, align = "start", alignOffset = 0, collisionPadding = 8, children, ...props }, ref) {
    const offset = side === "top" || side === "bottom"
        ? { x: alignOffset, y: 0 }
        : { x: 0, y: alignOffset };
    return (_jsx("anchored", { side: side, align: align, gap: sideOffset, offset: offset, fit: "snap", snapMargin: collisionPadding, deferred: true, priority: 1, occlude: true, children: _jsx("div", { ...props, ref: ref, style: mergeStyles({ backgroundColor: "#1A1A1A" }, props.style), children: children }) }));
});
//# sourceMappingURL=floating.js.map