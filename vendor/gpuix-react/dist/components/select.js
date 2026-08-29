import { jsx as _jsx } from "@gpuix/react/jsx-runtime";
/** Headless shadcn-shaped Select components rendered with GPUIX host elements. */
import React, { Children, createContext, forwardRef, isValidElement, useContext, useMemo, useRef, useState, } from "react";
import { useGpuix } from "../hooks/use-gpuix.js";
import { FloatingLayer, floatingRootStyle, renderSlot, resolveStyle, setRefs, useControllableState, } from "./floating.js";
const SelectContext = createContext(null);
function useSelectContext(name) {
    const context = useContext(SelectContext);
    if (!context)
        throw new Error(`${name} must be used inside Select`);
    return context;
}
function textContent(node) {
    if (typeof node === "string" || typeof node === "number")
        return String(node);
    if (!isValidElement(node))
        return "";
    return Children.toArray(node.props.children).map(textContent).join("");
}
function collectItems(node, items = []) {
    for (const child of Children.toArray(node)) {
        if (isValidElement(child) && child.type === SelectItem) {
            const props = child.props;
            items.push({
                value: props.value,
                label: typeof props.children === "function" ? props.textValue : props.children,
                textValue: props.textValue ??
                    (typeof props.children === "function" ? "" : textContent(props.children)),
                disabled: props.disabled ?? false,
            });
        }
        else if (isValidElement(child) &&
            child.props.children !== undefined) {
            collectItems(child.props.children, items);
        }
    }
    return items;
}
export function Select({ children, value: valueProp, defaultValue, onValueChange, open: openProp, defaultOpen = false, onOpenChange, disabled = false, style, ...props }) {
    const { renderer } = useGpuix();
    const [value, setValue] = useControllableState({
        value: valueProp,
        defaultValue,
        onChange: (nextValue) => {
            if (nextValue !== undefined)
                onValueChange?.(nextValue);
        },
    });
    const [open, setOpenState] = useControllableState({
        value: openProp,
        defaultValue: defaultOpen,
        onChange: onOpenChange,
    });
    const [activeValue, setActiveValue] = useState(null);
    const triggerPressedWhileOpen = useRef(false);
    const dismissedByOutsidePress = useRef(false);
    const triggerRef = useRef(null);
    const items = useMemo(() => collectItems(children), [children]);
    const setOpen = (nextOpen) => {
        setOpenState(nextOpen);
        if (nextOpen) {
            const selected = items.find((item) => item.value === value && !item.disabled);
            setActiveValue(selected?.value ?? null);
        }
        else if (triggerRef.current) {
            renderer?.focusElement?.(triggerRef.current.id);
        }
    };
    const moveActive = (delta) => {
        const enabled = items.filter((item) => !item.disabled);
        if (enabled.length === 0)
            return;
        const currentIndex = enabled.findIndex((item) => item.value === activeValue);
        const start = currentIndex < 0 ? (delta > 0 ? -1 : 0) : currentIndex;
        const nextIndex = (start + delta + enabled.length) % enabled.length;
        setActiveValue(enabled[nextIndex].value);
    };
    const selectValue = (nextValue) => {
        const item = items.find((candidate) => candidate.value === nextValue);
        if (!item || item.disabled)
            return;
        setValue(nextValue);
        setOpen(false);
    };
    const context = useMemo(() => ({
        open,
        value,
        disabled,
        items,
        activeValue,
        triggerPressedWhileOpen,
        dismissedByOutsidePress,
        triggerRef,
        setOpen,
        setActiveValue,
        moveActive,
        selectValue,
    }), [open, value, disabled, items, activeValue]);
    return (_jsx(SelectContext.Provider, { value: context, children: _jsx("div", { ...props, style: floatingRootStyle(style), children: children }) }));
}
export const SelectTrigger = forwardRef(function SelectTrigger({ asChild, disabled: disabledProp, style, children, onMouseDown, onClick, onKeyDown, ...props }, forwardedRef) {
    const context = useSelectContext("SelectTrigger");
    const disabled = disabledProp ?? context.disabled;
    const state = {
        open: context.open,
        disabled,
        placeholder: context.value === undefined,
    };
    const ref = (value) => {
        context.triggerRef.current = value;
        setRefs(value, forwardedRef);
    };
    const triggerProps = {
        ...props,
        tabIndex: disabled ? -1 : (asChild ? props.tabIndex : (props.tabIndex ?? 0)),
        style: resolveStyle(style, state),
        onMouseDown: (event) => {
            onMouseDown?.(event);
            context.triggerPressedWhileOpen.current = context.open;
        },
        onClick: (event) => {
            onClick?.(event);
            if (disabled)
                return;
            if (context.dismissedByOutsidePress.current) {
                context.dismissedByOutsidePress.current = false;
                return;
            }
            if (context.triggerPressedWhileOpen.current) {
                context.triggerPressedWhileOpen.current = false;
                context.setOpen(false);
                return;
            }
            context.setOpen(!context.open);
        },
        onKeyDown: (event) => {
            onKeyDown?.(event);
            if (disabled)
                return;
            if (event.key === "escape") {
                context.setOpen(false);
            }
            else if (event.key === "down" || (event.key === "n" && event.modifiers?.ctrl)) {
                if (!context.open)
                    context.setOpen(true);
                context.moveActive(1);
            }
            else if (event.key === "up" || (event.key === "p" && event.modifiers?.ctrl)) {
                if (!context.open)
                    context.setOpen(true);
                context.moveActive(-1);
            }
            else if (event.key === "enter" || event.key === "space") {
                context.setOpen(!context.open);
            }
        },
    };
    return renderSlot({ asChild, children, props: triggerProps, ref });
});
export const SelectValue = forwardRef(function SelectValue({ placeholder, children, ...props }, ref) {
    const context = useSelectContext("SelectValue");
    const item = context.items.find((candidate) => candidate.value === context.value);
    return _jsx("div", { ...props, ref: ref, children: children ?? item?.label ?? placeholder });
});
export const SelectContent = forwardRef(function SelectContent({ children, onMouseDownOutside, onKeyDown, onEscapeKeyDown, tabIndex = 0, ...props }, forwardedRef) {
    const context = useSelectContext("SelectContent");
    if (!context.open)
        return null;
    return (_jsx(FloatingLayer, { ...props, ref: forwardedRef, tabIndex: tabIndex, autoFocus: true, onMouseDownOutside: (event) => {
            onMouseDownOutside?.(event);
            context.dismissedByOutsidePress.current = true;
            queueMicrotask(() => {
                context.dismissedByOutsidePress.current = false;
            });
            context.setOpen(false);
        }, onKeyDown: (event) => {
            onKeyDown?.(event);
            if (event.key === "escape") {
                onEscapeKeyDown?.(event);
                context.setOpen(false);
            }
            else if (event.key === "down" || (event.key === "n" && event.modifiers?.ctrl)) {
                context.moveActive(1);
            }
            else if (event.key === "up" || (event.key === "p" && event.modifiers?.ctrl)) {
                context.moveActive(-1);
            }
            else if ((event.key === "enter" || event.key === "space") && context.activeValue) {
                context.selectValue(context.activeValue);
            }
        }, children: children }));
});
export const SelectItem = forwardRef(function SelectItem({ value, disabled = false, children, style, onClick, onMouseEnter, ...props }, ref) {
    const context = useSelectContext("SelectItem");
    const state = {
        selected: context.value === value,
        highlighted: context.activeValue === value,
        disabled,
    };
    return (_jsx("div", { ...props, ref: ref, style: resolveStyle(style, state), onMouseEnter: (event) => {
            onMouseEnter?.(event);
            if (!disabled)
                context.setActiveValue(value);
        }, onClick: (event) => {
            onClick?.(event);
            if (!disabled)
                context.selectValue(value);
        }, children: typeof children === "function" ? children(state) : children }));
});
export const SelectGroup = forwardRef(function SelectGroup(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const SelectLabel = forwardRef(function SelectLabel(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const SelectSeparator = forwardRef(function SelectSeparator(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const SelectScrollUpButton = forwardRef(function SelectScrollUpButton(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const SelectScrollDownButton = forwardRef(function SelectScrollDownButton(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export { Select as Root, SelectContent as Content, SelectGroup as Group, SelectItem as Item, SelectLabel as Label, SelectScrollDownButton as ScrollDownButton, SelectScrollUpButton as ScrollUpButton, SelectSeparator as Separator, SelectTrigger as Trigger, SelectValue as Value, };
//# sourceMappingURL=select.js.map