import { FFIType, JSCallback, dlopen, ptr } from "bun:ffi";

type WindowHandle = ReturnType<typeof ptr> | bigint;
const windows = process.platform === "win32" ? dlopen("user32.dll", {
  EnumWindows: { args: [FFIType.function, FFIType.ptr], returns: FFIType.bool },
  IsWindow: { args: [FFIType.ptr], returns: FFIType.bool },
  IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
  GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.uint32_t },
  GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.int32_t },
  GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.int32_t], returns: FFIType.int32_t },
}) : null;

const cached = new Map<string, WindowHandle>();
const owner = new Uint32Array(1);
let requestedTitle = "";
let visibleOnly = true;
let found: WindowHandle | null = null;
let enumeration: JSCallback | null = null;

function matches(handle: WindowHandle, title: string, visible: boolean): boolean {
  if (!windows || !windows.symbols.IsWindow(handle)) return false;
  windows.symbols.GetWindowThreadProcessId(handle, ptr(owner));
  if (owner[0] !== process.pid || (visible && !windows.symbols.IsWindowVisible(handle))) return false;
  const length = windows.symbols.GetWindowTextLengthW(handle);
  if (length !== title.length) return false;
  const buffer = new Uint16Array(length + 1);
  const copied = windows.symbols.GetWindowTextW(handle, ptr(buffer), buffer.length);
  return Buffer.from(buffer.buffer, 0, copied * 2).toString("utf16le") === title;
}

export function findProcessWindowByTitle(title: string, visible = true): WindowHandle | null {
  if (!windows) return null;
  const previous = cached.get(title);
  // HWNDs may be destroyed and reused. Validate identity, not just visibility.
  if (previous && matches(previous, title, visible)) return previous;
  cached.delete(title);
  if (!enumeration) {
    // Bun 1.3.14 on Windows retains native allocation overhead from repeatedly
    // compiling/closing callbacks. One synchronous EnumWindows callback lives
    // for the adapter lifetime, including when no matching window is present.
    enumeration = new JSCallback((candidate: ReturnType<typeof ptr>) => {
      if (!matches(candidate, requestedTitle, visibleOnly)) return true;
      found = candidate;
      return false;
    }, { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool });
    process.once("exit", () => enumeration?.close());
  }
  requestedTitle = title;
  visibleOnly = visible;
  found = null;
  windows.symbols.EnumWindows(enumeration, null);
  if (found) cached.set(title, found);
  return found;
}
