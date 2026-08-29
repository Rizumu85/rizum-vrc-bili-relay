/** Shared state, slot, and positioning helpers for headless floating controls. */
import React from "react";
import type { ReactElement, ReactNode, Ref } from "react";
import type { Props, PublicInstance, StyleDesc } from "../types/host.js";
export type FloatingSide = "top" | "right" | "bottom" | "left";
export type FloatingAlign = "start" | "center" | "end";
export type StateStyle<State> = StyleDesc | ((state: State) => StyleDesc);
export interface FloatingContentProps extends Omit<Props, "children"> {
    children?: ReactNode;
    side?: FloatingSide;
    sideOffset?: number;
    align?: FloatingAlign;
    alignOffset?: number;
    collisionPadding?: number;
}
export declare function resolveStyle<State>(style: StateStyle<State> | undefined, state: State): StyleDesc | undefined;
export declare function mergeStyles(base: StyleDesc | undefined, override: StyleDesc | undefined): StyleDesc | undefined;
export declare function floatingRootStyle(style?: StyleDesc): StyleDesc;
export declare function useControllableState<Value>({ value, defaultValue, onChange, }: {
    value: Value | undefined;
    defaultValue: Value;
    onChange?: (value: Value) => void;
}): [Value, (value: Value) => void];
export declare function setRefs<T>(value: T, ...refs: Array<Ref<T> | undefined>): void;
export declare function renderSlot({ asChild, children, props, ref, }: {
    asChild?: boolean;
    children: ReactNode;
    props: Props;
    ref?: Ref<PublicInstance>;
}): ReactElement;
export declare const FloatingLayer: React.ForwardRefExoticComponent<Omit<FloatingContentProps, "ref"> & React.RefAttributes<import("../types/host.js").Instance>>;
//# sourceMappingURL=floating.d.ts.map