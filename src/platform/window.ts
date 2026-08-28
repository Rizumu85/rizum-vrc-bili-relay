import { FFIType, JSCallback, dlopen, ptr } from "bun:ffi";

export const PRODUCT_WINDOW_TITLE = "VRC Bili Relay";

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_MINIMIZE = 6;
const WM_CLOSE = 0x0010;
const SPI_GETCLIENTAREAANIMATION = 0x1042;
const VK_LBUTTON = 0x01;

interface WindowDragState {
  handle: ReturnType<typeof ptr> | bigint;
  cursorX: number;
  cursorY: number;
  windowLeft: number;
  windowTop: number;
}

interface PointerMoveRenderer {
  getElementBounds(elementId: number): number[] | null;
  getWindowSize(): { width: number; height: number };
  simulateMouseMove(
    x: number,
    y: number,
    pressedButton?: number | null,
    modifiers?: string | null,
  ): void;
}

let pointerCaptureHandle: ReturnType<typeof ptr> | bigint | null = null;
let pointerMoveRenderer: PointerMoveRenderer | null = null;
let pointerCaptureTargetBounds: readonly [number, number, number, number] | null = null;
let textInputPointerPoll: ReturnType<typeof setInterval> | null = null;
let windowDragState: WindowDragState | null = null;
let windowDragPoll: ReturnType<typeof setInterval> | null = null;
let leftMouseWasDown = false;
const textInputElementIds = new Set<number>();

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
      GetCursorPos: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      ScreenToClient: {
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
      PostMessageW: {
        args: [FFIType.ptr, FFIType.uint32_t, FFIType.u64, FFIType.i64],
        returns: FFIType.bool,
      },
      ShowWindow: {
        args: [FFIType.ptr, FFIType.int32_t],
        returns: FFIType.bool,
      },
      SetCapture: {
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
      ReleaseCapture: {
        args: [],
        returns: FFIType.bool,
      },
      GetAsyncKeyState: {
        args: [FFIType.int32_t],
        returns: FFIType.int16_t,
      },
      SystemParametersInfoW: {
        args: [FFIType.uint32_t, FFIType.uint32_t, FFIType.ptr, FFIType.uint32_t],
        returns: FFIType.bool,
      },
    } as const)
  : null;

export function beginProductWindowDrag(): boolean {
  if (!user32) return false;
  const handle = findCurrentProcessWindow();
  if (!handle) return false;

  const cursor = new Int32Array(2);
  const rectangle = new Int32Array(4);
  if (
    !user32.symbols.GetCursorPos(ptr(cursor))
    || !user32.symbols.GetWindowRect(handle, ptr(rectangle))
  ) {
    return false;
  }
  endProductWindowDrag();
  windowDragState = {
    handle,
    cursorX: cursor[0],
    cursorY: cursor[1],
    windowLeft: rectangle[0],
    windowTop: rectangle[1],
  };
  user32.symbols.SetCapture(handle);
  windowDragPoll = setInterval(pollProductWindowDrag, 8);
  return true;
}

function pollProductWindowDrag(): void {
  if (!user32 || !windowDragState) return;
  if ((user32.symbols.GetAsyncKeyState(VK_LBUTTON) & 0x8000) === 0) {
    endProductWindowDrag();
    return;
  }

  const cursor = new Int32Array(2);
  if (!user32.symbols.GetCursorPos(ptr(cursor))) return;
  user32.symbols.SetWindowPos(
    windowDragState.handle,
    null,
    windowDragState.windowLeft + cursor[0] - windowDragState.cursorX,
    windowDragState.windowTop + cursor[1] - windowDragState.cursorY,
    0,
    0,
    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
  );
}

function endProductWindowDrag(): void {
  if (windowDragPoll) {
    clearInterval(windowDragPoll);
    windowDragPoll = null;
  }
  windowDragState = null;
  user32?.symbols.ReleaseCapture();
}

export function minimizeProductWindow(): boolean {
  if (!user32) return false;
  const handle = findCurrentProcessWindow();
  return handle ? user32.symbols.ShowWindow(handle, SW_MINIMIZE) : false;
}

export function closeProductWindow(): boolean {
  if (!user32) return false;
  const handle = findCurrentProcessWindow();
  return handle ? user32.symbols.PostMessageW(handle, WM_CLOSE, 0n, 0n) : false;
}

export function prefersReducedMotion(): boolean {
  if (!user32) return false;
  const animationsEnabled = new Uint32Array(1);
  if (
    !user32.symbols.SystemParametersInfoW(
      SPI_GETCLIENTAREAANIMATION,
      0,
      ptr(animationsEnabled),
      0,
    )
  ) {
    return false;
  }
  return animationsEnabled[0] === 0;
}

export function registerProductWindowTextInput(elementId: number): void {
  if (!user32) return;
  textInputElementIds.add(elementId);
  if (!textInputPointerPoll) {
    textInputPointerPoll = setInterval(pollProductWindowTextInputs, 8);
  }
}

export function unregisterProductWindowTextInput(elementId: number): void {
  textInputElementIds.delete(elementId);
  if (textInputElementIds.size === 0 && textInputPointerPoll) {
    clearInterval(textInputPointerPoll);
    textInputPointerPoll = null;
    leftMouseWasDown = false;
    releaseProductWindowPointer();
  }
}

export function setProductWindowPointerRenderer(renderer: PointerMoveRenderer | null): void {
  pointerMoveRenderer = renderer;
}

export function releaseProductWindowPointer(): void {
  pointerCaptureHandle = null;
  pointerCaptureTargetBounds = null;
  user32?.symbols.ReleaseCapture();
}

function pollProductWindowTextInputs(): void {
  if (!user32) return;
  const leftMouseDown = (user32.symbols.GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  if (!leftMouseDown) {
    if (pointerCaptureHandle) releaseProductWindowPointer();
    leftMouseWasDown = false;
    return;
  }

  if (!leftMouseWasDown) beginTextInputPointerCapture();
  leftMouseWasDown = true;
  updateTextInputPointerCapture();
}

function beginTextInputPointerCapture(): void {
  if (!user32 || !pointerMoveRenderer) return;
  const handle = findCurrentProcessWindow();
  if (!handle) return;
  const cursor = logicalClientCursor(handle);
  if (!cursor) return;

  for (const elementId of textInputElementIds) {
    const bounds = toPointerTargetBounds(pointerMoveRenderer.getElementBounds(elementId));
    if (!bounds) continue;
    const [x, y, width, height] = bounds;
    if (cursor.x < x || cursor.x >= x + width || cursor.y < y || cursor.y >= y + height) {
      continue;
    }
    pointerCaptureHandle = handle;
    pointerCaptureTargetBounds = bounds;
    user32.symbols.SetCapture(handle);
    return;
  }
}

function updateTextInputPointerCapture(): void {
  if (!user32 || !pointerMoveRenderer || !pointerCaptureHandle || !pointerCaptureTargetBounds) return;
  const cursor = new Int32Array(2);
  const client = new Int32Array(4);
  if (
    !user32.symbols.GetCursorPos(ptr(cursor))
    || !user32.symbols.ScreenToClient(pointerCaptureHandle, ptr(cursor))
    || !user32.symbols.GetClientRect(pointerCaptureHandle, ptr(client))
  ) {
    return;
  }
  if (
    cursor[0] >= client[0]
    && cursor[0] < client[2]
    && cursor[1] >= client[1]
    && cursor[1] < client[3]
  ) {
    return;
  }

  const windowSize = pointerMoveRenderer.getWindowSize();
  const scaleX = windowSize.width / Math.max(1, client[2] - client[0]);
  const scaleY = windowSize.height / Math.max(1, client[3] - client[1]);
  const [x, y, width, height] = pointerCaptureTargetBounds;
  const edgeInset = 0.5;
  pointerMoveRenderer.simulateMouseMove(
    Math.min(x + width - edgeInset, Math.max(x + edgeInset, cursor[0] * scaleX)),
    Math.min(y + height - edgeInset, Math.max(y + edgeInset, cursor[1] * scaleY)),
    0,
  );
}

function logicalClientCursor(handle: ReturnType<typeof ptr> | bigint): { x: number; y: number } | null {
  if (!user32) return null;
  const cursor = new Int32Array(2);
  const client = new Int32Array(4);
  if (
    !user32.symbols.GetCursorPos(ptr(cursor))
    || !user32.symbols.ScreenToClient(handle, ptr(cursor))
    || !user32.symbols.GetClientRect(handle, ptr(client))
  ) {
    return null;
  }
  const windowSize = pointerMoveRenderer?.getWindowSize();
  if (!windowSize) return null;
  return {
    x: cursor[0] * windowSize.width / Math.max(1, client[2] - client[0]),
    y: cursor[1] * windowSize.height / Math.max(1, client[3] - client[1]),
  };
}

function toPointerTargetBounds(
  bounds: number[] | null | undefined,
): readonly [number, number, number, number] | null {
  if (
    !bounds
    || bounds.length < 4
    || !bounds.slice(0, 4).every(Number.isFinite)
    || bounds[2] <= 1
    || bounds[3] <= 1
  ) {
    return null;
  }
  return [bounds[0], bounds[1], bounds[2], bounds[3]];
}

export function setProductWindowClientSize(logicalWidth: number, logicalHeight: number): boolean {
  if (
    !user32
    || !Number.isFinite(logicalWidth)
    || logicalWidth <= 0
    || !Number.isFinite(logicalHeight)
    || logicalHeight <= 0
  ) {
    return false;
  }
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
  const clientWidth = clientRect[2] - clientRect[0];
  const clientHeight = clientRect[3] - clientRect[1];
  const dpi = user32.symbols.GetDpiForWindow(handle) || 96;
  const desiredClientWidth = Math.round(logicalWidth * dpi / 96);
  const desiredClientHeight = Math.round(logicalHeight * dpi / 96);
  const desiredOuterWidth = desiredClientWidth + Math.max(0, outerWidth - clientWidth);
  const desiredOuterHeight = desiredClientHeight + Math.max(0, outerHeight - clientHeight);
  if (
    desiredOuterWidth <= 0
    || desiredOuterHeight <= 0
    || (
      Math.abs(clientWidth - desiredClientWidth) <= 1
      && Math.abs(clientHeight - desiredClientHeight) <= 1
    )
  ) {
    return true;
  }

  const centerX = (windowRect[0] + windowRect[2]) / 2;
  const centerY = (windowRect[1] + windowRect[3]) / 2;
  const desiredLeft = Math.round(centerX - desiredOuterWidth / 2);
  const desiredTop = Math.round(centerY - desiredOuterHeight / 2);

  return user32.symbols.SetWindowPos(
    handle,
    null,
    desiredLeft,
    desiredTop,
    desiredOuterWidth,
    desiredOuterHeight,
    SWP_NOZORDER | SWP_NOACTIVATE,
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
