import type { ReactNode } from "react";
import ReactReconciler from "react-reconciler";
import type { NativeRenderer } from "../types/host.js";
export declare const reconciler: ReactReconciler.Reconciler<unknown, unknown, unknown, unknown, unknown>;
export declare const flushSync: {
    (): void;
    <R>(fn: () => R): R;
};
export interface Root {
    render: (node: ReactNode) => void;
    unmount: () => void;
}
export declare function createRoot(renderer: NativeRenderer): Root;
//# sourceMappingURL=reconciler.d.ts.map