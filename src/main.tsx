import { render } from "@gpuix/react";

import { AppSurface, sceneWindowHeight, type Scene } from "./app";
import { PRODUCT_WINDOW_TITLE } from "./platform/window";
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

render(
  <AppSurface
    initialAppearance={initialAppearance}
    initialThemePreference={initialThemePreference}
    initialScene={initialScene}
    initialSource={process.env.VRC_BILI_RELAY_SOURCE}
  />,
  {
  title: PRODUCT_WINDOW_TITLE,
  width: 428,
  height: sceneWindowHeight(initialScene),
  minWidth: 428,
  minHeight: 205,
  resizable: false,
  windowBackground: "blurred",
  },
);
