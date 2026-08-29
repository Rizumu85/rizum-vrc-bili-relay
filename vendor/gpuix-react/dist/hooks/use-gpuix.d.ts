import type { NativeRenderer } from "../types/host.js";
export interface GpuixContextValue {
    renderer: NativeRenderer | null;
}
export declare const GpuixContext: import("react").Context<GpuixContextValue>;
/**
 * Access the GPUIX renderer from within a component
 */
export declare function useGpuix(): GpuixContextValue;
/**
 * Access the GPUIX renderer, throwing if not available
 */
export declare function useGpuixRequired(): NativeRenderer;
//# sourceMappingURL=use-gpuix.d.ts.map