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

const PRODUCT_WINDOW_TITLE = "VRC Bili Relay";
const POPUP_WINDOW_TITLE = "VRC Bili Relay · Parts";
const MENU_WIDTH = 368;
const MENU_ROW_HEIGHT = 31;
const MENU_MAX_ROWS = 7;
const MENU_PADDING = 4;
const SCROLLBAR_EDGE_INSET = 7;
const SCROLLBAR_MIN_THUMB_HEIGHT = 28;
const SCROLLBAR_HIT_WIDTH = 8;
const SCROLLBAR_RIGHT_INSET = 6;
const VK_LBUTTON = 0x01;

type WindowHandle = ReturnType<typeof ptr> | bigint;

interface QueryRenderer {
  getElementBounds(elementId: number): number[] | null;
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
  parentWindowId: number;
  anchorBounds: readonly [number, number, number, number];
  mainWindowSize: { width: number; height: number };
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

const user32 = process.platform === "win32"
  ? dlopen("user32.dll", {
      EnumWindows: { args: [FFIType.function, FFIType.ptr], returns: FFIType.bool },
      GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.uint32_t },
      GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.int32_t },
      GetWindowTextW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.int32_t],
        returns: FFIType.int32_t,
      },
      GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      ClientToScreen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
      GetAsyncKeyState: { args: [FFIType.int32_t], returns: FFIType.int16_t },
    } as const)
  : null;

let popupRenderer: ReturnType<typeof createRenderer> | null = null;
let popupRoot: Root | null = null;
let popupHandle: WindowHandle | null = null;
let popupRequest: NativePartPopupRequest | null = null;
let outsidePointerPoll: ReturnType<typeof setInterval> | null = null;
let leftMouseWasDown = false;

export function supportsNativePartPopup(): boolean {
  return process.platform === "win32" && user32 !== null;
}

export function showNativePartPopup(request: NativePartPopupRequest): boolean {
  if (!user32 || request.items.length === 0) return false;
  hideNativePartPopup();

  const visibleRows = Math.max(1, Math.min(MENU_MAX_ROWS, request.items.length));
  const panelHeight = visibleRows * MENU_ROW_HEIGHT + MENU_PADDING * 2;
  const parentHandle = findWindowByTitle(PRODUCT_WINDOW_TITLE);
  const [parentScaleX] = parentHandle
    ? readClientScale(parentHandle, request.mainWindowSize)
    : [1, 1];
  const renderer = createRenderer();
  try {
    renderer.init({
      title: POPUP_WINDOW_TITLE,
      appName: PRODUCT_WINDOW_TITLE,
      width: MENU_WIDTH,
      height: panelHeight,
      minWidth: MENU_WIDTH,
      minHeight: panelHeight,
      resizable: false,
      transparent: true,
      windowBackground: "transparent",
      focus: true,
      anchoredPopup: {
        parentWindowId: request.parentWindowId,
        // GPUIX currently reports the horizontal element origin in physical
        // client pixels on Windows. GPUI's popup API consumes logical pixels,
        // so normalize X once before the platform applies its DPI scale.
        anchorX: request.anchorBounds[0] / parentScaleX,
        anchorY: request.anchorBounds[1],
        anchorWidth: request.anchorBounds[2],
        anchorHeight: request.anchorBounds[3],
        anchor: "bottomLeft",
        gravity: "bottomRight",
        offsetY: 6,
        constraintAdjustment: ["flipY", "slideX", "slideY"],
        grab: false,
      },
    });
  } catch {
    return false;
  }

  const root = createRoot(renderer);
  popupRenderer = renderer;
  popupRoot = root;
  popupRequest = request;
  flushSync(() => {
    root.render(
      <NativePartPopupSurface
        request={request}
        onSelect={(value) => {
          request.onSelect(value);
          hideNativePartPopup();
        }}
        onDismiss={dismissNativePartPopup}
      />,
    );
  });

  popupHandle = findWindowByTitle(POPUP_WINDOW_TITLE);
  startOutsidePointerPoll();
  return true;
}

export function hideNativePartPopup(): void {
  popupRequest = null;
  stopOutsidePointerPoll();
  popupHandle = null;

  const root = popupRoot;
  const renderer = popupRenderer;
  popupRoot = null;
  popupRenderer = null;
  root?.unmount();
  renderer?.closeWindow();
}

export function disposeNativePartPopup(): void {
  hideNativePartPopup();
}

function dismissNativePartPopup(): void {
  const onDismiss = popupRequest?.onDismiss;
  hideNativePartPopup();
  onDismiss?.();
}

function startOutsidePointerPoll(): void {
  stopOutsidePointerPoll();
  leftMouseWasDown = (user32?.symbols.GetAsyncKeyState(VK_LBUTTON) ?? 0) < 0;
  outsidePointerPoll = setInterval(() => {
    if (!user32 || !popupRequest) return;
    const leftDown = user32.symbols.GetAsyncKeyState(VK_LBUTTON) < 0;
    if (leftDown && !leftMouseWasDown) {
      const cursor = new Int32Array(2);
      const popupRect = new Int32Array(4);
      const handle = popupHandle ?? findWindowByTitle(POPUP_WINDOW_TITLE);
      if (
        handle
        && user32.symbols.GetCursorPos(ptr(cursor))
        && user32.symbols.GetWindowRect(handle, ptr(popupRect))
        && !pointInside(cursor[0], cursor[1], popupRect)
      ) {
        const parentHandle = findWindowByTitle(PRODUCT_WINDOW_TITLE);
        const insideAnchor = parentHandle
          ? pointInsideAnchor(cursor[0], cursor[1], parentHandle, popupRequest)
          : false;
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
  if (
    !user32.symbols.GetClientRect(mainHandle, ptr(client))
    || !user32.symbols.ClientToScreen(mainHandle, ptr(origin))
  ) return false;
  const [scaleX, scaleY] = readClientScale(mainHandle, request.mainWindowSize, client);
  const [left, top, width, height] = request.anchorBounds;
  return x >= origin[0] + left
    && x < origin[0] + left + width * scaleX
    && y >= origin[1] + top * scaleY
    && y < origin[1] + (top + height) * scaleY;
}

function readClientScale(
  handle: WindowHandle,
  logicalSize: { width: number; height: number },
  knownClient?: Int32Array,
): readonly [number, number] {
  if (!user32) return [1, 1];
  const client = knownClient ?? new Int32Array(4);
  if (!knownClient && !user32.symbols.GetClientRect(handle, ptr(client))) return [1, 1];
  return [
    Math.max(0.01, (client[2] - client[0]) / Math.max(1, logicalSize.width)),
    Math.max(0.01, (client[3] - client[1]) / Math.max(1, logicalSize.height)),
  ];
}

function findWindowByTitle(title: string): WindowHandle | null {
  if (!user32) return null;
  let handle: WindowHandle | null = null;
  const callback = new JSCallback(
    (candidate: ReturnType<typeof ptr>) => {
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
  const scrollbarHeight = Math.max(1, panelHeight - SCROLLBAR_EDGE_INSET * 2);
  const thumbHeight = maxScroll > 0
    ? Math.max(SCROLLBAR_MIN_THUMB_HEIGHT, Math.round(scrollbarHeight * viewportHeight / contentHeight))
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
          borderRadius: RADII.compactPanel,
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
          style={{ width: "100%", height: viewportHeight, overflow: "scroll" }}
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
