import { jsx as _jsx } from "@gpuix/react/jsx-runtime";
/** Headless shadcn-shaped Combobox components with native GPUI text input. */
import React, { createContext, forwardRef, useContext, useRef, useState, } from "react";
import { useGpuix } from "../hooks/use-gpuix.js";
import { FloatingLayer, floatingRootStyle, renderSlot, resolveStyle, setRefs, useControllableState, } from "./floating.js";
const ComboboxContext = createContext(null);
function useComboboxContext(name) {
    const context = useContext(ComboboxContext);
    if (!context)
        throw new Error(`${name} must be used inside Combobox`);
    return context;
}
function defaultFilter({ items, query, itemToString, }) {
    const normalized = query.trim().toLowerCase();
    if (!normalized)
        return [...items];
    const matches = [];
    items.forEach((item, index) => {
        const label = itemToString(item).toLowerCase();
        const rank = label.startsWith(normalized) ? 0 : label.includes(normalized) ? 1 : null;
        if (rank !== null)
            matches.push({ item, rank, index });
    });
    return matches
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map((match) => match.item);
}
export function Combobox({ children, items = [], value: valueProp, defaultValue = null, onValueChange, inputValue: inputValueProp, defaultInputValue = "", onInputValueChange, open: openProp, defaultOpen = false, onOpenChange, multiple = false, disabled = false, autoHighlight = false, filter, itemToStringValue = (item) => item, style, ...props }) {
    const { renderer } = useGpuix();
    const [value, setValue] = useControllableState({
        value: valueProp,
        defaultValue,
        onChange: onValueChange,
    });
    const [inputValue, setInputValueState] = useControllableState({
        value: inputValueProp,
        defaultValue: defaultInputValue,
        onChange: onInputValueChange,
    });
    const [open, setOpenState] = useControllableState({
        value: openProp,
        defaultValue: defaultOpen,
        onChange: onOpenChange,
    });
    const [activeIndex, setActiveIndex] = useState(null);
    const inputRef = useRef(null);
    const disabledItems = useRef([]);
    const itemToString = itemToStringValue;
    const filterItems = (query) => {
        if (filter === null)
            return [...items];
        if (filter) {
            return items.filter((item) => filter(item, query, itemToStringValue));
        }
        return defaultFilter({ items, query, itemToString });
    };
    const filteredItems = filterItems(inputValue);
    const setOpen = (nextOpen) => {
        setOpenState(nextOpen);
        if (nextOpen) {
            queueMicrotask(() => {
                if (inputRef.current)
                    renderer?.focusElement?.(inputRef.current.id);
            });
        }
    };
    const registerItem = ({ value: item, disabled: itemDisabled, mounted }) => {
        disabledItems.current = disabledItems.current.filter((candidate) => candidate !== item);
        if (mounted && itemDisabled)
            disabledItems.current.push(item);
    };
    const updateInputValue = (nextValue) => {
        setInputValueState(nextValue);
        const nextItems = filterItems(nextValue);
        const firstEnabled = nextItems.findIndex((item) => !disabledItems.current.includes(item));
        setActiveIndex(autoHighlight && firstEnabled >= 0 ? firstEnabled : null);
    };
    const moveActive = (delta) => {
        if (filteredItems.length === 0)
            return;
        let nextIndex = activeIndex === null ? (delta > 0 ? -1 : 0) : activeIndex;
        for (let checked = 0; checked < filteredItems.length; checked++) {
            nextIndex = (nextIndex + delta + filteredItems.length) % filteredItems.length;
            if (!disabledItems.current.includes(filteredItems[nextIndex])) {
                setActiveIndex(nextIndex);
                return;
            }
        }
    };
    const selectItem = (item) => {
        if (disabled || disabledItems.current.includes(item))
            return;
        if (multiple) {
            const selected = Array.isArray(value) ? value : [];
            const exists = selected.includes(item);
            setValue(exists ? selected.filter((candidate) => candidate !== item) : [...selected, item]);
            setInputValueState("");
            setActiveIndex(null);
            return;
        }
        setValue(item);
        setInputValueState(itemToString(item));
        setOpen(false);
        setActiveIndex(null);
    };
    const context = {
        open,
        disabled,
        multiple,
        value,
        inputValue,
        filteredItems,
        activeIndex,
        inputRef,
        itemToString,
        setOpen,
        setInputValue: updateInputValue,
        setActiveIndex,
        moveActive,
        selectItem,
        registerItem,
    };
    return (_jsx(ComboboxContext.Provider, { value: context, children: _jsx("div", { ...props, style: floatingRootStyle(style), children: children }) }));
}
export const ComboboxInput = forwardRef(function ComboboxInput({ onChange, onClick, onFocus, onKeyDown, onKeyUp, onSubmit, disabled: disabledProp, ...props }, forwardedRef) {
    const context = useComboboxContext("ComboboxInput");
    const disabled = disabledProp ?? context.disabled;
    const ref = (value) => {
        context.inputRef.current = value;
        setRefs(value, forwardedRef);
    };
    return (_jsx("input", { ...props, ref: ref, value: context.inputValue, readOnly: disabled || props.readOnly, autoFocus: context.open, onClick: (event) => {
            onClick?.(event);
            if (!disabled)
                context.setOpen(true);
        }, onFocus: (event) => {
            onFocus?.(event);
            if (!disabled)
                context.setOpen(true);
        }, onChange: (event) => {
            onChange?.(event);
            context.setInputValue(event.value ?? "");
            if (!disabled)
                context.setOpen(true);
        }, onKeyDown: (event) => {
            onKeyDown?.(event);
            if (disabled)
                return;
            if (event.key === "escape") {
                context.setOpen(false);
            }
            else if (event.key === "down" || (event.key === "n" && event.modifiers?.ctrl)) {
                context.moveActive(1);
            }
            else if (event.key === "up" || (event.key === "p" && event.modifiers?.ctrl)) {
                context.moveActive(-1);
            }
        }, onKeyUp: (event) => {
            onKeyUp?.(event);
        }, onSubmit: (event) => {
            onSubmit?.(event);
            if (disabled)
                return;
            if (context.activeIndex !== null) {
                const item = context.filteredItems[context.activeIndex];
                if (item !== undefined)
                    context.selectItem(item);
            }
        } }));
});
export const ComboboxTrigger = forwardRef(function ComboboxTrigger({ asChild, disabled: disabledProp, children, onClick, onKeyDown, ...props }, ref) {
    const context = useComboboxContext("ComboboxTrigger");
    const disabled = disabledProp ?? context.disabled;
    return renderSlot({
        asChild,
        children,
        props: {
            ...props,
            tabIndex: disabled ? -1 : (asChild ? props.tabIndex : (props.tabIndex ?? 0)),
            onClick: (event) => {
                onClick?.(event);
                if (!disabled)
                    context.setOpen(!context.open);
            },
            onKeyDown: (event) => {
                onKeyDown?.(event);
                if (disabled)
                    return;
                if (event.key === "down" || event.key === "up")
                    context.setOpen(true);
                if (event.key === "escape")
                    context.setOpen(false);
            },
        },
        ref
    });
});
export const ComboboxValue = forwardRef(function ComboboxValue({ placeholder, children, ...props }, ref) {
    const context = useComboboxContext("ComboboxValue");
    const value = Array.isArray(context.value)
        ? context.value.map(context.itemToString).join(", ")
        : context.value === null
            ? ""
            : context.itemToString(context.value);
    const content = typeof children === "function" ? children(context.value) : children;
    return _jsx("div", { ...props, ref: ref, children: content ?? (value || placeholder) });
});
export const ComboboxContent = forwardRef(function ComboboxContent({ children, onMouseDownOutside, ...props }, ref) {
    const context = useComboboxContext("ComboboxContent");
    if (!context.open)
        return null;
    return (_jsx(FloatingLayer, { ...props, ref: ref, onMouseDownOutside: (event) => {
            onMouseDownOutside?.(event);
            context.setOpen(false);
        }, children: children }));
});
export const ComboboxList = forwardRef(function ComboboxList({ children, ...props }, ref) {
    const context = useComboboxContext("ComboboxList");
    return (_jsx("div", { ...props, ref: ref, children: typeof children === "function"
            ? context.filteredItems.map((item) => children(item))
            : children }));
});
export const ComboboxItem = forwardRef(function ComboboxItem({ value, disabled = false, children, style, onClick, onMouseEnter, ...props }, ref) {
    const context = useComboboxContext("ComboboxItem");
    const index = context.filteredItems.indexOf(value);
    const selected = Array.isArray(context.value)
        ? context.value.includes(value)
        : context.value === value;
    const state = { selected, highlighted: context.activeIndex === index, disabled };
    const itemRef = (instance) => {
        context.registerItem({ value, disabled, mounted: instance !== null });
        setRefs(instance, ref);
    };
    return (_jsx("div", { ...props, ref: itemRef, style: resolveStyle(style, state), onMouseEnter: (event) => {
            onMouseEnter?.(event);
            if (!disabled && index >= 0)
                context.setActiveIndex(index);
        }, onClick: (event) => {
            onClick?.(event);
            if (!disabled)
                context.selectItem(value);
        }, children: typeof children === "function" ? children(state) : children }));
});
export const ComboboxEmpty = forwardRef(function ComboboxEmpty(props, ref) {
    const context = useComboboxContext("ComboboxEmpty");
    return context.filteredItems.length === 0 ? _jsx("div", { ...props, ref: ref }) : null;
});
export const ComboboxGroup = forwardRef(function ComboboxGroup(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const ComboboxLabel = forwardRef(function ComboboxLabel(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export const ComboboxSeparator = forwardRef(function ComboboxSeparator(props, ref) {
    return _jsx("div", { ...props, ref: ref });
});
export { Combobox as Root, ComboboxContent as Content, ComboboxEmpty as Empty, ComboboxGroup as Group, ComboboxInput as Input, ComboboxItem as Item, ComboboxLabel as Label, ComboboxList as List, ComboboxSeparator as Separator, ComboboxTrigger as Trigger, ComboboxValue as Value, };
//# sourceMappingURL=combobox.js.map