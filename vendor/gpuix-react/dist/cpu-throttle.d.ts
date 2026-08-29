export declare const MAC_CPU_THROTTLES: readonly ["utility", "background", "maintenance"];
export type MacCpuThrottle = (typeof MAC_CPU_THROTTLES)[number];
export declare function readMacCpuThrottle(): MacCpuThrottle | null;
/** Re-exec under `taskpolicy -c`. Call from the process entry, not a vitest worker. */
export declare function applyMacCpuThrottleFromEnv(): MacCpuThrottle | null;
//# sourceMappingURL=cpu-throttle.d.ts.map