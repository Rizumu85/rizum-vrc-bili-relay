/** Headless shadcn-shaped Select components rendered with GPUIX host elements. */
import React from "react";
import type { ReactElement, ReactNode } from "react";
import type { EventPayload } from "@gpuix/native";
import type { Props } from "../types/host.js";
import type { FloatingContentProps, StateStyle } from "./floating.js";
export interface SelectProps extends Omit<Props, "children" | "onChange"> {
    children?: ReactNode;
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
}
export declare function Select({ children, value: valueProp, defaultValue, onValueChange, open: openProp, defaultOpen, onOpenChange, disabled, style, ...props }: SelectProps): ReactElement;
export interface SelectTriggerState {
    open: boolean;
    disabled: boolean;
    placeholder: boolean;
}
export interface SelectTriggerProps extends Omit<Props, "style"> {
    asChild?: boolean;
    disabled?: boolean;
    style?: StateStyle<SelectTriggerState>;
}
export declare const SelectTrigger: React.ForwardRefExoticComponent<Omit<SelectTriggerProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface SelectValueProps extends Props {
    placeholder?: ReactNode;
}
export declare const SelectValue: React.ForwardRefExoticComponent<Omit<SelectValueProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface SelectContentProps extends FloatingContentProps {
    onEscapeKeyDown?: (event: EventPayload) => void;
}
export declare const SelectContent: React.ForwardRefExoticComponent<Omit<SelectContentProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface SelectItemState {
    selected: boolean;
    highlighted: boolean;
    disabled: boolean;
}
export interface SelectItemProps extends Omit<Props, "children" | "style"> {
    value: string;
    disabled?: boolean;
    textValue?: string;
    children?: ReactNode | ((state: SelectItemState) => ReactNode);
    style?: StateStyle<SelectItemState>;
}
export declare const SelectItem: React.ForwardRefExoticComponent<Omit<SelectItemProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const SelectGroup: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const SelectLabel: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const SelectSeparator: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const SelectScrollUpButton: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const SelectScrollDownButton: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export { Select as Root, SelectContent as Content, SelectGroup as Group, SelectItem as Item, SelectLabel as Label, SelectScrollDownButton as ScrollDownButton, SelectScrollUpButton as ScrollUpButton, SelectSeparator as Separator, SelectTrigger as Trigger, SelectValue as Value, };
//# sourceMappingURL=select.d.ts.map