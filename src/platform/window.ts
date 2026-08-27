import { FFIType, JSCallback, dlopen, ptr } from "bun:ffi";

export const PRODUCT_WINDOW_TITLE = "VRC Bili Relay — GPUIX";

const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

const user32 = process.platform === "win32"
  ? dlopen("user32.dll", {
      EnumWindows: {
        args: [FFIType.function, FFIType.ptr],
        returns: FFIType.bool,
      },
      GetWindowThreadProcessId: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.uint32_t,
      },
      IsWindowVisible: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      GetWindowRect: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      GetClientRect: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      GetDpiForWindow: {
        args: [FFIType.ptr],
        returns: FFIType.uint32_t,
      },
      SetWindowPos: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.uint32_t,
        ],
        returns: FFIType.bool,
      },
    } as const)
  : null;

export function setProductWindowClientHeight(logicalHeight: number): boolean {
  if (!user32 || !Number.isFinite(logicalHeight) || logicalHeight <= 0) return false;
  const handle = findCurrentProcessWindow();
  if (!handle) return false;

  const windowRect = new Int32Array(4);
  const clientRect = new Int32Array(4);
  if (
    !user32.symbols.GetWindowRect(handle, ptr(windowRect))
    || !user32.symbols.GetClientRect(handle, ptr(clientRect))
  ) {
    return false;
  }

  const outerWidth = windowRect[2] - windowRect[0];
  const outerHeight = windowRect[3] - windowRect[1];
  const clientHeight = clientRect[3] - clientRect[1];
  const dpi = user32.symbols.GetDpiForWindow(handle) || 96;
  const desiredClientHeight = Math.round(logicalHeight * dpi / 96);
  const desiredOuterHeight = desiredClientHeight + Math.max(0, outerHeight - clientHeight);
  if (outerWidth <= 0 || desiredOuterHeight <= 0 || Math.abs(clientHeight - desiredClientHeight) <= 1) {
    return true;
  }

  return user32.symbols.SetWindowPos(
    handle,
    null,
    0,
    0,
    outerWidth,
    desiredOuterHeight,
    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
  );
}

function findCurrentProcessWindow(): ReturnType<typeof ptr> | bigint | null {
  if (!user32) return null;
  let handle: ReturnType<typeof ptr> | bigint | null = null;
  const callback = new JSCallback(
    (candidate: ReturnType<typeof ptr>) => {
      if (!user32.symbols.IsWindowVisible(candidate)) return true;
      const owner = new Uint32Array(1);
      user32.symbols.GetWindowThreadProcessId(candidate, ptr(owner));
      if (owner[0] !== process.pid) return true;
      handle = candidate;
      return false;
    },
    {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.bool,
    },
  );
  try {
    user32.symbols.EnumWindows(callback, null);
  } finally {
    callback.close();
  }
  return handle;
}
