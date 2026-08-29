// GPUIX React - React bindings for GPUI
export { createRoot, flushSync } from "./reconciler/index.js";
export { createRenderer, enableAutomation, render, resetRender, startFrameLoop, } from "./reconciler/renderer.js";
export { GpuixContext, useGpuix, useGpuixRequired } from "./hooks/use-gpuix.js";
export { useWindowInsets, useWindowSize } from "./hooks/use-window-size.js";
export { findRanges, useTextSearch } from "./hooks/use-text-search.js";
export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue, } from "./components/select.js";
export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSeparator, ComboboxTrigger, ComboboxValue, } from "./components/combobox.js";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/tooltip.js";
export { motion } from "./components/index.js";
export { handleGpuixEvent } from "./reconciler/event-registry.js";
export { applyMacCpuThrottleFromEnv, MAC_CPU_THROTTLES, readMacCpuThrottle, } from "./cpu-throttle.js";
export { GpuixRenderer } from "@gpuix/native";
//# sourceMappingURL=index.js.map