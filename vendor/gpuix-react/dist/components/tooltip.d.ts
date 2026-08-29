/** Headless shadcn-shaped Tooltip components over GPUIX anchored layers. */
import React from "react";
import type { ReactElement, ReactNode } from "react";
import type { Props } from "../types/host.js";
import type { FloatingContentProps } from "./floating.js";
export interface TooltipProviderProps {
    children: ReactNode;
    delayDuration?: number;
    skipDelayDuration?: number;
    disableHoverableContent?: boolean;
}
export declare function TooltipProvider({ children, delayDuration, skipDelayDuration, disableHoverableContent, }: TooltipProviderProps): ReactElement;
export interface TooltipProps extends Omit<Props, "children"> {
    children?: ReactNode;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    delayDuration?: number;
    disableHoverableContent?: boolean;
}
export declare function Tooltip({ children, open: openProp, defaultOpen, onOpenChange, delayDuration, disableHoverableContent, style, ...props }: TooltipProps): ReactElement;
export interface TooltipTriggerProps extends Props {
    asChild?: boolean;
}
export declare const TooltipTrigger: React.ForwardRefExoticComponent<Omit<TooltipTriggerProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface TooltipContentProps extends FloatingContentProps {
}
export declare const TooltipContent: React.ForwardRefExoticComponent<Omit<TooltipContentProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export { Tooltip as Root, TooltipContent as Content, TooltipProvider as Provider, TooltipTrigger as Trigger, };
//# sourceMappingURL=tooltip.d.ts.map