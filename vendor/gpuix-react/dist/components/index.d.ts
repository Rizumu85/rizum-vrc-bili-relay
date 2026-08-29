import type { ReactNode } from "react";
import type { MotionProps, Props, StyleDesc } from "../types/host.js";
export declare const gpuixComponents: {
    readonly div: "div";
    readonly text: "text";
    readonly img: "img";
    readonly svg: "svg";
    readonly canvas: "canvas";
    readonly input: "input";
    readonly textarea: "textarea";
    readonly anchored: "anchored";
    readonly "virtual-list": "virtual-list";
};
export type GpuixComponentType = keyof typeof gpuixComponents;
export interface MotionDivProps extends MotionProps {
    children?: ReactNode;
    style?: StyleDesc;
    onClick?: Props["onClick"];
    onMouseDown?: Props["onMouseDown"];
    onMouseUp?: Props["onMouseUp"];
    onMouseEnter?: Props["onMouseEnter"];
    onMouseLeave?: Props["onMouseLeave"];
    onMouseMove?: Props["onMouseMove"];
    onMouseDownOutside?: Props["onMouseDownOutside"];
    onKeyDown?: Props["onKeyDown"];
    onKeyUp?: Props["onKeyUp"];
    onFocus?: Props["onFocus"];
    onBlur?: Props["onBlur"];
    onScroll?: Props["onScroll"];
    autoFocus?: boolean;
}
/** Native animations with a Motion-like declarative React API. */
export declare const motion: {
    readonly div: import("react").ForwardRefExoticComponent<MotionDivProps & import("react").RefAttributes<import("../types/host.js").Instance>>;
};
//# sourceMappingURL=index.d.ts.map