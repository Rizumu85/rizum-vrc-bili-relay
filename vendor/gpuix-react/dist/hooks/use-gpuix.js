import { useContext, createContext } from "react";
export const GpuixContext = createContext({
    renderer: null,
});
/**
 * Access the GPUIX renderer from within a component
 */
export function useGpuix() {
    return useContext(GpuixContext);
}
/**
 * Access the GPUIX renderer, throwing if not available
 */
export function useGpuixRequired() {
    const { renderer } = useGpuix();
    if (!renderer) {
        throw new Error("useGpuixRequired must be used within a GpuixProvider");
    }
    return renderer;
}
//# sourceMappingURL=use-gpuix.js.map