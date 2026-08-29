import { useEffect, useMemo, useRef, useState } from "react";
import {
  createRenderer,
  createRoot,
  flushSync,
  useGpuixRequired,
  type EventPayload,
  type Root,
} from "@gpuix/react";
import { FFIType, JSCallback, dlopen, ptr } from "bun:ffi";

import { ICONS } from "../icons";
import { FONT_UI, RADII, type Palette } from "../theme";
import { PRODUCT_WINDOW_TITLE } from "./window";

const POPUP_WINDOW_TITLE = "VRC Bili Relay · Parts";
const MENU_WIDTH = 368;
const MENU_ROW_HEIGHT = 31;
const MENU_MAX_ROWS = 7;
const MENU_PADDING = 4;
const SCROLLBAR_EDGE_INSET = 7;
const SCROLLBAR_MIN_THUMB_HEIGHT = 28;
const SCROLLBAR_HIT_WIDTH = 8;
const SCROLLBAR_RIGHT_INSET = 6;

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_OVERLAPPEDWINDOW = 0x00cf0000n;
const WS_POPUP = 0x80000000n;
const WS_EX_APPWINDOW = 0x00040000n;
const WS_EX_TOOLWINDOW = 0x00000080n;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const WM_CLOSE = 0x0010;
const MONITOR_DEFAULTTONEAREST = 0x00000002;
const VK_LBUTTON = 0x01;
const DWMWA_NCRENDERING_POLICY = 2;
const DWMNCRP_DISABLED = 1;
const DWMWA_CLOAK = 13;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_DONOTROUND = 1;
const DWMWA_BORDER_COLOR = 34;
const DWMWA_COLOR_NONE = 0xfffffffe;

type WindowHandle = ReturnType<typeof ptr> | bigint;

interface QueryRenderer {
  getElementBounds(elementId: number): number[] | null;
  getWindowSize(): { width: number; height: number };
  getScrollOffset(elementId: number): number[] | null;
  scrollTo(elementId: number, x: number, y: number): void;
}

export interface NativePartPopupItem {
  value: string;
  label: string;
}

export interface NativePartPopupRequest {
  items: NativePartPopupItem[];
  selectedValue: string;
  palette: Palette;
  anchorBounds: readonly [number, number, number, number];
  mainWindowSize: { width: number; height: number };
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

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
      GetWindowTextLengthW: {
        args: [FFIType.ptr],
        returns: FFIType.int32_t,
      },
      GetWindowTextW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.int32_t],
        returns: FFIType.int32_t,
      },
      GetWindowLongPtrW: {
        args: [FFIType.ptr, FFIType.int32_t],
        returns: FFIType.i64,
      },
      SetWindowLongPtrW: {
        args: [FFIType.ptr, FFIType.int32_t, FFIType.i64],
        returns: FFIType.i64,
      },
      GetClientRect: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      GetWindowRect: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      ClientToScreen: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      GetCursorPos: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      GetAsyncKeyState: {
        args: [FFIType.int32_t],
        returns: FFIType.int16_t,
      },
      MonitorFromWindow: {
        args: [FFIType.ptr, FFIType.uint32_t],
        returns: FFIType.ptr,
      },
      GetMonitorInfoW: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
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
      SetWindowRgn: {
        args: [FFIType.u64, FFIType.u64, FFIType.int32_t],
        returns: FFIType.int32_t,
      },
      ShowWindow: {
        args: [FFIType.ptr, FFIType.int32_t],
        returns: FFIType.bool,
      },
      PostMessageW: {
        args: [FFIType.ptr, FFIType.uint32_t, FFIType.u64, FFIType.i64],
        returns: FFIType.bool,
      },
    } as const)
  : null;

const gdi32 = process.platform === "win32"
  ? dlopen("gdi32.dll", {
      CreateRoundRectRgn: {
        args: [
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
          FFIType.int32_t,
        ],
        returns: FFIType.u64,
      },
      DeleteObject: {
        args: [FFIType.u64],
        returns: FFIType.bool,
      },
    } as const)
  : null;

const dwmapi = process.platform === "win32"
  ? dlopen("dwmapi.dll", {
      DwmSetWindowAttribute: {
        args: [FFIType.ptr, FFIType.uint32_t, FFIType.ptr, FFIType.uint32_t],
        returns: FFIType.int32_t,
      },
    } as const)
  : null;

let popupRenderer: ReturnType<typeof createRenderer> | null = null;
let popupRoot: Root | null = null;
let popupHandle: WindowHandle | null = null;
let popupRequest: NativePartPopupRequest | null = null;
let outsidePointerPoll: ReturnType<typeof setInterval> | null = null;
let leftMouseWasDown = false;
let popupRevealTimer: ReturnType<typeof setTimeout> | null = null;

export function supportsNativePartPopup(): boolean {
  return process.platform === "win32" && user32 !== null;
}

export function showNativePartPopup(request: NativePartPopupRequest): boolean {
  if (!user32 || request.items.length === 0) return false;
  ensurePopupRenderer();
  if (!popupRoot || !popupRenderer) return false;

  popupRequest = request;
  flushSync(() => {
    popupRoot?.render(
      <NativePartPopupSurface
        key={`${request.selectedValue}:${request.items.length}`}
        request={request}
        onSelect={(value) => {
          request.onSelect(value);
          hideNativePartPopup();
        }}
        onDismiss={() => dismissNativePartPopup()}
      />,
    );
  });

  const handle = popupHandle ?? findWindowByTitle(POPUP_WINDOW_TITLE, false);
  const mainHandle = findWindowByTitle(PRODUCT_WINDOW_TITLE, true);
  if (!handle || !mainHandle) {
    hideNativePartPopup();
    return false;
  }
  popupHandle = handle;
  configurePopupWindow(handle, mainHandle);
  positionPopupWindow(handle, mainHandle, request);
  startOutsidePointerPoll();
  return true;
}

export function hideNativePartPopup(): void {
  popupRequest = null;
  stopOutsidePointerPoll();
  cancelPopupReveal();
  if (popupHandle && user32) {
    setPopupCloaked(popupHandle, true);
    user32.symbols.ShowWindow(popupHandle, SW_HIDE);
  }
  if (popupRoot) flushSync(() => popupRoot?.render(null));
}

export function disposeNativePartPopup(): void {
  hideNativePartPopup();
  if (popupHandle && user32) user32.symbols.PostMessageW(popupHandle, WM_CLOSE, 0n, 0n);
  popupRoot?.unmount();
  popupRoot = null;
  popupRenderer = null;
  popupHandle = null;
}

function ensurePopupRenderer(): void {
  if (popupRenderer && popupRoot) return;
  const renderer = createRenderer();
  renderer.init({
    title: POPUP_WINDOW_TITLE,
    appName: "VRC Bili Relay",
    width: MENU_WIDTH,
    height: MENU_ROW_HEIGHT * MENU_MAX_ROWS + MENU_PADDING * 2,
    minWidth: MENU_WIDTH,
    minHeight: MENU_ROW_HEIGHT + MENU_PADDING * 2,
    resizable: false,
    transparent: true,
    titlebarTransparent: true,
    windowBackground: "transparent",
  });
  popupRenderer = renderer;
  popupRoot = createRoot(renderer);
  popupHandle = findWindowByTitle(POPUP_WINDOW_TITLE, false);
  if (popupHandle && user32) {
    setPopupCloaked(popupHandle, true);
    user32.symbols.ShowWindow(popupHandle, SW_HIDE);
  }
}

function dismissNativePartPopup(): void {
  const onDismiss = popupRequest?.onDismiss;
  hideNativePartPopup();
  onDismiss?.();
}

function configurePopupWindow(handle: WindowHandle, mainHandle: WindowHandle): void {
  if (!user32) return;
  const style = unsignedLong(user32.symbols.GetWindowLongPtrW(handle, GWL_STYLE));
  const exStyle = unsignedLong(user32.symbols.GetWindowLongPtrW(handle, GWL_EXSTYLE));
  const popupStyle = (style & ~WS_OVERLAPPEDWINDOW) | WS_POPUP;
  const popupExStyle = (exStyle & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
  user32.symbols.SetWindowLongPtrW(handle, GWL_STYLE, signedLong(popupStyle));
  user32.symbols.SetWindowLongPtrW(handle, GWL_EXSTYLE, signedLong(popupExStyle));
  user32.symbols.SetWindowLongPtrW(handle, GWLP_HWNDPARENT, signedLong(handleValue(mainHandle)));
  disableNativePopupDecoration(handle);
}

function disableNativePopupDecoration(handle: WindowHandle): void {
  if (!dwmapi) return;
  const nonClientPolicy = new Uint32Array([DWMNCRP_DISABLED]);
  const cornerPreference = new Uint32Array([DWMWCP_DONOTROUND]);
  const borderColor = new Uint32Array([DWMWA_COLOR_NONE]);
  dwmapi.symbols.DwmSetWindowAttribute(
    handle,
    DWMWA_NCRENDERING_POLICY,
    ptr(nonClientPolicy),
    nonClientPolicy.byteLength,
  );
  dwmapi.symbols.DwmSetWindowAttribute(
    handle,
    DWMWA_WINDOW_CORNER_PREFERENCE,
    ptr(cornerPreference),
    cornerPreference.byteLength,
  );
  dwmapi.symbols.DwmSetWindowAttribute(
    handle,
    DWMWA_BORDER_COLOR,
    ptr(borderColor),
    borderColor.byteLength,
  );
}

function setPopupCloaked(handle: WindowHandle, cloaked: boolean): void {
  if (!dwmapi) return;
  const value = new Uint32Array([cloaked ? 1 : 0]);
  dwmapi.symbols.DwmSetWindowAttribute(handle, DWMWA_CLOAK, ptr(value), value.byteLength);
}

function cancelPopupReveal(): void {
  if (popupRevealTimer) clearTimeout(popupRevealTimer);
  popupRevealTimer = null;
}

function revealPopupWhenReady(handle: WindowHandle): void {
  cancelPopupReveal();
  // Keep the already-visible HWND compositor-cloaked for one frame after the
  // synchronous React commit, region application, and final client alignment.
  popupRevealTimer = setTimeout(() => {
    popupRevealTimer = null;
    if (!popupRequest || popupHandle !== handle) return;
    setPopupCloaked(handle, false);
  }, 16);
}

function positionPopupWindow(
  handle: WindowHandle,
  mainHandle: WindowHandle,
  request: NativePartPopupRequest,
): void {
  if (!user32) return;
  const client = new Int32Array(4);
  const clientOrigin = new Int32Array(2);
  if (
    !user32.symbols.GetClientRect(mainHandle, ptr(client))
    || !user32.symbols.ClientToScreen(mainHandle, ptr(clientOrigin))
  ) return;

  const clientWidth = Math.max(1, client[2] - client[0]);
  const clientHeight = Math.max(1, client[3] - client[1]);
  const scaleX = clientWidth / Math.max(1, request.mainWindowSize.width);
  const scaleY = clientHeight / Math.max(1, request.mainWindowSize.height);
  const [anchorX, anchorY, anchorWidth, anchorHeight] = request.anchorBounds;
  const visibleRows = Math.max(1, Math.min(MENU_MAX_ROWS, request.items.length));
  const panelHeight = visibleRows * MENU_ROW_HEIGHT + MENU_PADDING * 2;
  const logicalWindowWidth = MENU_WIDTH;
  const logicalWindowHeight = panelHeight;
  const physicalWindowWidth = Math.round(logicalWindowWidth * scaleX);
  const physicalWindowHeight = Math.round(logicalWindowHeight * scaleY);
  // GPUIX 0.5.1 already reports horizontal element origins in physical
  // client pixels on Windows, while the popup window size remains logical.
  // Scaling anchorX again shifts the menu right at 125%+ display scaling.
  const panelLeft = clientOrigin[0] + Math.round(anchorX);
  const anchorTop = clientOrigin[1] + Math.round(anchorY * scaleY);
  const anchorBottom = clientOrigin[1] + Math.round((anchorY + anchorHeight) * scaleY);
  const panelGap = Math.round(6 * scaleY);
  const panelHeightPhysical = Math.round(panelHeight * scaleY);
  const workArea = monitorWorkArea(mainHandle);
  const canOpenBelow = anchorBottom + panelGap + panelHeightPhysical <= workArea.bottom - 8;
  const panelTop = canOpenBelow
    ? anchorBottom + panelGap
    : Math.max(workArea.top + 8, anchorTop - panelGap - panelHeightPhysical);
  const desiredWindowLeft = Math.round(
    Math.min(
      workArea.right - 8 - physicalWindowWidth,
      Math.max(workArea.left + 8, panelLeft),
    ),
  );
  const desiredWindowTop = Math.round(panelTop);

  user32.symbols.SetWindowPos(
    handle,
    null,
    desiredWindowLeft,
    desiredWindowTop,
    physicalWindowWidth,
    physicalWindowHeight,
    SWP_NOACTIVATE | SWP_FRAMECHANGED,
  );
  alignPopupClientOrigin(handle, desiredWindowLeft, desiredWindowTop, physicalWindowWidth, physicalWindowHeight);
  setRoundedPopupRegion(handle, physicalWindowWidth, physicalWindowHeight, scaleY);
  user32.symbols.ShowWindow(handle, SW_SHOW);
  revealPopupWhenReady(handle);
}

function setRoundedPopupRegion(handle: WindowHandle, width: number, height: number, scale: number): void {
  if (!user32 || !gdi32) return;
  // GPUIX 0.5.1 antialiases React radii against a black matte on transparent
  // Windows render targets. Clip an opaque rectangular surface at the HWND
  // boundary instead, so no partially transparent dark fringe is composited.
  const diameter = Math.max(2, Math.round(RADII.compactPanel * 2 * scale));
  const region = gdi32.symbols.CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
  if (!region) return;
  const applied = user32.symbols.SetWindowRgn(handleValue(handle), region, 1);
  if (applied === 0) {
    gdi32.symbols.DeleteObject(region);
  }
}

function alignPopupClientOrigin(
  handle: WindowHandle,
  desiredClientLeft: number,
  desiredClientTop: number,
  width: number,
  height: number,
): void {
  if (!user32) return;
  const windowRect = new Int32Array(4);
  const clientOrigin = new Int32Array(2);
  if (!user32.symbols.GetWindowRect(handle, ptr(windowRect)) || !user32.symbols.ClientToScreen(handle, ptr(clientOrigin))) {
    return;
  }
  const insetX = clientOrigin[0] - windowRect[0];
  const insetY = clientOrigin[1] - windowRect[1];
  if (insetX === 0 && insetY === 0) return;
  user32.symbols.SetWindowPos(
    handle,
    null,
    desiredClientLeft - insetX,
    desiredClientTop - insetY,
    width,
    height,
    SWP_NOACTIVATE,
  );
}

function monitorWorkArea(handle: WindowHandle): { left: number; top: number; right: number; bottom: number } {
  if (!user32) return { left: 0, top: 0, right: 1920, bottom: 1080 };
  const monitor = user32.symbols.MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST);
  const info = new Int32Array(10);
  info[0] = info.byteLength;
  if (monitor && user32.symbols.GetMonitorInfoW(monitor, ptr(info))) {
    return { left: info[5], top: info[6], right: info[7], bottom: info[8] };
  }
  return { left: 0, top: 0, right: 1920, bottom: 1080 };
}

function startOutsidePointerPoll(): void {
  stopOutsidePointerPoll();
  leftMouseWasDown = (user32?.symbols.GetAsyncKeyState(VK_LBUTTON) ?? 0) < 0;
  outsidePointerPoll = setInterval(() => {
    if (!user32 || !popupHandle || !popupRequest) return;
    const leftDown = user32.symbols.GetAsyncKeyState(VK_LBUTTON) < 0;
    if (leftDown && !leftMouseWasDown) {
      const cursor = new Int32Array(2);
      const popupRect = new Int32Array(4);
      if (
        user32.symbols.GetCursorPos(ptr(cursor))
        && user32.symbols.GetWindowRect(popupHandle, ptr(popupRect))
        && !pointInside(cursor[0], cursor[1], popupRect)
      ) {
        const mainHandle = findWindowByTitle(PRODUCT_WINDOW_TITLE, true);
        const insideAnchor = mainHandle ? pointInsideAnchor(cursor[0], cursor[1], mainHandle, popupRequest) : false;
        if (!insideAnchor) dismissNativePartPopup();
      }
    }
    leftMouseWasDown = leftDown;
  }, 24);
}

function stopOutsidePointerPoll(): void {
  if (outsidePointerPoll) clearInterval(outsidePointerPoll);
  outsidePointerPoll = null;
  leftMouseWasDown = false;
}

function pointInside(x: number, y: number, rectangle: Int32Array): boolean {
  return x >= rectangle[0] && x < rectangle[2] && y >= rectangle[1] && y < rectangle[3];
}

function pointInsideAnchor(
  x: number,
  y: number,
  mainHandle: WindowHandle,
  request: NativePartPopupRequest,
): boolean {
  if (!user32) return false;
  const client = new Int32Array(4);
  const origin = new Int32Array(2);
  if (!user32.symbols.GetClientRect(mainHandle, ptr(client)) || !user32.symbols.ClientToScreen(mainHandle, ptr(origin))) {
    return false;
  }
  const scaleX = (client[2] - client[0]) / Math.max(1, request.mainWindowSize.width);
  const scaleY = (client[3] - client[1]) / Math.max(1, request.mainWindowSize.height);
  const [left, top, width, height] = request.anchorBounds;
  return x >= origin[0] + left * scaleX
    && x < origin[0] + (left + width) * scaleX
    && y >= origin[1] + top * scaleY
    && y < origin[1] + (top + height) * scaleY;
}

function findWindowByTitle(title: string, visibleOnly: boolean): WindowHandle | null {
  if (!user32) return null;
  let handle: WindowHandle | null = null;
  const callback = new JSCallback(
    (candidate: ReturnType<typeof ptr>) => {
      if (visibleOnly && !user32.symbols.IsWindowVisible(candidate)) return true;
      const owner = new Uint32Array(1);
      user32.symbols.GetWindowThreadProcessId(candidate, ptr(owner));
      if (owner[0] !== process.pid || readWindowTitle(candidate) !== title) return true;
      handle = candidate;
      return false;
    },
    { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  );
  try {
    user32.symbols.EnumWindows(callback, null);
  } finally {
    callback.close();
  }
  return handle;
}

function readWindowTitle(handle: WindowHandle): string {
  if (!user32) return "";
  const length = user32.symbols.GetWindowTextLengthW(handle);
  if (length <= 0) return "";
  const buffer = new Uint16Array(length + 1);
  const copied = user32.symbols.GetWindowTextW(handle, ptr(buffer), buffer.length);
  if (copied <= 0) return "";
  return Buffer.from(buffer.buffer, 0, copied * 2).toString("utf16le");
}

function handleValue(handle: WindowHandle): bigint {
  return typeof handle === "bigint" ? handle : BigInt(handle as unknown as number);
}

function unsignedLong(value: bigint): bigint {
  return BigInt.asUintN(64, value);
}

function signedLong(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

function PopupIcon({ name, color, size }: { name: "check"; color: string; size: number }) {
  return <svg source={ICONS[name]} style={{ width: size, height: size, color, flexShrink: 0 }} />;
}

function NativePartPopupSurface({
  request,
  onSelect,
  onDismiss,
}: {
  request: NativePartPopupRequest;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}) {
  const renderer = useGpuixRequired() as typeof useGpuixRequired extends () => infer T
    ? T & QueryRenderer
    : QueryRenderer;
  const selectedIndex = Math.max(0, request.items.findIndex((item) => item.value === request.selectedValue));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollbarHovered, setScrollbarHovered] = useState(false);
  const scrollerId = useRef<number | null>(null);
  const trackId = useRef<number | null>(null);
  const visibleRows = Math.max(1, Math.min(MENU_MAX_ROWS, request.items.length));
  const viewportHeight = visibleRows * MENU_ROW_HEIGHT;
  const contentHeight = request.items.length * MENU_ROW_HEIGHT;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const panelHeight = viewportHeight + MENU_PADDING * 2;
  // The scrollbar's endpoint inset is measured from the popup edge. Adding
  // MENU_PADDING here again made the thumb sit too far from the first and last
  // option backgrounds, especially at the scroll limits.
  const scrollbarHeight = Math.max(1, panelHeight - SCROLLBAR_EDGE_INSET * 2);
  const thumbHeight = maxScroll > 0
    ? Math.max(
        SCROLLBAR_MIN_THUMB_HEIGHT,
        Math.round(scrollbarHeight * viewportHeight / contentHeight),
      )
    : scrollbarHeight;
  const thumbTravel = Math.max(0, scrollbarHeight - thumbHeight);
  const thumbTop = maxScroll > 0 ? Math.round(scrollOffset / maxScroll * thumbTravel) : 0;
  const initialScroll = useMemo(
    () => Math.min(maxScroll, Math.max(0, selectedIndex * MENU_ROW_HEIGHT - Math.floor(visibleRows / 2) * MENU_ROW_HEIGHT)),
    [maxScroll, selectedIndex, visibleRows],
  );

  const scrollTo = (offset: number) => {
    const bounded = Math.max(0, Math.min(maxScroll, offset));
    const scroller = scrollerId.current;
    if (scroller !== null) renderer.scrollTo(scroller, 0, -bounded);
    setScrollOffset(bounded);
  };

  useEffect(() => {
    const timer = setTimeout(() => scrollTo(initialScroll), 0);
    return () => clearTimeout(timer);
  }, [initialScroll]);

  useEffect(() => {
    const activeTop = activeIndex * MENU_ROW_HEIGHT;
    const activeBottom = activeTop + MENU_ROW_HEIGHT;
    if (activeTop < scrollOffset) scrollTo(activeTop);
    else if (activeBottom > scrollOffset + viewportHeight) scrollTo(activeBottom - viewportHeight);
  }, [activeIndex]);

  const syncScrollOffset = () => {
    const scroller = scrollerId.current;
    const offset = scroller !== null ? renderer.getScrollOffset(scroller) : null;
    if (offset) setScrollOffset(Math.max(0, Math.min(maxScroll, -(offset[1] ?? 0))));
  };

  const setScrollFromTrack = (event: EventPayload) => {
    if (maxScroll <= 0 || event.y === undefined) return;
    const track = trackId.current;
    const bounds = track !== null ? renderer.getElementBounds(track) : null;
    if (!bounds) return;
    const ratio = Math.max(0, Math.min(1, (event.y - bounds[1] - thumbHeight / 2) / Math.max(1, thumbTravel)));
    scrollTo(ratio * maxScroll);
  };

  return (
    <div
      testId="native-part-popup"
      tabIndex={0}
      autoFocus
      onKeyDown={(event) => {
        if (event.key === "escape") onDismiss();
        if (event.key === "down") setActiveIndex((index) => Math.min(request.items.length - 1, index + 1));
        if (event.key === "up") setActiveIndex((index) => Math.max(0, index - 1));
        if (event.key === "home") setActiveIndex(0);
        if (event.key === "end") setActiveIndex(request.items.length - 1);
        if ((event.key === "enter" || event.key === "space") && request.items[activeIndex]) {
          onSelect(request.items[activeIndex].value);
        }
      }}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        backgroundColor: "#00000000",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: MENU_WIDTH,
          height: panelHeight,
          padding: MENU_PADDING,
          borderRadius: 0,
          borderWidth: 1,
          borderColor: request.palette.floatingEdge,
          backgroundColor: request.palette.floatingSurface,
          overflow: "hidden",
        }}
      >
        <div
          ref={(instance) => {
            scrollerId.current = instance?.id ?? null;
          }}
          onScroll={syncScrollOffset}
          style={{
            width: "100%",
            height: viewportHeight,
            overflow: "scroll",
          }}
        >
          {request.items.map((item, index) => (
            <div
              key={item.value}
              testId={`native-part-option-${item.value}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(item.value)}
              style={{
                width: "100%",
                height: MENU_ROW_HEIGHT,
                minHeight: MENU_ROW_HEIGHT,
                flexShrink: 0,
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingLeft: 8,
                paddingRight: maxScroll > 0 ? 16 : 8,
                borderRadius: 7,
                cursor: "pointer",
                backgroundColor: activeIndex === index ? request.palette.segmentedTrack : "#00000000",
                hover: { backgroundColor: request.palette.segmentedTrack },
                active: { backgroundColor: request.palette.surfaceActive },
              }}
            >
              <text
                style={{
                  minWidth: 0,
                  flexGrow: 1,
                  overflow: "hidden",
                  color: request.palette.inkSoft,
                  fontFamily: FONT_UI,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {item.label}
              </text>
              {item.value === request.selectedValue ? (
                <PopupIcon name="check" size={10} color={request.palette.accentTeal} />
              ) : null}
            </div>
          ))}
        </div>
        {maxScroll > 0 ? (
          <div
            ref={(instance) => {
              trackId.current = instance?.id ?? null;
            }}
            testId="native-part-scrollbar"
            onMouseDown={setScrollFromTrack}
            onMouseMove={(event) => {
              if (event.pressedButton === 0) setScrollFromTrack(event);
            }}
            onMouseEnter={() => setScrollbarHovered(true)}
            onMouseLeave={() => setScrollbarHovered(false)}
            style={{
              position: "absolute",
              top: SCROLLBAR_EDGE_INSET,
              right: SCROLLBAR_RIGHT_INSET,
              width: SCROLLBAR_HIT_WIDTH,
              height: scrollbarHeight,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: thumbTop,
                width: scrollbarHovered ? 3 : 2,
                height: thumbHeight,
                borderRadius: RADII.full,
                backgroundColor: request.palette.scrollbarThumb,
                opacity: scrollbarHovered ? 0.64 : 0.3,
                pointerEvents: "none",
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
