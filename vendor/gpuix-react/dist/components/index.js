// GPUIX component definitions and native motion wrappers.
import { createElement, forwardRef } from "react";
export const gpuixComponents = {
    div: "div",
    text: "text",
    img: "img",
    svg: "svg",
    canvas: "canvas",
    input: "input",
    textarea: "textarea",
    anchored: "anchored",
    "virtual-list": "virtual-list",
};
const MotionDiv = forwardRef(function MotionDiv({ initial, animate, transition, ...props }, ref) {
    const hostProps = {
        ...props,
        ref,
        motion: {
            ...(initial === undefined ? {} : { initial }),
            animate,
            ...(transition === undefined ? {} : { transition }),
        },
    };
    return createElement("div", hostProps);
});
/** Native animations with a Motion-like declarative React API. */
export const motion = {
    div: MotionDiv,
};
// There is no `VirtualList` React wrapper. Windowing on the React side is the
// app's job: pass `itemCount`, `estimatedItemHeight` and `windowStart` to the
// host `<virtual-list>` and render only that slice. A generic wrapper cannot
// know when to widen its own window, so it silently dropped rows whenever
// `itemCount` grew without a scroll.
//# sourceMappingURL=index.js.map