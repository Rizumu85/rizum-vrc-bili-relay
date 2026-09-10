// Read-only Win32 callback allocation benchmark; no window actions or assertions.
import { dlopen, FFIType, JSCallback } from "bun:ffi";
import { findProcessWindowByTitle } from "../src/platform/window-lookup";

const win = dlopen("user32.dll", {
  EnumWindows: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
});
const mode = process.argv[2] ?? "recreate";
const count = Number(process.argv[3] ?? "2000");
const options = { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool };
const retained = mode === "reuse" ? new JSCallback(() => false, options) : null;
const start = performance.now();
Bun.gc(true);
const before = process.memoryUsage();
for (let index = 0; index < count; index++) {
  if (mode === "lookup") {
    findProcessWindowByTitle("VRC Bili Relay");
    if ((index + 1) % 12000 === 0) {
      Bun.gc(true);
      console.log(JSON.stringify({ completed: index + 1, rssMB: process.memoryUsage().rss / 1048576 }));
    }
    continue;
  }
  const callback = retained ?? new JSCallback(() => false, options);
  win.symbols.EnumWindows(callback.ptr, null);
  if (!retained) callback.close();
}
Bun.gc(true);
const after = process.memoryUsage();
console.log(JSON.stringify({ mode, count, durationMs: performance.now() - start,
  rssDeltaMB: (after.rss - before.rss) / 1048576,
  heapDeltaMB: (after.heapUsed - before.heapUsed) / 1048576,
  before, after }));
retained?.close();
win.close();
