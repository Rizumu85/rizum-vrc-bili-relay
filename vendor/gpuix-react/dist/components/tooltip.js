import { jsx as _jsx } from "@gpuix/react/jsx-runtime";
/** Headless shadcn-shaped Tooltip components over GPUIX anchored layers. */
import React, { createContext, forwardRef, useContext, useEffect, useMemo, useRef, } from "react";
import { FloatingLayer, floatingRootStyle, renderSlot, useControllableState, } from "./floating.js";
const defaultProvider = {
    delayDuration: 0,
    skipDelayDuration: 300,
    disableHoverableContent: false,
    lastClosedAt: { current: Number.NEGATIVE_INFINITY },
};
const TooltipProviderContext = createContext(defaultProvider);
export function TooltipProvider({ children, delayDuration = 0, skipDelayDuration = 300, disableHoverableContent = false, }) {
    const lastClosedAt = useRef(Number.NEGATIVE_INFINITY);
    const value = useMemo(() => ({ delayDuration, skipDelayDuration, disableHoverableContent, lastClosedAt }), [delayDuration, skipDelayDuration, disableHoverableContent]);
    return _jsx(TooltipProviderContext.Provider, { value: value, children: children });
}
const TooltipContext = createContext(null);
function useTooltipContext(name) {
    const context = useContext(TooltipContext);
    if (!context)
        throw new Error(`${name} must be used inside Tooltip`);
    return context;
}
export function Tooltip({ children, open: openProp, defaultOpen = false, onOpenChange, delayDuration, disableHoverableContent, style, ...props }) {
    const provider = useContext(TooltipProviderContext);
    const [open, setOpenState] = useControllableState({
        value: openProp,
        defaultValue: defaultOpen,
        onChange: onOpenChange,
    });
    const openTimer = useRef(null);
    const closeTimer = useRef(null);
    const hoverableDisabled = disableHoverableContent ?? provider.disableHoverableContent;
    const cancelOpen = () => {
        if (openTimer.current !== null)
            clearTimeout(openTimer.current);
        openTimer.current = null;
    };
    const cancelClose = () => {
        if (closeTimer.current !== null)
            clearTimeout(closeTimer.current);
        closeTimer.current = null;
    };
    const setOpen = (nextOpen) => {
        cancelOpen();
        cancelClose();
        setOpenState(nextOpen);
        if (!nextOpen)
            provider.lastClosedAt.current = Date.now();
    };
    const openImmediately = () => setOpen(true);
    const scheduleOpen = () => {
        cancelClose();
        const recentlyClosed = Date.now() - provider.lastClosedAt.current <= provider.skipDelayDuration;
        const delay = recentlyClosed ? 0 : (delayDuration ?? provider.delayDuration);
        if (delay <= 0) {
            setOpen(true);
            return;
        }
        cancelOpen();
        openTimer.current = setTimeout(() => setOpen(true), delay);
    };
    const close = () => setOpen(false);
    const scheduleClose = () => {
        cancelOpen();
        if (hoverableDisabled) {
            close();
            return;
        }
        cancelClose();
        closeTimer.current = setTimeout(close, 80);
    };
    useEffect(() => () => {
        cancelOpen();
        cancelClose();
    }, []);
    const context = {
        open,
        disableHoverableContent: hoverableDisabled,
        openImmediately,
        scheduleOpen,
        scheduleClose,
        cancelClose,
        close,
    };
    return (_jsx(TooltipContext.Provider, { value: context, children: _jsx("div", { ...props, style: floatingRootStyle(style), children: children }) }));
}
export const TooltipTrigger = forwardRef(function TooltipTrigger({ asChild, children, onMouseEnter, onMouseLeave, onMouseDown, onClick, onFocus, onBlur, onKeyDown, ...props }, ref) {
    const context = useTooltipContext("TooltipTrigger");
    return renderSlot({
        asChild,
        children,
        props: {
            ...props,
            tabIndex: asChild ? props.tabIndex : (props.tabIndex ?? 0),
            onMouseEnter: (event) => {
                onMouseEnter?.(event);
                context.scheduleOpen();
            },
            onMouseLeave: (event) => {
                onMouseLeave?.(event);
                context.scheduleClose();
            },
            onMouseDown: (event) => {
                onMouseDown?.(event);
                context.close();
            },
            onClick: (event) => {
                onClick?.(event);
                context.close();
            },
            onFocus: (event) => {
                onFocus?.(event);
                context.openImmediately();
            },
            onBlur: (event) => {
                onBlur?.(event);
                context.close();
            },
            onKeyDown: (event) => {
                onKeyDown?.(event);
                if (event.key === "escape")
                    context.close();
            },
        },
        ref
    });
});
export const TooltipContent = forwardRef(function TooltipContent({ children, side = "top", align = "center", sideOffset = 0, onMouseEnter, onMouseLeave, ...props }, ref) {
    const context = useTooltipContext("TooltipContent");
    if (!context.open)
        return null;
    return (_jsx(FloatingLayer, { ...props, ref: ref, side: side, align: align, sideOffset: sideOffset, onMouseEnter: (event) => {
            onMouseEnter?.(event);
            if (!context.disableHoverableContent)
                context.cancelClose();
        }, onMouseLeave: (event) => {
            onMouseLeave?.(event);
            context.scheduleClose();
        }, children: children }));
});
export { Tooltip as Root, TooltipContent as Content, TooltipProvider as Provider, TooltipTrigger as Trigger, };
//# sourceMappingURL=tooltip.js.map