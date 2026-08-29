/** Headless shadcn-shaped Combobox components with native GPUI text input. */
import React from "react";
import type { ReactElement, ReactNode } from "react";
import type { InputProps, Props } from "../types/host.js";
import type { FloatingContentProps, StateStyle } from "./floating.js";
export type ComboboxValue = string | string[] | null;
export interface ComboboxProps extends Omit<Props, "children" | "onChange"> {
    children?: ReactNode;
    items?: readonly string[];
    value?: ComboboxValue;
    defaultValue?: ComboboxValue;
    onValueChange?: (value: ComboboxValue) => void;
    inputValue?: string;
    defaultInputValue?: string;
    onInputValueChange?: (value: string) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    multiple?: boolean;
    disabled?: boolean;
    autoHighlight?: boolean | "always";
    filter?: null | ((item: string, query: string, itemToString: (item: string) => string) => boolean);
    itemToStringValue?: (item: string) => string;
}
export declare function Combobox({ children, items, value: valueProp, defaultValue, onValueChange, inputValue: inputValueProp, defaultInputValue, onInputValueChange, open: openProp, defaultOpen, onOpenChange, multiple, disabled, autoHighlight, filter, itemToStringValue, style, ...props }: ComboboxProps): ReactElement;
export interface ComboboxInputProps extends InputProps {
    disabled?: boolean;
}
export declare const ComboboxInput: React.ForwardRefExoticComponent<Omit<ComboboxInputProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface ComboboxTriggerProps extends Props {
    asChild?: boolean;
    disabled?: boolean;
}
export declare const ComboboxTrigger: React.ForwardRefExoticComponent<Omit<ComboboxTriggerProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface ComboboxValueProps extends Omit<Props, "children"> {
    placeholder?: ReactNode;
    children?: ReactNode | ((value: ComboboxValue) => ReactNode);
}
export declare const ComboboxValue: React.ForwardRefExoticComponent<Omit<ComboboxValueProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const ComboboxContent: React.ForwardRefExoticComponent<Omit<FloatingContentProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface ComboboxListProps extends Omit<Props, "children"> {
    children?: ReactNode | ((item: string) => ReactNode);
}
export declare const ComboboxList: React.ForwardRefExoticComponent<Omit<ComboboxListProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export interface ComboboxItemState {
    selected: boolean;
    highlighted: boolean;
    disabled: boolean;
}
export interface ComboboxItemProps extends Omit<Props, "children" | "style"> {
    value: string;
    disabled?: boolean;
    children?: ReactNode | ((state: ComboboxItemState) => ReactNode);
    style?: StateStyle<ComboboxItemState>;
}
export declare const ComboboxItem: React.ForwardRefExoticComponent<Omit<ComboboxItemProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const ComboboxEmpty: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const ComboboxGroup: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const ComboboxLabel: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export declare const ComboboxSeparator: React.ForwardRefExoticComponent<Omit<Props, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
export { Combobox as Root, ComboboxContent as Content, ComboboxEmpty as Empty, ComboboxGroup as Group, ComboboxInput as Input, ComboboxItem as Item, ComboboxLabel as Label, ComboboxList as List, ComboboxSeparator as Separator, ComboboxTrigger as Trigger, ComboboxValue as Value, };
//# sourceMappingURL=combobox.d.ts.map