import { render } from "@gpuix/react";

import { AppSurface, sceneWindowHeight, sceneWindowWidth, type Scene } from "./app";
import {
  PRODUCT_WINDOW_TITLE,
  setProductWindowIconFromExecutable,
  setProductWindowPointerRenderer,
} from "./platform/window";
import { registerBundledFonts } from "./platform/fonts";
import type { ThemePreference } from "./settings";
import type { Appearance } from "./theme";

const initialAppearance: Appearance =
  process.env.VRC_BILI_RELAY_THEME === "dark" ? "dark" : "light";
const initialThemePreference: ThemePreference | undefined =
  process.env.VRC_BILI_RELAY_THEME === "dark" || process.env.VRC_BILI_RELAY_THEME === "light"
    ? process.env.VRC_BILI_RELAY_THEME
    : undefined;
const requestedScene = process.env.VRC_BILI_RELAY_SCENE;
const initialScene: Scene =
  requestedScene === "loading"
  || requestedScene === "error"
  || requestedScene === "ready-vod"
  || requestedScene === "settings"
  || requestedScene === "danmaku"
    ? requestedScene
    : "idle";

registerBundledFonts();

render(
  <AppSurface
    initialAppearance={initialAppearance}
    initialThemePreference={initialThemePreference}
    initialScene={initialScene}
    initialSource={process.env.VRC_BILI_RELAY_SOURCE}
  />,
  {
    title: PRODUCT_WINDOW_TITLE,
    appName: "VRC Bili Relay",
    width: sceneWindowWidth(initialScene),
    height: sceneWindowHeight(initialScene),
    minWidth: sceneWindowWidth("idle"),
    minHeight: sceneWindowHeight("idle"),
    resizable: false,
    titlebarTransparent: process.platform === "win32",
    windowBackground: "blurred",
  },
);

// GPUIX 0.5.1 has no window-icon option. Assign the icon embedded by Bun to
// the live HWND so the taskbar does not keep a stale shell-cached silhouette.
setProductWindowIconFromExecutable();

// GPUIX does not yet expose the live renderer returned by render(). Its render
// host is synchronous, so bridge the retained instance after mounting. This
// lets Win32 pointer capture keep native text selection moving beyond the
// window boundary instead of stopping at the final in-window mouse event.
const renderHost = Reflect.get(globalThis, "__gpuixRenderHost") as
  | {
      renderer?: {
        getElementBounds: (elementId: number) => number[] | null;
        getWindowSize: () => { width: number; height: number };
        simulateMouseMove: (x: number, y: number, pressedButton?: number | null) => void;
      };
    }
  | undefined;
setProductWindowPointerRenderer(renderHost?.renderer ?? null);
